// Création et gestion des comptes STP2i (sans e-mail de confirmation).
// Actions :
//   premier_admin : crée le premier administrateur, seulement si aucun n'existe.
//   creer         : l'administrateur crée un compte (identifiant, mot de passe, nom, rôle).
//   mot_de_passe  : l'administrateur change le mot de passe d'un compte STP2i.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ROLES = ["admin", "base", "logistique", "dg"];

function rep(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
// "Rodrigue Tchibinda" → "rodrigue.tchibinda" ; une adresse e-mail est gardée telle quelle.
function nettoyer(identifiant: string) {
  const id = identifiant.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (id.includes("@")) return id.replace(/\s+/g, "");
  return id.replace(/\s+/g, ".").replace(/[^a-z0-9._-]/g, "").replace(/\.+/g, ".").replace(/^\.|\.$/g, "");
}
function emailDe(identifiant: string) {
  const id = nettoyer(identifiant);
  return id.includes("@") ? id : `${id}@stp2i.app`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return rep(405, { erreur: "Méthode non autorisée" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return rep(400, { erreur: "Requête invalide" }); }
  const action = String(b.action ?? "");

  if (action === "premier_admin") {
    const { count } = await service.from("stp2i_profils").select("id", { count: "exact", head: true }).eq("role", "admin");
    if ((count ?? 0) > 0) return rep(403, { erreur: "Un administrateur existe déjà" });
    return await creer(service, b, "admin");
  }

  // Les autres actions exigent un administrateur STP2i actif.
  const jeton = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await service.auth.getUser(jeton);
  if (!u?.user) return rep(401, { erreur: "Non connecté" });
  const { data: moi } = await service.from("stp2i_profils").select("role, actif").eq("id", u.user.id).maybeSingle();
  if (!moi || moi.role !== "admin" || !moi.actif) return rep(403, { erreur: "Réservé à l'administrateur" });

  if (action === "creer") {
    const role = String(b.role ?? "");
    if (!ROLES.includes(role)) return rep(400, { erreur: "Rôle inconnu" });
    return await creer(service, b, role, u.user.id);
  }

  if (action === "mot_de_passe") {
    const cible = String(b.id ?? "");
    const mdp = String(b.mot_de_passe ?? "");
    if (mdp.length < 6) return rep(400, { erreur: "Le mot de passe doit faire au moins 6 caractères" });
    const { data: p } = await service.from("stp2i_profils").select("id, nom").eq("id", cible).maybeSingle();
    if (!p) return rep(404, { erreur: "Compte STP2i introuvable" });
    const { error } = await service.auth.admin.updateUserById(cible, { password: mdp });
    if (error) return rep(400, { erreur: error.message });
    await service.from("stp2i_journal").insert({ par: u.user.id, role: "admin", action: `Mot de passe changé pour ${p.nom}`, ref: "" });
    return rep(200, { ok: true });
  }

  return rep(400, { erreur: "Action inconnue" });
});

// deno-lint-ignore no-explicit-any
async function creer(service: any, b: Record<string, unknown>, role: string, par?: string) {
  const identifiant = nettoyer(String(b.identifiant ?? ""));
  const mdp = String(b.mot_de_passe ?? "");
  const nom = String(b.nom ?? "").trim() || identifiant;
  console.log("creer", { role, identifiant, longueur_mdp: mdp.length });
  if (!identifiant) return rep(400, { erreur: "Indiquez un identifiant (par exemple : gloria)" });
  if (mdp.length < 6) return rep(400, { erreur: "Le mot de passe doit faire au moins 6 caractères" });
  const email = emailDe(identifiant);
  const { data, error } = await service.auth.admin.createUser({
    email, password: mdp, email_confirm: true, user_metadata: { nom, app: "stp2i" },
  });
  if (error) { console.log("createUser", error.message); return rep(400, { erreur: error.message.includes("already") ? "Cet identifiant existe déjà, choisissez-en un autre" : error.message }); }
  const { error: e2 } = await service.from("stp2i_profils").insert({ id: data.user.id, nom, email, role, actif: true });
  if (e2) return rep(400, { erreur: e2.message });
  await service.from("stp2i_journal").insert({ par: par ?? data.user.id, role: "admin", action: `Compte créé : ${nom} (${role})`, ref: identifiant });
  return rep(200, { ok: true, email, identifiant: email.endsWith("@stp2i.app") ? identifiant : email });
}
