/* STP2i Achats et Parc : interface web.
   Les règles (qui peut faire quoi, contrôle des factures, numérotation, journal)
   sont appliquées par la base de données. Cette page ne fait qu'afficher et appeler ces règles. */
(function(){
"use strict";
const CFG=window.STP2I_CONFIG;
const sb=window.supabase.createClient(CFG.url,CFG.cle,{auth:{persistSession:true,autoRefreshToken:true}});
const BUCKET="stp2i-documents";

const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const NF=new Intl.NumberFormat("fr-FR",{maximumFractionDigits:0});
const fmt=n=>NF.format(Math.round(+n||0));
const xaf=n=>fmt(n)+" XAF";
const ts=t=>t?new Date(t).getTime():0;
const dt=t=>t?new Date(t).toLocaleDateString("fr-FR",{day:"2-digit",month:"2-digit",year:"numeric"}):"";
const dtt=t=>t?new Date(t).toLocaleString("fr-FR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):"";
const ROLES={base:"Chef de base",logistique:"Logistique",dg:"Direction générale",hse:"Responsable HSE",admin:"Administration"};
const ICON={
 plus:'<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"><circle cx="24" cy="24" r="20" stroke-width="3.5"/><path d="M24 14v20M14 24h20"/></svg>',
 box:'<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round"><path d="M6 15l18-9 18 9v18l-18 9-18-9z"/><path d="M6 15l18 9 18-9M24 24v18"/></svg>',
 wrench:'<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M30 6a10 10 0 0 0-9 14L7 34a4 4 0 0 0 6 6l14-14a10 10 0 0 0 14-9l-6 6-6-2-2-6z"/></svg>',
 alert:'<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M24 5L3 42h42z"/><path d="M24 19v11M24 36v1"/></svg>',
 fuel:'<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"><path d="M8 42V8h20v34M4 42h28M8 20h20"/><path d="M28 16h6l4 5v15a3 3 0 0 1-6 0v-8h-4"/></svg>',
 shield:'<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"><path d="M24 4l16 6v12c0 10-7 18-16 22C15 40 8 32 8 22V10z"/><path d="M17 24l5 5 9-10"/></svg>',
 cam:'<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round"><path d="M5 15h9l4-6h12l4 6h9v24H5z"/><circle cx="24" cy="26" r="8"/></svg>'
};
const C_STAT={
 demande:{"Nouvelle":"orange","En validation":"blue","Commandée":"blue","Reçue à la base":"ok","Montée":"ok","Refusée":"bad"},
 bc:{"À valider":"orange","Validé":"blue","Refusé":"bad","Reçu partiel":"warn","Reçu":"ok","Facturé":"ok","Payé":""},
 facture:{"Conforme":"ok","Bloquée":"bad","Payée":""}
};
const chip=(kind,s)=>`<span class="chip ${C_STAT[kind][s]||""}">${esc(s)}</span>`;
// Temps d'attente en couleur : vert, puis orange, puis rouge (plus vite si urgent).
const HEURE=3600e3;
function depuis(t){const h=(Date.now()-ts(t))/HEURE;if(h<1)return "il y a "+Math.max(1,Math.round(h*60))+" min";if(h<48)return "il y a "+Math.round(h)+" h";return "il y a "+Math.round(h/24)+" jours"}
function attenteCls(t,urgent,lent){const h=(Date.now()-ts(t))/HEURE;const [o,r]=urgent?[2,8]:lent?[72,168]:[24,72];return h>=r?"bad":h>=o?"warn":"ok"}
const attChip=(t,urgent,lent)=>`<span class="chip ${attenteCls(t,urgent,lent)}" title="Temps d'attente">${depuis(t)}</span>`;

/* ---------- État ---------- */
const S={vehicules:[],demandes:[],commandes:[],lignes:[],receptions:[],stock:[],mouvements:[],factures:[],profils:[],journal:[],attendues:[],seuil:0,
  affectations:[],pannes:[],entretiens:[],entretiens_faits:[],carburant:[],papiers:[],sites:[],stock_sites:[],transferts:[],inventaires:[],fournisseurs:[],jours:[],contrat_prix:[],controles:[],hse:[],formations:[],smq:[],smq_versions:[],rapport_jour:[]};
// Lien d'un QR collé sur un camion : #camion=CE-01
let qrCamion=(location.hash.match(/camion=([^&]+)/)||[])[1]||null; if(qrCamion) qrCamion=decodeURIComponent(qrCamion);
let qrDoc=(location.hash.match(/doc=([^&]+)/)||[])[1]||null; if(qrDoc) qrDoc=decodeURIComponent(qrDoc);
let me=null;               // profil STP2i de la personne connectée
let boot="loading";        // loading | login | setup | ready
let syncTxt="";
let viewAs="admin"; try{viewAs=localStorage.getItem("stp2i-viewas")||"admin"}catch(e){}
let tab=null, screen="home", F={};
const urlCache={};
const byId=(c,id)=>S[c].find(r=>r.id===id);
const veh=id=>byId("vehicules",id);
const vName=id=>{const v=veh(id);return v?(v.code+(v.immat?" · "+v.immat:"")):"—"};
const vSort=(a,b)=>String(a.code||"").localeCompare(String(b.code||""),"fr",{numeric:true});
const newest=(a,b)=>ts(b.created_at)-ts(a.created_at);
const who=id=>{if(!id)return "";const p=byId("profils",id);return p?(p.nom||p.email||"Utilisateur"):"Utilisateur"};
const lignesDe=cid=>S.lignes.filter(l=>l.commande_id===cid).sort((a,b)=>a.position-b.position);
const designation=sid=>{const s=byId("stock",sid);return s?s.designation:""};
const urgentBc=b=>{const d=b.demande_id?byId("demandes",b.demande_id):null;return !!(d&&d.urgent)};

// Rôle affiché. L'administrateur peut regarder les autres écrans ; la base de données
// garde le dernier mot (le DG seul valide et paie).
function role(){
  if(!me||!me.role||!me.actif) return null;
  if(me.role==="admin") return viewAs;
  return me.role;
}
const canDo=a=>{
  const r=role(), real=me&&me.role;
  if(a==="valider"||a==="payer") return real==="dg";
  if(a==="b") return r==="base"&&(real==="base"||real==="admin");
  if(["bc","refuse","facture","recheck","veh","km"].includes(a)) return r==="logistique"&&(real==="logistique"||real==="admin");
  if(a==="admin") return real==="admin"&&r==="admin";
  if(a==="rapjour") return r==="logistique"&&(real==="logistique"||real==="admin");
  if(a==="papier") return (r==="logistique"&&(real==="logistique"||real==="admin"))||(r==="hse"&&(real==="hse"||real==="admin"));
  if(a==="controle") return ["base","logistique","hse"].includes(r)&&(real===r||real==="admin");
  if(a==="stockop") return ["base","logistique"].includes(r)&&(real===r||real==="admin");
  if(a==="plein") return ["base","logistique"].includes(r)&&(real===r||real==="admin");
  if(a==="panne") return ["base","logistique"].includes(r)&&(real===r||real==="admin");
  return false;
};

/* ---------- Outils ---------- */
function errMsg(e){
  const m=(e&&(e.message||e.erreur))||String(e||"");
  if(/Failed to fetch|NetworkError|network/i.test(m)) return "Pas de connexion internet. Réessayez.";
  if(/Invalid login credentials/i.test(m)) return "Identifiant ou mot de passe incorrect.";
  if(/JWT|session/i.test(m)) return "Session expirée : reconnectez-vous.";
  return m||"L'enregistrement a échoué. Réessayez.";
}
async function rpc(fn,args){const {data,error}=await sb.rpc(fn,args||{});if(error) throw error;return data}
async function fonction(body){
  const {data,error}=await sb.functions.invoke("stp2i-comptes",{body});
  if(error){let msg=error.message;try{const j=await error.context.json();if(j&&j.erreur)msg=j.erreur}catch(x){}throw new Error(msg)}
  if(data&&data.erreur) throw new Error(data.erreur);
  return data;
}
// Même règle que le serveur : "Rodrigue Tchibinda" → "rodrigue.tchibinda@stp2i.app".
const nettoyer=id=>{id=String(id||"").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  if(id.includes("@")) return id.replace(/\s+/g,"");
  return id.replace(/\s+/g,".").replace(/[^a-z0-9._-]/g,"").replace(/\.+/g,".").replace(/^\.|\.$/g,"")};
const emailDe=id=>{id=nettoyer(id);return id.includes("@")?id:id+"@"+CFG.domaine};

async function shrink(file){
  try{const img=await createImageBitmap(file);const k=Math.min(1,1600/Math.max(img.width,img.height));const c=document.createElement("canvas");c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);c.getContext("2d").drawImage(img,0,0,c.width,c.height);return await new Promise(r=>c.toBlob(b=>r(b||file),"image/jpeg",0.8));}catch(e){return file}
}
// Envoie une photo ou un PDF ; renvoie le chemin du fichier dans le dossier STP2i.
async function upload(file){
  const isImg=file.type.startsWith("image/");
  const blob=isImg?await shrink(file):file;
  const ext=isImg?"jpg":(file.type==="application/pdf"?"pdf":(file.name.split(".").pop()||"bin").toLowerCase());
  const d=new Date();
  const path=`${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${crypto.randomUUID()}.${ext}`;
  const {error}=await sb.storage.from(BUCKET).upload(path,blob,{contentType:isImg?"image/jpeg":file.type||"application/octet-stream",upsert:false});
  if(error) throw error;
  await signer([path]);
  return path;
}
// Image envoyée telle quelle (signature, cachet : garder la transparence).
async function uploadBrut(file){
  const ext=file.type==="image/png"?"png":"jpg";
  const path=`officiel/${crypto.randomUUID()}.${ext}`;
  const {error}=await sb.storage.from(BUCKET).upload(path,file,{contentType:file.type||"image/png",upsert:false});
  if(error) throw error; return path;
}
const isImgPath=p=>/\.(jpe?g|png|webp|gif|heic)$/i.test(p||"");
async function signer(paths){
  const need=[...new Set(paths.filter(p=>p&&!urlCache[p]))];
  if(!need.length) return false;
  const {data}=await sb.storage.from(BUCKET).createSignedUrls(need,6*3600);
  let ch=false;(data||[]).forEach(x=>{if(x.signedUrl){urlCache[x.path]=x.signedUrl;ch=true}});
  return ch;
}
function thumb(p,label){
  if(!p) return "";
  const u=urlCache[p];
  const inner=isImgPath(p)?(u?`<img src="${esc(u)}" alt="${esc(label||"Photo")}">`:"Photo"):(/\.pdf$/i.test(p)?"PDF":"Fichier");
  return `<button type="button" class="thumb" data-act="view" data-p="${esc(p)}" title="${esc(label||"")}">${inner}</button>`;
}
function docItem(p,label){return p?`<div class="doc">${thumb(p,label)}<span>${esc(label)}</span></div>`:""}

let tt;function toast(t){const el=$("#toast");el.textContent=t;el.classList.add("on");clearTimeout(tt);tt=setTimeout(()=>el.classList.remove("on"),2800)}

/* ---------- Chargement des données ---------- */
let loading=false, again=false;
async function charger(){
  if(!me||!me.role||!me.actif) return;
  if(loading){again=true;return}
  loading=true;
  try{
    const direction=me.role!=="base";
    const q=(t,sel,ord)=>{let x=sb.from(t).select(sel||"*");if(ord)x=x.order(ord,{ascending:false});return x};
    const jobs={
      vehicules:q("stp2i_vehicules"),
      demandes:q("stp2i_demandes","*","created_at"),
      stock:q("stp2i_stock"),
      mouvements:q("stp2i_mouvements","*","created_at").limit(500),
      profils:q("stp2i_profils"),
      reglages:q("stp2i_reglages"),
      affectations:q("stp2i_affectations","*","debut"),
      pannes:q("stp2i_pannes","*","created_at"),
      entretiens:q("stp2i_entretiens"),
      entretiens_faits:q("stp2i_entretiens_faits","*","created_at").limit(500),
      carburant:q("stp2i_carburant","*","created_at").limit(1500),
      papiers:q("stp2i_papiers","*","created_at"),
      sites:q("stp2i_sites"),
      stock_sites:q("stp2i_stock_sites"),
      transferts:q("stp2i_transferts","*","envoye_le").limit(300),
      inventaires:q("stp2i_inventaires","*","created_at").limit(30),
      jours:q("stp2i_jours","*","jour").limit(3000),
      controles:q("stp2i_controles_depart","*","created_at").limit(600),
      hse:q("stp2i_hse","*","created_at"),
      formations:q("stp2i_formations","*","created_at"),
      smq:q("stp2i_smq_documents"),
      smq_versions:q("stp2i_smq_versions","*","remplace_le"),
      rapport_jour:q("stp2i_rapport_jour","*","jour").limit(2000)
    };
    if(direction){
      jobs.commandes=q("stp2i_commandes","*","created_at");
      jobs.lignes=q("stp2i_commande_lignes");
      jobs.receptions=q("stp2i_receptions","*","created_at");
      jobs.factures=q("stp2i_factures","*","created_at");
      jobs.journal=q("stp2i_journal","*","at").limit(400);
      jobs.fournisseurs=q("stp2i_fournisseurs");
      jobs.contrat_prix=q("stp2i_contrat_prix");
    }
    const keys=Object.keys(jobs);
    const res=await Promise.all(keys.map(k=>jobs[k]));
    res.forEach((r,i)=>{const k=keys[i]; if(r.error){if(NOUVELLES.includes(k)){S[k]=[];return} throw r.error} if(k==="reglages"){reglages=r.data[0]||{};S.seuil=r.data[0]?+r.data[0].seuil_validation:0} else S[k]=r.data||[]});
    if(me.role==="base"||me.role==="admin") S.attendues=await rpc("stp2i_commandes_attendues").catch(()=>[]);
    const mine=S.profils.find(p=>p.id===me.id); if(mine) me=mine;
    if(qrDoc&&me.role!=="base"){const b=S.commandes.find(x=>x.num===qrDoc);const r=S.receptions.find(x=>x.num===qrDoc);qrDoc=null;try{history.replaceState(null,"",location.pathname)}catch(x){}
      setTimeout(()=>{if(b)openBc(b.id);else if(r)openBc(r.commande_id);else toast("Document introuvable : il n'existe pas dans STP2i")},50)}
    if(qrCamion){const v=S.vehicules.find(x=>String(x.code).toLowerCase()===qrCamion.toLowerCase());qrCamion=null;
      if(v){tab="camions";fiche=v.id;screen="home";try{history.replaceState(null,"",location.pathname)}catch(x){}}}
    syncTxt="À jour · "+new Date().toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"});
    render();
    const paths=[...S.demandes.map(d=>d.photo),...S.commandes.map(c=>c.devis),...S.receptions.map(r=>r.photo),...S.factures.map(f=>f.fichier),...S.mouvements.map(m=>m.photo),...S.pannes.map(x=>x.photo),...S.carburant.map(x=>x.photo),...S.papiers.map(x=>x.fichier),...S.hse.map(x=>x.photo),...S.controles.map(x=>x.photo),...S.formations.map(x=>x.fichier),...S.smq.map(x=>x.fichier)];
    if(await signer(paths)) render();
  }catch(e){syncTxt="Erreur de chargement : "+errMsg(e);render()}
  finally{loading=false;if(again){again=false;charger()}}
}
// Tables ajoutées par la mise à jour du parc : l'écran reste utilisable si elles manquent.
const NOUVELLES=["affectations","pannes","entretiens","entretiens_faits","carburant","papiers","sites","stock_sites","transferts","inventaires","fournisseurs","jours","contrat_prix","controles","hse","formations","smq","smq_versions","rapport_jour"];
let reloadT;const bientot=()=>{clearTimeout(reloadT);reloadT=setTimeout(charger,400)};
let canal=null;
function ecouter(){
  if(canal) return;
  canal=sb.channel("stp2i");
  ["stp2i_demandes","stp2i_commandes","stp2i_receptions","stp2i_stock","stp2i_mouvements","stp2i_factures","stp2i_vehicules","stp2i_profils","stp2i_journal","stp2i_pannes","stp2i_entretiens","stp2i_affectations","stp2i_carburant","stp2i_papiers","stp2i_transferts","stp2i_stock_sites","stp2i_jours","stp2i_controles_depart","stp2i_hse","stp2i_smq_documents"]
    .forEach(t=>canal.on("postgres_changes",{event:"*",schema:"public",table:t},bientot));
  canal.subscribe();
  setInterval(charger,120000); // filet de sécurité si le temps réel est coupé
}

/* ---------- Rendu ---------- */
let pending=false;
function render(force){
  const ae=document.activeElement;
  if(!force&&($("#dlg").open||(ae&&ae.matches("input,textarea,select")&&$("#main").contains(ae)))){pending=true;return}
  pending=false;
  renderHeader();
  const m=$("#main");
  if(boot==="loading"){m.innerHTML='<div class="empty">Chargement…</div>';return}
  if(boot==="setup"){m.innerHTML=vSetup();return}
  if(boot==="login"){m.innerHTML=vLogin();return}
  const r=role();
  if(!me||!me.actif){m.innerHTML=`<div class="panel narrow"><div class="phead"><h2>Compte désactivé</h2></div><div class="db"><p>Ce compte n'a plus accès à l'application. Contactez l'administrateur.</p><div><button class="btn" data-act="logout">Se déconnecter</button></div></div></div>`;return}
  if(!r){m.innerHTML=`<div class="panel narrow"><div class="phead"><h2>Accès en attente</h2></div><div class="db"><p>Bonjour ${esc(me.nom||"")}. Votre compte existe, mais aucun rôle ne vous a encore été attribué.</p><p class="sub">Demandez à l'administrateur de vous donner un rôle : Chef de base, Logistique ou Direction générale.</p><div><button class="btn" data-act="logout">Se déconnecter</button></div></div></div>`;return}
  const T=tabsFor(r);
  if(!T.find(x=>x[0]===tab)) tab=T[0][0];
  const VIEWS={base:vBase,demandes:vDemandes,commandes:vCommandes,factures:vFactures,stock:vStock,camions:vCamions,journal:vJournal,valider:vValider,params:vParams,bord:vBord,carburant:vCarburant,papiers:vPapiers,fournisseurs:vFournisseurs,contrat:vContrat,hse:vHse,rapports:vRapports,smq:vSmq,rapjour:vRapJour};
  m.innerHTML=VIEWS[tab]();
}
function tabsFor(r){
  const nD=S.demandes.filter(d=>d.statut==="Nouvelle").length, nV=S.commandes.filter(b=>b.statut==="À valider").length,
        nF=S.factures.filter(f=>f.statut==="Bloquée").length, nP=S.factures.filter(f=>f.statut==="Conforme").length;
  return ({
    base:[["base","Accueil"],["camions","Camions"],["stock","Stock",S.transferts.filter(t=>t.statut==="En route"&&t.envoye_par!==me.id).length],["hse","HSE"],["smq","Documents HSE"]],
    logistique:[["bord","Accueil"],["demandes","Demandes",nD],["commandes","Bons de commande"],["factures","Factures",nF],["stock","Stock"],["fournisseurs","Fournisseurs"],["camions","Camions"],["rapjour","Rapport journalier",rjManquants(auj()).length],["carburant","Carburant"],["papiers","Papiers",papiersAlerte().length],["contrat","Contrat ENI"],["hse","HSE",S.hse.filter(h=>h.statut==="Ouvert").length],["smq","Documents HSE"],["rapports","Rapports"],["journal","Journal"]],
    dg:[["bord","Accueil"],["valider","À valider",nV],["factures","Factures à payer",nP],["commandes","Bons de commande"],["fournisseurs","Fournisseurs"],["stock","Stock"],["camions","Camions"],["rapjour","Rapport journalier"],["carburant","Carburant"],["papiers","Papiers",papiersAlerte().length],["contrat","Contrat ENI"],["hse","HSE",S.hse.filter(h=>h.statut==="Ouvert").length],["smq","Documents HSE"],["rapports","Rapports"],["journal","Journal"]],
    hse:[["hse","Accueil HSE",S.hse.filter(h=>h.statut==="Ouvert").length],["smq","Documents",smqARevoir().length],["papiers","Papiers",papiersAlerte().length],["camions","Camions"],["rapports","Rapports"],["journal","Journal"]],
    admin:[["params","Comptes et réglages"],["bord","Tableau de bord"],["journal","Journal"]]
  })[r];
}
function renderHeader(){
  let h="";
  if(boot==="ready"&&me){
    h+=`<span id="sync">${esc(syncTxt)}</span><span>${esc(me.nom||"")}</span>`;
    if(me.role==="admin") h+=`<select id="viewas" aria-label="Écran affiché" style="width:auto">${["admin","base","logistique","dg","hse"].map(k=>`<option value="${k}"${k===viewAs?" selected":""}>${k==="admin"?"Administration":"Écran : "+ROLES[k]}</option>`).join("")}</select>`;
    else if(me.role) h+=`<span class="role">${esc(ROLES[me.role])}</span>`;
    h+=`<button class="btn sm" data-act="logout">Déconnexion</button>`;
  }
  $("#who").innerHTML=h;
  const nav=$("#tabs"), r=role();
  if(!r||boot!=="ready"){nav.innerHTML="";return}
  const T=tabsFor(r);
  nav.innerHTML=T.length>1?T.map(([k,l,n])=>`<button role="tab" data-act="tab" data-k="${k}" aria-selected="${k===tab}">${l}${n?`<span class="n">${n}</span>`:""}</button>`).join(""):"";
}

/* ===== Connexion ===== */
function vLogin(){
  return `<form class="panel narrow" id="f-login" novalidate><div class="phead"><h2>Connexion</h2></div><div class="db">
   <div class="f"><label for="lg-id">Identifiant</label><input id="lg-id" class="bigin" autocomplete="username" autocapitalize="none" value="${esc(F.lgid||"")}" placeholder="ex. gloria"></div>
   <div class="f"><label for="lg-pw">Mot de passe</label><input id="lg-pw" class="bigin" type="password" autocomplete="current-password"></div>
   ${F.err?`<div class="err">${esc(F.err)}</div>`:""}
   <button class="send" type="submit" ${F.busy?"disabled":""}>${F.busy?"Connexion…":"Se connecter"}</button>
   <p class="sub">Votre identifiant vous a été remis par l'administrateur (par exemple : gloria). Mot de passe oublié : demandez-lui de le changer.</p>
   <p class="sub">Aucun compte administrateur encore ? <button type="button" class="btn sm" data-act="vers-setup">Premier démarrage</button></p></div></form>`;
}
function vSetup(){
  return `<form class="panel narrow" id="f-setup" novalidate><div class="phead"><h2>Premier démarrage</h2></div><div class="db">
   <p>Aucun administrateur n'existe encore. Créez le compte administrateur : il servira à créer les comptes du chef de base, de la logistique et du DG.</p>
   <div class="f"><label for="su-nom">Nom complet</label><input id="su-nom"></div>
   <div class="f"><label for="su-id">Identifiant</label><input id="su-id" autocapitalize="none" placeholder="ex. admin"></div>
   <div class="f"><label for="su-pw">Mot de passe (6 caractères minimum)</label><input id="su-pw" type="password" autocomplete="new-password"></div>
   ${F.err?`<div class="err">${esc(F.err)}</div>`:""}
   <button class="send" type="submit" ${F.busy?"disabled":""}>${F.busy?"Création…":"Créer l'administrateur"}</button>
   <div><button type="button" class="btn sm" data-act="vers-login">← Retour à la connexion</button></div></div></form>`;
}

/* ===== BASE ===== */
function vBase(){
  if(screen==="new") return baseNew();
  if(screen==="recv") return baseRecv();
  if(screen==="mount") return baseMount();
  if(screen==="panne") return basePanne();
  if(screen==="plein") return basePlein();
  if(screen==="controle") return baseControle();
  const attendues=S.attendues.length;
  const enStock=S.stock.filter(s=>s.qte>0).length;
  const mine=[...S.demandes].sort(newest).slice(0,25);
  return `<div class="base">
   <div class="bigs">
    <button class="big k" data-act="go" data-s="controle">${ICON.shield}<span><b>Contrôle avant départ</b><small>${(()=>{const n=new Set(S.controles.filter(c=>duJour(c.created_at)).map(c=>c.vehicule_id)).size,t=S.vehicules.filter(v=>v.statut!=="Hors parc").length;return n>=t?"Tous les camions sont contrôlés aujourd'hui":`${n} sur ${t} camions contrôlés aujourd'hui`})()}</small></span></button>
    <button class="big o" data-act="go" data-s="new">${ICON.plus}<span><b>Nouvelle demande</b><small>Le mécanicien a besoin d'une pièce</small></span></button>
    <button class="big b" data-act="go" data-s="recv">${ICON.box}<span><b>Réception livraison</b><small>${attendues?`${attendues} commande(s) attendue(s)`:"Aucune commande attendue"}</small></span></button>
    <button class="big g" data-act="go" data-s="mount">${ICON.wrench}<span><b>Pièce montée</b><small>${enStock?`${enStock} pièce(s) en stock à la base`:"Stock de la base vide"}</small></span></button>
    <button class="big y" data-act="go" data-s="plein">${ICON.fuel}<span><b>Plein de carburant</b><small>Noter les litres avec le ticket</small></span></button>
    <button class="big r" data-act="go" data-s="panne">${ICON.alert}<span><b>Déclarer une panne</b><small>${pannesOuvertes().length?`${pannesOuvertes().length} panne(s) en cours`:"Aucune panne en cours"}</small></span></button>
   </div>
   ${pannesOuvertes().length?`<h3>Pannes en cours</h3>${pannesOuvertes().map(panneCard).join("")}`:""}
   <h3>Demandes envoyées</h3>
   ${mine.length?mine.map(d=>`<div class="card">${thumb(d.photo,"Demande")}<div class="grow"><div class="row"><span class="ref">${esc(d.num)}</span>${chip("demande",d.statut)}${d.urgent?'<span class="chip bad">Urgent</span>':""}</div><div>${esc(d.piece||"Voir la photo")} × ${d.qte} · ${esc(vName(d.vehicule_id))}</div><div class="sub">${dt(d.created_at)}${d.motif?` · ${esc(d.motif)}`:""}</div></div></div>`).join(""):'<div class="empty">Aucune demande pour l\'instant. Appuyez sur « Nouvelle demande » pour commencer.</div>'}
  </div>`;
}
const vehTiles=sel=>{const vs=[...S.vehicules].filter(v=>v.statut!=="Hors parc").sort(vSort);return vs.length?`<div class="tiles">${vs.map(v=>`<button class="tile" data-act="pick" data-k="veh" data-v="${v.id}" aria-pressed="${sel===v.id}"><b>${esc(v.code)}</b><small>${esc(v.immat||v.type||"")}</small></button>`).join("")}</div>`:'<div class="empty">Aucun camion enregistré. La logistique doit d\'abord ajouter les camions.</div>'};
const photoBtn=(k,label)=>{const p=F[k];const busy=F[k+"_busy"];return `<label class="photo ${p?"done":""}" for="ph-${k}">${ICON.cam}<span>${busy?"Envoi de la photo…":p?"Photo enregistrée · reprendre":label}</span></label><input type="file" id="ph-${k}" data-photo="${k}" accept="image/*" capture="environment" hidden>${p&&urlCache[p]?`<img class="preview" src="${esc(urlCache[p])}" alt="Aperçu">`:""}`};
const stepper=k=>`<div class="stepper"><button type="button" data-act="qty" data-k="${k}" data-d="-1" aria-label="Moins">−</button><output>${F[k]}</output><button type="button" data-act="qty" data-k="${k}" data-d="1" aria-label="Plus">+</button></div>`;
function baseNew(){
  return `<div class="base"><button class="back" data-act="go" data-s="home">← Retour</button><h2>Nouvelle demande de pièce</h2>
   <div class="step"><i>1</i><span>Quel camion ?</span></div>${vehTiles(F.veh)}
   <div class="step"><i>2</i><span>Photo de la demande écrite <em>ou de la pièce usée</em></span></div>${photoBtn("photo","Prendre la photo")}
   <div class="step"><i>3</i><span>Quelle pièce ? <em>facultatif si la photo est claire</em></span></div><input class="bigin" data-f="piece" value="${esc(F.piece||"")}" placeholder="ex. filtre à gasoil">
   <div class="step"><i>4</i><span>Combien ?</span></div>${stepper("qte")}
   <div class="step"><i>5</i><span>Le camion est-il arrêté ?</span></div>
   <div class="two"><button class="tile" data-act="pick" data-k="urgent" data-v="0" aria-pressed="${!F.urgent}"><b>Non</b><small>Demande normale</small></button><button class="tile" data-act="pick" data-k="urgent" data-v="1" aria-pressed="${!!F.urgent}"><b>Oui</b><small>Urgent</small></button></div>
   ${F.err?`<div class="err">${esc(F.err)}</div>`:""}
   <button class="send" data-act="b-new-send" ${F.busy?"disabled":""}>${F.busy?"Envoi…":"Envoyer la demande"}</button></div>`;
}
function baseRecv(){
  const list=S.attendues;
  if(!F.bc) return `<div class="base"><button class="back" data-act="go" data-s="home">← Retour</button><h2>Réception d'une livraison</h2>
   <div class="step"><i>1</i><span>Quelle commande arrive ?</span></div>
   ${list.length?list.map(b=>`<button class="card cardbtn" data-act="pick" data-k="bc" data-v="${b.id}"><div class="grow"><div class="row"><span class="ref">${esc(b.num)}</span>${chip("bc",b.statut)}</div><div><b>${esc(b.fournisseur)}</b> · ${esc(vName(b.vehicule_id))}</div><div class="sub">${(b.lignes||[]).map(l=>`${esc(l.designation)} × ${l.qte}`).join(" · ")}</div></div></button>`).join(""):'<div class="empty">Aucune commande validée en attente de livraison. Une livraison sans bon de commande validé par le DG ne doit pas être acceptée.</div>'}</div>`;
  const b=list.find(x=>x.id===F.bc); if(!b){F.bc=null;return baseRecv()}
  return `<div class="base"><button class="back" data-act="pick" data-k="bc" data-v="">← Changer de commande</button><h2>${esc(b.num)} · ${esc(b.fournisseur)}</h2>
   <div class="step"><i>2</i><span>Combien de pièces sont arrivées ?</span></div>
   <div class="panel" style="padding:4px 14px">${(b.lignes||[]).map((l,i)=>{const reste=Math.max(0,l.qte-(l.recu||0));return `<div class="line"><div class="grow"><b>${esc(l.designation)}</b><div class="sub">Commandé ${l.qte}${l.recu?` · déjà reçu ${l.recu}`:""} · reste ${reste}</div></div>${stepper("r"+i)}</div>`}).join("")}</div>
   <div class="step"><i>3</i><span>Photo du bon de livraison</span></div>${photoBtn("bl","Photographier le bon de livraison")}
   <div class="step"><i>4</i><span>Numéro du bon de livraison <em>facultatif</em></span></div><input class="bigin" data-f="blnum" value="${esc(F.blnum||"")}" placeholder="ex. BL 2291">
   ${F.err?`<div class="err">${esc(F.err)}</div>`:""}
   <button class="send" data-act="b-recv-send" ${F.busy?"disabled":""}>${F.busy?"Enregistrement…":"Valider la réception"}</button></div>`;
}
function baseMount(){
  const items=S.stock.filter(s=>qteLieu(s,"Base")>0).sort((a,b)=>String(a.designation).localeCompare(b.designation,"fr"));
  if(!F.item) return `<div class="base"><button class="back" data-act="go" data-s="home">← Retour</button><h2>Pièce montée sur un camion</h2>
   <div class="step"><i>1</i><span>Quelle pièce sort du stock ?</span></div>
   ${items.length?`<div class="tiles">${items.map(s=>`<button class="tile" data-act="pick" data-k="item" data-v="${s.id}"><b style="font-size:15px">${esc(s.designation)}</b><small>${qteLieu(s,"Base")} à la base</small></button>`).join("")}</div>`:'<div class="empty">Aucune pièce en stock. Les pièces entrent dans le stock à la réception d\'une livraison.</div>'}</div>`;
  const s=byId("stock",F.item); if(!s){F.item=null;return baseMount()}
  return `<div class="base"><button class="back" data-act="pick" data-k="item" data-v="">← Changer de pièce</button><h2>${esc(s.designation)}</h2><div class="sub">${qteLieu(s,"Base")} à la base</div>
   <div class="step"><i>2</i><span>Sur quel camion ?</span></div>${vehTiles(F.veh)}
   <div class="step"><i>3</i><span>Combien ?</span></div>${stepper("qte")}
   ${(()=>{const autre=F.veh?S.demandes.find(d=>d.statut==="Reçue à la base"&&d.vehicule_id!==F.veh&&!S.demandes.some(x=>x.statut==="Reçue à la base"&&x.vehicule_id===F.veh)&&String(d.piece||"").toLowerCase()===String(s.designation).toLowerCase()):null;
     return autre?`<div class="banner">Cette pièce a été demandée pour ${esc(vName(autre.vehicule_id))} (${esc(autre.num)}). Si vous la montez sur un autre camion, dites pourquoi à l'étape 6.</div>`:""})()}
   <div class="step"><i>4</i><span>Photo de la pièce usée</span></div>${photoBtn("old","Photographier la pièce usée")}
   <div class="step"><i>5</i><span>La pièce usée est-elle rendue au magasin ?</span></div>
   <div class="two"><button class="tile" data-act="pick" data-k="rendue" data-v="1" aria-pressed="${F.rendue!=="0"}"><b>Oui</b><small>Rendue</small></button><button class="tile" data-act="pick" data-k="rendue" data-v="0" aria-pressed="${F.rendue==="0"}"><b>Non</b><small>Dire pourquoi</small></button></div>
   <div class="step"><i>6</i><span>Pourquoi ? <em>${F.rendue==="0"?"obligatoire":"seulement si la pièce n'est pas rendue ou change de camion"}</em></span></div><input class="bigin" data-f="motif" value="${esc(F.motif||"")}" placeholder="ex. pièce usée brûlée, camion plus urgent">
   <div class="step"><i>7</i><span>Kilométrage du camion <em>facultatif</em></span></div><input class="bigin" data-f="km" inputmode="numeric" value="${esc(F.km||"")}" placeholder="ex. 152300">
   ${F.err?`<div class="err">${esc(F.err)}</div>`:""}
   <button class="send" data-act="b-mount-send" ${F.busy?"disabled":""}>${F.busy?"Enregistrement…":"Valider la sortie"}</button></div>`;
}

/* ===== LOGISTIQUE : demandes ===== */
let fDem="Nouvelle";
function vDemandes(){
  const list=S.demandes.filter(d=>!fDem||d.statut===fDem).sort(newest);
  const opts=["","Nouvelle","En validation","Commandée","Reçue à la base","Montée","Refusée"];
  return `<div class="panel"><div class="phead"><h2 class="grow">Demandes de la base</h2><select id="f-dem" style="width:auto">${opts.map(o=>`<option value="${o}"${o===fDem?" selected":""}>${o||"Toutes"}</option>`).join("")}</select></div>
  ${list.length?`<div class="tbl"><table><thead><tr><th>N°</th><th>Date</th><th>Camion</th><th>Pièce</th><th class="num">Qté</th><th>Photo</th><th>Statut</th><th></th></tr></thead><tbody>${list.map(d=>{const c=d.commande_id?byId("commandes",d.commande_id):null;return `<tr><td class="ref">${esc(d.num)}${d.urgent?' <span class="chip bad">Urgent</span>':""}</td><td>${dt(d.created_at)}<div class="sub">${esc(who(d.created_by))}</div></td><td>${esc(vName(d.vehicule_id))}</td><td>${esc(d.piece||"Voir la photo")}${d.motif?`<div class="sub">${esc(d.motif)}</div>`:""}</td><td class="num">${d.qte}</td><td>${thumb(d.photo,"Demande")}</td><td>${chip("demande",d.statut)}${d.statut==="Nouvelle"?" "+attChip(d.created_at,d.urgent):""}${c?`<div class="sub">${esc(c.num)}</div>`:""}</td><td class="num">${d.statut==="Nouvelle"&&canDo("bc")?`<button class="btn sm primary" data-act="bc-new" data-id="${d.id}">Créer le bon de commande</button> <button class="btn sm" data-act="dem-refuse" data-id="${d.id}">Refuser</button>`:""}</td></tr>`}).join("")}</tbody></table></div>`:`<div class="empty">${fDem==="Nouvelle"?"Aucune nouvelle demande à traiter.":"Aucune demande."}</div>`}</div>`;
}

/* ===== Bons de commande ===== */
let fBc="";
function vCommandes(){
  const list=S.commandes.filter(b=>!fBc||b.statut===fBc).sort(newest);
  const opts=["","À valider","Validé","Refusé","Reçu partiel","Reçu","Facturé","Payé"];
  return `<div class="panel"><div class="phead"><h2 class="grow">Bons de commande</h2><select id="f-bc" style="width:auto">${opts.map(o=>`<option value="${o}"${o===fBc?" selected":""}>${o||"Tous"}</option>`).join("")}</select></div>
  ${list.length?`<div class="tbl"><table><thead><tr><th>N°</th><th>Date</th><th>Fournisseur</th><th>Camion</th><th class="num">Total</th><th>Statut</th><th>Réception</th><th>Facture</th></tr></thead><tbody>${list.map(b=>{const f=S.factures.find(x=>x.commande_id===b.id);const nr=S.receptions.filter(r=>r.commande_id===b.id).length;return `<tr class="click" data-act="bc-open" data-id="${b.id}"><td class="ref">${esc(b.num)}</td><td>${dt(b.created_at)}</td><td>${esc(b.fournisseur)}</td><td>${esc(vName(b.vehicule_id))}</td><td class="num">${xaf(b.total)}</td><td>${chip("bc",b.statut)}${b.statut==="À valider"?" "+attChip(b.created_at,urgentBc(b)):["Validé","Reçu partiel"].includes(b.statut)?" "+attChip(b.valide_le||b.created_at,urgentBc(b),true):""}</td><td>${nr?`${nr} bon(s)`:'<span class="sub">—</span>'}</td><td>${f?chip("facture",f.statut):'<span class="sub">—</span>'}</td></tr>`}).join("")}</tbody></table></div>`:'<div class="empty">Aucun bon de commande.</div>'}</div>`;
}

/* ===== Factures ===== */
function vFactures(){
  const r=role();
  const list=[...S.factures].sort((a,b)=>{const o={"Bloquée":0,"Conforme":1,"Payée":2};return (o[a.statut]-o[b.statut])||newest(a,b)});
  const bcNum=id=>{const c=byId("commandes",id);return c?c.num:""};
  return `<div class="stack">
  ${r==="dg"?'<p class="sub">Seules les factures « Conforme » peuvent être payées : bon de commande validé par vous, livraison reçue à la base et montant identique.</p>':""}
  <div class="panel"><div class="phead"><h2 class="grow">Factures fournisseurs</h2>${canDo("facture")?'<button class="btn primary" data-act="fac-new">Enregistrer une facture</button>':""}</div>
  ${list.length?`<div class="tbl"><table><thead><tr><th>Facture</th><th>Fournisseur</th><th>Bon de commande</th><th class="num">Montant</th><th>Contrôle</th><th>Fichier</th><th></th></tr></thead><tbody>${list.map(f=>`<tr><td><span class="ref">${esc(f.numero)}</span><div class="sub">${f.date_facture?dt(f.date_facture):""}</div></td><td>${esc(f.fournisseur)}</td><td class="ref">${esc(bcNum(f.commande_id))}</td><td class="num">${xaf(f.montant)}</td><td>${chip("facture",f.statut)}${f.statut==="Bloquée"?`<ul class="checks">${(f.motifs||[]).map(m=>`<li>${esc(m)}</li>`).join("")}</ul>`:""}${f.statut==="Payée"?`<div class="sub">Payée le ${dt(f.paye_le)}${f.paye_ref?" · "+esc(f.paye_ref):""}</div>`:""}</td><td>${thumb(f.fichier,"Facture")}</td><td class="num">${f.statut==="Bloquée"&&canDo("recheck")?`<button class="btn sm" data-act="fac-recheck" data-id="${f.id}">Recontrôler</button>`:""}${f.statut==="Conforme"&&canDo("payer")?`<button class="btn sm ok" data-act="fac-pay" data-id="${f.id}">Marquer payée</button>`:""}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty">Aucune facture enregistrée.</div>'}</div></div>`;
}

/* ===== Stock : lieux, minimum, envois, inventaires ===== */
const enRoute=sid=>S.transferts.filter(t=>t.stock_id===sid&&t.statut==="En route").reduce((s,t)=>s+t.qte,0);
function qteLieu(s,lieu){
  if(lieu==="Base") return s.qte-S.stock_sites.filter(x=>x.stock_id===s.id).reduce((a,x)=>a+x.qte,0)-enRoute(s.id);
  const x=S.stock_sites.find(y=>y.stock_id===s.id&&y.site===lieu);return x?x.qte:0;
}
const lieux=()=>S.sites.length?[...S.sites].sort((a,b)=>a.ordre-b.ordre).map(x=>x.nom):["Base"];
const niveau=s=>s.seuil_min>0&&s.qte<=0?"bad":s.seuil_min>0&&s.qte<=s.seuil_min?"warn":s.qte<=0?"off":"ok";
const aCommander=s=>Math.max(0,s.seuil_min*2-s.qte);
let fFam="";
function vStock(){
  const L=lieux();
  const fams=[...new Set(S.stock.map(s=>s.famille).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"fr"));
  const ordre={bad:0,warn:1,ok:2,off:3};
  const items=S.stock.filter(s=>!fFam||s.famille===fFam).sort((a,b)=>ordre[niveau(a)]-ordre[niveau(b)]||String(a.designation).localeCompare(b.designation,"fr"));
  const ruptures=S.stock.filter(s=>["bad","warn"].includes(niveau(s)));
  const route=S.transferts.filter(t=>t.statut==="En route").sort((a,b)=>ts(a.envoye_le)-ts(b.envoye_le));
  const mv=[...S.mouvements].sort(newest).slice(0,150);
  const inv=[...S.inventaires].sort(newest).slice(0,10);
  const gere=canDo("veh");
  return `<div class="stack">
   <div class="row"><h2 class="grow">Stock</h2>${gere?'<button class="btn" data-act="art-new">Ajouter une pièce</button>':""}${canDo("stockop")?'<button class="btn" data-act="tr-new">Envoyer vers un autre lieu</button><button class="btn primary" data-act="inv-new">Faire l\'inventaire</button>':""}</div>
   <div class="kpis">
    <div class="kpi"><span>Pièces différentes</span><b>${S.stock.length}</b><em>${fmt(S.stock.reduce((a,s)=>a+s.qte,0))} pièces au total</em></div>
    <div class="kpi${ruptures.length?" k-warn":" k-ok"}"><span>Sous le minimum</span><b>${ruptures.length}</b><em>${ruptures.length?"à commander":"tout va bien"}</em></div>
    <div class="kpi${route.length?" k-warn":""}"><span>Envois en route</span><b>${route.length}</b><em>à confirmer à l'arrivée</em></div>
    <div class="kpi"><span>Dernier inventaire</span><b style="font-size:20px">${inv[0]?dt(inv[0].created_at):"jamais"}</b><em>${inv[0]?esc(inv[0].site)+" · "+inv[0].ecarts+" écart(s)":"à faire chaque mois"}</em></div>
   </div>
   ${ruptures.length&&gere?`<div class="panel"><div class="phead"><h2 class="grow">Commande suggérée</h2><span class="sub">Pour revenir à 2 fois le minimum</span></div><div class="db"><div class="hist">${ruptures.map(s=>`<div><b>${esc(s.designation)}</b> : commander ${aCommander(s)} (reste ${s.qte}, minimum ${s.seuil_min})</div>`).join("")}</div></div></div>`:""}
   ${route.length?`<div class="panel"><div class="phead"><h2 class="grow">Envois en route</h2></div><div class="db">${route.map(t=>`<div class="card"><div class="grow"><div class="row"><span class="ref">${esc(t.num)}</span>${attChip(t.envoye_le)}</div><div><b>${t.qte} × ${esc(designation(t.stock_id))}</b> · ${esc(t.de_site)} → ${esc(t.vers_site)}</div><div class="sub">Envoyé par ${esc(who(t.envoye_par))} le ${dtt(t.envoye_le)}</div></div>${canDo("stockop")&&t.envoye_par!==me.id?`<button class="btn ok" data-act="tr-recu" data-id="${t.id}">Bien reçu</button>`:'<span class="sub">À confirmer par la personne qui reçoit</span>'}</div>`).join("")}</div></div>`:""}
   ${fams.length?`<div class="chips-f"><button class="chip ${!fFam?"blue":""}" data-act="fam" data-k="">Toutes</button>${fams.map(f=>`<button class="chip ${fFam===f?"blue":""}" data-act="fam" data-k="${esc(f)}">${esc(f)}</button>`).join("")}</div>`:""}
   ${items.length?`<div class="vtiles">${items.map(s=>{const n=niveau(s);return `<${gere?"button":"div"} class="vtile t-${n}"${gere?` data-act="art-edit" data-id="${s.id}"`:""}><span class="vt-top"><b style="font-size:16px">${esc(s.designation)}</b><span class="chip ${n==="off"?"":n}">${s.qte}</span></span>
     <span class="vt-l sub">${esc(s.famille||"Sans famille")}${s.rayon?" · rayon "+esc(s.rayon):""}${s.seuil_min?" · minimum "+s.seuil_min:""}</span>
     <span class="vt-l">${L.map(l=>{const q=qteLieu(s,l);return q?`${esc(l)} : <b>${q}</b>`:""}).filter(Boolean).join(" · ")||'<span class="sub">Aucune pièce</span>'}${enRoute(s.id)?` · en route : <b>${enRoute(s.id)}</b>`:""}</span>
     ${n==="bad"?'<span class="vt-alert">Rupture : à commander</span>':n==="warn"?`<span class="vt-alert w">Bas : commander ${aCommander(s)}</span>`:""}</${gere?"button":"div"}>`}).join("")}</div>`:'<div class="empty panel">Le stock se remplit à chaque réception de livraison. Vous pouvez aussi ajouter une pièce à l\'avance pour fixer son minimum.</div>'}
   ${inv.length?`<div class="panel"><div class="phead"><h2 class="grow">Inventaires</h2></div><div class="tbl"><table><thead><tr><th>N°</th><th>Date</th><th>Lieu</th><th class="num">Pièces comptées</th><th class="num">Écarts</th><th>Explication</th><th>Par</th></tr></thead><tbody>${inv.map(i=>`<tr><td class="ref">${esc(i.num)}</td><td>${dt(i.created_at)}</td><td>${esc(i.site)}</td><td class="num">${(i.lignes||[]).length}</td><td class="num">${i.ecarts?`<span class="chip warn">${i.ecarts}</span>`:'<span class="chip ok">0</span>'}</td><td>${esc(i.note)}</td><td>${esc(who(i.created_by))}</td></tr>`).join("")}</tbody></table></div></div>`:""}
   <div class="panel"><div class="phead"><h2 class="grow">Mouvements</h2><span class="sub">Chaque entrée et sortie, avec la personne et la photo</span></div>
   ${mv.length?`<div class="tbl"><table><thead><tr><th>Date</th><th>Mouvement</th><th>Pièce</th><th class="num">Qté</th><th>Camion</th><th>Lieu</th><th>Pièce usée</th><th>Par</th><th>Photo</th></tr></thead><tbody>${mv.map(m=>`<tr><td>${dtt(m.created_at)}</td><td>${m.type==="entree"?'<span class="chip ok">Entrée</span>':'<span class="chip orange">Sortie</span>'}</td><td>${esc(designation(m.stock_id))}<div class="sub">${esc(m.ref||"")}</div></td><td class="num">${m.type==="entree"?"+":"−"}${m.qte}</td><td>${m.vehicule_id?esc(vName(m.vehicule_id)):""}${m.km?`<div class="sub">${fmt(m.km)} km</div>`:""}</td><td>${esc(m.site||"Base")}</td><td>${m.type==="sortie"?(m.ancienne_rendue===false?`<span class="chip bad">Non rendue</span><div class="sub">${esc(m.motif)}</div>`:'<span class="chip ok">Rendue</span>'+(m.motif?`<div class="sub">${esc(m.motif)}</div>`:"")):""}</td><td>${esc(who(m.created_by))}</td><td>${thumb(m.photo,"Photo")}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty">Aucun mouvement.</div>'}</div></div>`;
}

/* ===== Fournisseurs ===== */
function statsFournisseurs(){
  const noms=new Map();
  S.fournisseurs.forEach(f=>noms.set(f.nom.toLowerCase(),{nom:f.nom,fiche:f}));
  S.commandes.forEach(b=>{const k=String(b.fournisseur||"").toLowerCase();if(k&&!noms.has(k))noms.set(k,{nom:b.fournisseur,fiche:null})});
  return [...noms.values()].map(x=>{
    const bcs=S.commandes.filter(b=>String(b.fournisseur).toLowerCase()===x.nom.toLowerCase());
    const fac=S.factures.filter(f=>String(f.fournisseur).toLowerCase()===x.nom.toLowerCase());
    const dette=fac.filter(f=>f.statut!=="Payée").reduce((s,f)=>s+(+f.montant||0),0);
    const paye=fac.filter(f=>f.statut==="Payée").reduce((s,f)=>s+(+f.montant||0),0);
    const delais=bcs.map(b=>{const r=S.receptions.filter(r=>r.commande_id===b.id).sort((a,c)=>ts(a.created_at)-ts(c.created_at))[0];return r&&b.valide_le?(ts(r.created_at)-ts(b.valide_le))/JOUR:null}).filter(d=>d!=null&&d>=0);
    return {...x,bcs,dette,paye,engage:bcs.filter(engage).reduce((s,b)=>s+(+b.total||0),0),delai:delais.length?delais.reduce((a,b)=>a+b,0)/delais.length:null,bloquees:fac.filter(f=>f.statut==="Bloquée").length};
  }).sort((a,b)=>b.dette-a.dette||b.engage-a.engage);
}
function vFournisseurs(){
  const st=statsFournisseurs();
  const dette=st.reduce((s,f)=>s+f.dette,0);
  return `<div class="stack">
   <div class="row"><h2 class="grow">Fournisseurs</h2>${canDo("veh")?'<button class="btn primary" data-act="four-edit" data-k="">Ajouter un fournisseur</button>':""}</div>
   <div class="kpis">
    <div class="kpi${dette?" k-warn":" k-ok"}"><span>Nos dettes fournisseurs</span><b>${fmt(dette)} <small>XAF</small></b><em>factures reçues pas encore payées</em></div>
    <div class="kpi"><span>Fournisseurs</span><b>${st.length}</b><em>${st.filter(f=>f.dette).length} à qui nous devons</em></div>
    <div class="kpi"><span>Payé au total</span><b>${fmt(st.reduce((s,f)=>s+f.paye,0))} <small>XAF</small></b><em>toutes factures payées</em></div>
   </div>
   ${dette?`<div class="panel"><div class="phead"><h2 class="grow">À qui nous devons</h2></div><div class="db">${barres(st.filter(f=>f.dette).map(f=>[f.nom,f.dette]),xaf)}</div></div>`:""}
   ${st.length?`<div class="vtiles">${st.map(f=>`<button class="vtile t-${f.bloquees?"bad":f.dette?"warn":"ok"}" data-act="four-voir" data-k="${esc(f.nom)}"><span class="vt-top"><b style="font-size:17px">${esc(f.nom)}</b>${f.dette?`<span class="chip warn">doit ${xaf(f.dette)}</span>`:""}</span>
    <span class="vt-l">${f.bcs.length} bon(s) · ${xaf(f.engage)} commandés</span>
    <span class="vt-l sub">${f.delai!=null?"livre en "+jours(f.delai)+" en moyenne":"délai pas encore connu"}${f.fiche&&f.fiche.telephone?" · ☎ "+esc(f.fiche.telephone):""}</span>
    ${f.bloquees?`<span class="vt-alert">${f.bloquees} facture(s) bloquée(s)</span>`:""}</button>`).join("")}</div>`:'<div class="empty panel">Les fournisseurs apparaissent ici dès le premier bon de commande. Vous pouvez aussi les ajouter à l\'avance.</div>'}</div>`;
}

/* ===== Camions : liste, fiche, pannes, entretien ===== */
let fiche=null;
const JOUR=864e5;
const C_PANNE={"Déclarée":"orange","En réparation":"blue","Réparée":"ok"};
const chipPanne=s=>`<span class="chip ${C_PANNE[s]||""}">${esc(s)}</span>`;
const pannesOuvertes=vid=>S.pannes.filter(p=>p.statut!=="Réparée"&&(!vid||p.vehicule_id===vid)).sort((a,b)=>ts(a.created_at)-ts(b.created_at));
const joursArret=p=>Math.max(0,((p.reparee_le?ts(p.reparee_le):Date.now())-ts(p.created_at))/JOUR);
const jours=n=>n<1?Math.max(1,Math.round(n*24))+" h":(Math.round(n*10)/10).toLocaleString("fr-FR")+" jour"+(n>=2?"s":"");
function panneCard(p){
  return `<div class="card">${thumb(p.photo,"Panne")}<div class="grow"><div class="row"><span class="ref">${esc(p.num)}</span>${chipPanne(p.statut)}${p.statut!=="Réparée"?attChip(p.created_at,true):""}</div>
   <div><b>${esc(vName(p.vehicule_id))}</b> · ${esc(p.description)}</div>
   <div class="sub">Déclarée le ${dtt(p.created_at)} par ${esc(who(p.created_by))}${p.km?` · ${fmt(p.km)} km`:""}${p.reparation?` · Réparation : ${esc(p.reparation)}`:""}${p.statut==="Réparée"?` · arrêt de ${jours(joursArret(p))}`:""}</div>
   ${p.statut!=="Réparée"&&canDo("panne")?`<div class="row" style="margin-top:6px">${p.statut==="Déclarée"?`<button class="btn sm" data-act="panne-step" data-id="${p.id}" data-s="En réparation">En réparation</button>`:""}<button class="btn sm ok" data-act="panne-step" data-id="${p.id}" data-s="Réparée">Réparée</button></div>`:""}</div></div>`;
}
// Entretien : vert, orange (bientôt : 1 000 km ou 14 jours), rouge (en retard).
function entEtat(e){
  const v=veh(e.vehicule_id)||{};
  const km=e.tous_km&&e.dernier_km!=null&&v.km!=null?e.dernier_km+e.tous_km-v.km:null;
  const j=e.tous_jours&&e.dernier_le?Math.round((ts(e.dernier_le)+e.tous_jours*JOUR-Date.now())/JOUR):null;
  const bad=(km!=null&&km<=0)||(j!=null&&j<=0), warn=(km!=null&&km<=1000)||(j!=null&&j<=14);
  const t=[];
  if(km!=null) t.push(km<=0?`en retard de ${fmt(-km)} km`:`dans ${fmt(km)} km`);
  if(j!=null) t.push(j<=0?`en retard de ${-j} jour(s)`:`dans ${j} jour(s)`);
  if(!t.length) t.push("à compléter : dernier entretien inconnu");
  return {c:bad?"bad":warn?"warn":"ok",t:t.join(" ou ")};
}
const entretiensAFaire=()=>S.entretiens.filter(e=>entEtat(e).c!=="ok");
function coutCamion(vid){return S.commandes.filter(b=>engage(b)&&b.vehicule_id===vid).reduce((s,b)=>s+(+b.total||0),0)}

function vCamions(){
  if(fiche) return vFiche();
  const vs=[...S.vehicules].sort(vSort);
  const direction=role()!=="base";
  return `<div class="stack"><div class="panel"><div class="phead"><h2 class="grow">Camions</h2>${canDo("km")?'<button class="btn primary" data-act="km-releve">Relever les kilomètres (WhatsGPS)</button>':""}${canDo("veh")?'<button class="btn" data-act="veh-edit" data-id="">Ajouter un camion</button>':""}${canDo("veh")?'<button class="btn" data-act="qr-tous">Imprimer les QR</button>':""}</div>
  ${vs.length?`<div class="db"><div class="vtiles">${vs.map(v=>{const po=pannesOuvertes(v.id);const en=S.entretiens.filter(e=>e.vehicule_id===v.id).map(e=>({e,x:entEtat(e)})).sort((a,b)=>({bad:0,warn:1,ok:2}[a.x.c]-{bad:0,warn:1,ok:2}[b.x.c]))[0];
    const etat=v.statut==="En panne"?"bad":v.statut==="Hors parc"?"off":en&&en.x.c!=="ok"?"warn":"ok";
    return `<button class="vtile t-${etat}" data-act="fiche" data-id="${v.id}"><span class="vt-top"><b>${esc(v.code)}</b><span class="chip ${v.statut==="En panne"?"bad":v.statut==="Hors parc"?"":"ok"}">${esc(v.statut)}</span></span>
     <span class="vt-l">${esc(v.immat||v.type||"")}</span><span class="vt-l">${v.chauffeur?"👤 "+esc(v.chauffeur):'<span class="sub">Pas de chauffeur</span>'}</span>
     <span class="vt-l">${v.km?fmt(v.km)+" km":'<span class="sub">Km inconnu</span>'}</span>
     ${po.length?`<span class="vt-alert">${esc(po[0].description)} · ${depuis(po[0].created_at)}</span>`:en&&en.x.c!=="ok"?`<span class="vt-alert w">${esc(en.e.type)} ${esc(en.x.t)}</span>`:""}
     ${direction&&coutCamion(v.id)?`<span class="vt-cost">${xaf(coutCamion(v.id))} de pièces</span>`:""}</button>`}).join("")}</div></div>`:'<div class="empty">Aucun camion.</div>'}</div>
  <p class="sub">Appuyez sur un camion pour ouvrir sa fiche. Collez le QR du camion dans la cabine : en le scannant, on arrive directement sur sa fiche.</p></div>`;
}

function vFiche(){
  const v=veh(fiche); if(!v){fiche=null;return vCamions()}
  const direction=role()!=="base";
  const pannes=S.pannes.filter(p=>p.vehicule_id===v.id).sort(newest);
  const arret=pannes.reduce((s,p)=>s+joursArret(p),0);
  const ents=S.entretiens.filter(e=>e.vehicule_id===v.id).sort((a,b)=>String(a.type).localeCompare(b.type,"fr"));
  const faits=S.entretiens_faits.filter(f=>ents.some(e=>e.id===f.entretien_id)).sort(newest);
  const pieces=S.mouvements.filter(m=>m.type==="sortie"&&m.vehicule_id===v.id).sort(newest);
  const bcs=S.commandes.filter(b=>b.vehicule_id===v.id).sort(newest);
  const aff=S.affectations.filter(a=>a.vehicule_id===v.id).sort((a,b)=>ts(b.debut)-ts(a.debut));
  const dem=S.demandes.filter(d=>d.vehicule_id===v.id&&!["Montée","Refusée"].includes(d.statut));
  const tbl=(head,rows,vide)=>rows.length?`<div class="tbl"><table><thead><tr>${head.map(h=>`<th${h.startsWith("#")?' class="num"':""}>${esc(h.replace(/^#/,""))}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`:`<div class="empty">${vide}</div>`;
  const info=[["Immatriculation",v.immat],["Type",v.type],["Marque",v.marque],["Année",v.annee],["Chauffeur",v.chauffeur],["Kilométrage",v.km?fmt(v.km)+" km"+(v.km_le?" (le "+dt(v.km_le)+")":""):""]];
  return `<div class="stack"><button class="back" data-act="fiche" data-id="">← Tous les camions</button>
   <div class="panel"><div class="phead"><h2 class="grow">${esc(v.code)} <span class="chip ${v.statut==="En panne"?"bad":v.statut==="Hors parc"?"":"ok"}">${esc(v.statut)}</span></h2>
    ${canDo("panne")?`<button class="btn bad" data-act="panne-new" data-id="${v.id}">Déclarer une panne</button>`:""}
    ${role()==="base"?`<button class="btn" data-act="dem-camion" data-id="${v.id}">Demander une pièce</button>`:""}
    <button class="btn" data-act="qr" data-id="${v.id}">QR du camion</button></div>
    <div class="db"><div class="infos">${info.map(([k,x])=>`<div><span>${k}</span><b>${x?esc(x):'<span class="sub">—</span>'}</b></div>`).join("")}</div>
    ${v.notes?`<p class="sub">${esc(v.notes)}</p>`:""}
    ${canDo("veh")?`<div class="row"><button class="btn sm" data-act="fiche-edit" data-id="${v.id}">Modifier la fiche</button><button class="btn sm" data-act="chauffeur" data-id="${v.id}">Changer de chauffeur</button><button class="btn sm" data-act="veh-edit" data-id="${v.id}">Code, immatriculation, statut</button></div>`:""}</div></div>
   <div class="kpis">
    <div class="kpi${pannes.some(p=>p.statut!=="Réparée")?" k-bad":""}"><span>Pannes</span><b>${pannes.length}</b><em>${pannes.filter(p=>p.statut!=="Réparée").length} en cours</em></div>
    <div class="kpi"><span>Jours d'arrêt</span><b>${(Math.round(arret*10)/10).toLocaleString("fr-FR")}</b><em>toutes pannes confondues</em></div>
    <div class="kpi"><span>Pièces montées</span><b>${pieces.reduce((s,m)=>s+m.qte,0)}</b><em>${dem.length} demande(s) en cours</em></div>
    ${direction?`<div class="kpi"><span>Coût des pièces</span><b>${fmt(coutCamion(v.id))} <small>XAF</small></b><em>bons de commande engagés</em></div>`:""}
   </div>
   <div class="panel"><div class="phead"><h2 class="grow">Pannes</h2></div>${pannes.length?`<div class="db">${pannes.map(panneCard).join("")}</div>`:'<div class="empty">Aucune panne déclarée.</div>'}</div>
   <div class="panel"><div class="phead"><h2 class="grow">Entretien</h2>${canDo("veh")?`<button class="btn sm primary" data-act="ent-new" data-id="${v.id}">Programmer un entretien</button>`:""}</div>
    ${tbl(["Entretien","Tous les","Dernier","Prochain",""],ents.map(e=>{const x=entEtat(e);return `<tr><td><b>${esc(e.type)}</b></td><td>${[e.tous_km?fmt(e.tous_km)+" km":"",e.tous_jours?e.tous_jours+" jours":""].filter(Boolean).join(" ou ")}</td><td>${[e.dernier_km!=null?fmt(e.dernier_km)+" km":"",e.dernier_le?dt(e.dernier_le):""].filter(Boolean).join(" · ")||"—"}</td><td><span class="chip ${x.c}">${esc(x.t)}</span></td><td class="num">${canDo("panne")||canDo("veh")?`<button class="btn sm ok" data-act="ent-fait" data-id="${e.id}">C'est fait</button>`:""}</td></tr>`}),"Aucun entretien programmé. Exemple : vidange tous les 10 000 km ou 6 mois.")}
    ${faits.length?`<div class="db"><div class="hist">${faits.slice(0,10).map(f=>{const e=S.entretiens.find(x=>x.id===f.entretien_id);return `<div>${dt(f.fait_le)} · ${esc(e?e.type:"")}${f.km?" · "+fmt(f.km)+" km":""} · ${esc(who(f.created_by))}${f.note?" · "+esc(f.note):""}</div>`}).join("")}</div></div>`:""}</div>
   <div class="panel"><div class="phead"><h2 class="grow">Papiers</h2>${canDo("papier")?`<button class="btn sm primary" data-act="papier-new" data-v="${v.id}">Ajouter un papier</button>`:""}</div>${tbl(["Papier","N°","Fin","État","Fichier"],papiersActuels().filter(p=>p.vehicule_id===v.id).sort((a,b)=>ts(a.date_fin)-ts(b.date_fin)).map(p=>{const e=papierEtat(p);return `<tr><td><b>${esc(p.type)}</b></td><td>${esc(p.numero)}</td><td>${dt(p.date_fin)}</td><td><span class="chip ${e.c}">${esc(e.t)}</span></td><td>${thumb(p.fichier,p.type)}</td></tr>`}),"Aucun papier enregistré pour ce camion.")}</div>
   <div class="panel"><div class="phead"><h2 class="grow">Carburant</h2><span class="sub">${fmt(conso4j(v.id))} L ces 4 derniers jours (limite ${LIMITE_4J} L)</span></div>${tbl(["Date","#Litres","#Prix/L","#Montant","#Km","Ticket"],S.carburant.filter(c=>c.vehicule_id===v.id).sort((a,b)=>ts(b.fait_le)-ts(a.fait_le)).slice(0,15).map(c=>`<tr><td>${dt(c.fait_le)}</td><td class="num">${fmt(c.litres)}</td><td class="num">${fmt(c.prix_litre)}</td><td class="num">${xaf(c.montant)}</td><td class="num">${c.km?fmt(c.km):""}</td><td>${thumb(c.photo,"Ticket")}</td></tr>`),"Aucun plein noté.")}</div>
   <div class="panel"><div class="phead"><h2 class="grow">Pièces montées</h2></div>${tbl(["Date","Pièce","#Qté","Km","Par","Photo"],pieces.map(m=>`<tr><td>${dt(m.created_at)}</td><td>${esc(designation(m.stock_id))}${m.motif?`<div class="sub">${esc(m.motif)}</div>`:""}</td><td class="num">${m.qte}</td><td>${m.km?fmt(m.km):""}</td><td>${esc(who(m.created_by))}</td><td>${thumb(m.photo,"Pièce usée")}</td></tr>`),"Aucune pièce montée sur ce camion.")}</div>
   ${direction?`<div class="panel"><div class="phead"><h2 class="grow">Bons de commande</h2></div>${tbl(["N°","Date","Fournisseur","#Montant","Statut"],bcs.map(b=>`<tr class="click" data-act="bc-open" data-id="${b.id}"><td class="ref">${esc(b.num)}</td><td>${dt(b.created_at)}</td><td>${esc(b.fournisseur)}</td><td class="num">${xaf(b.total)}</td><td>${chip("bc",b.statut)}</td></tr>`),"Aucun bon de commande pour ce camion.")}</div>`:""}
   <div class="panel"><div class="phead"><h2 class="grow">Chauffeurs successifs</h2></div>${tbl(["Chauffeur","Du","Au","Motif"],aff.map(a=>`<tr><td><b>${esc(a.chauffeur)}</b></td><td>${dt(a.debut)}</td><td>${a.fin?dt(a.fin):'<span class="chip ok">Actuel</span>'}</td><td>${esc(a.motif)}</td></tr>`),"Aucun chauffeur enregistré.")}</div>
  </div>`;
}

function basePanne(){
  return `<div class="base"><button class="back" data-act="go" data-s="home">← Retour</button><h2>Déclarer une panne</h2>
   <div class="step"><i>1</i><span>Quel camion ?</span></div>${vehTiles(F.veh)}
   <div class="step"><i>2</i><span>Photo de la panne</span></div>${photoBtn("photo","Prendre la photo")}
   <div class="step"><i>3</i><span>Qu'est-ce qui ne va pas ?</span></div><input class="bigin" data-f="desc" value="${esc(F.desc||"")}" placeholder="ex. fuite d'huile sous le moteur">
   <div class="step"><i>4</i><span>Kilométrage <em>facultatif</em></span></div><input class="bigin" data-f="km" inputmode="numeric" value="${esc(F.km||"")}" placeholder="ex. 152300">
   ${F.err?`<div class="err">${esc(F.err)}</div>`:""}
   <button class="send" data-act="b-panne-send" ${F.busy?"disabled":""}>${F.busy?"Envoi…":"Déclarer la panne"}</button></div>`;
}

// QR : bibliothèque chargée seulement quand on en a besoin.
let qrLib=null;
function chargerQR(){if(window.qrcode) return Promise.resolve();if(qrLib) return qrLib;
  qrLib=new Promise((ok,ko)=>{const s=document.createElement("script");s.src="assets/qrcode.js";s.onload=ok;s.onerror=()=>{qrLib=null;ko(new Error("Le QR n'a pas pu être préparé. Vérifiez la connexion."))};document.head.appendChild(s)});return qrLib}
const lienCamion=v=>location.origin+location.pathname+"#camion="+encodeURIComponent(v.code);
function qrSvg(texte,taille){const q=window.qrcode(0,"M");q.addData(texte);q.make();return q.createSvgTag({cellSize:Math.max(2,Math.round(taille/(q.getModuleCount()+8))),margin:4,scalable:true})}
function imprimerQR(vs){
  const w=window.open("","_blank");if(!w){toast("Autorisez l'ouverture de fenêtres pour imprimer.");return}
  w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>QR des camions STP2i</title><style>body{font-family:Arial,sans-serif;margin:0}.p{display:grid;grid-template-columns:repeat(2,1fr);gap:10mm;padding:10mm}.q{border:1px solid #999;border-radius:4mm;padding:6mm;text-align:center;break-inside:avoid}.q svg{width:60mm;height:60mm}.c{font-size:28pt;font-weight:bold;margin-top:2mm}.s{font-size:10pt;color:#444}</style></head><body><div class="p">${vs.map(v=>`<div class="q">${qrSvg(lienCamion(v),240)}<div class="c">${esc(v.code)}</div><div class="s">${esc(v.immat||"")} · STP2i · scanner pour ouvrir la fiche</div></div>`).join("")}</div><script>setTimeout(()=>print(),300)<\/script></body></html>`);
  w.document.close();
}

/* ===== Carburant ===== */
const LIMITE_4J=210; // litres par camion tous les 4 jours (contrat)
const conso4j=vid=>S.carburant.filter(c=>c.vehicule_id===vid&&ts(c.fait_le)>=Date.now()-4*JOUR).reduce((s,c)=>s+(+c.litres||0),0);
const dernierPrix=()=>{const c=[...S.carburant].sort(newest)[0];return c?+c.prix_litre:""};
function vCarburant(){
  const m0=debutMois(), mois=S.carburant.filter(c=>ts(c.fait_le)>=m0);
  const L=mois.reduce((s,c)=>s+(+c.litres||0),0), M=mois.reduce((s,c)=>s+(+c.montant||0),0);
  const vs=[...S.vehicules].filter(v=>v.statut!=="Hors parc").sort(vSort);
  const trop=vs.filter(v=>conso4j(v.id)>LIMITE_4J);
  const list=[...S.carburant].sort((a,b)=>ts(b.fait_le)-ts(a.fait_le)||newest(a,b)).slice(0,200);
  const parMois=[];for(let k=-5;k<=0;k++){const a=debutMois(k),b=debutMois(k+1);parMois.push([new Date(a).toLocaleDateString("fr-FR",{month:"short",year:"2-digit"}),S.carburant.filter(c=>ts(c.fait_le)>=a&&ts(c.fait_le)<b).reduce((s,c)=>s+(+c.litres||0),0)])}
  return `<div class="stack">
   <div class="row"><h2 class="grow">Carburant</h2>${canDo("plein")?'<button class="btn primary" data-act="plein-new">Noter un plein</button>':""}</div>
   <div class="kpis">
    <div class="kpi"><span>Litres ce mois</span><b>${fmt(L)} <small>L</small></b><em>${mois.length} plein(s)</em></div>
    <div class="kpi"><span>Coût ce mois</span><b>${fmt(M)} <small>XAF</small></b><em>prix moyen ${L?fmt(M/L):"—"} XAF/L</em></div>
    <div class="kpi${trop.length?" k-bad":" k-ok"}"><span>Au-dessus de ${LIMITE_4J} L / 4 jours</span><b>${trop.length}</b><em>${trop.length?trop.map(v=>v.code).join(", "):"aucun camion"}</em></div>
   </div>
   <div class="panel"><div class="phead"><h2 class="grow">Les 4 derniers jours, par camion</h2><span class="sub">Limite : ${LIMITE_4J} L</span></div><div class="db"><div class="vtiles">${vs.map(v=>{const l=conso4j(v.id);const c=l>LIMITE_4J?"bad":l>LIMITE_4J*0.9?"warn":"ok";
     return `<button class="vtile t-${c}" data-act="voir-camion" data-id="${v.id}"><span class="vt-top"><b>${esc(v.code)}</b><span class="chip ${c}">${fmt(l)} L</span></span><span class="jauge"><i class="${c}" style="width:${Math.min(100,Math.round(l/LIMITE_4J*100))}%"></i></span><span class="vt-l sub">${l>LIMITE_4J?`${fmt(l-LIMITE_4J)} L de trop : à vérifier`:`reste ${fmt(LIMITE_4J-l)} L`}</span></button>`}).join("")}</div></div></div>
   <div class="panel"><div class="phead"><h2 class="grow">Litres par mois</h2></div><div class="db">${barres(parMois,v=>fmt(v)+" L")}</div></div>
   <div class="panel"><div class="phead"><h2 class="grow">Pleins</h2></div>${list.length?`<div class="tbl"><table><thead><tr><th>Date</th><th>Camion</th><th class="num">Litres</th><th class="num">Prix/L</th><th class="num">Montant</th><th class="num">Km</th><th>Station / facture</th><th>Par</th><th>Photo</th></tr></thead><tbody>${list.map(c=>`<tr><td>${dt(c.fait_le)}</td><td class="ref">${esc(vName(c.vehicule_id))}</td><td class="num">${fmt(c.litres)}</td><td class="num">${fmt(c.prix_litre)}</td><td class="num">${xaf(c.montant)}</td><td class="num">${c.km?fmt(c.km):""}</td><td>${esc(c.fournisseur)}${c.facture_num?`<div class="sub">${esc(c.facture_num)}</div>`:""}</td><td>${esc(who(c.created_by))}</td><td>${thumb(c.photo,"Ticket")}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty">Aucun plein noté. Chaque plein se note avec le ticket ou la facture de la station.</div>'}</div></div>`;
}
/* ===== Rapport journalier IVMS (même structure que le fichier Excel « RAPPORT JOURNALIER ») ===== */
const RJ_CHECKS=[["c1","Check N°1 (Fin 08h30)","08:30"],["c2","Check N°2 (Fin 12h00)","12:00"],["c3","Check N°3 (Fin 16h30)","16:30"]];
const RJ_LIEUX=["stationné à la base","se trouve à la BI","se trouve en ville","stationné à GPGOS","en route"], RJ_OBS=["RAS","stationné","en mouvement"];
const auj=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10)};
let rjJour=auj(); const RJD={};   // brouillons non enregistrés : RJD[jour][camion][champ]
const hm=t=>t?String(t).slice(0,5):"";
const minutes=t=>{if(!t) return null;const [h,m]=String(t).split(":").map(Number);return h*60+(m||0)};
function rjDuree(l){const d=minutes(l.demarrage),f=minutes(l.fin),p=minutes(l.pause)||0;if(d===null||f===null||f<=d) return "";const x=f-d-p;return x<0?"":String(Math.floor(x/60)).padStart(2,"0")+":"+String(x%60).padStart(2,"0")}
const rjVehs=()=>[...S.vehicules].filter(v=>v.statut!=="Hors parc").sort(vSort);
const rjSaved=(jour,vid)=>S.rapport_jour.find(r=>r.jour===jour&&r.vehicule_id===vid);
function rjLigne(jour,vid){const s=rjSaved(jour,vid)||{};const d=(RJD[jour]||{})[vid]||{};
  const l={km:s.km??"",infraction:s.infraction||"NON",demarrage:hm(s.demarrage),ivms_ok:s.ivms_ok===undefined?true:s.ivms_ok,pause:hm(s.pause),fin:hm(s.fin)};
  RJ_CHECKS.forEach(([k,,h])=>{l[k+"_lieu"]=s[k+"_lieu"]||"";l[k+"_heure"]=hm(s[k+"_heure"])||h;l[k+"_obs"]=s[k+"_obs"]||""});
  Object.assign(l,d);if(typeof l.ivms_ok==="string")l.ivms_ok=l.ivms_ok==="OK";return l}
const rjModifie=jour=>Object.keys(RJD[jour]||{}).length>0;
const rjManquants=jour=>rjVehs().filter(v=>!rjSaved(jour,v.id));
const peutRj=()=>canDo("rapjour");
function vRapJour(){
  const vs=rjVehs(), ed=peutRj(), J=rjJour, lignes=vs.map(v=>[v,rjLigne(J,v.id)]);
  const faits=vs.filter(v=>rjSaved(J,v.id)).length, km=lignes.reduce((a,[,l])=>a+(+String(l.km).replace(",",".")||0),0);
  const ivmsKo=lignes.filter(([,l])=>!l.ivms_ok), infr=lignes.filter(([,l])=>l.infraction&&l.infraction.toUpperCase()!=="NON");
  const inp=(vid,k,v,t="text",w="",list="")=>ed?`<input class="rj" data-rj="${vid}|${k}" type="${t}" value="${esc(v)}"${w?` style="width:${w}"`:""}${list?` list="${list}"`:""}${k==="km"?' inputmode="decimal"':""} aria-label="${k}">`:esc(v);
  const m0=new Date(J.slice(0,7)+"-01T00:00:00"), m1=new Date(m0.getFullYear(),m0.getMonth()+1,1);
  const duMois=S.rapport_jour.filter(r=>{const t=new Date(r.jour+"T00:00:00").getTime();return t>=m0.getTime()&&t<m1.getTime()});
  return `<div class="stack">
   <div class="row"><h2 class="grow">Rapport journalier</h2>
    <button class="btn" data-act="rj-jour" data-k="-1" aria-label="Jour précédent">◀</button><input id="rj-jour" type="date" value="${J}" max="${auj()}" style="width:auto"><button class="btn" data-act="rj-jour" data-k="1" aria-label="Jour suivant"${J>=auj()?" disabled":""}>▶</button>
    <button class="btn" data-act="rj-imprimer">Imprimer / PDF</button><button class="btn" data-act="rj-excel">Exporter le mois en Excel</button>
    ${ed?`<button class="btn primary" data-act="rj-save"${rjModifie(J)?"":" disabled"}>Enregistrer</button>`:""}</div>
   <div class="kpis">
    <div class="kpi${faits<vs.length?" k-warn":" k-ok"}"><span>Camions saisis</span><b>${faits} <small>/ ${vs.length}</small></b><em>${faits<vs.length?"il reste "+(vs.length-faits)+" camion(s)":"rapport complet"}</em></div>
    <div class="kpi"><span>Km parcourus</span><b>${nb(km)} <small>km</small></b><em>tous les camions, ce jour</em></div>
    <div class="kpi${ivmsKo.length?" k-bad":" k-ok"}"><span>IVMS en panne</span><b>${ivmsKo.length}</b><em>${ivmsKo.length?ivmsKo.map(([v])=>esc(v.code)).join(", "):"tous fonctionnent"}</em></div>
    <div class="kpi${infr.length?" k-bad":" k-ok"}"><span>Infractions jour précédent</span><b>${infr.length}</b><em>${infr.length?infr.map(([v])=>esc(v.code)).join(", "):"aucune"}</em></div>
   </div>
   ${rjModifie(J)?'<div class="note warn">Des changements ne sont pas encore enregistrés. Appuyez sur « Enregistrer ».</div>':""}
   <div class="panel"><div class="phead"><h2 class="grow">Rapport du ${dt(J+"T12:00:00")}</h2>${ed?'<button class="btn sm" data-act="rj-base">Cases vides : « stationné à la base / RAS »</button>':""}</div>
   <div class="tbl"><table class="rjt"><thead>
    <tr><th rowspan="2">N°</th><th rowspan="2">Immatriculation</th><th rowspan="2">KM parcourus</th><th rowspan="2">Infractions jour précédent</th><th rowspan="2">Heure de démarrage du conducteur</th><th rowspan="2">IVMS fonctionnel</th>${RJ_CHECKS.map(([,t])=>`<th colspan="3" class="grp">${t}<br><small>Opérateur IVMS (STP2I)</small></th>`).join("")}<th colspan="3" class="grp">Check N°4 (le lendemain)<br><small>Opérateur IVMS (STP2I)</small></th></tr>
    <tr>${RJ_CHECKS.map(()=>"<th>Emplacement actuel</th><th>Heure de contrôle</th><th>Observation</th>").join("")}<th>Heure de pause</th><th>Heure de fin de service du chauffeur</th><th>Durée de travail</th></tr></thead><tbody>
    ${lignes.map(([v,l],i)=>`<tr class="${rjSaved(J,v.id)?"":"rj-vide"}"><td class="num">${i+1}</td><td><b>${esc(v.code)}</b>${v.immat||v.marque?`<div class="sub">${esc([v.immat,v.marque].filter(Boolean).join(" "))}</div>`:""}</td>
     <td>${inp(v.id,"km",l.km,"text","70px")}</td><td>${inp(v.id,"infraction",l.infraction,"text","80px","rj-inf")}</td><td>${inp(v.id,"demarrage",l.demarrage,"time")}</td>
     <td>${ed?`<select class="rj" data-rj="${v.id}|ivms_ok" aria-label="IVMS"><option${l.ivms_ok?" selected":""}>OK</option><option value="NON"${l.ivms_ok?"":" selected"}>Non</option></select>`:(l.ivms_ok?"OK":'<span class="chip bad">Non</span>')}</td>
     ${RJ_CHECKS.map(([k])=>`<td>${inp(v.id,k+"_lieu",l[k+"_lieu"],"text","150px","rj-lieux")}</td><td>${inp(v.id,k+"_heure",l[k+"_heure"],"time")}</td><td>${inp(v.id,k+"_obs",l[k+"_obs"],"text","110px","rj-obs")}</td>`).join("")}
     <td>${inp(v.id,"pause",l.pause,"time")}</td><td>${inp(v.id,"fin",l.fin,"time")}</td><td class="num"><b id="rjd-${v.id}">${rjDuree(l)}</b></td></tr>`).join("")}
   </tbody></table></div>
   <datalist id="rj-inf"><option value="NON"><option value="OUI"></datalist>
   <datalist id="rj-lieux">${[...new Set([...RJ_LIEUX,...S.rapport_jour.flatMap(r=>[r.c1_lieu,r.c2_lieu,r.c3_lieu]).filter(Boolean)])].slice(0,40).map(x=>`<option value="${esc(x)}">`).join("")}</datalist>
   <datalist id="rj-obs">${RJ_OBS.map(x=>`<option value="${x}">`).join("")}</datalist>
   <div class="db sub">Durée de travail = heure de fin de service − heure de pause − heure de démarrage. Le check N°4 se remplit le lendemain : revenez sur ce jour avec ◀.</div></div>
   <div class="panel"><div class="phead"><h2 class="grow">Le mois de ${m0.toLocaleDateString("fr-FR",{month:"long",year:"numeric"})}</h2><span class="sub">${new Set(duMois.map(r=>r.jour)).size} jour(s) de rapport</span></div>
   <div class="tbl"><table><thead><tr><th>Camion</th><th class="num">Km parcourus</th><th class="num">Jours roulés</th><th class="num">Jours IVMS en panne</th><th class="num">Infractions</th><th class="num">Durée moyenne de travail</th></tr></thead><tbody>
   ${vs.map(v=>{const r=duMois.filter(x=>x.vehicule_id===v.id);const k=r.reduce((a,x)=>a+(+x.km||0),0);const ds=r.map(x=>minutes(rjDuree({demarrage:hm(x.demarrage),fin:hm(x.fin),pause:hm(x.pause)}))).filter(x=>x);const moy=ds.length?Math.round(ds.reduce((a,b)=>a+b,0)/ds.length):0;
     return `<tr><td><b>${esc(v.code)}</b> <span class="sub">${esc(v.immat||"")}</span></td><td class="num">${nb(k)}</td><td class="num">${r.filter(x=>+x.km>0).length}</td><td class="num">${r.filter(x=>!x.ivms_ok).length||""}</td><td class="num">${r.filter(x=>x.infraction&&x.infraction.toUpperCase()!=="NON").length||""}</td><td class="num">${moy?Math.floor(moy/60)+" h "+String(moy%60).padStart(2,"0"):"—"}</td></tr>`}).join("")}
   </tbody></table></div></div></div>`;
}
async function rjEnregistrer(){
  const J=rjJour, d=RJD[J]||{};
  const lignes=Object.keys(d).map(vid=>{const l=rjLigne(J,vid);const o={vehicule_id:vid};
    ["km","infraction","demarrage","pause","fin",...RJ_CHECKS.flatMap(([k])=>[k+"_lieu",k+"_heure",k+"_obs"])].forEach(f=>o[f]=String(l[f]??"").trim());
    o.km=o.km.replace(",",".");if(o.km&&isNaN(+o.km)) throw "Km incorrect pour "+vName(vid)+" : écrivez un nombre (ex. 41,56).";
    o.ivms_ok=!!l.ivms_ok;return o});
  if(!lignes.length) return;
  const n=await rpc("stp2i_rapport_jour_enregistrer",{p_jour:J,p_lignes:lignes});
  delete RJD[J];toast(`Rapport du ${dt(J+"T12:00:00")} enregistré (${n} camion(s))`);await charger();
}
function rjLignesSaved(jour){return rjVehs().map(v=>[v,rjSaved(jour,v.id)]).filter(([,r])=>r)}
const rjRow=(i,v,r)=>[i,[v.immat,v.marque].filter(Boolean).join(" ")||v.code,r.km==null?"":nb(r.km),r.infraction,hm(r.demarrage),r.ivms_ok?"OK":"NON",...RJ_CHECKS.flatMap(([k])=>[r[k+"_lieu"],hm(r[k+"_heure"]),r[k+"_obs"]]),hm(r.pause),hm(r.fin),rjDuree({demarrage:hm(r.demarrage),fin:hm(r.fin),pause:hm(r.pause)})];
function rjImprimer(){
  const J=rjJour, L=rjLignesSaved(J);if(!L.length){toast("Rien d'enregistré pour ce jour.");return}
  imprimer("Rapport journalier "+dt(J+"T12:00:00"),`<style>@page{size:A4 landscape;margin:8mm}table{font-size:8.5px}th{font-size:8px}</style><h1>RAPPORT JOURNALIER IVMS</h1><p>${esc(reglages.societe||"STP2i")} · Journée du <b>${dt(J+"T12:00:00")}</b> · Nombre de véhicules en contrat : <b>${rjVehs().length}</b></p>
  <table><thead><tr><th rowspan="2">N°</th><th rowspan="2">Immatriculation</th><th rowspan="2">KM parcourus</th><th rowspan="2">Infractions jour précédent</th><th rowspan="2">Heure de démarrage</th><th rowspan="2">IVMS fonctionnel</th>${RJ_CHECKS.map(([,t])=>`<th colspan="3">${t}</th>`).join("")}<th colspan="3">Check N°4 (le lendemain)</th></tr>
  <tr>${RJ_CHECKS.map(()=>"<th>Emplacement actuel</th><th>Heure</th><th>Observation</th>").join("")}<th>Heure de pause</th><th>Fin de service</th><th>Durée de travail</th></tr></thead>
  <tbody>${L.map(([v,r],i)=>`<tr>${rjRow(i+1,v,r).map(c=>`<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table><p>Opérateur IVMS : ${esc(me.nom||"")}</p>`);
}
async function rjExcel(){
  try{await chargerXlsx()}catch(e){toast(errMsg(e));return}
  const X=window.XLSX, wb=X.utils.book_new(), mois=rjJour.slice(0,7);
  const jours=[...new Set(S.rapport_jour.filter(r=>r.jour.startsWith(mois)).map(r=>r.jour))].sort();
  if(!jours.length){toast("Aucun rapport enregistré ce mois-ci.");return}
  const h1=["Nombre de véhicules en contrat","Immatriculation","KM PARCOURUS","INFRACTIONS JOUR PRECEDENT","heure de démarage du conducteur","IVMS fonctionnel",...RJ_CHECKS.flatMap(([,t])=>[t+"\nOpérateur IVMS (STP2I)","",""]),"Check N°4 (le lendemain)\nOpérateur IVMS (STP2I)","",""];
  const h2=["","","","","","",...RJ_CHECKS.flatMap(()=>["Emplacement actuel","heure de contrôle","Observation"]),"heure de pause","heure de fin de service du chauffeur","La durée de travail"];
  jours.forEach(j=>{const rows=rjLignesSaved(j).map(([v,r],i)=>rjRow(i?"":rjVehs().length,v,r));
    const ws=X.utils.aoa_to_sheet([["RAPPORT JOURNALIER IVMS du "+j.split("-").reverse().join("/")],[],h1,h2,...rows]);
    ws["!merges"]=[{s:{r:0,c:0},e:{r:0,c:17}},...[0,1,2,3,4,5].map(c=>({s:{r:2,c},e:{r:3,c}})),{s:{r:2,c:6},e:{r:2,c:8}},{s:{r:2,c:9},e:{r:2,c:11}},{s:{r:2,c:12},e:{r:2,c:14}},{s:{r:2,c:15},e:{r:2,c:17}}];
    if(rows.length>1) ws["!merges"].push({s:{r:4,c:0},e:{r:3+rows.length,c:0}});
    ws["!cols"]=[{wch:10},{wch:24},{wch:10},{wch:12},{wch:11},{wch:9},{wch:26},{wch:9},{wch:14},{wch:26},{wch:9},{wch:14},{wch:26},{wch:9},{wch:14},{wch:9},{wch:11},{wch:10}];
    X.utils.book_append_sheet(wb,ws,j.split("-").reverse().join("-"))});
  X.writeFile(wb,"RAPPORT_JOURNALIER_"+mois+".xlsx");
}
function basePlein(){
  return `<div class="base"><button class="back" data-act="go" data-s="home">← Retour</button><h2>Plein de carburant</h2>
   <div class="step"><i>1</i><span>Quel camion ?</span></div>${vehTiles(F.veh)}
   <div class="step"><i>2</i><span>Combien de litres ?</span></div><input class="bigin" data-f="litres" inputmode="decimal" value="${esc(F.litres||"")}" placeholder="ex. 210">
   <div class="step"><i>3</i><span>Prix du litre (XAF)</span></div><input class="bigin" data-f="prix" inputmode="decimal" value="${esc(F.prix??dernierPrix())}" placeholder="ex. 625">
   <div class="step"><i>4</i><span>Photo du ticket ou de la facture</span></div>${photoBtn("photo","Prendre la photo")}
   <div class="step"><i>5</i><span>Kilométrage <em>facultatif</em></span></div><input class="bigin" data-f="km" inputmode="numeric" value="${esc(F.km||"")}" placeholder="ex. 152300">
   <div class="step"><i>6</i><span>Station et n° de facture <em>facultatif</em></span></div><input class="bigin" data-f="station" value="${esc(F.station||"")}" placeholder="ex. ROX OIL, facture 1234">
   ${F.err?`<div class="err">${esc(F.err)}</div>`:""}
   <button class="send" data-act="b-plein-send" ${F.busy?"disabled":""}>${F.busy?"Enregistrement…":"Enregistrer le plein"}</button></div>`;
}

/* ===== Papiers et dates de fin ===== */
const TYPES_PAPIERS_V=["Assurance","Visite technique","Carte grise","Extincteur","Autorisation de transport","Vignette"];
const TYPES_PAPIERS_P=["Permis de conduire","Visite médicale","Formation HSE"];
function papiersActuels(){const m={};[...S.papiers].sort((a,b)=>ts(a.created_at)-ts(b.created_at)).forEach(p=>{m[(p.vehicule_id||"p:"+p.personne.toLowerCase())+"|"+p.type.toLowerCase()]=p});return Object.values(m)}
const resteJours=p=>Math.floor((ts(p.date_fin)+JOUR-Date.now())/JOUR);
const papierEtat=p=>{const j=resteJours(p);return {c:j<0?"bad":j<=30?"warn":"ok",t:j<0?`expiré depuis ${-j} jour(s)`:j===0?"expire aujourd'hui":`encore ${j} jour(s)`}};
const papiersAlerte=()=>papiersActuels().filter(p=>papierEtat(p).c!=="ok");
function vPapiers(){
  const act=papiersActuels().sort((a,b)=>ts(a.date_fin)-ts(b.date_fin));
  const exp=act.filter(p=>papierEtat(p).c==="bad"), bientot=act.filter(p=>papierEtat(p).c==="warn");
  const qui=p=>p.vehicule_id?vName(p.vehicule_id):p.personne;
  const tuile=p=>{const e=papierEtat(p);return `<div class="vtile t-${e.c}"><span class="vt-top"><b style="font-size:17px">${esc(p.type)}</b><span class="chip ${e.c}">${esc(e.t)}</span></span><span class="vt-l"><b>${esc(qui(p))}</b>${p.numero?" · n° "+esc(p.numero):""}</span><span class="vt-l sub">Fin le ${dt(p.date_fin)}</span><span class="row">${thumb(p.fichier,p.type)}${canDo("papier")?`<button class="btn sm" data-act="papier-new" data-v="${p.vehicule_id||""}" data-p="${esc(p.personne)}" data-t="${esc(p.type)}">Renouveler</button>`:""}</span></div>`};
  return `<div class="stack">
   <div class="row"><h2 class="grow">Papiers et dates de fin</h2>${canDo("papier")?'<button class="btn primary" data-act="papier-new">Ajouter un papier</button>':""}</div>
   <div class="kpis">
    <div class="kpi${exp.length?" k-bad":" k-ok"}"><span>Expirés</span><b>${exp.length}</b><em>${exp.length?"le camion ou la personne ne doit pas rouler":"aucun"}</em></div>
    <div class="kpi${bientot.length?" k-warn":" k-ok"}"><span>À renouveler sous 30 jours</span><b>${bientot.length}</b><em>${bientot.length?"préparer le renouvellement":"rien à préparer"}</em></div>
    <div class="kpi"><span>Papiers suivis</span><b>${act.length}</b><em>camions et personnes</em></div>
   </div>
   ${act.length?`<div class="vtiles">${act.map(tuile).join("")}</div>`:'<div class="empty panel">Aucun papier enregistré. Ajoutez l\'assurance, la visite technique, la carte grise, les extincteurs de chaque camion et les permis des chauffeurs : l\'alerte arrive 30 jours avant la fin.</div>'}
   ${S.papiers.length>act.length?`<div class="panel"><div class="phead"><h2 class="grow">Anciens papiers</h2></div><div class="db"><div class="hist">${S.papiers.filter(p=>!act.includes(p)).sort(newest).map(p=>`<div>${esc(p.type)} · ${esc(qui(p))} · fin ${dt(p.date_fin)} · remplacé</div>`).join("")}</div></div></div>`:""}</div>`;
}

/* ===== Rapports : soir (WhatsApp), mois (PDF), export Excel ===== */
const aujourdhui=()=>{const n=new Date();return new Date(n.getFullYear(),n.getMonth(),n.getDate()).getTime()};
const duJour=t=>ts(t)>=aujourdhui();
function rapportSoir(){
  const L=[];const d=new Date().toLocaleDateString("fr-FR",{weekday:"long",day:"numeric",month:"long"});
  L.push(`*STP2i : point du ${d}*`,"");
  const vs=S.vehicules.filter(v=>v.statut!=="Hors parc");
  const pn=vs.filter(v=>v.statut==="En panne");
  L.push(`🚚 Camions : ${vs.length-pn.length} en service sur ${vs.length}`);
  pn.forEach(v=>{const p=pannesOuvertes(v.id)[0];L.push(`   🔴 ${v.code} en panne${p?" : "+p.description+" ("+depuis(p.created_at)+")":""}`)});
  const pj=S.pannes.filter(p=>duJour(p.created_at)), rj=S.pannes.filter(p=>p.reparee_le&&duJour(p.reparee_le));
  if(pj.length) L.push(`⚠️ Nouvelles pannes : ${pj.map(p=>vName(p.vehicule_id)).join(", ")}`);
  if(rj.length) L.push(`✅ Réparés aujourd'hui : ${rj.map(p=>vName(p.vehicule_id)).join(", ")}`);
  const ctl=S.controles.filter(c=>duJour(c.created_at));
  if(S.controles.length||ctl.length) L.push(`🛡️ Contrôles avant départ : ${new Set(ctl.map(c=>c.vehicule_id)).size} sur ${vs.length}${ctl.some(c=>!c.ok)?" (dont "+ctl.filter(c=>!c.ok).length+" à revoir)":""}`);
  L.push("");
  const dj=S.demandes.filter(x=>duJour(x.created_at));
  L.push(`🔧 Demandes de pièces aujourd'hui : ${dj.length}${dj.some(x=>x.urgent)?" (dont "+dj.filter(x=>x.urgent).length+" urgente(s))":""}`);
  const av=S.commandes.filter(b=>b.statut==="À valider");
  if(av.length) L.push(`🟠 Bons à valider par le DG : ${av.length} pour ${xaf(av.reduce((s,b)=>s+(+b.total||0),0))}`);
  const vj=S.commandes.filter(b=>b.valide_le&&duJour(b.valide_le));
  if(vj.length) L.push(`🟢 Bons validés aujourd'hui : ${vj.length} pour ${xaf(vj.reduce((s,b)=>s+(+b.total||0),0))}`);
  const rcj=S.receptions.filter(r=>duJour(r.created_at));
  if(rcj.length) L.push(`📦 Livraisons reçues : ${rcj.length}`);
  const cj=S.carburant.filter(c=>duJour(c.fait_le)||duJour(c.created_at));
  if(cj.length) L.push(`⛽ Carburant : ${fmt(cj.reduce((s,c)=>s+(+c.litres||0),0))} L pour ${xaf(cj.reduce((s,c)=>s+(+c.montant||0),0))}`);
  const trop=vs.filter(v=>conso4j(v.id)>LIMITE_4J);
  if(trop.length) L.push(`   ❗ Au-dessus de ${LIMITE_4J} L sur 4 jours : ${trop.map(v=>v.code).join(", ")}`);
  const pa=papiersAlerte();
  if(pa.length) L.push(`📄 Papiers : ${pa.filter(p=>papierEtat(p).c==="bad").length} expiré(s), ${pa.filter(p=>papierEtat(p).c==="warn").length} à renouveler sous 30 jours`);
  const hj=S.hse.filter(h=>duJour(h.created_at));
  if(hj.length) L.push(`🦺 HSE : ${hj.map(h=>h.type+(h.vehicule_id?" "+vName(h.vehicule_id):"")).join(", ")}`);
  const st=S.stock.filter(s=>niveau(s)==="bad");
  if(st.length) L.push(`📉 Pièces en rupture : ${st.slice(0,5).map(s=>s.designation).join(", ")}${st.length>5?"…":""}`);
  return L.join("\n");
}
function conseilsMois(m0,m1){
  const c=[];
  const dep=x=>S.commandes.filter(b=>engage(b)&&ts(b.valide_le||b.created_at)>=x[0]&&ts(b.valide_le||b.created_at)<x[1]).reduce((s,b)=>s+(+b.total||0),0);
  const p0=new Date(new Date(m0).getFullYear(),new Date(m0).getMonth()-1,1).getTime();
  const a=dep([m0,m1]),b=dep([p0,m0]);
  if(b&&a>b*1.2) c.push(`Les dépenses de pièces montent de ${Math.round((a/b-1)*100)} % : regardez les camions qui coûtent le plus.`);
  const parV={};S.pannes.filter(p=>ts(p.created_at)>=m0&&ts(p.created_at)<m1).forEach(p=>parV[p.vehicule_id]=(parV[p.vehicule_id]||0)+1);
  Object.entries(parV).filter(([,n])=>n>=3).forEach(([v,n])=>c.push(`${vName(v)} est tombé en panne ${n} fois : prévoir une révision complète.`));
  if(entretiensAFaire().some(e=>entEtat(e).c==="bad")) c.push("Des entretiens sont en retard : un entretien fait à temps évite une panne plus chère.");
  if(papiersAlerte().some(p=>papierEtat(p).c==="bad")) c.push("Des papiers sont expirés : en cas de contrôle ou d'accident, c'est un risque pour STP2i.");
  const nr=S.mouvements.filter(m=>m.type==="sortie"&&m.ancienne_rendue===false&&ts(m.created_at)>=m0&&ts(m.created_at)<m1).length;
  if(nr) c.push(`${nr} pièce(s) usée(s) n'ont pas été rendues : vérifiez les motifs.`);
  if(S.factures.some(f=>f.statut==="Bloquée")) c.push("Des factures sont bloquées : la logistique doit les régler avec les fournisseurs.");
  if(!c.length) c.push("Rien d'inquiétant ce mois-ci. Continuez comme ça.");
  return c;
}
function rapportMois(k){
  const m0=debutMois(k),m1=debutMois(k+1);const dans=t=>ts(t)>=m0&&ts(t)<m1;
  const titre=new Date(m0).toLocaleDateString("fr-FR",{month:"long",year:"numeric"});
  const bcs=S.commandes.filter(b=>engage(b)&&dans(b.valide_le||b.created_at));
  const pannes=S.pannes.filter(p=>dans(p.created_at));
  const carb=S.carburant.filter(c=>dans(c.fait_le));
  const parV=[...S.vehicules].sort(vSort).map(v=>{const p=bcs.filter(b=>b.vehicule_id===v.id).reduce((s,b)=>s+(+b.total||0),0);const l=carb.filter(c=>c.vehicule_id===v.id);return {v,pieces:p,pannes:pannes.filter(x=>x.vehicule_id===v.id).length,arret:S.pannes.filter(x=>x.vehicule_id===v.id).reduce((s,x)=>{const a=Math.max(ts(x.created_at),m0),b=Math.min(x.reparee_le?ts(x.reparee_le):Date.now(),m1);return s+Math.max(0,(b-a)/JOUR)},0),litres:l.reduce((s,c)=>s+(+c.litres||0),0),carb:l.reduce((s,c)=>s+(+c.montant||0),0)}});
  const T=(h,r)=>`<table><thead><tr>${h.map(x=>`<th>${x}</th>`).join("")}</tr></thead><tbody>${r.join("")}</tbody></table>`;
  return `<h1>Rapport du mois : ${esc(titre)}</h1><p class="s">STP2i · Achats et Parc · imprimé le ${dtt(Date.now())}</p>
   <div class="k"><div><span>Pièces commandées</span><b>${xaf(bcs.reduce((s,b)=>s+(+b.total||0),0))}</b></div><div><span>Carburant</span><b>${fmt(carb.reduce((s,c)=>s+(+c.litres||0),0))} L · ${xaf(carb.reduce((s,c)=>s+(+c.montant||0),0))}</b></div><div><span>Pannes</span><b>${pannes.length}</b></div><div><span>Accidents / presque</span><b>${S.hse.filter(h=>dans(h.survenu_le)&&h.type==="Accident").length} / ${S.hse.filter(h=>dans(h.survenu_le)&&h.type==="Presque accident").length}</b></div></div>
   <h2>Conseils</h2><ul>${conseilsMois(m0,m1).map(x=>`<li>${esc(x)}</li>`).join("")}</ul>
   <h2>Par camion</h2>${T(["Camion","Pièces (XAF)","Pannes","Jours d'arrêt","Litres","Carburant (XAF)"],parV.map(x=>`<tr><td>${esc(x.v.code)}</td><td class="n">${fmt(x.pieces)}</td><td class="n">${x.pannes}</td><td class="n">${(Math.round(x.arret*10)/10).toLocaleString("fr-FR")}</td><td class="n">${fmt(x.litres)}</td><td class="n">${fmt(x.carb)}</td></tr>`))}
   <h2>Bons de commande</h2>${T(["N°","Date","Fournisseur","Camion","Montant","Statut"],bcs.sort((a,b)=>ts(a.created_at)-ts(b.created_at)).map(b=>`<tr><td>${esc(b.num)}</td><td>${dt(b.created_at)}</td><td>${esc(b.fournisseur)}</td><td>${esc(vName(b.vehicule_id))}</td><td class="n">${fmt(b.total)}</td><td>${esc(b.statut)}${b.hors_contrat?" · hors contrat":""}</td></tr>`))}
   <h2>Pannes</h2>${pannes.length?T(["N°","Camion","Panne","Déclarée","Réparée"],pannes.map(p=>`<tr><td>${esc(p.num)}</td><td>${esc(vName(p.vehicule_id))}</td><td>${esc(p.description)}</td><td>${dt(p.created_at)}</td><td>${p.reparee_le?dt(p.reparee_le):"en cours"}</td></tr>`)):"<p>Aucune panne.</p>"}`;
}
const STYLE_IMP=`body{font-family:Arial,sans-serif;color:#111;margin:14mm;font-size:11pt}h1{font-size:18pt;margin:0}h2{font-size:13pt;margin:18px 0 6px;border-bottom:2px solid #1f4e9e;padding-bottom:3px}.s{color:#555;margin:2px 0 12px}table{width:100%;border-collapse:collapse;margin:6px 0}th,td{border:1px solid #bbb;padding:4px 6px;text-align:left;font-size:10pt}th{background:#eef2f8}.n{text-align:right}.k{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.k div{border:1px solid #bbb;border-radius:6px;padding:8px}.k span{display:block;font-size:9pt;color:#555}.k b{font-size:12pt}@media print{.np{display:none}}`;
function imprimer(titre,corps){
  const w=window.open("","_blank");if(!w){toast("Autorisez l'ouverture de fenêtres pour imprimer.");return}
  w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(titre)}</title><style>${STYLE_IMP}</style></head><body><p class="np"><button onclick="print()">Imprimer ou enregistrer en PDF</button></p>${corps}<script>setTimeout(()=>print(),600)<\/script></body></html>`);
  w.document.close();
}
// Export pour Excel : fichier CSV (séparateur « ; », accents conservés).
function exporter(nom,entetes,lignes){
  const c=v=>{const s=String(v??"");return /[";\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};
  const txt="﻿"+[entetes,...lignes].map(l=>l.map(c).join(";")).join("\r\n");
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([txt],{type:"text/csv;charset=utf-8"}));a.download=nom+".csv";document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},500);
}
const nb=n=>String(Math.round((+n||0)*100)/100).replace(".",",");
const EXPORTS={
  commandes:()=>exporter("bons-de-commande",["N°","Date","Fournisseur","Camion","Montant XAF","Statut","Validé le","Hors contrat"],S.commandes.map(b=>[b.num,dt(b.created_at),b.fournisseur,vName(b.vehicule_id),nb(b.total),b.statut,dt(b.valide_le),b.hors_contrat?"oui":""])),
  carburant:()=>exporter("carburant",["Date","Camion","Litres","Prix/L","Montant XAF","Km","Station","Facture"],S.carburant.map(c=>[dt(c.fait_le),vName(c.vehicule_id),nb(c.litres),nb(c.prix_litre),nb(c.montant),c.km||"",c.fournisseur,c.facture_num])),
  stock:()=>exporter("stock",["Pièce","Famille","Rayon","Total","Minimum",...lieux()],S.stock.map(s=>[s.designation,s.famille,s.rayon,s.qte,s.seuil_min,...lieux().map(l=>qteLieu(s,l))])),
  mouvements:()=>exporter("mouvements",["Date","Type","Pièce","Qté","Camion","Lieu","Pièce usée rendue","Motif","Réf"],S.mouvements.map(m=>[dtt(m.created_at),m.type,designation(m.stock_id),m.qte,vName(m.vehicule_id),m.site||"Base",m.type==="sortie"?(m.ancienne_rendue===false?"non":"oui"):"",m.motif||"",m.ref])),
  pannes:()=>exporter("pannes",["N°","Camion","Panne","Statut","Déclarée","Réparée","Réparation","Jours d'arrêt"],S.pannes.map(p=>[p.num,vName(p.vehicule_id),p.description,p.statut,dtt(p.created_at),dtt(p.reparee_le),p.reparation,nb(joursArret(p))])),
  factures:()=>exporter("factures",["Facture","Fournisseur","Montant XAF","Statut","Date","Payée le"],S.factures.map(f=>[f.numero,f.fournisseur,nb(f.montant),f.statut,dt(f.date_facture),dt(f.paye_le)]))
};
function vRapports(){
  const mois=[0,-1,-2].map(k=>[k,new Date(debutMois(k)).toLocaleDateString("fr-FR",{month:"long",year:"numeric"})]);
  return `<div class="stack"><h2>Rapports</h2>
   <div class="vtiles">
    <button class="vtile t-ok big-t" data-act="rap-soir"><span class="vt-top"><b>Rapport du soir</b><span class="chip ok">WhatsApp</span></span><span class="vt-l">Le point de la journée, prêt à envoyer au DG.</span></button>
    ${mois.map(([k,l])=>`<button class="vtile big-t" data-act="rap-mois" data-k="${k}"><span class="vt-top"><b>Rapport ${esc(l)}</b><span class="chip blue">PDF</span></span><span class="vt-l">Chiffres, camions, pannes et conseils simples.</span></button>`).join("")}
   </div>
   <div class="panel"><div class="phead"><h2 class="grow">Exporter pour Excel</h2></div><div class="db"><div class="row">${[["commandes","Bons de commande"],["factures","Factures"],["carburant","Carburant"],["stock","Stock"],["mouvements","Mouvements de pièces"],["pannes","Pannes"]].filter(([k])=>role()!=="base"||!["commandes","factures"].includes(k)).map(([k,l])=>`<button class="btn" data-act="export" data-k="${k}">${l}</button>`).join("")}</div><p class="sub">Le fichier s'ouvre directement dans Excel.</p></div></div></div>`;
}

/* ===== Papiers officiels : bon de commande et bon de réception ===== */
let reglages={};
const lienDoc=num=>location.origin+location.pathname+"#doc="+encodeURIComponent(num);
async function imprimerBc(id){
  const b=byId("commandes",id);if(!b)return;
  try{await chargerQR()}catch(e){toast(errMsg(e));return}
  const valide=["Validé","Reçu partiel","Reçu","Facturé","Payé"].includes(b.statut);
  const avecSig=valide&&b.valide_par;
  if(avecSig) await signer([reglages.signature_dg,reglages.cachet].filter(Boolean));
  const img=p=>p&&urlCache[p]?`<img src="${esc(urlCache[p])}" alt="">`:"";
  const L=lignesDe(b.id);
  imprimer(b.num,`<div style="display:flex;align-items:center;gap:16px"><img src="${esc(new URL("assets/logo.png",location.href).href)}" style="height:54px" alt="STP2i"><div style="flex:1"><h1>Bon de commande ${esc(b.num)}</h1><p class="s">Émis le ${dt(b.created_at)} · Camion ${esc(vName(b.vehicule_id))}</p></div><div style="width:110px;text-align:center">${qrSvg(lienDoc(b.num),110)}<div style="font-size:8pt;color:#555">Vérifier ce document</div></div></div>
   ${!valide?`<p style="border:3px solid #c0392b;color:#c0392b;font-weight:bold;text-align:center;padding:8px;font-size:14pt">NON VALIDÉ PAR LE DG : CE DOCUMENT N'A PAS DE VALEUR</p>`:""}
   <h2>Fournisseur</h2><p><b>${esc(b.fournisseur)}</b></p>
   <h2>Détail</h2><table><thead><tr><th>Désignation</th><th class="n">Qté</th><th class="n">Prix unitaire (XAF)</th><th class="n">Montant (XAF)</th></tr></thead><tbody>${L.map(l=>`<tr><td>${esc(l.designation)}</td><td class="n">${l.qte}</td><td class="n">${fmt(l.pu)}</td><td class="n">${fmt(l.qte*l.pu)}</td></tr>`).join("")}<tr><td colspan="3"><b>Total</b></td><td class="n"><b>${fmt(b.total)}</b></td></tr></tbody></table>
   ${b.note?`<p>Note : ${esc(b.note)}</p>`:""}
   <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:24px">
    <div><b>Préparé par</b><br>${esc(who(b.created_by))} (logistique)<br>le ${dt(b.created_at)}</div>
    <div><b>Validation de la Direction générale</b><br>${avecSig?`${esc(who(b.valide_par))} le ${dtt(b.valide_le)}<div style="display:flex;gap:10px;align-items:center;margin-top:6px;height:100px">${img(reglages.signature_dg)}${img(reglages.cachet)}</div>`:valide?"Validé automatiquement (montant sous le seuil fixé par le DG)":"<i>En attente</i>"}</div>
   </div>
   <p class="s" style="margin-top:24px">Livraison acceptée à la base uniquement avec ce bon validé. Facture à établir au même montant, avec le n° ${esc(b.num)}.</p>`.replace(/<img src="([^"]+)" alt="">/g,'<img src="$1" alt="" style="max-height:100px;max-width:45%">'));
}
async function imprimerBr(id){
  const r=S.receptions.find(x=>x.id===id);if(!r)return;const b=byId("commandes",r.commande_id);
  try{await chargerQR()}catch(e){toast(errMsg(e));return}
  imprimer(r.num,`<div style="display:flex;align-items:center;gap:16px"><img src="${esc(new URL("assets/logo.png",location.href).href)}" style="height:54px" alt="STP2i"><div style="flex:1"><h1>Bon de réception ${esc(r.num)}</h1><p class="s">Reçu le ${dtt(r.created_at)} à la base par ${esc(who(r.created_by))}</p></div><div style="width:110px;text-align:center">${qrSvg(lienDoc(r.num),110)}</div></div>
   <p>Bon de commande <b>${esc(b?b.num:"")}</b> · ${esc(b?b.fournisseur:"")} · BL ${esc(r.bl_num||"—")} · ${r.complet?"livraison complète":"<b>livraison incomplète</b>"}</p>
   <table><thead><tr><th>Désignation</th><th class="n">Commandé</th><th class="n">Reçu au total</th></tr></thead><tbody>${b?lignesDe(b.id).map(l=>`<tr><td>${esc(l.designation)}</td><td class="n">${l.qte}</td><td class="n">${l.recu||0}</td></tr>`).join(""):""}</tbody></table>`);
}

/* ===== Contrat ENI ===== */
const ST_JOUR={"Travaillé":["ok","T"],"Panne":["bad","P"],"Arrêt client":["blue","A"],"Repos":["","R"]};
let moisC=0;
const cleJour=t=>{const d=new Date(t);return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")};
function jourDe(vid,j){return S.jours.find(x=>x.vehicule_id===vid&&x.jour===j)}
// Statut proposé : « Panne » si une panne était ouverte ce jour-là, sinon « Travaillé ».
function jourPropose(vid,j){const d0=new Date(j+"T00:00:00").getTime(),d1=d0+JOUR;return S.pannes.some(p=>p.vehicule_id===vid&&ts(p.created_at)<d1&&(!p.reparee_le||ts(p.reparee_le)>d0))?"Panne":"Travaillé"}
function calculContrat(k){
  const m0=debutMois(k),m1=debutMois(k+1);const nbj=Math.round((m1-m0)/JOUR);
  const vs=[...S.vehicules].filter(v=>v.statut!=="Hors parc").sort(vSort);
  return vs.map(v=>{const pr=S.contrat_prix.find(x=>x.type===v.type)||{prix_mois:0,prix_m3:0};
    const js=S.jours.filter(x=>x.vehicule_id===v.id&&ts(x.jour+"T12:00:00")>=m0&&ts(x.jour+"T12:00:00")<m1);
    const panne=js.filter(x=>x.statut==="Panne").length, trav=js.filter(x=>x.statut==="Travaillé").length, m3=js.reduce((s,x)=>s+(+x.m3||0),0);
    const loyer=pr.prix_mois*(nbj-panne)/nbj;
    return {v,pr,nbj,panne,trav,notes:js.length,m3,loyer,eau:m3*pr.prix_m3,total:loyer+m3*pr.prix_m3}});
}
function vContrat(){
  const m0=debutMois(moisC),m1=debutMois(moisC+1),nbj=Math.round((m1-m0)/JOUR);
  const titre=new Date(m0).toLocaleDateString("fr-FR",{month:"long",year:"numeric"});
  const C=calculContrat(moisC), tot=C.reduce((s,x)=>s+x.total,0);
  const hc=S.commandes.filter(b=>b.hors_contrat&&engage(b)&&ts(b.valide_le||b.created_at)>=m0&&ts(b.valide_le||b.created_at)<m1);
  const jl=[];for(let i=0;i<nbj;i++){const t=m0+i*JOUR+12*3600e3;jl.push(cleJour(t))}
  const today=cleJour(Date.now());
  const sansPrix=!S.contrat_prix.some(p=>p.prix_mois>0);
  const peutPrix=["dg","admin"].includes(me.role);
  return `<div class="stack">
   <div class="row"><h2 class="grow">Contrat ENI · ${esc(titre)}</h2><button class="btn sm" data-act="mois-c" data-d="-1">← Mois précédent</button>${moisC<0?'<button class="btn sm" data-act="mois-c" data-d="1">Mois suivant →</button>':""}${canDo("stockop")||me.role==="admin"?'<button class="btn primary" data-act="jour-noter">Noter la journée</button>':""}${peutPrix?'<button class="btn" data-act="prix-c">Prix du contrat</button>':""}</div>
   ${sansPrix?`<div class="banner">Les prix du contrat ne sont pas encore saisis. ${peutPrix?"Appuyez sur « Prix du contrat ».":"Le DG ou l'administrateur doit les saisir."}</div>`:""}
   <div class="kpis">
    <div class="kpi"><span>Estimation de la facture</span><b>${fmt(tot)} <small>XAF</small></b><em>prix mensuel moins les jours de panne</em></div>
    <div class="kpi${C.some(x=>x.panne)?" k-warn":" k-ok"}"><span>Jours de panne</span><b>${C.reduce((s,x)=>s+x.panne,0)}</b><em>${xaf(C.reduce((s,x)=>s+x.pr.prix_mois-x.loyer,0))} perdus</em></div>
    <div class="kpi"><span>Eau livrée</span><b>${fmt(C.reduce((s,x)=>s+x.m3,0))} <small>m³</small></b><em>${xaf(C.reduce((s,x)=>s+x.eau,0))}</em></div>
    <div class="kpi${hc.length?" k-warn":""}"><span>Pièces hors contrat</span><b>${fmt(hc.reduce((s,b)=>s+(+b.total||0),0))} <small>XAF</small></b><em>${hc.length} bon(s), à facturer à part</em></div>
   </div>
   <div class="panel"><div class="phead"><h2 class="grow">Jours de travail</h2><span class="sub"><span class="chip ok">T</span> travaillé · <span class="chip bad">P</span> panne · <span class="chip blue">A</span> arrêt demandé par le client · <span class="chip">R</span> repos</span></div>
    <div class="tbl"><table class="cal"><thead><tr><th>Camion</th>${jl.map(j=>`<th class="${j===today?"auj":""}">${+j.slice(8)}</th>`).join("")}</tr></thead><tbody>${C.map(x=>`<tr><td class="ref">${esc(x.v.code)}</td>${jl.map(j=>{const r=jourDe(x.v.id,j);const s=r?ST_JOUR[r.statut]:null;return `<td class="${j===today?"auj":""}">${s?`<span class="chip ${s[0]}" title="${esc(r.statut)}${r.m3?" · "+r.m3+" m³":""}">${s[1]}</span>`:j<=today?'<span class="vide">·</span>':""}</td>`}).join("")}</tr>`).join("")}</tbody></table></div></div>
   <div class="panel"><div class="phead"><h2 class="grow">Calcul par camion</h2></div><div class="tbl"><table><thead><tr><th>Camion</th><th class="num">Prix mensuel</th><th class="num">Jours notés</th><th class="num">Jours de panne</th><th class="num">Loyer dû</th><th class="num">Eau (m³)</th><th class="num">Eau (XAF)</th><th class="num">Total</th></tr></thead><tbody>${C.map(x=>`<tr><td class="ref">${esc(x.v.code)}</td><td class="num">${fmt(x.pr.prix_mois)}</td><td class="num">${x.notes} / ${x.nbj}</td><td class="num">${x.panne||""}</td><td class="num">${fmt(x.loyer)}</td><td class="num">${x.m3?fmt(x.m3):""}</td><td class="num">${x.eau?fmt(x.eau):""}</td><td class="num"><b>${fmt(x.total)}</b></td></tr>`).join("")}<tr><td colspan="7"><b>Total</b></td><td class="num"><b>${xaf(tot)}</b></td></tr></tbody></table></div>
    <div class="db"><p class="sub">Estimation : prix mensuel × (jours du mois − jours de panne) ÷ jours du mois, plus l'eau livrée. À comparer avec les règles exactes du contrat avant d'envoyer la facture.</p></div></div>
   ${hc.length?`<div class="panel"><div class="phead"><h2 class="grow">Pièces hors contrat du mois</h2></div><div class="tbl"><table><thead><tr><th>N°</th><th>Camion</th><th>Fournisseur</th><th class="num">Montant</th><th>Pourquoi</th></tr></thead><tbody>${hc.map(b=>`<tr class="click" data-act="bc-open" data-id="${b.id}"><td class="ref">${esc(b.num)}</td><td>${esc(vName(b.vehicule_id))}</td><td>${esc(b.fournisseur)}</td><td class="num">${xaf(b.total)}</td><td>${esc(b.hors_contrat_note)}</td></tr>`).join("")}</tbody></table></div></div>`:""}
  </div>`;
}

/* ===== HSE ===== */
const POINTS=["Pneus","Freins","Pas de fuite","Feux","Rétroviseurs","Ceinture","Extincteur","Trousse de secours"];
const C_HSE={"Accident":"bad","Presque accident":"warn","Inspection":"blue","Remarque":""};
function joursSansAccident(){const a=S.hse.filter(h=>h.type==="Accident").sort((x,y)=>ts(y.survenu_le)-ts(x.survenu_le))[0];return a?Math.floor((Date.now()-ts(a.survenu_le))/JOUR):null}
function vHse(){
  const vs=[...S.vehicules].filter(v=>v.statut!=="Hors parc").sort(vSort);
  const ctlJ=S.controles.filter(c=>duJour(c.created_at));
  const m0=debutMois();
  const ev=[...S.hse].sort((a,b)=>(a.statut==="Ouvert"?0:1)-(b.statut==="Ouvert"?0:1)||ts(b.survenu_le)-ts(a.survenu_le));
  const js=joursSansAccident();
  const form=[...S.formations].sort((a,b)=>ts(a.valable_jusqu_au||"2999-01-01")-ts(b.valable_jusqu_au||"2999-01-01"));
  const fEtat=f=>{if(!f.valable_jusqu_au)return {c:"ok",t:"sans date de fin"};const j=Math.floor((ts(f.valable_jusqu_au)+JOUR-Date.now())/JOUR);return {c:j<0?"bad":j<=30?"warn":"ok",t:j<0?"expirée":`encore ${j} jour(s)`}};
  return `<div class="stack">
   <div class="row"><h2 class="grow">HSE : sécurité</h2>${canDo("controle")?'<button class="btn primary" data-act="ctl-go">Contrôle avant départ</button>':""}<button class="btn bad" data-act="hse-new">Déclarer un accident ou un presque-accident</button></div>
   <div class="kpis">
    <div class="kpi${js===null||js>30?" k-ok":js<7?" k-bad":" k-warn"}"><span>Jours sans accident</span><b>${js===null?"—":js}</b><em>${js===null?"aucun accident enregistré":"depuis le dernier accident"}</em></div>
    <div class="kpi${new Set(ctlJ.map(c=>c.vehicule_id)).size<vs.length?" k-warn":" k-ok"}"><span>Contrôles aujourd'hui</span><b>${new Set(ctlJ.map(c=>c.vehicule_id)).size} <small>/ ${vs.length}</small></b><em>${ctlJ.filter(c=>!c.ok).length} camion(s) à revoir</em></div>
    <div class="kpi"><span>Ce mois</span><b>${S.hse.filter(h=>h.type==="Accident"&&ts(h.survenu_le)>=m0).length} <small>accident(s)</small></b><em>${S.hse.filter(h=>h.type==="Presque accident"&&ts(h.survenu_le)>=m0).length} presque-accident(s)</em></div>
    <div class="kpi${S.hse.some(h=>h.statut==="Ouvert")?" k-warn":""}"><span>Fiches ouvertes</span><b>${S.hse.filter(h=>h.statut==="Ouvert").length}</b><em>à clore avec une action</em></div>
   </div>
   ${S.smq.length||role()==="hse"?`<button class="panel smq-band" data-act="tab" data-k="smq"><span><b>Documents HSE et qualité</b><span class="sub">${S.smq.filter(d=>d.actif).length} en vigueur · ${smqARevoir().length} à revoir · ${S.smq.filter(d=>d.actif&&!d.fichier).length} sans fichier</span></span><span class="chip ${smqARevoir().length?"warn":"ok"}">Ouvrir</span></button>`:""}
   <div class="panel"><div class="phead"><h2 class="grow">Contrôles avant départ du jour</h2></div><div class="db"><div class="vtiles">${vs.map(v=>{const c=ctlJ.filter(x=>x.vehicule_id===v.id).sort(newest)[0];const e=!c?"warn":c.ok?"ok":"bad";
     return `<div class="vtile t-${e}"><span class="vt-top"><b>${esc(v.code)}</b><span class="chip ${e}">${!c?"Pas fait":c.ok?"Tout est bon":"À revoir"}</span></span><span class="vt-l sub">${c?`${dtt(c.created_at)} · ${esc(c.chauffeur||who(c.created_by))}`:"Le chauffeur doit faire le contrôle avant de partir"}</span>${c&&!c.ok?`<span class="vt-alert">${esc(Object.entries(c.points||{}).filter(([,x])=>x!==true).map(([k])=>k).join(", "))}${c.panne_num?" · "+esc(c.panne_num):""}</span>`:""}</div>`}).join("")}</div></div></div>
   <div class="panel"><div class="phead"><h2 class="grow">Accidents, presque-accidents, inspections</h2></div>${ev.length?`<div class="db">${ev.map(h=>`<div class="card">${thumb(h.photo,h.type)}<div class="grow"><div class="row"><span class="ref">${esc(h.num)}</span><span class="chip ${C_HSE[h.type]||""}">${esc(h.type)}</span><span class="chip ${h.statut==="Ouvert"?"orange":"ok"}">${esc(h.statut)}</span>${h.blesses?'<span class="chip bad">Blessé(s)</span>':""}<span class="chip">${esc(h.gravite)}</span></div>
     <div>${h.vehicule_id?`<b>${esc(vName(h.vehicule_id))}</b> · `:""}${esc(h.description)}</div><div class="sub">${dtt(h.survenu_le)}${h.lieu?" · "+esc(h.lieu):""} · déclaré par ${esc(who(h.created_by))}${h.actions?" · Action : "+esc(h.actions):""}</div>
     ${h.statut==="Ouvert"&&["logistique","dg","hse"].includes(role())?`<div style="margin-top:6px"><button class="btn sm ok" data-act="hse-clore" data-id="${h.id}">Clore avec une action</button></div>`:""}</div></div>`).join("")}</div>`:'<div class="empty">Aucune fiche. Déclarer un presque-accident, c\'est éviter le prochain accident.</div>'}</div>
   <div class="panel"><div class="phead"><h2 class="grow">Formations</h2>${canDo("papier")?'<button class="btn sm primary" data-act="form-new">Ajouter une formation</button>':""}</div>${form.length?`<div class="tbl"><table><thead><tr><th>Personne</th><th>Formation</th><th>Faite le</th><th>Valable jusqu'au</th><th>État</th><th>Attestation</th></tr></thead><tbody>${form.map(f=>{const e=fEtat(f);return `<tr><td><b>${esc(f.personne)}</b></td><td>${esc(f.theme)}</td><td>${dt(f.faite_le)}</td><td>${dt(f.valable_jusqu_au)}</td><td><span class="chip ${e.c}">${esc(e.t)}</span></td><td>${thumb(f.fichier,"Attestation")}</td></tr>`}).join("")}</tbody></table></div>`:'<div class="empty">Aucune formation enregistrée.</div>'}</div>
  </div>`;
}
function baseControle(){
  const v=F.veh?veh(F.veh):null;
  return `<div class="base"><button class="back" data-act="go" data-s="home">← Retour</button><h2>Contrôle avant départ</h2>
   <div class="step"><i>1</i><span>Quel camion ?</span></div>${vehTiles(F.veh)}
   <div class="step"><i>2</i><span>Chauffeur</span></div><input class="bigin" data-f="chauffeur" value="${esc(F.chauffeur??(v?v.chauffeur:""))}" placeholder="Nom du chauffeur">
   <div class="step"><i>3</i><span>Appuyez sur ce qui ne va PAS</span></div>
   <div class="tiles">${POINTS.map(p=>{const mal=(F.mal||[]).includes(p);return `<button class="tile ${mal?"mal":"bien"}" data-act="ctl-pt" data-k="${esc(p)}" aria-pressed="${mal}"><b>${mal?"✗":"✓"} ${esc(p)}</b><small>${mal?"Pas bon":"Bon"}</small></button>`}).join("")}</div>
   ${(F.mal||[]).length?`<div class="step"><i>4</i><span>Photo du problème</span></div>${photoBtn("photo","Prendre la photo")}<div class="step"><i>5</i><span>Expliquez <em>facultatif</em></span></div><input class="bigin" data-f="note" value="${esc(F.note||"")}" placeholder="ex. pneu avant gauche lisse"><div class="banner">Une panne sera déclarée automatiquement pour ce camion.</div>`:""}
   <div class="step"><i>${(F.mal||[]).length?6:4}</i><span>Kilométrage <em>facultatif</em></span></div><input class="bigin" data-f="km" inputmode="numeric" value="${esc(F.km||"")}" placeholder="ex. 152300">
   ${F.err?`<div class="err">${esc(F.err)}</div>`:""}
   <button class="send" data-act="b-ctl-send" ${F.busy?"disabled":""}>${F.busy?"Enregistrement…":(F.mal||[]).length?"Enregistrer : camion à revoir":"Tout est bon : enregistrer"}</button></div>`;
}

/* ===== HSE : inventaire du système de management (même structure que le fichier SMQ INVENTAIRE) ===== */
// [catégorie, onglet, titre de l'inventaire, préfixe de référence]
const CATS=[["Procédure","PROCÉDURES","INVENTAIRE DES PROCÉDURES","PRO"],["Instruction","INSTRUCTIONS","INVENTAIRE DES INSTRUCTIONS","INS"],["Enregistrement","ENREGISTREMENTS","INVENTAIRE DES ENREGISTREMENTS","ENR"],["Politique","POLITIQUES","INVENTAIRE DES POLITIQUES","POL"],["Registre","REGISTRES","INVENTAIRE DES REGISTRES","SO"]];
const COLS=["INTITULÉ","RÉFÉRENCE","SERVICE","DATE DE CRÉATION","DATE DE LA DERNIÈRE MISE À JOUR","OBJET DE LA MISE À JOUR","VERSION"];
let fCat="Procédure", fCherche="", voirRetires=false;
const derniereMaj=d=>d.date_maj||d.date_creation;
function smqEtat(d){
  if(!d.actif) return {c:"",t:"Retiré"};
  const m=derniereMaj(d); if(!m) return {c:"warn",t:"Date inconnue"};
  const lim=new Date(m);lim.setMonth(lim.getMonth()+(d.revision_mois||12));
  const j=Math.floor((lim.getTime()-Date.now())/JOUR);
  return j<0?{c:"bad",t:`À revoir (depuis ${-j} j)`}:j<=30?{c:"warn",t:`À revoir dans ${j} j`}:{c:"ok",t:"À jour"};
}
const smqARevoir=()=>S.smq.filter(d=>d.actif&&smqEtat(d).c!=="ok");
const peutSmq=()=>["hse","admin"].includes(role())&&["hse","admin"].includes(me.role);
// Prochaine référence : « PRO 028 QHSE V1 » (registres : « SO », comme dans l'inventaire).
function prochaineRef(cat,service,version){
  const c=CATS.find(x=>x[0]===cat); if(!c||c[3]==="SO") return "SO";
  const nums=S.smq.filter(d=>d.categorie===cat).map(d=>{const m=String(d.reference).toUpperCase().replace(/\s+/g,"").match(new RegExp("^"+c[3]+"(\\d+)"));return m?+m[1]:0});
  const n=String((nums.length?Math.max(...nums):0)+1).padStart(3,"0");
  return [c[3],n,String(service||"").trim().toUpperCase(),String(version||"V1").trim().toUpperCase()].filter(Boolean).join(" ");
}
function vSmq(){
  const C=CATS.find(c=>c[0]===fCat)||CATS[0];
  const actifs=S.smq.filter(d=>d.actif);
  const list=S.smq.filter(d=>(voirRetires?!d.actif:d.actif)&&d.categorie===C[0]&&(!fCherche||(d.intitule+" "+d.reference+" "+d.service).toLowerCase().includes(fCherche.toLowerCase())))
    .sort((a,b)=>String(a.reference).replace(/\s+/g,"").localeCompare(String(b.reference).replace(/\s+/g,""),"fr",{numeric:true})||ts(a.date_creation||a.created_at)-ts(b.date_creation||b.created_at));
  const revoir=smqARevoir(), sansF=actifs.filter(d=>!d.fichier);
  const cols=C[0]==="Registre"?COLS.slice(0,6):COLS;
  return `<div class="stack">
   <div class="row"><h2 class="grow">Inventaire SMQ</h2><button class="btn" data-act="smq-export">Exporter en Excel</button>${peutSmq()?`<button class="btn primary" data-act="smq-edit" data-id="">Ajouter ${C[0]==="Enregistrement"?"un enregistrement":C[0]==="Instruction"?"une instruction":C[0]==="Politique"?"une politique":C[0]==="Registre"?"un registre":"une procédure"}</button>`:""}</div>
   <div class="kpis">
    <div class="kpi"><span>Documents en vigueur</span><b>${actifs.length}</b><em>dans les 5 inventaires</em></div>
    <div class="kpi${revoir.some(d=>smqEtat(d).c==="bad")?" k-bad":revoir.length?" k-warn":" k-ok"}"><span>À revoir</span><b>${revoir.length}</b><em>pas mis à jour depuis 12 mois</em></div>
    <div class="kpi${sansF.length?" k-warn":" k-ok"}"><span>Sans fichier</span><b>${sansF.length}</b><em>joindre le document signé</em></div>
    <div class="kpi"><span>Retirés</span><b>${S.smq.length-actifs.length}</b><em>gardés dans l'historique</em></div>
   </div>
   <div class="vtiles">${CATS.map(([k,l,,pre])=>{const n=actifs.filter(d=>d.categorie===k);const r=n.filter(d=>smqEtat(d).c!=="ok").length;
     return `<button class="vtile t-${fCat===k?"sel":r?"warn":"ok"}" data-act="smq-cat" data-k="${k}"><span class="vt-top"><b style="font-size:16px">${esc(l)}</b><span class="chip blue">${pre}</span></span><span class="vt-l"><b style="font-size:26px">${n.length}</b> document(s)</span><span class="vt-l sub">${n.length?(r?r+" à revoir":"tout est à jour"):"vide"}</span></button>`}).join("")}</div>
   <div class="panel"><div class="phead"><h2 class="grow">${esc(C[2])}${voirRetires?" (retirés)":""}</h2>
     <input id="smq-q" placeholder="Chercher…" value="${esc(fCherche)}" style="max-width:220px">
     <button class="btn sm" data-act="smq-retires">${voirRetires?"Documents en vigueur":"Voir les retirés"}</button></div>
   ${list.length?`<div class="tbl"><table class="smq"><thead><tr>${cols.map(c=>`<th>${c}</th>`).join("")}<th>ÉTAT</th><th>FICHIER</th><th></th></tr></thead><tbody>${list.map(d=>{const e=smqEtat(d);return `<tr><td><b>${esc(d.intitule)}</b></td><td class="ref">${esc(d.reference||"")}</td><td>${esc(d.service)}</td><td>${dt(d.date_creation)}</td><td>${dt(d.date_maj)}</td><td>${esc(d.objet_maj)}</td>${C[0]==="Registre"?"":`<td>${esc(d.version)}</td>`}<td><span class="chip ${e.c}">${esc(e.t)}</span></td><td>${d.fichier?thumb(d.fichier,d.intitule):'<span class="sub">—</span>'}</td><td class="num">${peutSmq()?`<button class="btn sm" data-act="smq-edit" data-id="${d.id}">Mettre à jour</button>`:""}${S.smq_versions.some(v=>v.document_id===d.id)?` <button class="btn sm" data-act="smq-hist" data-id="${d.id}">Versions</button>`:""}</td></tr>`}).join("")}</tbody></table></div>`:`<div class="empty">${voirRetires?"Aucun document retiré.":peutSmq()?`Aucun document dans cet inventaire. Appuyez sur « Ajouter » : la référence est proposée toute seule (${esc(prochaineRef(C[0],"QHSE","V1"))}).`:"Aucun document dans cet inventaire."}</div>`}</div></div>`;
}
// Bibliothèque Excel (chargée à la demande).
let xlsxLib=null;
function chargerXlsx(){if(window.XLSX&&window.XLSX.read) return Promise.resolve();if(xlsxLib) return xlsxLib;
  xlsxLib=new Promise((ok,ko)=>{const s=document.createElement("script");s.src="assets/xlsx.mini.min.js";s.onload=ok;s.onerror=()=>{xlsxLib=null;ko(new Error("La lecture du fichier Excel n'a pas pu démarrer."))};document.head.appendChild(s)});return xlsxLib}
// Export : un classeur avec les 5 onglets et les colonnes de l'inventaire SMQ.
async function exporterSmq(){
  try{await chargerXlsx()}catch(e){toast(errMsg(e));return}
  const X=window.XLSX, wb=X.utils.book_new(), d8=v=>v?new Date(v+"T00:00:00"):"";
  CATS.forEach(([k,onglet,titre])=>{const reg=k==="Registre";const cols=reg?COLS.slice(0,6):COLS;
    const rows=S.smq.filter(d=>d.actif&&d.categorie===k).sort((a,b)=>String(a.reference).replace(/\s+/g,"").localeCompare(String(b.reference).replace(/\s+/g,""),"fr",{numeric:true}))
      .map(d=>{const r=[d.intitule,d.reference||"SO",d.service,d8(d.date_creation),d8(d.date_maj),d.objet_maj||""];if(!reg)r.push(d.version||"");return r});
    const ws=X.utils.aoa_to_sheet([[titre],[],cols,...rows],{cellDates:true,dateNF:"dd/mm/yyyy"});
    ws["!cols"]=[{wch:50},{wch:20},{wch:12},{wch:14},{wch:16},{wch:30},{wch:10}];ws["!merges"]=[{s:{r:0,c:0},e:{r:0,c:cols.length-1}}];
    X.utils.book_append_sheet(wb,ws,onglet)});
  X.writeFile(wb,"SMQ_INVENTAIRE_"+new Date().toISOString().slice(0,10)+".xlsx");
}

/* ===== Journal ===== */
function vJournal(){
  const j=S.journal;
  return `<div class="panel"><div class="phead"><h2 class="grow">Journal</h2><span class="sub">Toutes les actions, avec la personne et l'heure. Rien ne peut y être effacé.</span></div>
  ${j.length?`<div class="tbl"><table><thead><tr><th>Date</th><th>Personne</th><th>Rôle</th><th>Action</th><th>Référence</th></tr></thead><tbody>${j.map(e=>`<tr><td>${dtt(e.at)}</td><td>${esc(who(e.par))}</td><td>${esc(ROLES[e.role]||e.role||"")}</td><td>${esc(e.action)}</td><td class="ref">${esc(e.ref)}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty">Aucune action enregistrée.</div>'}</div>`;
}

/* ===== DG ===== */
function vValider(){
  const list=S.commandes.filter(b=>b.statut==="À valider").sort((a,b)=>ts(a.created_at)-ts(b.created_at));
  return `<div class="stack"><h2>Bons de commande à valider</h2><p class="sub">Une commande n'est valable que si elle est validée ici. Un accord donné par téléphone ne suffit pas.</p>
  ${list.length?`<div class="valid">${list.map(b=>{const d=b.demande_id?byId("demandes",b.demande_id):null;return `<div class="vcard w-${attenteCls(b.created_at,d&&d.urgent)}"><div class="row"><span class="ref">${esc(b.num)}</span>${d&&d.urgent?'<span class="chip bad">Urgent : camion arrêté</span>':""}${attChip(b.created_at,d&&d.urgent)}<span class="grow"></span><span class="amount">${xaf(b.total)}</span></div>
   <div><b>${esc(b.fournisseur)}</b> · ${esc(vName(b.vehicule_id))}</div>
   <div class="sub">${lignesDe(b.id).map(l=>`${esc(l.designation)} × ${l.qte} à ${xaf(l.pu)}`).join("<br>")}</div>
   <div class="docs">${d?docItem(d.photo,"Demande "+d.num):""}${docItem(b.devis,"Devis")}</div>
   ${b.note?`<div class="sub">Note : ${esc(b.note)}</div>`:""}
   <div class="sub">Préparé par ${esc(who(b.created_by))} le ${dt(b.created_at)}${d?` · demande ${esc(d.num)} du ${dt(d.created_at)}`:""}</div>
   ${canDo("valider")?`<div class="vbtns"><button class="btn ok" data-act="bc-ok" data-id="${b.id}">Valider</button><button class="btn bad" data-act="bc-no" data-id="${b.id}">Refuser</button></div>`:'<div class="sub">Seul le DG peut valider.</div>'}</div>`}).join("")}</div>`:'<div class="empty panel">Rien à valider pour le moment.</div>'}</div>`;
}
let zoom=null;
const debutMois=(k=0)=>{const n=new Date();return new Date(n.getFullYear(),n.getMonth()+k,1).getTime()};
const engage=b=>!["À valider","Refusé"].includes(b.statut);
function barres(rows,fmtV){const max=Math.max(1,...rows.map(r=>r[1]));
  return rows.length?`<div class="bars">${rows.map(([l,v])=>`<div class="bar"><span class="bl">${esc(l)}</span><span class="bt"><i style="width:${Math.max(2,Math.round(v/max*100))}%"></i></span><span class="bv">${fmtV(v)}</span></div>`).join("")}</div>`:'<div class="empty">Pas encore de données.</div>'}
function cartesBord(){
  const m0=debutMois(),m1=debutMois(-1);
  const bcM=S.commandes.filter(b=>engage(b)&&ts(b.valide_le||b.created_at)>=m0);
  const bcP=S.commandes.filter(b=>engage(b)&&ts(b.valide_le||b.created_at)>=m1&&ts(b.valide_le||b.created_at)<m0);
  const somme=a=>a.reduce((s,b)=>s+(+b.total||0),0);
  const av=S.commandes.filter(b=>b.statut==="À valider");
  const plusVieux=av.length?av.reduce((a,b)=>ts(a.created_at)<ts(b.created_at)?a:b):null;
  const conf=S.factures.filter(f=>f.statut==="Conforme");
  return [
    {k:"depenses",t:"Dépenses du mois",v:fmt(somme(bcM)),u:"XAF",s:`${bcM.length} bon(s) · mois dernier ${fmt(somme(bcP))} XAF`},
    {k:"attente",t:"Bons à valider",v:av.length,s:plusVieux?"le plus ancien "+depuis(plusVieux.created_at):"rien en attente",c:plusVieux?attenteCls(plusVieux.created_at,urgentBc(plusVieux)):"ok"},
    {k:"panne",t:"Camions en panne",v:S.vehicules.filter(v=>v.statut==="En panne").length,s:`sur ${S.vehicules.filter(v=>v.statut!=="Hors parc").length} camions`,c:S.vehicules.some(v=>v.statut==="En panne")?"bad":"ok"},
    {k:"entretien",t:"Entretiens à faire",v:entretiensAFaire().length,s:`${entretiensAFaire().filter(e=>entEtat(e).c==="bad").length} en retard`,c:entretiensAFaire().some(e=>entEtat(e).c==="bad")?"bad":entretiensAFaire().length?"warn":"ok"},
    {k:"papiers",t:"Papiers à renouveler",v:papiersAlerte().length,s:`${papiersAlerte().filter(p=>papierEtat(p).c==="bad").length} expiré(s)`,c:papiersAlerte().some(p=>papierEtat(p).c==="bad")?"bad":papiersAlerte().length?"warn":"ok"},
    {k:"carburant",t:"Carburant du mois",v:fmt(S.carburant.filter(c=>ts(c.fait_le)>=m0).reduce((s,c)=>s+(+c.litres||0),0)),u:"L",s:`${S.vehicules.filter(v=>conso4j(v.id)>LIMITE_4J).length} camion(s) au-dessus de ${LIMITE_4J} L / 4 jours`,c:S.vehicules.some(v=>conso4j(v.id)>LIMITE_4J)?"bad":""},
    {k:"ruptures",t:"Pièces sous le minimum",v:S.stock.filter(s=>["bad","warn"].includes(niveau(s))).length,s:"voir la commande suggérée",c:S.stock.some(s=>niveau(s)==="bad")?"bad":S.stock.some(s=>niveau(s)==="warn")?"warn":"ok"},
    {k:"hse",t:"Jours sans accident",v:joursSansAccident()??"—",s:`${new Set(S.controles.filter(c=>duJour(c.created_at)).map(c=>c.vehicule_id)).size} contrôle(s) avant départ aujourd'hui`,c:joursSansAccident()!==null&&joursSansAccident()<7?"bad":""},
    {k:"demandes",t:"Demandes en cours",v:S.demandes.filter(d=>!["Montée","Refusée"].includes(d.statut)).length,s:`${S.demandes.filter(d=>d.statut==="Nouvelle").length} nouvelle(s) à traiter`},
    {k:"livraisons",t:"Livraisons attendues",v:S.commandes.filter(b=>["Validé","Reçu partiel"].includes(b.statut)).length,s:"bons validés pas encore reçus"},
    {k:"dettes",t:"À payer aux fournisseurs",v:fmt(conf.reduce((s,f)=>s+(+f.montant||0),0)),u:"XAF",s:`${conf.length} facture(s) conforme(s)`},
    {k:"bloquees",t:"Factures bloquées",v:S.factures.filter(f=>f.statut==="Bloquée").length,s:"à vérifier par la logistique",c:S.factures.some(f=>f.statut==="Bloquée")?"warn":"ok"}
  ];
}
function classements(){
  const parCamion={},parPiece={},parFourn={};
  S.commandes.filter(engage).forEach(b=>{const k=b.vehicule_id?vName(b.vehicule_id):"Sans camion";parCamion[k]=(parCamion[k]||0)+(+b.total||0)});
  S.mouvements.filter(m=>m.type==="sortie").forEach(m=>{const k=designation(m.stock_id)||"Pièce";parPiece[k]=(parPiece[k]||0)+m.qte});
  S.factures.filter(f=>f.statut==="Payée").forEach(f=>{parFourn[f.fournisseur]=(parFourn[f.fournisseur]||0)+(+f.montant||0)});
  const top=o=>Object.entries(o).sort((a,b)=>b[1]-a[1]).slice(0,8);
  return {camion:top(parCamion),piece:top(parPiece),fourn:top(parFourn)};
}
function vBord(){
  if(zoom) return vZoom();
  const C=cartesBord(), R=classements();
  const phrase=[];
  const av=C.find(c=>c.k==="attente"); if(av.v) phrase.push(`${av.v} bon(s) attendent la validation du DG (${av.s}).`);
  const pn=C.find(c=>c.k==="panne"); if(pn.v) phrase.push(`${pn.v} camion(s) en panne.`);
  if(R.camion[0]) phrase.push(`Le camion qui a coûté le plus : ${R.camion[0][0]} (${xaf(R.camion[0][1])}).`);
  return `<div class="stack">
   <div class="panel"><div class="db"><div class="row"><b class="grow">En bref</b><button class="btn sm ok" data-act="rap-soir">Rapport du soir (WhatsApp)</button></div>${phrase.map(p=>`<div>${esc(p)}</div>`).join("")||"<div>Rien de spécial aujourd'hui.</div>"}</div></div>
   <div class="kpis">${C.map(c=>`<button class="kpi kbtn${c.c?" k-"+c.c:""}" data-act="zoom" data-k="${c.k}"><span>${esc(c.t)}</span><b>${c.v}${c.u?` <small>${c.u}</small>`:""}</b><em>${esc(c.s)}</em></button>`).join("")}</div>
   <div class="grid3">
    <div class="panel"><div class="phead"><h2 class="grow">Camions qui coûtent le plus</h2></div><div class="db">${barres(R.camion,xaf)}</div></div>
    <div class="panel"><div class="phead"><h2 class="grow">Pièces qui cassent le plus</h2></div><div class="db">${barres(R.piece,v=>v+" montée(s)")}</div></div>
    <div class="panel"><div class="phead"><h2 class="grow">Fournisseurs les plus payés</h2></div><div class="db">${barres(R.fourn,xaf)}</div></div>
   </div></div>`;
}
function vZoom(){
  const C=cartesBord().find(c=>c.k===zoom); if(!C){zoom=null;return vBord()}
  const back=`<button class="back" data-act="zoom" data-k="">← Retour à l'accueil</button>`;
  const tbl=(head,rows)=>rows.length?`<div class="tbl"><table><thead><tr>${head.map(h=>`<th${h.startsWith("#")?' class="num"':""}>${esc(h.replace(/^#/,""))}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`:'<div class="empty">Rien à afficher.</div>';
  let txt="",corps="";
  if(zoom==="depenses"){
    const mois=[];for(let k=-5;k<=0;k++){const a=debutMois(k),b=debutMois(k+1);mois.push([new Date(a).toLocaleDateString("fr-FR",{month:"short",year:"2-digit"}),S.commandes.filter(x=>engage(x)&&ts(x.valide_le||x.created_at)>=a&&ts(x.valide_le||x.created_at)<b).reduce((s,x)=>s+(+x.total||0),0)])}
    const [cur,prev]=[mois[5][1],mois[4][1]];
    txt=prev?(cur>prev?`Ce mois, vous avez engagé ${xaf(cur-prev)} de plus que le mois dernier.`:`Ce mois, vous avez engagé ${xaf(prev-cur)} de moins que le mois dernier.`):`Ce mois, ${xaf(cur)} engagés.`;
    const list=S.commandes.filter(b=>engage(b)&&ts(b.valide_le||b.created_at)>=debutMois()).sort(newest);
    corps=`<div class="panel"><div class="phead"><h2 class="grow">Les 6 derniers mois</h2></div><div class="db">${barres(mois,xaf)}</div></div>
     <div class="panel"><div class="phead"><h2 class="grow">Bons du mois</h2></div>${tbl(["N°","Fournisseur","Camion","#Montant","Statut"],list.map(b=>`<tr class="click" data-act="bc-open" data-id="${b.id}"><td class="ref">${esc(b.num)}</td><td>${esc(b.fournisseur)}</td><td>${esc(vName(b.vehicule_id))}</td><td class="num">${xaf(b.total)}</td><td>${chip("bc",b.statut)}</td></tr>`))}</div>`;
  }else if(zoom==="attente"){
    const list=S.commandes.filter(b=>b.statut==="À valider").sort((a,b)=>ts(a.created_at)-ts(b.created_at));
    txt=list.length?`${list.length} bon(s) attendent. Vert = moins d'un jour, orange = plus d'un jour, rouge = plus de 3 jours (2 h et 8 h si urgent).`:"Rien n'attend la validation du DG.";
    corps=`<div class="panel">${tbl(["N°","Fournisseur","Camion","#Montant","Attente"],list.map(b=>`<tr class="click" data-act="bc-open" data-id="${b.id}"><td class="ref">${esc(b.num)}</td><td>${esc(b.fournisseur)}</td><td>${esc(vName(b.vehicule_id))}</td><td class="num">${xaf(b.total)}</td><td>${attChip(b.created_at,urgentBc(b))}</td></tr>`))}</div>`;
  }else if(zoom==="panne"){
    const list=S.vehicules.filter(v=>v.statut==="En panne").sort(vSort);
    txt=list.length?`${list.length} camion(s) arrêté(s). Chaque jour d'arrêt coûte au contrat ENI.`:"Aucun camion en panne.";
    corps=`<div class="panel">${tbl(["Camion","Panne","Arrêté depuis","Demandes en cours"],list.map(v=>{const p=pannesOuvertes(v.id)[0];return `<tr class="click" data-act="voir-camion" data-id="${v.id}"><td class="ref">${esc(vName(v.id))}</td><td>${p?esc(p.description)+" "+chipPanne(p.statut):"—"}</td><td>${p?attChip(p.created_at,true):""}</td><td>${S.demandes.filter(d=>d.vehicule_id===v.id&&!["Montée","Refusée"].includes(d.statut)).map(d=>esc(d.num)+" "+chip("demande",d.statut)).join("<br>")||"—"}</td></tr>`}))}</div>`;
  }else if(zoom==="entretien"){
    const list=entretiensAFaire().map(e=>({e,x:entEtat(e)})).sort((a,b)=>(a.x.c==="bad"?0:1)-(b.x.c==="bad"?0:1));
    txt=list.length?"Entretiens en retard (rouge) ou bientôt à faire (orange).":"Aucun entretien à faire pour le moment.";
    corps=`<div class="panel">${tbl(["Camion","Entretien","Quand"],list.map(({e,x})=>`<tr class="click" data-act="voir-camion" data-id="${e.vehicule_id}"><td class="ref">${esc(vName(e.vehicule_id))}</td><td>${esc(e.type)}</td><td><span class="chip ${x.c}">${esc(x.t)}</span></td></tr>`))}</div>`;
  }else if(zoom==="demandes"){
    const list=S.demandes.filter(d=>!["Montée","Refusée"].includes(d.statut)).sort((a,b)=>ts(a.created_at)-ts(b.created_at));
    txt=`${list.length} demande(s) en cours, de la plus ancienne à la plus récente.`;
    corps=`<div class="panel">${tbl(["N°","Camion","Pièce","Statut","Depuis"],list.map(d=>`<tr><td class="ref">${esc(d.num)}${d.urgent?' <span class="chip bad">Urgent</span>':""}</td><td>${esc(vName(d.vehicule_id))}</td><td>${esc(d.piece||"Voir la photo")} × ${d.qte}</td><td>${chip("demande",d.statut)}</td><td>${attChip(d.created_at,d.urgent,d.statut!=="Nouvelle")}</td></tr>`))}</div>`;
  }else if(zoom==="livraisons"){
    const list=S.commandes.filter(b=>["Validé","Reçu partiel"].includes(b.statut)).sort((a,b)=>ts(a.valide_le)-ts(b.valide_le));
    txt=list.length?"Bons validés par le DG, pas encore livrés en entier à la base.":"Aucune livraison attendue.";
    corps=`<div class="panel">${tbl(["N°","Fournisseur","Camion","Statut","Validé"],list.map(b=>`<tr class="click" data-act="bc-open" data-id="${b.id}"><td class="ref">${esc(b.num)}</td><td>${esc(b.fournisseur)}</td><td>${esc(vName(b.vehicule_id))}</td><td>${chip("bc",b.statut)}</td><td>${attChip(b.valide_le||b.created_at,urgentBc(b),true)}</td></tr>`))}</div>`;
  }else if(zoom==="dettes"||zoom==="bloquees"){
    const st=zoom==="dettes"?"Conforme":"Bloquée";
    const list=S.factures.filter(f=>f.statut===st).sort(newest);
    const pf={};list.forEach(f=>pf[f.fournisseur]=(pf[f.fournisseur]||0)+(+f.montant||0));
    txt=zoom==="dettes"?"Factures contrôlées et conformes : le DG peut les payer.":"Factures bloquées par le contrôle : la logistique doit vérifier les motifs.";
    corps=`${zoom==="dettes"?`<div class="panel"><div class="phead"><h2 class="grow">Par fournisseur</h2></div><div class="db">${barres(Object.entries(pf).sort((a,b)=>b[1]-a[1]),xaf)}</div></div>`:""}
     <div class="panel">${tbl(["Facture","Fournisseur","#Montant","Motifs"],list.map(f=>`<tr><td class="ref">${esc(f.numero)}</td><td>${esc(f.fournisseur)}</td><td class="num">${xaf(f.montant)}</td><td>${(f.motifs||[]).map(esc).join("<br>")||"—"}</td></tr>`))}</div>`;
  }
  return `<div class="stack">${back}<div class="kpis"><div class="kpi${C.c?" k-"+C.c:""}"><span>${esc(C.t)}</span><b>${C.v}${C.u?` <small>${C.u}</small>`:""}</b><em>${esc(C.s)}</em></div></div>
   ${txt?`<div class="panel"><div class="db">${esc(txt)}</div></div>`:""}${corps}</div>`;
}

/* ===== Administration ===== */
function vParams(){
  const ps=[...S.profils].sort((a,b)=>ts(a.created_at)-ts(b.created_at));
  const ident=p=>{const e=p.email||"";return e.endsWith("@"+CFG.domaine)?e.slice(0,-(CFG.domaine.length+1)):e};
  return `<div class="stack"><div class="panel"><div class="phead"><h2 class="grow">Comptes</h2><button class="btn primary" data-act="cpt-new">Créer un compte</button></div>
  <div class="db"><p class="sub">Créez un compte par personne. Donnez-lui son identifiant et son mot de passe. Une personne sans rôle ou désactivée ne voit rien.</p></div>
  ${ps.length?`<div class="tbl"><table><thead><tr><th>Personne</th><th>Identifiant</th><th>Rôle</th><th>Accès</th><th></th></tr></thead><tbody>${ps.map(p=>p.id===me.id?`<tr><td>${esc(p.nom)} (vous)</td><td>${esc(ident(p))}</td><td>Administration</td><td><span class="chip ok">Actif</span></td><td class="num"><button class="btn sm" data-act="mon-mdp">Changer mon mot de passe</button></td></tr>`:`<tr><td>${esc(p.nom)}</td><td>${esc(ident(p))}</td><td><select data-role="${p.id}" style="width:auto"><option value="">Aucun accès</option>${["base","logistique","dg","hse","admin"].map(k=>`<option value="${k}"${p.role===k?" selected":""}>${ROLES[k]}</option>`).join("")}</select></td><td>${p.actif?`<button class="btn sm" data-act="cpt-actif" data-id="${p.id}" data-v="0">Désactiver</button>`:`<button class="btn sm ok" data-act="cpt-actif" data-id="${p.id}" data-v="1">Réactiver</button>`}</td><td class="num"><button class="btn sm" data-act="cpt-mdp" data-id="${p.id}">Changer le mot de passe</button></td></tr>`).join("")}</tbody></table></div>`:""}</div>
  <div class="panel"><div class="phead"><h2 class="grow">Validation du DG</h2></div><div class="db">
   <div class="f" style="max-width:360px"><label for="seuil">Validation obligatoire au-dessus de (XAF)</label><input id="seuil" type="number" min="0" value="${+S.seuil||0}"></div>
   <p class="sub">0 = toutes les commandes passent par le DG (recommandé). Sous le seuil, la commande est validée automatiquement et le journal l'indique.</p>
   <div><button class="btn primary" data-act="seuil-save">Enregistrer</button></div></div></div>
  <div class="panel"><div class="phead"><h2 class="grow">Signature et cachet</h2></div><div class="db">
   <p class="sub">Ils sont posés automatiquement sur les bons de commande, seulement après la validation du DG.</p>
   <div class="row"><span>Signature du DG : ${reglages.signature_dg?'<span class="chip ok">Enregistrée</span>':'<span class="chip warn">Manquante</span>'}</span><button class="btn sm" data-act="sig-up" data-k="signature">Envoyer l'image</button></div>
   <div class="row"><span>Cachet de STP2i : ${reglages.cachet?'<span class="chip ok">Enregistré</span>':'<span class="chip warn">Manquant</span>'}</span><button class="btn sm" data-act="sig-up" data-k="cachet">Envoyer l'image</button></div></div></div></div>`;
}

/* ---------- Dialogue générique ---------- */
let dlgOnOk=null;
function openDlg(title,body,okLabel,onOk,okCls){
  $("#dlgt").textContent=title; $("#dlgb").innerHTML=body;
  $("#dlgf").innerHTML=`<span class="err grow" id="dlgerr"></span><button type="button" class="btn" data-act="dlg-cancel">${okLabel?"Annuler":"Fermer"}</button>${okLabel?`<button type="submit" class="btn ${okCls||"primary"}" id="dlgok">${okLabel}</button>`:""}`;
  dlgOnOk=onOk; $("#dlg").showModal();
}
$("#dlgform").addEventListener("submit",async e=>{e.preventDefault(); if(!dlgOnOk) return; const b=$("#dlgok"); b.disabled=true; $("#dlgerr").textContent="";
  try{const r=await dlgOnOk(); if(r!==false){$("#dlg").close();charger()}}catch(err){$("#dlgerr").textContent=typeof err==="string"?err:errMsg(err)} finally{b.disabled=false}});
$("#dlg").addEventListener("close",()=>render(true));
const val=id=>{const el=document.getElementById(id);return el?el.value.trim():""};

/* ---------- Bon de commande ---------- */
function bcLinesHTML(lines){return lines.map((l,i)=>`<tr><td><input id="l-d-${i}" value="${esc(l.designation)}" aria-label="Désignation"></td><td style="width:80px"><input id="l-q-${i}" type="number" min="1" value="${l.qte}" aria-label="Quantité"></td><td style="width:140px"><input id="l-p-${i}" type="number" min="0" value="${l.pu??""}" aria-label="Prix unitaire"></td><td style="width:40px">${lines.length>1?`<button type="button" class="btn sm" data-act="l-del" data-i="${i}" aria-label="Supprimer la ligne">×</button>`:""}</td></tr>`).join("")}
let bcDraft=null;
function readLines(){return bcDraft.lines.map((l,i)=>({designation:val("l-d-"+i),qte:+val("l-q-"+i)||0,pu:val("l-p-"+i)===""?null:+val("l-p-"+i)}))}
function bcTotal(){const t=readLines().reduce((s,l)=>s+(l.qte*(l.pu||0)),0);$("#bc-total").textContent=xaf(t)}
function openBcNew(dId){
  const d=byId("demandes",dId); if(!d) return;
  bcDraft={d:dId,lines:[{designation:d.piece||"",qte:d.qte,pu:null}]};
  const fourn=[...new Set(S.commandes.map(b=>b.fournisseur).filter(Boolean))];
  openDlg("Bon de commande pour "+d.num,`
   <div class="card">${thumb(d.photo,"Demande")}<div class="grow"><b>${esc(d.piece||"Voir la photo")} × ${d.qte}</b><div class="sub">${esc(vName(d.vehicule_id))} · ${dt(d.created_at)}${d.urgent?" · urgent":""}</div>${d.motif?`<div class="sub">${esc(d.motif)}</div>`:""}</div></div>
   <div class="f"><label for="bc-f">Fournisseur</label><input id="bc-f" list="fourn-list" required><datalist id="fourn-list">${fourn.map(f=>`<option value="${esc(f)}">`).join("")}</datalist></div>
   <div class="f"><label>Lignes (prix unitaire en XAF)</label><div class="tbl"><table class="lines"><thead><tr><th>Désignation</th><th>Qté</th><th>Prix unitaire</th><th></th></tr></thead><tbody id="bc-lines">${bcLinesHTML(bcDraft.lines)}</tbody></table></div><div class="row"><button type="button" class="btn sm" data-act="l-add">Ajouter une ligne</button><span class="grow"></span><b>Total : <span id="bc-total">0 XAF</span></b></div></div>
   <div class="f"><label for="bc-devis">Devis du fournisseur (photo ou PDF)</label><input id="bc-devis" type="file" accept="image/*,application/pdf"></div>
   <div class="f"><label for="bc-note">Note</label><input id="bc-note"></div>`,
  S.seuil>0?"Enregistrer le bon de commande":"Envoyer au DG pour validation",async()=>{
    const fourn=val("bc-f"), lines=readLines().filter(l=>l.designation);
    if(!fourn) throw "Indiquez le fournisseur.";
    if(!lines.length) throw "Ajoutez au moins une ligne.";
    if(lines.some(l=>l.qte<=0||l.pu===null||isNaN(l.pu))) throw "Chaque ligne doit avoir une quantité et un prix.";
    const file=$("#bc-devis").files[0]; const devis=file?await upload(file):null;
    const num=await rpc("stp2i_creer_commande",{p_demande:bcDraft.d,p_fournisseur:fourn,p_lignes:lines,p_devis:devis,p_note:val("bc-note")});
    toast(num+" enregistré");
  });
  setTimeout(bcTotal,0);
}
function openBc(id){
  const b=byId("commandes",id); if(!b) return;
  const d=b.demande_id?byId("demandes",b.demande_id):null;
  const brs=S.receptions.filter(r=>r.commande_id===b.id); const f=S.factures.find(x=>x.commande_id===b.id);
  const hist=S.journal.filter(j=>String(j.ref||"").includes(b.num)).sort((x,y)=>ts(x.at)-ts(y.at));
  openDlg(b.num+" · "+b.fournisseur,`
   <div class="row">${chip("bc",b.statut)}<span class="sub">${esc(vName(b.vehicule_id))} · créé le ${dt(b.created_at)} par ${esc(who(b.created_by))}${b.valide_le?` · validé le ${dt(b.valide_le)}${b.valide_par?" par "+esc(who(b.valide_par)):" (sous le seuil)"}`:""}</span></div>
   ${b.motif?`<div class="banner">Refusé : ${esc(b.motif)}</div>`:""}
   <div class="tbl"><table><thead><tr><th>Désignation</th><th class="num">Commandé</th><th class="num">Reçu</th><th class="num">Prix unitaire</th><th class="num">Montant</th></tr></thead><tbody>${lignesDe(b.id).map(l=>`<tr><td>${esc(l.designation)}</td><td class="num">${l.qte}</td><td class="num">${l.recu||0}</td><td class="num">${fmt(l.pu)}</td><td class="num">${fmt(l.qte*l.pu)}</td></tr>`).join("")}<tr><td colspan="4"><b>Total</b></td><td class="num"><b>${xaf(b.total)}</b></td></tr></tbody></table></div>
   <div class="f"><label>Documents</label><div class="docs">${d?docItem(d.photo,"Demande "+d.num):""}${docItem(b.devis,"Devis")}${brs.map(r=>docItem(r.photo,r.num+(r.bl_num?" · "+r.bl_num:""))).join("")}${f?docItem(f.fichier,"Facture "+f.numero):""}</div></div>
   ${b.note?`<div class="sub">Note : ${esc(b.note)}</div>`:""}
   ${b.hors_contrat?`<div class="banner">Hors contrat : ${esc(b.hors_contrat_note)}</div>`:""}
   <div class="row"><button type="button" class="btn primary" data-act="bc-print" data-id="${b.id}">Bon de commande en PDF</button>${brs.map(r=>`<button type="button" class="btn" data-act="br-print" data-id="${r.id}">${esc(r.num)} en PDF</button>`).join("")}${["logistique","dg"].includes(role())&&engage(b)?`<button type="button" class="btn" data-act="bc-hc" data-id="${b.id}">${b.hors_contrat?"Remettre dans le contrat":"Hors contrat"}</button>`:""}</div>
   <div class="f"><label>Historique</label><div class="hist">${hist.map(h=>`<div>${dtt(h.at)} · ${esc(who(h.par))} · ${esc(h.action)}</div>`).join("")||"—"}</div></div>`,null,null);
}

/* ---------- Actions ---------- */
const H={};
H.tab=d=>{tab=d.k;screen="home";zoom=null;fiche=null;F={};render(true)};
H["voir-camion"]=d=>{tab="camions";fiche=d.id;zoom=null;render(true);window.scrollTo(0,0)};
H.zoom=d=>{if(["papiers","carburant","ruptures","hse"].includes(d.k)){if(d.k==="ruptures")d.k="stock";tab=d.k;zoom=null;render(true);window.scrollTo(0,0);return}zoom=d.k||null;render(true);window.scrollTo(0,0)};
H.go=d=>{screen=d.s;F={qte:1};render(true);window.scrollTo(0,0);if(d.s==="recv")charger()};
H.pick=d=>{if(d.k==="urgent")F.urgent=d.v==="1";else if(d.k==="rendue")F.rendue=d.v;else F[d.k]=d.v||null;
  if(d.k==="bc"&&d.v){const b=S.attendues.find(x=>x.id===d.v);if(!b){F.bc=null;return render(true)}(b.lignes||[]).forEach((l,i)=>F["r"+i]=Math.max(0,l.qte-(l.recu||0)))}
  if(d.k==="item"&&d.v){F.qte=1}
  F.err="";render(true)};
H.qty=d=>{let max=99;if(screen==="mount"&&F.item){const s=byId("stock",F.item);max=s?qteLieu(s,"Base"):1}
  const min=d.k==="qte"?1:0;F[d.k]=Math.min(max,Math.max(min,(+F[d.k]||0)+(+d.d)));render(true)};
H["lb-close"]=()=>$("#lightbox").close();
H.view=async d=>{const p=d.p;await signer([p]);const u=urlCache[p];if(!u){toast("Document indisponible");return}
  $("#lbopen").href=u;$("#lbb").innerHTML=isImgPath(p)?`<img src="${esc(u)}" alt="Document">`:'<p>Ce document est un fichier PDF. Utilisez le bouton « Ouvrir ».</p>';$("#lightbox").showModal()};
H["dlg-cancel"]=()=>$("#dlg").close();
H.logout=async()=>{await sb.auth.signOut();};
// Premier démarrage : le serveur refuse si un administrateur existe déjà.
H["vers-setup"]=()=>{F={};boot="setup";render(true)};
H["vers-login"]=()=>{F={};boot="login";render(true)};
async function action(fn,okMsg){F.busy=true;F.err="";render(true);
  try{const r=await fn();screen="home";F={};toast(typeof okMsg==="function"?okMsg(r):okMsg);charger();render(true)}
  catch(e){F.busy=false;F.err=errMsg(e);render(true)}}
H["b-new-send"]=()=>{
  if(!F.veh){F.err="Choisissez le camion.";return render(true)}
  if(!F.photo&&!(F.piece||"").trim()){F.err="Prenez une photo ou écrivez le nom de la pièce.";return render(true)}
  action(()=>rpc("stp2i_creer_demande",{p_vehicule:F.veh,p_piece:(F.piece||"").trim(),p_qte:F.qte||1,p_urgent:!!F.urgent,p_photo:F.photo||null}),n=>"Demande "+n+" envoyée");
};
H["b-recv-send"]=()=>{
  const b=S.attendues.find(x=>x.id===F.bc); if(!b) return;
  const lignes=(b.lignes||[]).map((l,i)=>({ligne_id:l.id,qte:+F["r"+i]||0})).filter(x=>x.qte>0);
  if(!lignes.length){F.err="Indiquez au moins une pièce reçue.";return render(true)}
  if(!F.bl){F.err="Prenez la photo du bon de livraison.";return render(true)}
  action(()=>rpc("stp2i_receptionner",{p_commande:b.id,p_lignes:lignes,p_photo:F.bl,p_bl:(F.blnum||"").trim()}),n=>"Réception "+n+" enregistrée");
};
H["b-mount-send"]=()=>{
  const s=byId("stock",F.item); if(!s) return;
  if(!F.veh){F.err="Choisissez le camion.";return render(true)}
  if(!F.old){F.err="Prenez la photo de la pièce usée. Pas de pièce neuve sans pièce usée rendue.";return render(true)}
  if(F.rendue==="0"&&!(F.motif||"").trim()){F.err="La pièce usée n'est pas rendue : dites pourquoi.";return render(true)}
  const km=parseInt(String(F.km||"").replace(/\D/g,""),10)||null;
  action(()=>rpc("stp2i_monter_piece",{p_stock:s.id,p_vehicule:F.veh,p_qte:Math.min(F.qte||1,qteLieu(s,"Base")),p_photo:F.old,p_km:km,p_site:"Base",p_demande:null,p_motif:(F.motif||"").trim(),p_ancienne_rendue:F.rendue!=="0"}),"Sortie enregistrée");
};
H["bc-new"]=d=>openBcNew(d.id);
H["l-add"]=()=>{bcDraft.lines=readLines();bcDraft.lines.push({designation:"",qte:1,pu:null});$("#bc-lines").innerHTML=bcLinesHTML(bcDraft.lines);bcTotal()};
H["l-del"]=d=>{bcDraft.lines=readLines();bcDraft.lines.splice(+d.i,1);$("#bc-lines").innerHTML=bcLinesHTML(bcDraft.lines);bcTotal()};
H["dem-refuse"]=dd=>{const d=byId("demandes",dd.id);openDlg("Refuser "+d.num,`<div class="f"><label for="motif">Motif (visible par la base)</label><input id="motif" required></div>`,"Refuser la demande",async()=>{const m=val("motif");if(!m) throw "Indiquez le motif.";await rpc("stp2i_refuser_demande",{p_id:d.id,p_motif:m});toast("Demande refusée")},"bad")};
H["bc-open"]=d=>openBc(d.id);
H["bc-ok"]=async dd=>{const b=byId("commandes",dd.id);if(!b)return;
  try{await rpc("stp2i_valider_commande",{p_id:b.id});toast(b.num+" validé");charger()}catch(e){toast(errMsg(e))}};
H["bc-no"]=dd=>{const b=byId("commandes",dd.id);openDlg("Refuser "+b.num,`<div class="f"><label for="motif">Motif du refus</label><input id="motif" required placeholder="ex. trop cher, demander un autre devis"></div><p class="sub">La demande revient à la logistique, qui pourra préparer un nouveau bon de commande.</p>`,"Refuser",async()=>{const m=val("motif");if(!m) throw "Indiquez le motif.";
  await rpc("stp2i_refuser_commande",{p_id:b.id,p_motif:m});toast(b.num+" refusé")},"bad")};
H["fac-new"]=()=>{
  const bcs=S.commandes.filter(b=>["Validé","Reçu partiel","Reçu"].includes(b.statut)&&!S.factures.some(f=>f.commande_id===b.id)).sort(newest);
  openDlg("Enregistrer une facture",`
   <div class="f"><label for="fa-bc">Bon de commande</label><select id="fa-bc"><option value="">Choisir…</option>${bcs.map(b=>`<option value="${b.id}">${esc(b.num)} · ${esc(b.fournisseur)} · ${xaf(b.total)}</option>`).join("")}</select></div>
   <div class="grid2"><div class="f"><label for="fa-n">N° de facture</label><input id="fa-n"></div><div class="f"><label for="fa-d">Date de la facture</label><input id="fa-d" type="date"></div></div>
   <div class="f"><label for="fa-m">Montant (XAF)</label><input id="fa-m" type="number" min="0"></div>
   <div class="f"><label for="fa-file">Facture (photo ou PDF)</label><input id="fa-file" type="file" accept="image/*,application/pdf"></div>
   <p class="sub">Le contrôle est automatique : bon de commande validé par le DG, livraison reçue à la base, montant identique, pas de doublon. Une facture bloquée ne peut pas être payée.</p>`,
  "Enregistrer et contrôler",async()=>{
    const bcId=val("fa-bc"),n=val("fa-n"),m=val("fa-m"),file=$("#fa-file").files[0];
    if(!bcId) throw "Choisissez le bon de commande. Une facture sans bon de commande n'est pas acceptée.";
    if(!n) throw "Indiquez le numéro de facture."; if(m==="") throw "Indiquez le montant."; if(!file) throw "Joignez la facture.";
    const fichier=await upload(file);
    const st=await rpc("stp2i_enregistrer_facture",{p_commande:bcId,p_numero:n,p_date:val("fa-d")||null,p_montant:+m,p_fichier:fichier});
    toast(st==="Conforme"?"Facture conforme":"Facture bloquée : voir les motifs");
  });
};
H["fac-recheck"]=async d=>{try{const st=await rpc("stp2i_controler_facture",{p_id:d.id});toast("Facture : "+st);charger()}catch(e){toast(errMsg(e))}};
H["fac-pay"]=dd=>{const f=byId("factures",dd.id);const c=byId("commandes",f.commande_id);openDlg("Paiement de la facture "+f.numero,`<p>${esc(f.fournisseur)} · ${xaf(f.montant)} · ${esc(c?c.num:"")}</p><div class="f"><label for="pay-ref">Référence du paiement (virement, chèque)</label><input id="pay-ref"></div>`,"Marquer payée",async()=>{
  await rpc("stp2i_payer_facture",{p_id:f.id,p_ref:val("pay-ref")});toast("Facture payée")},"ok")};
H["veh-edit"]=dd=>{const v=dd.id?veh(dd.id):{};openDlg(dd.id?"Modifier "+v.code:"Ajouter un camion",`
  <div class="grid2"><div class="f"><label for="v-code">Code</label><input id="v-code" value="${esc(v.code||"")}" placeholder="CE-08"></div><div class="f"><label for="v-imm">Immatriculation</label><input id="v-imm" value="${esc(v.immat||"")}"></div>
  <div class="f"><label for="v-type">Type</label><select id="v-type">${["Camion-citerne eau","Mini citerne carburant","Pick-up","Autre"].map(t=>`<option${t===v.type?" selected":""}>${t}</option>`).join("")}</select></div><div class="f"><label for="v-ch">Chauffeur</label><input id="v-ch" value="${esc(v.chauffeur||"")}"></div>
  <div class="f"><label for="v-st">Statut</label><select id="v-st">${["En service","En panne","Hors parc"].map(t=>`<option${t===(v.statut||"En service")?" selected":""}>${t}</option>`).join("")}</select></div></div>`,"Enregistrer",async()=>{
  const code=val("v-code"); if(!code) throw "Indiquez le code.";
  if(S.vehicules.some(x=>x.id!==dd.id&&String(x.code).toLowerCase()===code.toLowerCase())) throw "Ce code existe déjà.";
  await rpc("stp2i_enregistrer_vehicule",{p_id:dd.id||null,p_code:code,p_immat:val("v-imm"),p_type:val("v-type"),p_chauffeur:val("v-ch"),p_statut:val("v-st")});toast("Camion enregistré")})};
H["km-releve"]=()=>{const vs=[...S.vehicules].filter(v=>v.statut!=="Hors parc").sort(vSort);openDlg("Relevé des kilomètres (WhatsGPS)",`<p class="sub">Recopiez le kilométrage affiché sur WhatsGPS. Laissez vide si inchangé.</p>${vs.map(v=>`<div class="row"><span class="ref" style="width:80px">${esc(v.code)}</span><span class="sub grow">${v.km?"Dernier : "+fmt(v.km)+" km":"Aucun relevé"}</span><input id="km-${v.id}" type="number" min="0" style="width:150px" aria-label="Kilométrage ${esc(v.code)}"></div>`).join("")}`,"Enregistrer",async()=>{
  const rel=[];for(const v of vs){const x=val("km-"+v.id);if(x===""||+x===v.km)continue;if(v.km&&+x<v.km) throw `${v.code} : le kilométrage ne peut pas baisser (dernier ${fmt(v.km)}).`;rel.push({id:v.id,km:Math.round(+x)})}
  const n=rel.length?await rpc("stp2i_relever_km",{p_releves:rel}):0;toast(n?n+" relevé(s) enregistré(s)":"Aucun changement")})};
H["seuil-save"]=async()=>{try{await rpc("stp2i_definir_seuil",{p_seuil:Math.max(0,+val("seuil")||0)});toast("Réglage enregistré");charger()}catch(e){toast(errMsg(e))}};
H["cpt-new"]=()=>openDlg("Créer un compte",`
  <div class="f"><label for="c-nom">Nom complet</label><input id="c-nom" placeholder="ex. VOUMISSA Gloria"></div>
  <div class="grid2"><div class="f"><label for="c-id">Identifiant</label><input id="c-id" autocapitalize="none" placeholder="ex. gloria"></div>
  <div class="f"><label for="c-role">Rôle</label><select id="c-role">${["base","logistique","dg","hse","admin"].map(k=>`<option value="${k}">${ROLES[k]}</option>`).join("")}</select></div></div>
  <div class="f"><label for="c-pw">Mot de passe (6 caractères minimum)</label><input id="c-pw" autocomplete="new-password"></div>
  <p class="sub">Communiquez l'identifiant et le mot de passe à la personne en main propre.</p>`,"Créer le compte",async()=>{
  const roleVoulu=val("c-role");
  const r=await fonction({action:"creer",nom:val("c-nom"),identifiant:val("c-id"),mot_de_passe:$("#c-pw").value,role:roleVoulu==="hse"?"base":roleVoulu});
  if(roleVoulu==="hse"){const {data}=await sb.from("stp2i_profils").select("id").eq("email",r.email).maybeSingle();if(data) await rpc("stp2i_definir_role",{p_user:data.id,p_role:"hse",p_actif:true})}
  openDlg("Compte créé",`<p>Donnez ces informations à la personne :</p><p>Identifiant : <b>${esc(r.identifiant||r.email)}</b></p><p class="sub">Le mot de passe est celui que vous venez de choisir.</p>`,null,null);charger();return false});
H["cpt-mdp"]=dd=>{const p=byId("profils",dd.id);openDlg("Nouveau mot de passe pour "+(p.nom||p.email),`<div class="f"><label for="m-pw">Nouveau mot de passe (6 caractères minimum)</label><input id="m-pw" autocomplete="new-password"></div>`,"Enregistrer",async()=>{
  await fonction({action:"mot_de_passe",id:p.id,mot_de_passe:$("#m-pw").value});toast("Mot de passe changé")})};
H["mon-mdp"]=()=>openDlg("Changer mon mot de passe",`<div class="f"><label for="mm-pw">Nouveau mot de passe (6 caractères minimum)</label><input id="mm-pw" type="password" autocomplete="new-password"></div>`,"Enregistrer",async()=>{
  const pw=$("#mm-pw").value; if(pw.length<6) throw "Le mot de passe doit faire au moins 6 caractères.";
  const {error}=await sb.auth.updateUser({password:pw}); if(error) throw error; toast("Mot de passe changé")});
H["cpt-actif"]=async dd=>{const p=byId("profils",dd.id);try{await rpc("stp2i_definir_role",{p_user:p.id,p_role:p.role,p_actif:dd.v==="1"});toast(dd.v==="1"?"Compte réactivé":"Compte désactivé");charger()}catch(e){toast(errMsg(e))}};

/* ---------- Camions, pannes, entretien ---------- */
H.fiche=d=>{fiche=d.id||null;render(true);window.scrollTo(0,0)};
H["dem-camion"]=d=>{tab="base";screen="new";F={qte:1,veh:d.id};fiche=null;render(true);window.scrollTo(0,0)};
H["b-panne-send"]=()=>{
  if(!F.veh){F.err="Choisissez le camion.";return render(true)}
  if(!(F.desc||"").trim()){F.err="Dites ce qui ne va pas.";return render(true)}
  const km=parseInt(String(F.km||"").replace(/\D/g,""),10)||null;
  action(()=>rpc("stp2i_declarer_panne",{p_vehicule:F.veh,p_description:F.desc.trim(),p_photo:F.photo||null,p_km:km}),n=>"Panne "+n+" déclarée");
};
H["panne-new"]=d=>{const v=veh(d.id);openDlg("Panne sur "+v.code,`
  <div class="f"><label for="pn-d">Qu'est-ce qui ne va pas ?</label><input id="pn-d" placeholder="ex. fuite d'huile sous le moteur"></div>
  <div class="grid2"><div class="f"><label for="pn-km">Kilométrage (facultatif)</label><input id="pn-km" type="number" min="0"></div>
  <div class="f"><label for="pn-ph">Photo (facultatif)</label><input id="pn-ph" type="file" accept="image/*" capture="environment"></div></div>
  <p class="sub">Le camion passe « En panne ». Il revient « En service » quand toutes ses pannes sont réparées.</p>`,"Déclarer la panne",async()=>{
  const desc=val("pn-d"); if(!desc) throw "Dites ce qui ne va pas.";
  const f=$("#pn-ph").files[0]; const photo=f?await upload(f):null;
  const n=await rpc("stp2i_declarer_panne",{p_vehicule:v.id,p_description:desc,p_photo:photo,p_km:val("pn-km")?Math.round(+val("pn-km")):null});toast("Panne "+n+" déclarée")},"bad")};
H["panne-step"]=d=>{const p=byId("pannes",d.id);if(!p)return;
  if(d.s==="En réparation"){rpc("stp2i_avancer_panne",{p_id:p.id,p_statut:"En réparation",p_note:""}).then(()=>{toast(p.num+" en réparation");charger()}).catch(e=>toast(errMsg(e)));return}
  openDlg(p.num+" réparée",`<p>${esc(vName(p.vehicule_id))} · ${esc(p.description)}</p><div class="f"><label for="pn-r">Qu'est-ce qui a été réparé ?</label><input id="pn-r" placeholder="ex. joint de carter changé"></div>`,"Panne réparée",async()=>{
    const n=val("pn-r"); if(!n) throw "Dites ce qui a été réparé.";
    await rpc("stp2i_avancer_panne",{p_id:p.id,p_statut:"Réparée",p_note:n});toast(p.num+" réparée")},"ok")};
H["fiche-edit"]=d=>{const v=veh(d.id);openDlg("Fiche de "+v.code,`
  <div class="grid2"><div class="f"><label for="fi-m">Marque et modèle</label><input id="fi-m" value="${esc(v.marque||"")}"></div><div class="f"><label for="fi-a">Année</label><input id="fi-a" type="number" min="1970" max="2100" value="${v.annee||""}"></div></div>
  <div class="f"><label for="fi-n">Notes</label><textarea id="fi-n" rows="3">${esc(v.notes||"")}</textarea></div>`,"Enregistrer",async()=>{
  await rpc("stp2i_fiche_vehicule",{p_id:v.id,p_marque:val("fi-m"),p_annee:val("fi-a")?+val("fi-a"):null,p_notes:val("fi-n")});toast("Fiche enregistrée")})};
H.chauffeur=d=>{const v=veh(d.id);openDlg("Chauffeur de "+v.code,`<p class="sub">Chauffeur actuel : ${esc(v.chauffeur||"aucun")}. L'ancien reste dans l'historique.</p>
  <div class="f"><label for="ch-n">Nouveau chauffeur</label><input id="ch-n"></div><div class="f"><label for="ch-m">Motif</label><input id="ch-m" placeholder="ex. congé, nouvelle embauche"></div>`,"Enregistrer",async()=>{
  if(!val("ch-m")) throw "Indiquez le motif.";
  await rpc("stp2i_changer_chauffeur",{p_vehicule:v.id,p_chauffeur:val("ch-n"),p_motif:val("ch-m")});toast("Chauffeur changé")})};
H["ent-new"]=d=>{const v=veh(d.id);openDlg("Programmer un entretien sur "+v.code,`
  <div class="f"><label for="en-t">Entretien</label><input id="en-t" list="en-l" placeholder="ex. Vidange"><datalist id="en-l">${["Vidange","Filtre à gasoil","Filtre à air","Graissage","Freins","Pneus","Courroie"].map(x=>`<option value="${x}">`).join("")}</datalist></div>
  <div class="grid2"><div class="f"><label for="en-km">Tous les (km)</label><input id="en-km" type="number" min="1" placeholder="10000"></div><div class="f"><label for="en-j">Ou tous les (jours)</label><input id="en-j" type="number" min="1" placeholder="180"></div>
  <div class="f"><label for="en-dk">Fait la dernière fois à (km)</label><input id="en-dk" type="number" min="0" value="${v.km||""}"></div><div class="f"><label for="en-dl">Le</label><input id="en-dl" type="date"></div></div>
  <p class="sub">L'alerte passe orange 1 000 km ou 14 jours avant, rouge quand c'est dépassé.</p>`,"Enregistrer",async()=>{
  if(!val("en-t")) throw "Indiquez l'entretien."; if(!val("en-km")&&!val("en-j")) throw "Indiquez tous les combien de km ou de jours.";
  await rpc("stp2i_definir_entretien",{p_vehicule:v.id,p_type:val("en-t"),p_tous_km:val("en-km")?+val("en-km"):null,p_tous_jours:val("en-j")?+val("en-j"):null,p_dernier_km:val("en-dk")?+val("en-dk"):null,p_dernier_le:val("en-dl")||null});toast("Entretien programmé")})};
H["ent-fait"]=d=>{const e=byId("entretiens",d.id);const v=veh(e.vehicule_id);openDlg(e.type+" fait sur "+v.code,`
  <div class="grid2"><div class="f"><label for="ef-km">Kilométrage</label><input id="ef-km" type="number" min="0" value="${v.km||""}"></div><div class="f"><label for="ef-d">Date</label><input id="ef-d" type="date" value="${new Date().toISOString().slice(0,10)}"></div></div>
  <div class="f"><label for="ef-n">Note (facultatif)</label><input id="ef-n"></div>`,"Enregistrer",async()=>{
  await rpc("stp2i_faire_entretien",{p_id:e.id,p_km:val("ef-km")?+val("ef-km"):null,p_le:val("ef-d")||null,p_note:val("ef-n")});toast("Entretien enregistré")},"ok")};
H.qr=async d=>{const v=veh(d.id);try{await chargerQR()}catch(e){toast(errMsg(e));return}
  openDlg("QR de "+v.code,`<div class="qrbox">${qrSvg(lienCamion(v),260)}<b>${esc(v.code)}</b><span class="sub">Collez ce QR dans la cabine. En le scannant, on ouvre la fiche du camion (après connexion).</span></div>`,"Imprimer",async()=>{imprimerQR([v]);return false})};
H["qr-tous"]=async()=>{try{await chargerQR()}catch(e){toast(errMsg(e));return}imprimerQR([...S.vehicules].filter(v=>v.statut!=="Hors parc").sort(vSort))};

/* ---------- Carburant et papiers ---------- */
const nombre=x=>{const n=parseFloat(String(x||"").replace(/\s/g,"").replace(",","."));return isNaN(n)?null:n};
H["b-plein-send"]=()=>{
  const l=nombre(F.litres), p=nombre(F.prix??dernierPrix());
  if(!F.veh){F.err="Choisissez le camion.";return render(true)}
  if(!l||l<=0){F.err="Indiquez les litres.";return render(true)}
  if(p===null||p<0){F.err="Indiquez le prix du litre.";return render(true)}
  if(!F.photo){F.err="Prenez la photo du ticket ou de la facture.";return render(true)}
  const km=parseInt(String(F.km||"").replace(/\D/g,""),10)||null;
  const st=(F.station||"").trim();
  action(()=>rpc("stp2i_noter_plein",{p_vehicule:F.veh,p_le:null,p_litres:l,p_prix:p,p_km:km,p_fournisseur:st,p_facture:"",p_photo:F.photo}),"Plein enregistré");
};
H["plein-new"]=()=>{const vs=[...S.vehicules].filter(v=>v.statut!=="Hors parc").sort(vSort);openDlg("Noter un plein",`
  <div class="grid2"><div class="f"><label for="pl-v">Camion</label><select id="pl-v"><option value="">Choisir…</option>${vs.map(v=>`<option value="${v.id}">${esc(vName(v.id))}</option>`).join("")}</select></div>
  <div class="f"><label for="pl-d">Date</label><input id="pl-d" type="date" value="${new Date().toISOString().slice(0,10)}"></div>
  <div class="f"><label for="pl-l">Litres</label><input id="pl-l" type="number" min="0" step="0.1"></div><div class="f"><label for="pl-p">Prix du litre (XAF)</label><input id="pl-p" type="number" min="0" value="${dernierPrix()}"></div>
  <div class="f"><label for="pl-k">Kilométrage</label><input id="pl-k" type="number" min="0"></div><div class="f"><label for="pl-s">Station</label><input id="pl-s" placeholder="ex. ROX OIL"></div>
  <div class="f"><label for="pl-n">N° de facture</label><input id="pl-n"></div><div class="f"><label for="pl-f">Ticket ou facture (photo ou PDF)</label><input id="pl-f" type="file" accept="image/*,application/pdf"></div></div>`,"Enregistrer",async()=>{
  if(!val("pl-v")) throw "Choisissez le camion."; if(!(+val("pl-l")>0)) throw "Indiquez les litres."; if(val("pl-p")==="") throw "Indiquez le prix du litre.";
  const f=$("#pl-f").files[0]; const photo=f?await upload(f):null;
  await rpc("stp2i_noter_plein",{p_vehicule:val("pl-v"),p_le:val("pl-d")||null,p_litres:+val("pl-l"),p_prix:+val("pl-p"),p_km:val("pl-k")?Math.round(+val("pl-k")):null,p_fournisseur:val("pl-s"),p_facture:val("pl-n"),p_photo:photo});toast("Plein enregistré")})};
H["papier-new"]=d=>{const vs=[...S.vehicules].sort(vSort);const pourPers=!d.v&&!!d.p;
  openDlg(d.t?"Renouveler : "+d.t:"Ajouter un papier",`
  <div class="two" style="margin-bottom:8px"><button type="button" class="tile" data-act="pap-cible" data-k="v" aria-pressed="${!pourPers}"><b>Un camion</b></button><button type="button" class="tile" data-act="pap-cible" data-k="p" aria-pressed="${pourPers}"><b>Une personne</b></button></div>
  <div class="f" id="pap-v" ${pourPers?"hidden":""}><label for="pa-v">Camion</label><select id="pa-v"><option value="">Choisir…</option>${vs.map(v=>`<option value="${v.id}"${v.id===d.v?" selected":""}>${esc(vName(v.id))}</option>`).join("")}</select></div>
  <div class="f" id="pap-p" ${pourPers?"":"hidden"}><label for="pa-p">Personne</label><input id="pa-p" value="${esc(d.p||"")}" placeholder="ex. nom du chauffeur"></div>
  <div class="grid2"><div class="f"><label for="pa-t">Papier</label><input id="pa-t" list="pa-tl" value="${esc(d.t||"")}"><datalist id="pa-tl">${[...TYPES_PAPIERS_V,...TYPES_PAPIERS_P].map(x=>`<option value="${x}">`).join("")}</datalist></div>
  <div class="f"><label for="pa-n">Numéro (facultatif)</label><input id="pa-n"></div>
  <div class="f"><label for="pa-d">Valable jusqu'au</label><input id="pa-d" type="date"></div><div class="f"><label for="pa-f">Photo ou PDF du papier</label><input id="pa-f" type="file" accept="image/*,application/pdf"></div></div>
  <p class="sub">L'alerte passe orange 30 jours avant la fin, rouge quand c'est expiré. L'ancien papier reste dans l'historique.</p>`,"Enregistrer",async()=>{
  const pers=!$("#pap-p").hidden;
  const vid=pers?null:val("pa-v"), p=pers?val("pa-p"):"";
  if(!vid&&!p) throw pers?"Indiquez la personne.":"Choisissez le camion.";
  if(!val("pa-t")) throw "Indiquez le papier."; if(!val("pa-d")) throw "Indiquez la date de fin.";
  const f=$("#pa-f").files[0]; const fichier=f?await upload(f):null;
  await rpc("stp2i_enregistrer_papier",{p_vehicule:vid,p_personne:p,p_type:val("pa-t"),p_numero:val("pa-n"),p_date_fin:val("pa-d"),p_fichier:fichier});toast("Papier enregistré")})};
H["pap-cible"]=(d,el)=>{const p=d.k==="p";$("#pap-v").hidden=p;$("#pap-p").hidden=!p;el.parentNode.querySelectorAll(".tile").forEach(t=>t.setAttribute("aria-pressed",String(t===el)))};

/* ---------- Stock et fournisseurs ---------- */
H.fam=d=>{fFam=d.k||"";render(true)};
H["art-new"]=()=>openDlg("Ajouter une pièce au stock",`
  <div class="f"><label for="ar-d">Nom de la pièce</label><input id="ar-d" placeholder="ex. Filtre à gasoil"></div>
  <div class="grid2"><div class="f"><label for="ar-f">Famille</label><input id="ar-f" list="ar-fl" placeholder="ex. Filtres"><datalist id="ar-fl">${[...new Set(["Filtres","Pneus","Freins","Moteur","Électricité","Huiles","Carrosserie",...S.stock.map(s=>s.famille).filter(Boolean)])].map(x=>`<option value="${esc(x)}">`).join("")}</datalist></div>
  <div class="f"><label for="ar-m">Minimum à garder</label><input id="ar-m" type="number" min="0" value="0"></div><div class="f"><label for="ar-r">Rayon / étagère</label><input id="ar-r"></div></div>
  <p class="sub">La quantité commence à 0 : elle augmente à chaque réception de livraison.</p>`,"Ajouter",async()=>{
  if(!val("ar-d")) throw "Indiquez le nom de la pièce.";
  await rpc("stp2i_creer_article",{p_designation:val("ar-d"),p_famille:val("ar-f"),p_seuil:+val("ar-m")||0,p_rayon:val("ar-r")});toast("Pièce ajoutée")});
H["art-edit"]=d=>{const s=byId("stock",d.id);openDlg(s.designation,`
  <p>${lieux().map(l=>`${esc(l)} : <b>${qteLieu(s,l)}</b>`).join(" · ")}</p>
  <div class="grid2"><div class="f"><label for="ae-f">Famille</label><input id="ae-f" value="${esc(s.famille||"")}"></div>
  <div class="f"><label for="ae-m">Minimum à garder</label><input id="ae-m" type="number" min="0" value="${s.seuil_min||0}"></div><div class="f"><label for="ae-r">Rayon / étagère</label><input id="ae-r" value="${esc(s.rayon||"")}"></div></div>`,"Enregistrer",async()=>{
  await rpc("stp2i_definir_article",{p_stock:s.id,p_famille:val("ae-f"),p_seuil:+val("ae-m")||0,p_rayon:val("ae-r")});toast("Pièce enregistrée")})};
H["tr-new"]=()=>{const L=lieux();const items=S.stock.filter(s=>s.qte>0).sort((a,b)=>String(a.designation).localeCompare(b.designation,"fr"));openDlg("Envoyer des pièces vers un autre lieu",`
  <div class="f"><label for="tr-s">Pièce</label><select id="tr-s"><option value="">Choisir…</option>${items.map(s=>`<option value="${s.id}">${esc(s.designation)} (${L.map(l=>l+" "+qteLieu(s,l)).join(", ")})</option>`).join("")}</select></div>
  <div class="grid2"><div class="f"><label for="tr-de">De</label><select id="tr-de">${L.map(l=>`<option>${esc(l)}</option>`).join("")}</select></div><div class="f"><label for="tr-v">Vers</label><select id="tr-v">${L.map((l,i)=>`<option${i===1?" selected":""}>${esc(l)}</option>`).join("")}</select></div>
  <div class="f"><label for="tr-q">Quantité</label><input id="tr-q" type="number" min="1" value="1"></div></div>
  <p class="sub">Une autre personne confirme l'arrivée avec « Bien reçu ». Les deux noms restent dans le journal.</p>`,"Envoyer",async()=>{
  if(!val("tr-s")) throw "Choisissez la pièce."; if(val("tr-de")===val("tr-v")) throw "Choisissez deux lieux différents.";
  const n=await rpc("stp2i_envoyer_transfert",{p_stock:val("tr-s"),p_qte:+val("tr-q")||0,p_de:val("tr-de"),p_vers:val("tr-v")});toast("Envoi "+n+" enregistré")})};
H["tr-recu"]=async d=>{try{await rpc("stp2i_recevoir_transfert",{p_id:d.id});toast("Arrivée confirmée");charger()}catch(e){toast(errMsg(e))}};
H["inv-new"]=()=>{const L=lieux();const items=[...S.stock].sort((a,b)=>String(a.famille).localeCompare(b.famille,"fr")||String(a.designation).localeCompare(b.designation,"fr"));
  const corps=lieu=>items.map(s=>`<div class="row"><span class="grow">${esc(s.designation)}<span class="sub"> · ${esc(s.rayon||s.famille||"")}</span></span><span class="sub">attendu ${qteLieu(s,lieu)}</span><input type="number" min="0" id="inv-${s.id}" style="width:90px" aria-label="Compté ${esc(s.designation)}"></div>`).join("");
  openDlg("Inventaire",`<div class="f"><label for="inv-l">Lieu</label><select id="inv-l">${L.map(l=>`<option>${esc(l)}</option>`).join("")}</select></div>
  <p class="sub">Comptez chaque pièce sur l'étagère et écrivez le nombre. Laissez vide si vous ne l'avez pas comptée.</p><div id="inv-c" class="stack" style="gap:6px">${corps(L[0])}</div>
  <div class="f"><label for="inv-n">S'il y a des écarts, expliquez</label><input id="inv-n"></div>`,"Enregistrer l'inventaire",async()=>{
  const lignes=items.map(s=>({stock_id:s.id,compte:val("inv-"+s.id)})).filter(x=>x.compte!=="").map(x=>({stock_id:x.stock_id,compte:+x.compte}));
  if(!lignes.length) throw "Comptez au moins une pièce.";
  const n=await rpc("stp2i_enregistrer_inventaire",{p_site:val("inv-l"),p_lignes:lignes,p_note:val("inv-n")});toast("Inventaire "+n+" enregistré")});
  $("#inv-l").addEventListener("change",e=>{$("#inv-c").innerHTML=corps(e.target.value)})};
H["four-edit"]=d=>{const f=S.fournisseurs.find(x=>x.nom===d.k)||{nom:d.k||""};openDlg(f.id?"Fiche "+f.nom:"Fournisseur",`
  <div class="grid2"><div class="f"><label for="fo-n">Nom</label><input id="fo-n" value="${esc(f.nom||"")}"></div><div class="f"><label for="fo-t">Téléphone</label><input id="fo-t" value="${esc(f.telephone||"")}"></div>
  <div class="f"><label for="fo-c">Contact</label><input id="fo-c" value="${esc(f.contact||"")}"></div><div class="f"><label for="fo-a">Adresse</label><input id="fo-a" value="${esc(f.adresse||"")}"></div>
  <div class="f"><label for="fo-d">Délai promis (jours)</label><input id="fo-d" type="number" min="0" value="${f.delai_jours??""}"></div></div>
  <div class="f"><label for="fo-x">Notes</label><input id="fo-x" value="${esc(f.notes||"")}"></div>`,"Enregistrer",async()=>{
  if(!val("fo-n")) throw "Indiquez le nom.";
  await rpc("stp2i_enregistrer_fournisseur",{p_id:f.id||null,p_nom:val("fo-n"),p_telephone:val("fo-t"),p_contact:val("fo-c"),p_adresse:val("fo-a"),p_delai:val("fo-d")===""?null:+val("fo-d"),p_notes:val("fo-x")});toast("Fournisseur enregistré")})};
H["four-voir"]=d=>{const f=statsFournisseurs().find(x=>x.nom===d.k);if(!f)return;
  const prix={};f.bcs.filter(engage).forEach(b=>lignesDe(b.id).forEach(l=>{const k=l.designation.toLowerCase();(prix[k]=prix[k]||{d:l.designation,p:[]}).p.push({pu:+l.pu,le:b.created_at})}));
  const fac=S.factures.filter(x=>String(x.fournisseur).toLowerCase()===f.nom.toLowerCase()&&x.statut!=="Payée");
  openDlg(f.nom,`
   ${f.fiche?`<p class="sub">${[f.fiche.contact,f.fiche.telephone,f.fiche.adresse,f.fiche.delai_jours!=null?"délai promis "+f.fiche.delai_jours+" j":""].filter(Boolean).map(esc).join(" · ")}</p>`:""}
   <div class="kpis"><div class="kpi"><span>Nous devons</span><b>${fmt(f.dette)} <small>XAF</small></b></div><div class="kpi"><span>Déjà payé</span><b>${fmt(f.paye)} <small>XAF</small></b></div><div class="kpi"><span>Délai moyen</span><b style="font-size:20px">${f.delai!=null?jours(f.delai):"—"}</b></div></div>
   ${fac.length?`<div class="f"><label>Factures pas encore payées</label><div class="hist">${fac.map(x=>`<div>${esc(x.numero)} · ${xaf(x.montant)} · ${esc(x.statut)}</div>`).join("")}</div></div>`:""}
   <div class="f"><label>Prix payés</label><div class="hist">${Object.values(prix).map(x=>`<div><b>${esc(x.d)}</b> : ${x.p.sort((a,b)=>ts(a.le)-ts(b.le)).map(p=>xaf(p.pu)+" ("+dt(p.le)+")").join(" → ")}</div>`).join("")||"—"}</div></div>
   <div class="f"><label>Bons de commande</label><div class="hist">${f.bcs.sort(newest).map(b=>`<div>${esc(b.num)} · ${dt(b.created_at)} · ${xaf(b.total)} · ${esc(b.statut)}</div>`).join("")||"—"}</div></div>
   ${canDo("veh")?`<div><button type="button" class="btn sm" data-act="four-edit" data-k="${esc(f.nom)}">Modifier la fiche</button></div>`:""}`,null,null)};

/* ---------- Rapports, papiers officiels, contrat, HSE ---------- */
H["rap-soir"]=()=>{const t=rapportSoir();openDlg("Rapport du soir",`<textarea id="rs-t" rows="16" style="width:100%;font-family:inherit">${esc(t)}</textarea><p class="sub">Vous pouvez corriger le texte avant de l'envoyer.</p>
  <div class="row"><button type="button" class="btn" data-act="rs-copier">Copier</button><a class="btn ok" id="rs-wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(t)}">Ouvrir WhatsApp</a></div>`,null,null);
  $("#rs-t").addEventListener("input",e=>{$("#rs-wa").href="https://wa.me/?text="+encodeURIComponent(e.target.value)})};
H["rs-copier"]=async()=>{try{await navigator.clipboard.writeText($("#rs-t").value);toast("Texte copié")}catch(e){$("#rs-t").select();toast("Sélectionnez le texte et copiez-le")}};
H["rap-mois"]=d=>imprimer("Rapport du mois",rapportMois(+d.k||0));
H.export=d=>{EXPORTS[d.k]&&EXPORTS[d.k]()};
H["bc-print"]=d=>imprimerBc(d.id);
H["br-print"]=d=>imprimerBr(d.id);
H["bc-hc"]=d=>{const b=byId("commandes",d.id);if(b.hors_contrat){rpc("stp2i_marquer_hors_contrat",{p_commande:b.id,p_hors:false,p_note:""}).then(()=>{toast("Remis dans le contrat");$("#dlg").close();charger()}).catch(e=>toast(errMsg(e)));return}
  openDlg(b.num+" hors contrat",`<p class="sub">Ces pièces ne sont pas couvertes par le contrat : elles seront facturées à part au client.</p><div class="f"><label for="hc-n">Pourquoi ?</label><input id="hc-n" placeholder="ex. dégât causé sur le chantier du client"></div>`,"Marquer hors contrat",async()=>{
  if(!val("hc-n")) throw "Expliquez pourquoi.";await rpc("stp2i_marquer_hors_contrat",{p_commande:b.id,p_hors:true,p_note:val("hc-n")});toast("Marqué hors contrat")})};
H["sig-up"]=d=>{openDlg(d.k==="cachet"?"Cachet de STP2i":"Signature du DG",`<p class="sub">Image PNG ou JPG, sur fond blanc ou transparent. Elle n'apparaît que sur les bons validés par le DG.</p><div class="f"><label for="sg-f">Image</label><input id="sg-f" type="file" accept="image/png,image/jpeg"></div>`,"Enregistrer",async()=>{
  const f=$("#sg-f").files[0];if(!f) throw "Choisissez l'image.";
  const path=await uploadBrut(f);
  await rpc("stp2i_definir_signature",d.k==="cachet"?{p_signature:null,p_cachet:path}:{p_signature:path,p_cachet:null});toast("Enregistré")})};
H["mois-c"]=d=>{moisC=Math.min(0,moisC+(+d.d));render(true)};
H["prix-c"]=()=>{const types=[...new Set(S.vehicules.map(v=>v.type))];openDlg("Prix du contrat",`<p class="sub">Prix hors taxes, comme dans l'annexe du contrat.</p>${types.map((t,i)=>{const p=S.contrat_prix.find(x=>x.type===t)||{};return `<div class="grid2"><div class="f"><label for="pc-m-${i}">${esc(t)} : prix par mois (XAF)</label><input id="pc-m-${i}" type="number" min="0" value="${p.prix_mois||""}"></div><div class="f"><label for="pc-e-${i}">Prix du m³ d'eau (XAF)</label><input id="pc-e-${i}" type="number" min="0" value="${p.prix_m3||""}"></div></div>`}).join("")}`,"Enregistrer",async()=>{
  for(let i=0;i<types.length;i++){if(val("pc-m-"+i)===""&&val("pc-e-"+i)==="")continue;await rpc("stp2i_definir_prix_contrat",{p_type:types[i],p_prix_mois:+val("pc-m-"+i)||0,p_prix_m3:+val("pc-e-"+i)||0})}toast("Prix enregistrés")})};
H["jour-noter"]=()=>{const vs=[...S.vehicules].filter(v=>v.statut!=="Hors parc").sort(vSort);const j=cleJour(Date.now());
  openDlg("Noter la journée",`<div class="f"><label for="jn-d">Jour</label><input id="jn-d" type="date" value="${j}" max="${j}"></div><div id="jn-l" class="stack" style="gap:6px"></div>`,"Enregistrer",async()=>{
    const jour=val("jn-d");const rows=vs.map(v=>({vehicule_id:v.id,jour,statut:val("jn-s-"+v.id),m3:+val("jn-m-"+v.id)||0}));
    const n=await rpc("stp2i_noter_jours",{p_jours:rows});toast(n+" camion(s) noté(s)")});
  const remplir=jour=>{$("#jn-l").innerHTML=vs.map(v=>{const r=jourDe(v.id,jour);const st=r?r.statut:jourPropose(v.id,jour);return `<div class="row"><span class="ref" style="width:70px">${esc(v.code)}</span><select id="jn-s-${v.id}" style="width:auto">${Object.keys(ST_JOUR).map(s=>`<option${s===st?" selected":""}>${s}</option>`).join("")}</select><input id="jn-m-${v.id}" type="number" min="0" step="0.1" style="width:110px" placeholder="m³ d'eau" value="${r&&r.m3?r.m3:""}" aria-label="m³ ${esc(v.code)}"></div>`}).join("")};
  remplir(j);$("#jn-d").addEventListener("change",e=>remplir(e.target.value))};
H["ctl-go"]=()=>{tab=role()==="base"?"base":tab;if(role()!=="base"){openCtlDlg();return}screen="controle";F={};render(true);window.scrollTo(0,0)};
function openCtlDlg(){const vs=[...S.vehicules].filter(v=>v.statut!=="Hors parc").sort(vSort);openDlg("Contrôle avant départ",`
  <div class="grid2"><div class="f"><label for="cd-v">Camion</label><select id="cd-v"><option value="">Choisir…</option>${vs.map(v=>`<option value="${v.id}">${esc(vName(v.id))}</option>`).join("")}</select></div><div class="f"><label for="cd-c">Chauffeur</label><input id="cd-c"></div></div>
  <div class="f"><label>Cochez ce qui ne va PAS</label>${POINTS.map((p,i)=>`<label class="row" style="font-weight:400"><input type="checkbox" id="cd-p-${i}" style="width:auto"> ${esc(p)}</label>`).join("")}</div>
  <div class="grid2"><div class="f"><label for="cd-f">Photo (obligatoire si un point n'est pas bon)</label><input id="cd-f" type="file" accept="image/*" capture="environment"></div><div class="f"><label for="cd-n">Note</label><input id="cd-n"></div></div>`,"Enregistrer",async()=>{
  if(!val("cd-v")) throw "Choisissez le camion.";
  const pts={};POINTS.forEach((p,i)=>pts[p]=!$("#cd-p-"+i).checked);
  const f=$("#cd-f").files[0];const photo=f?await upload(f):null;
  const r=await rpc("stp2i_controle_depart",{p_vehicule:val("cd-v"),p_chauffeur:val("cd-c"),p_points:pts,p_km:null,p_photo:photo,p_note:val("cd-n")});toast(r==="ok"?"Contrôle enregistré : tout est bon":"Panne "+r+" déclarée")})}
H["ctl-pt"]=d=>{const m=new Set(F.mal||[]);m.has(d.k)?m.delete(d.k):m.add(d.k);F.mal=[...m];F.err="";render(true)};
H["b-ctl-send"]=()=>{
  if(!F.veh){F.err="Choisissez le camion.";return render(true)}
  const mal=F.mal||[];if(mal.length&&!F.photo){F.err="Un point n'est pas bon : prenez une photo.";return render(true)}
  const pts={};POINTS.forEach(p=>pts[p]=!mal.includes(p));
  const v=veh(F.veh);const km=parseInt(String(F.km||"").replace(/\D/g,""),10)||null;
  action(()=>rpc("stp2i_controle_depart",{p_vehicule:F.veh,p_chauffeur:((F.chauffeur??(v?v.chauffeur:""))||"").trim(),p_points:pts,p_km:km,p_photo:F.photo||null,p_note:(F.note||"").trim()}),r=>r==="ok"?"Contrôle enregistré : bonne route":"Panne "+r+" déclarée : le camion ne part pas");
};
H["hse-new"]=()=>{const vs=[...S.vehicules].sort(vSort);openDlg("Déclarer un événement HSE",`
  <div class="grid2"><div class="f"><label for="hs-t">Type</label><select id="hs-t">${Object.keys(C_HSE).map(t=>`<option>${t}</option>`).join("")}</select></div><div class="f"><label for="hs-v">Camion (facultatif)</label><select id="hs-v"><option value="">Aucun</option>${vs.map(v=>`<option value="${v.id}">${esc(vName(v.id))}</option>`).join("")}</select></div>
  <div class="f"><label for="hs-d">Quand</label><input id="hs-d" type="datetime-local" value="${new Date(Date.now()-new Date().getTimezoneOffset()*6e4).toISOString().slice(0,16)}"></div><div class="f"><label for="hs-l">Où</label><input id="hs-l"></div>
  <div class="f"><label for="hs-g">Gravité</label><select id="hs-g"><option>Faible</option><option>Moyenne</option><option>Grave</option></select></div><div class="f"><label for="hs-f">Photo (facultatif)</label><input id="hs-f" type="file" accept="image/*"></div></div>
  <div class="f"><label for="hs-x">Ce qui s'est passé</label><textarea id="hs-x" rows="3"></textarea></div>
  <label class="row" style="font-weight:400"><input type="checkbox" id="hs-b" style="width:auto"> Il y a des blessés</label>`,"Déclarer",async()=>{
  if(!val("hs-x")) throw "Racontez ce qui s'est passé.";
  const f=$("#hs-f").files[0];const photo=f?await upload(f):null;
  const n=await rpc("stp2i_declarer_hse",{p_type:val("hs-t"),p_vehicule:val("hs-v")||null,p_le:val("hs-d")?new Date(val("hs-d")).toISOString():null,p_lieu:val("hs-l"),p_description:val("hs-x"),p_gravite:val("hs-g"),p_blesses:$("#hs-b").checked,p_photo:photo});toast(n+" enregistré")},"bad")};
H["hse-clore"]=d=>{const h=byId("hse",d.id);openDlg("Clore "+h.num,`<p>${esc(h.description)}</p><div class="f"><label for="hc-a">Qu'a-t-on fait pour que ça ne recommence pas ?</label><textarea id="hc-a" rows="3"></textarea></div>`,"Clore",async()=>{
  if(!val("hc-a")) throw "Dites ce qui a été fait.";await rpc("stp2i_clore_hse",{p_id:h.id,p_actions:val("hc-a")});toast(h.num+" clos")},"ok")};
H["form-new"]=()=>openDlg("Ajouter une formation",`
  <div class="grid2"><div class="f"><label for="fm-p">Personne</label><input id="fm-p"></div><div class="f"><label for="fm-t">Formation</label><input id="fm-t" list="fm-tl"><datalist id="fm-tl">${["Conduite défensive","Premiers secours","Lutte contre l'incendie","Transport de carburant","Induction HSE ENI"].map(x=>`<option value="${x}">`).join("")}</datalist></div>
  <div class="f"><label for="fm-d">Faite le</label><input id="fm-d" type="date"></div><div class="f"><label for="fm-j">Valable jusqu'au (facultatif)</label><input id="fm-j" type="date"></div></div>
  <div class="f"><label for="fm-f">Attestation (photo ou PDF)</label><input id="fm-f" type="file" accept="image/*,application/pdf"></div>`,"Enregistrer",async()=>{
  if(!val("fm-p")||!val("fm-t")) throw "Indiquez la personne et la formation.";
  const f=$("#fm-f").files[0];const fichier=f?await upload(f):null;
  await rpc("stp2i_enregistrer_formation",{p_personne:val("fm-p"),p_theme:val("fm-t"),p_le:val("fm-d")||null,p_jusqu_au:val("fm-j")||null,p_fichier:fichier});toast("Formation enregistrée")});

/* ---------- Documents HSE ---------- */
H["smq-cat"]=d=>{fCat=d.k||"";render(true)};
H["smq-retires"]=()=>{voirRetires=!voirRetires;render(true)};
H["smq-edit"]=d=>{const x=d.id?byId("smq",d.id):{categorie:fCat||"Procédure",revision_mois:12};const nouveau=!d.id;
  openDlg(nouveau?"Ajouter un document":"Mettre à jour : "+x.intitule,`
  <div class="grid2"><div class="f"><label for="sm-c">Catégorie</label><select id="sm-c">${CATS.map(([k])=>`<option value="${k}"${k===x.categorie?" selected":""}>${k}</option>`).join("")}</select></div><div class="f"><label for="sm-r">Référence</label><input id="sm-r"${nouveau?' data-auto="1"':""} value="${esc(nouveau?prochaineRef(x.categorie,"QHSE","V1"):x.reference||"")}"><span class="sub">Proposée toute seule, comme dans l'inventaire.</span></div></div>
  <div class="f"><label for="sm-i">Intitulé</label><input id="sm-i" value="${esc(x.intitule||"")}"></div>
  <div class="grid2"><div class="f"><label for="sm-s">Service</label><input id="sm-s" list="sm-sl" value="${esc(nouveau?"QHSE":x.service||"")}"><datalist id="sm-sl">${[["QHSE","Qualité, hygiène, sécurité, environnement"],["RH","Ressources humaines"],["MAINT","Maintenance"],["DIR","Direction"],["LOG","Logistique"],["EXP","Exploitation"]].map(([s,l])=>`<option value="${s}">${l}</option>`).join("")}</datalist></div><div class="f"><label for="sm-v">Version</label><input id="sm-v" value="${esc(nouveau?"V1":x.version||"")}"></div>
  <div class="f"><label for="sm-dc">Date de création</label><input id="sm-dc" type="date" value="${nouveau?new Date().toISOString().slice(0,10):x.date_creation||""}"></div><div class="f"><label for="sm-dm">Date de la dernière mise à jour</label><input id="sm-dm" type="date" value="${nouveau?"":new Date().toISOString().slice(0,10)}"></div>
  <div class="f"><label for="sm-rv">À revoir tous les (mois)</label><input id="sm-rv" type="number" min="1" max="60" value="${x.revision_mois||12}"></div><div class="f"><label for="sm-f">Document signé (PDF ou photo)</label><input id="sm-f" type="file" accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx"></div></div>
  <div class="f"><label for="sm-o">Objet de la mise à jour</label><input id="sm-o" value="${esc(nouveau?"Création du document":"")}" placeholder="ex. révision générale"></div>
  ${!nouveau?`<p class="sub">Si la version ou le fichier change, l'ancienne version reste dans l'historique.</p>${x.actif?`<div><button type="button" class="btn sm bad" data-act="smq-retirer" data-id="${x.id}">Retirer ce document</button></div>`:`<div><button type="button" class="btn sm ok" data-act="smq-remettre" data-id="${x.id}">Remettre en vigueur</button></div>`}`:""}`,"Enregistrer",async()=>{
  if(!val("sm-i")) throw "Indiquez l'intitulé.";
  if(!nouveau&&!val("sm-o")) throw "Dites ce qui change (objet de la mise à jour).";
  const f=$("#sm-f").files[0];const fichier=f?await upload(f):null;
  await rpc("stp2i_smq_enregistrer",{p_id:d.id||null,p_categorie:val("sm-c"),p_intitule:val("sm-i"),p_reference:val("sm-r"),p_service:val("sm-s").toUpperCase(),p_version:val("sm-v").toUpperCase(),p_date_creation:val("sm-dc")||null,p_date_maj:val("sm-dm")||null,p_objet_maj:val("sm-o"),p_fichier:fichier,p_revision_mois:+val("sm-rv")||12});toast("Document enregistré")})};
H["smq-retirer"]=d=>{const x=byId("smq",d.id);openDlg("Retirer : "+x.intitule,`<p class="sub">Le document n'est pas effacé : il passe dans « retirés ».</p><div class="f"><label for="sr-m">Pourquoi ?</label><input id="sr-m" placeholder="ex. remplacé par PRO 028"></div>`,"Retirer",async()=>{
  if(!val("sr-m")) throw "Dites pourquoi.";await rpc("stp2i_smq_archiver",{p_id:x.id,p_actif:false,p_motif:val("sr-m")});toast("Document retiré")},"bad")};
H["smq-remettre"]=async d=>{try{await rpc("stp2i_smq_archiver",{p_id:d.id,p_actif:true,p_motif:""});$("#dlg").close();toast("Document remis en vigueur");charger()}catch(e){toast(errMsg(e))}};
H["smq-hist"]=d=>{const x=byId("smq",d.id);const vs=S.smq_versions.filter(v=>v.document_id===x.id).sort((a,b)=>ts(b.remplace_le)-ts(a.remplace_le));
  openDlg("Versions : "+x.intitule,`<div class="tbl"><table><thead><tr><th>Version</th><th>Date</th><th>Objet</th><th>Fichier</th><th>Remplacée le</th></tr></thead><tbody><tr><td><b>${esc(x.version)}</b> (actuelle)</td><td>${dt(derniereMaj(x))}</td><td>${esc(x.objet_maj)}</td><td>${thumb(x.fichier,x.intitule)}</td><td></td></tr>${vs.map(v=>`<tr><td>${esc(v.version)}</td><td>${dt(v.date_maj)}</td><td>${esc(v.objet_maj)}</td><td>${thumb(v.fichier,v.version)}</td><td>${dt(v.remplace_le)} · ${esc(who(v.remplace_par))}</td></tr>`).join("")}</tbody></table></div>`,null,null)};
H["smq-export"]=()=>exporterSmq();
H["rj-jour"]=d=>{const t=new Date(rjJour+"T12:00:00");t.setDate(t.getDate()+(+d.k));const n=t.toISOString().slice(0,10);if(n>auj())return;rjJour=n;render(true)};
H["rj-save"]=async()=>{try{await rjEnregistrer()}catch(e){toast(typeof e==="string"?e:errMsg(e))}};
H["rj-imprimer"]=()=>rjImprimer();H["rj-excel"]=()=>rjExcel();
H["rj-base"]=()=>{const J=rjJour;RJD[J]=RJD[J]||{};rjVehs().forEach(v=>{const l=rjLigne(J,v.id);RJ_CHECKS.forEach(([k])=>{if(!l[k+"_lieu"]){(RJD[J][v.id]=RJD[J][v.id]||{})[k+"_lieu"]="stationné à la base";if(!l[k+"_obs"])RJD[J][v.id][k+"_obs"]="RAS"}})});render(true)};

document.addEventListener("click",e=>{const el=e.target.closest("[data-act]");if(!el)return;const a=el.dataset.act;if(H[a]){if(el.tagName==="BUTTON"&&el.type!=="submit")e.preventDefault();H[a](el.dataset,el)}});
document.addEventListener("input",e=>{const t=e.target;
  if(t.dataset.f){F[t.dataset.f]=t.value}
  if(t.id==="lg-id")F.lgid=t.value;
  if(t.id==="smq-q"){fCherche=t.value;clearTimeout(window._smqT);window._smqT=setTimeout(()=>{render(true);const q=$("#smq-q");if(q){q.focus();q.setSelectionRange(q.value.length,q.value.length)}},250)}
  if(t.id&&/^l-[qp]-/.test(t.id))bcTotal();
  if(["sm-s","sm-v"].includes(t.id)){const r=$("#sm-r");if(r&&r.dataset.auto)r.value=prochaineRef(val("sm-c"),val("sm-s"),val("sm-v"))}
  if(t.id==="sm-r")delete t.dataset.auto;
  if(t.dataset.rj&&t.tagName!=="SELECT"){const [vid,k]=t.dataset.rj.split("|");const J=rjJour;RJD[J]=RJD[J]||{};(RJD[J][vid]=RJD[J][vid]||{})[k]=t.value;
    const c=document.getElementById("rjd-"+vid);if(c)c.textContent=rjDuree(rjLigne(J,vid));const b=document.querySelector('[data-act="rj-save"]');if(b)b.disabled=false}
});
document.addEventListener("change",async e=>{const t=e.target;
  if(t.id==="viewas"){viewAs=t.value;try{localStorage.setItem("stp2i-viewas",viewAs)}catch(x){}tab=null;screen="home";F={};render(true)}
  if(t.id==="f-dem"){fDem=t.value;render(true)}
  if(t.id==="f-bc"){fBc=t.value;render(true)}
  if(t.id==="rj-jour"&&t.value){rjJour=t.value>auj()?auj():t.value;render(true)}
  if(t.dataset.rj&&t.tagName==="SELECT"){const [vid,k]=t.dataset.rj.split("|");const J=rjJour;RJD[J]=RJD[J]||{};(RJD[J][vid]=RJD[J][vid]||{})[k]=t.value;const b=document.querySelector('[data-act="rj-save"]');if(b)b.disabled=false}
  if(t.id==="sm-c"){const r=$("#sm-r");if(r&&r.dataset.auto)r.value=prochaineRef(t.value,val("sm-s"),val("sm-v"))}
  if(t.dataset.role!==undefined&&t.dataset.role){const p=byId("profils",t.dataset.role);
    try{await rpc("stp2i_definir_role",{p_user:p.id,p_role:t.value||null,p_actif:p.actif});toast("Rôle enregistré");charger()}catch(x){toast(errMsg(x));render(true)}}
  if(t.dataset.photo){const k=t.dataset.photo,file=t.files[0];if(!file)return;F[k+"_busy"]=true;F.err="";render(true);
    try{F[k]=await upload(file)}catch(x){F.err="La photo n'a pas pu être envoyée : "+errMsg(x)}F[k+"_busy"]=false;render(true)}
});
document.addEventListener("submit",async e=>{
  // Lire les champs AVANT de redessiner l'écran (le rendu vide les champs).
  if(e.target.id==="f-login"){e.preventDefault();
    const email=emailDe(val("lg-id")),password=$("#lg-pw").value;
    if(!val("lg-id")||!password){F.err="Indiquez l'identifiant et le mot de passe.";render(true);return}
    F.busy=true;F.err="";render(true);
    const {error}=await sb.auth.signInWithPassword({email,password});
    if(error){F.busy=false;F.err=errMsg(error);render(true)}}
  if(e.target.id==="f-setup"){e.preventDefault();
    const id=val("su-id"),pw=$("#su-pw").value,nom=val("su-nom");
    F.busy=true;F.err="";render(true);
    try{await fonction({action:"premier_admin",nom,identifiant:id,mot_de_passe:pw});
      const {error}=await sb.auth.signInWithPassword({email:emailDe(id),password:pw});if(error) throw error}
    catch(x){F.busy=false;F.err=errMsg(x);render(true)}}
});
document.addEventListener("focusout",()=>{if(pending)setTimeout(()=>{if(pending)render()},50)});

/* ---------- Démarrage ---------- */
async function demarrer(session){
  if(!session){
    me=null;F={};tab=null;screen="home";
    boot="login";render(true);return; // écran « Premier démarrage » accessible par un bouton
  }
  try{me=await rpc("stp2i_mon_profil")}catch(e){boot="login";F={err:errMsg(e)};render(true);return}
  boot="ready";F={};render(true);
  if(me&&me.role&&me.actif){charger();ecouter()}
}
let derniere=undefined;
sb.auth.onAuthStateChange((ev,session)=>{
  const uid=session&&session.user?session.user.id:null;
  if(uid===derniere&&ev!=="SIGNED_OUT") return; // simple rafraîchissement du jeton
  derniere=uid;
  setTimeout(()=>demarrer(session),0);
});
})();
