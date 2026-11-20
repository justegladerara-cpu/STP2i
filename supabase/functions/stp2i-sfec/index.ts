// Envoi d'une facture STP2i à la SFEC (facture électronique certifiée du Congo, décret 2026-101).
// Documentation : https://docs.sfec.gouv.cg/api (POST /api/v1/invoices, en-tête X-API-Key).
//
// Secrets du serveur (tableau de bord Supabase → Edge Functions → Secrets), jamais dans la page ni dans git :
//   SFEC_API_KEY : clé donnée par la DGID après la demande d'intégration « API (ERP) » sur le portail e-Facture.
//   SFEC_ENV     : « sandbox » (par défaut, tests) ou « production » (vraies factures).
//
// Appel depuis la page : POST { facture_id } avec le jeton de la personne connectée.
// Rôles permis : logistique, dg, admin (comptes STP2i actifs).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BASES: Record<string, string> = {
  sandbox: "https://sandbox.api.sfec.gouv.cg",
  production: "https://api.sfec.gouv.cg",
};

function rep(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
const n = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
const iso = (d: string | null) => (d ? `${d}T00:00:00Z` : null);
const vide = (s: unknown) => (s === null || s === undefined || String(s).trim() === "" ? null : String(s).trim());

// Message lisible à partir d'une réponse d'erreur SFEC (deux formes possibles selon la doc).
function messageSfec(status: number, j: any): string {
  if (j?.errors?.length) return j.errors.map((e: any) => `${e.field ?? ""} : ${e.message ?? e.code ?? ""}`).join(" ; ");
  return j?.message || j?.error || `Erreur SFEC ${status}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return rep(405, { erreur: "Méthode non autorisée" });

  const env = (Deno.env.get("SFEC_ENV") || "sandbox").toLowerCase();
  const cle = Deno.env.get("SFEC_API_KEY") || "";
  const base = BASES[env];
  if (!base) return rep(500, { erreur: "Réglage SFEC_ENV inconnu (sandbox ou production)" });
  if (!cle) return rep(503, { erreur: "La clé SFEC n'est pas encore installée sur le serveur" });

  const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // Qui appelle ?
  const jeton = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await service.auth.getUser(jeton);
  if (!u?.user) return rep(401, { erreur: "Non connecté" });
  const { data: moi } = await service.from("stp2i_profils").select("role, actif").eq("id", u.user.id).maybeSingle();
  if (!moi?.actif || !["logistique", "dg", "admin"].includes(moi.role)) return rep(403, { erreur: "Action non autorisée pour votre rôle" });

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return rep(400, { erreur: "Requête invalide" }); }
  const id = String(b.facture_id ?? "");

  const { data: f } = await service.from("stp2i_factures_clients").select("*").eq("id", id).maybeSingle();
  if (!f) return rep(404, { erreur: "Facture introuvable" });
  if (f.statut === "Annulée") return rep(400, { erreur: "Facture annulée : rien à envoyer" });
  if (f.sfec_statut === "Certifiée") return rep(400, { erreur: "Facture déjà certifiée" });
  const { data: c } = await service.from("stp2i_clients").select("*").eq("id", f.client_id).maybeSingle();
  const { data: L } = await service.from("stp2i_factures_clients_lignes").select("*").eq("facture_id", f.id).order("ordre");
  if (!c || !L?.length) return rep(400, { erreur: "Client ou lignes manquants" });

  const payload: Record<string, unknown> = {
    invoice_id: f.num,
    invoice_type: "salesInvoice",
    invoice_subject: vide(f.objet),
    invoice_due_date: iso(f.echeance),
    reference_invoice_id: null,
    subtotal: n(f.total_ht),
    total_tax_t_amount: n(f.tva_18),
    total_tax_r_amount: n(f.tva_5),
    total_exempt_amount: n(f.total_exonere),
    total_tax_amount: n(Number(f.tva_18) + Number(f.tva_5)),
    discount_amount: 0,
    total_line_discount_amount: 0,
    additional_cent_tax: 0,
    electronic_stamp_duty: 0,
    total_amount: n(f.total_ttc),
    amount_due: n(f.net_a_payer),
    currency: "XAF",
    recipient_type: c.type_sfec,
    recipient_name: c.nom,
    recipient_niu: vide(c.niu),
    recipient_rccm: vide(c.rccm),
    recipient_address: vide(c.adresse),
    recipient_phone: vide(c.telephone),
    recipient_email: vide(c.email),
    is_recipient_taxable: !!c.assujetti_tva,
    notes: vide(f.reference),
    items: L.map((l: any) => ({
      designation: l.designation,
      type: l.type,
      unit_price: n(l.pu),
      quantity: Number(l.qte),
      subtotal: n(l.montant),
      discount_amount: 0,
      amount_after_discount: n(l.montant),
      tax_rate: String(l.taux_tva),
      tax_amount: n(l.tva),
      net_amount: n(Number(l.montant) + Number(l.tva)),
      total_amount: n(Number(l.montant) + Number(l.tva)),
    })),
  };
  if (Number(f.ras_taux) > 0) { payload.ras_rate = Number(f.ras_taux); payload.ras_amount = n(f.ras_montant); }

  const entetes = { "X-API-Key": cle, "Content-Type": "application/json", Accept: "application/json" };
  let ok = false, sig = "", code = "", qr = "", quand: string | null = null, erreur = "";
  try {
    const r = await fetch(`${base}/api/v1/invoices`, { method: "POST", headers: entetes, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 201) {
      ok = true; sig = j.signature ?? j.certification_number ?? ""; code = j.short_signature ?? j.identifier ?? "";
      qr = j.qr_code ?? ""; quand = j.certification_date ?? null;
    } else if (r.status === 409) {
      // Déjà certifiée à la SFEC (par exemple, réponse perdue la dernière fois) : on relit la facture.
      const g = await fetch(`${base}/api/v1/invoices/${encodeURIComponent(f.num)}`, { headers: entetes });
      const k = await g.json().catch(() => ({}));
      if (g.ok && k.certification_signature) {
        ok = true; sig = k.certification_signature; code = k.certification_short_signature ?? "";
        qr = k.certification_qr_code ?? ""; quand = k.certification_date ?? null;
      } else erreur = messageSfec(r.status, j);
    } else {
      erreur = messageSfec(r.status, j);
    }
  } catch (e) {
    // Réseau coupé : on ne change rien, la personne pourra réessayer.
    return rep(502, { erreur: "Impossible de joindre la SFEC : " + String((e as Error)?.message ?? e) });
  }

  const { error } = await service.rpc("stp2i_facture_client_sfec_noter", {
    p_id: f.id, p_ok: ok, p_env: env, p_signature: sig, p_code: code, p_qr: qr, p_date: quand, p_erreur: erreur, p_par: u.user.id,
  });
  if (error) return rep(500, { erreur: "Résultat SFEC reçu mais non enregistré : " + error.message, signature: sig });
  return rep(ok ? 200 : 400, ok ? { statut: "Certifiée", code, env } : { statut: "Refusée", erreur });
});
