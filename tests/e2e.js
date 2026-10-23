// Test de bout en bout sur le site en ligne : tout le circuit, avec des comptes de test.
// Lancé par .github/workflows/e2e.yml. Les résultats s'affichent en annotations.
const { chromium } = require("playwright");
const URL = process.env.SITE || "https://justegladerara-cpu.github.io/STP2i/";
const ADMIN = process.env.ADMIN_ID, ADMIN_PW = process.env.ADMIN_PW;
const R = Math.random().toString(36).slice(2, 7);
const PW = "Test-" + Math.random().toString(36).slice(2, 10);
const U = { base: "e2e.base." + R, logistique: "e2e.log." + R, dg: "e2e.dg." + R };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const note = (m) => console.log("::notice::" + m.replace(/\n/g, " | "));
let page, ok = 0, total = 0;

async function etape(nom, fn) {
  total++;
  try { await fn(); ok++; note("OK " + nom); }
  catch (e) {
    const txt = page ? (await page.innerText("body").catch(() => "")).slice(0, 600) : "";
    console.log("::error::ÉCHEC " + nom + " : " + String(e.message).split("\n")[0] + " || page : " + txt.replace(/\n+/g, " / "));
    throw e;
  }
}
const toast = async (re) => { await page.waitForFunction((s) => new RegExp(s).test(document.querySelector("#toast").textContent), re.source, { timeout: 15000 }); };
async function login(id, pw) {
  await page.goto(URL + "?t=" + Date.now()); await page.waitForSelector("#f-login", { timeout: 20000 });
  await page.fill("#lg-id", id); await page.fill("#lg-pw", pw); await page.click("#f-login button[type=submit]");
  await page.waitForSelector("[data-act=logout]", { timeout: 20000 });
  await page.waitForFunction(() => { const s = document.querySelector("#sync"); return (s && /À jour/.test(s.textContent)) || /Accès en attente|désactivé/.test(document.body.innerText); }, null, { timeout: 20000 });
  const err = await page.$eval("#sync", (s) => s.textContent).catch(() => "");
  if (/Erreur/.test(err)) throw new Error(err);
}
async function logout() { await page.click("header [data-act=logout]"); await page.waitForSelector("#f-login", { timeout: 15000 }); }
const fichier = (name, buf, mime) => ({ name, mimeType: mime, buffer: buf });

(async () => {
  const b = await chromium.launch();
  page = await b.newPage({ viewport: { width: 1200, height: 900 } });
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  try {
    await etape("connexion administrateur", () => login(ADMIN, ADMIN_PW));
    await etape("écran administration", async () => { await page.waitForSelector("text=Créer un compte"); });
    for (const [role, id] of Object.entries(U)) {
      await etape("création du compte " + role, async () => {
        await page.click("text=Créer un compte");
        await page.fill("#c-nom", "Test " + role); await page.fill("#c-id", id); await page.selectOption("#c-role", role); await page.fill("#c-pw", PW);
        await page.click("#dlgok"); await page.waitForSelector("#dlgt:has-text('Compte créé')", { timeout: 15000 });
        await page.click("[data-act=dlg-cancel]");
      });
    }
    await etape("déconnexion", logout);

    await etape("base : connexion", () => login(U.base, PW));
    await etape("base : nouvelle demande avec photo", async () => {
      await page.click("text=Nouvelle demande"); await page.click(".tile:has-text('CE-01')");
      await page.setInputFiles("#ph-photo", fichier("demande.png", PNG, "image/png"));
      await page.waitForSelector("text=Photo enregistrée", { timeout: 20000 });
      await page.fill("[data-f=piece]", "Filtre test E2E"); await page.click("[aria-label=Plus]");
      await page.click("text=Envoyer la demande"); await toast(/Demande DP-/);
    });
    await etape("déconnexion base", logout);

    await etape("logistique : connexion", () => login(U.logistique, PW));
    await etape("logistique : bon de commande avec devis", async () => {
      await page.click("tr:has-text('Filtre test E2E') >> text=Créer le bon de commande");
      await page.fill("#bc-f", "FOURNISSEUR TEST"); await page.fill("#l-p-0", "15000");
      await page.setInputFiles("#bc-devis", fichier("devis.pdf", PDF, "application/pdf"));
      await page.click("#dlgok"); await toast(/BC-.* enregistré/);
    });
    await etape("déconnexion logistique", logout);

    await etape("DG : connexion", () => login(U.dg, PW));
    await etape("DG : validation du bon de commande", async () => {
      await page.click(".vcard:has-text('FOURNISSEUR TEST') [data-act=bc-ok]"); await toast(/validé/);
    });
    await etape("déconnexion DG", logout);

    await etape("base : réception de la livraison", async () => {
      await login(U.base, PW);
      await page.click("text=Réception livraison"); await page.click(".cardbtn:has-text('FOURNISSEUR TEST')");
      await page.setInputFiles("#ph-bl", fichier("bl.png", PNG, "image/png"));
      await page.waitForSelector("text=Photo enregistrée", { timeout: 20000 });
      await page.click("text=Valider la réception"); await toast(/Réception BR-/);
    });
    await etape("base : pièce montée", async () => {
      await page.click("text=Pièce montée"); await page.click(".tile:has-text('Filtre test E2E')");
      await page.click(".tile:has-text('CE-01')");
      await page.setInputFiles("#ph-old", fichier("usee.png", PNG, "image/png"));
      await page.waitForSelector("text=Photo enregistrée", { timeout: 20000 });
      await page.click("text=Valider la sortie"); await toast(/Sortie enregistrée/);
    });
    await etape("déconnexion base", logout);

    await etape("logistique : facture contrôlée conforme", async () => {
      await login(U.logistique, PW);
      await page.click("nav >> text=Factures"); await page.click("text=Enregistrer une facture");
      const opt = await page.$eval("#fa-bc", (s) => [...s.options].find((o) => /FOURNISSEUR TEST/.test(o.text)).value);
      await page.selectOption("#fa-bc", opt); await page.fill("#fa-n", "FT-" + R); await page.fill("#fa-m", "30000");
      await page.setInputFiles("#fa-file", fichier("facture.pdf", PDF, "application/pdf"));
      await page.click("#dlgok"); await toast(/Facture conforme/);
    });
    await etape("déconnexion logistique", logout);

    await etape("DG : paiement de la facture", async () => {
      await login(U.dg, PW);
      await page.click("nav >> text=Factures à payer");
      await page.click("tr:has-text('FT-" + R + "') >> text=Marquer payée");
      await page.fill("#pay-ref", "VIR-TEST"); await page.click("#dlgok"); await toast(/Facture payée/);
    });
    await etape("DG : journal rempli", async () => {
      await page.click("nav >> text=Journal"); await page.waitForSelector("td:has-text('Facture FT-" + R + " payée')", { timeout: 10000 });
    });
    await etape("affichage téléphone (base)", async () => {
      await logout(); await page.setViewportSize({ width: 390, height: 800 }); await login(U.base, PW);
      await page.waitForSelector("text=Nouvelle demande");
    });
  } catch (e) { /* déjà signalé */ }
  if (errs.length) console.log("::warning::Erreurs JavaScript : " + errs.join(" || "));
  note(`RÉSULTAT ${ok}/${total} étapes réussies ; comptes de test : ${Object.values(U).join(", ")}`);
  await b.close();
  process.exit(ok === total ? 0 : 1);
})();
