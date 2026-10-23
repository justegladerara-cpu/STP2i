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
const ROLES={base:"Chef de base",logistique:"Logistique",dg:"Direction générale",admin:"Administration"};
const ICON={
 plus:'<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"><circle cx="24" cy="24" r="20" stroke-width="3.5"/><path d="M24 14v20M14 24h20"/></svg>',
 box:'<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round"><path d="M6 15l18-9 18 9v18l-18 9-18-9z"/><path d="M6 15l18 9 18-9M24 24v18"/></svg>',
 wrench:'<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M30 6a10 10 0 0 0-9 14L7 34a4 4 0 0 0 6 6l14-14a10 10 0 0 0 14-9l-6 6-6-2-2-6z"/></svg>',
 cam:'<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round"><path d="M5 15h9l4-6h12l4 6h9v24H5z"/><circle cx="24" cy="26" r="8"/></svg>'
};
const C_STAT={
 demande:{"Nouvelle":"orange","En validation":"blue","Commandée":"blue","Reçue à la base":"ok","Montée":"ok","Refusée":"bad"},
 bc:{"À valider":"orange","Validé":"blue","Refusé":"bad","Reçu partiel":"warn","Reçu":"ok","Facturé":"ok","Payé":""},
 facture:{"Conforme":"ok","Bloquée":"bad","Payée":""}
};
const chip=(kind,s)=>`<span class="chip ${C_STAT[kind][s]||""}">${esc(s)}</span>`;

/* ---------- État ---------- */
const S={vehicules:[],demandes:[],commandes:[],lignes:[],receptions:[],stock:[],mouvements:[],factures:[],profils:[],journal:[],attendues:[],seuil:0};
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
      reglages:q("stp2i_reglages")
    };
    if(direction){
      jobs.commandes=q("stp2i_commandes","*","created_at");
      jobs.lignes=q("stp2i_commande_lignes");
      jobs.receptions=q("stp2i_receptions","*","created_at");
      jobs.factures=q("stp2i_factures","*","created_at");
      jobs.journal=q("stp2i_journal","*","at").limit(400);
    }
    const keys=Object.keys(jobs);
    const res=await Promise.all(keys.map(k=>jobs[k]));
    res.forEach((r,i)=>{if(r.error) throw r.error; const k=keys[i]; if(k==="reglages") S.seuil=r.data[0]?+r.data[0].seuil_validation:0; else S[k]=r.data||[]});
    if(me.role==="base"||me.role==="admin") S.attendues=await rpc("stp2i_commandes_attendues").catch(()=>[]);
    const mine=S.profils.find(p=>p.id===me.id); if(mine) me=mine;
    syncTxt="À jour · "+new Date().toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"});
    render();
    const paths=[...S.demandes.map(d=>d.photo),...S.commandes.map(c=>c.devis),...S.receptions.map(r=>r.photo),...S.factures.map(f=>f.fichier),...S.mouvements.map(m=>m.photo)];
    if(await signer(paths)) render();
  }catch(e){syncTxt="Erreur de chargement : "+errMsg(e);render()}
  finally{loading=false;if(again){again=false;charger()}}
}
let reloadT;const bientot=()=>{clearTimeout(reloadT);reloadT=setTimeout(charger,400)};
let canal=null;
function ecouter(){
  if(canal) return;
  canal=sb.channel("stp2i");
  ["stp2i_demandes","stp2i_commandes","stp2i_receptions","stp2i_stock","stp2i_mouvements","stp2i_factures","stp2i_vehicules","stp2i_profils","stp2i_journal"]
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
  const VIEWS={base:vBase,demandes:vDemandes,commandes:vCommandes,factures:vFactures,stock:vStock,camions:vCamions,journal:vJournal,valider:vValider,params:vParams,bord:vBord};
  m.innerHTML=VIEWS[tab]();
}
function tabsFor(r){
  const nD=S.demandes.filter(d=>d.statut==="Nouvelle").length, nV=S.commandes.filter(b=>b.statut==="À valider").length,
        nF=S.factures.filter(f=>f.statut==="Bloquée").length, nP=S.factures.filter(f=>f.statut==="Conforme").length;
  return ({
    base:[["base","Accueil"]],
    logistique:[["demandes","Demandes",nD],["commandes","Bons de commande"],["factures","Factures",nF],["stock","Stock"],["camions","Camions"],["journal","Journal"]],
    dg:[["valider","À valider",nV],["factures","Factures à payer",nP],["bord","Tableau de bord"],["commandes","Bons de commande"],["stock","Stock"],["camions","Camions"],["journal","Journal"]],
    admin:[["params","Comptes et réglages"],["bord","Tableau de bord"],["journal","Journal"]]
  })[r];
}
function renderHeader(){
  let h="";
  if(boot==="ready"&&me){
    h+=`<span id="sync">${esc(syncTxt)}</span><span>${esc(me.nom||"")}</span>`;
    if(me.role==="admin") h+=`<select id="viewas" aria-label="Écran affiché" style="width:auto">${["admin","base","logistique","dg"].map(k=>`<option value="${k}"${k===viewAs?" selected":""}>${k==="admin"?"Administration":"Écran : "+ROLES[k]}</option>`).join("")}</select>`;
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
   <p class="sub">Votre identifiant vous a été remis par l'administrateur (par exemple : gloria). Mot de passe oublié : demandez-lui de le changer.</p></div></form>`;
}
function vSetup(){
  return `<form class="panel narrow" id="f-setup" novalidate><div class="phead"><h2>Premier démarrage</h2></div><div class="db">
   <p>Aucun administrateur n'existe encore. Créez le compte administrateur : il servira à créer les comptes du chef de base, de la logistique et du DG.</p>
   <div class="f"><label for="su-nom">Nom complet</label><input id="su-nom"></div>
   <div class="f"><label for="su-id">Identifiant</label><input id="su-id" autocapitalize="none" placeholder="ex. admin"></div>
   <div class="f"><label for="su-pw">Mot de passe (6 caractères minimum)</label><input id="su-pw" type="password" autocomplete="new-password"></div>
   ${F.err?`<div class="err">${esc(F.err)}</div>`:""}
   <button class="send" type="submit" ${F.busy?"disabled":""}>${F.busy?"Création…":"Créer l'administrateur"}</button></div></form>`;
}

/* ===== BASE ===== */
function vBase(){
  if(screen==="new") return baseNew();
  if(screen==="recv") return baseRecv();
  if(screen==="mount") return baseMount();
  const attendues=S.attendues.length;
  const enStock=S.stock.filter(s=>s.qte>0).length;
  const mine=[...S.demandes].sort(newest).slice(0,25);
  return `<div class="base">
   <div class="bigs">
    <button class="big o" data-act="go" data-s="new">${ICON.plus}<span><b>Nouvelle demande</b><small>Le mécanicien a besoin d'une pièce</small></span></button>
    <button class="big b" data-act="go" data-s="recv">${ICON.box}<span><b>Réception livraison</b><small>${attendues?`${attendues} commande(s) attendue(s)`:"Aucune commande attendue"}</small></span></button>
    <button class="big g" data-act="go" data-s="mount">${ICON.wrench}<span><b>Pièce montée</b><small>${enStock?`${enStock} pièce(s) en stock à la base`:"Stock de la base vide"}</small></span></button>
   </div>
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
  const items=S.stock.filter(s=>s.qte>0).sort((a,b)=>String(a.designation).localeCompare(b.designation,"fr"));
  if(!F.item) return `<div class="base"><button class="back" data-act="go" data-s="home">← Retour</button><h2>Pièce montée sur un camion</h2>
   <div class="step"><i>1</i><span>Quelle pièce sort du stock ?</span></div>
   ${items.length?`<div class="tiles">${items.map(s=>`<button class="tile" data-act="pick" data-k="item" data-v="${s.id}"><b style="font-size:15px">${esc(s.designation)}</b><small>${s.qte} en stock</small></button>`).join("")}</div>`:'<div class="empty">Aucune pièce en stock. Les pièces entrent dans le stock à la réception d\'une livraison.</div>'}</div>`;
  const s=byId("stock",F.item); if(!s){F.item=null;return baseMount()}
  return `<div class="base"><button class="back" data-act="pick" data-k="item" data-v="">← Changer de pièce</button><h2>${esc(s.designation)}</h2><div class="sub">${s.qte} en stock</div>
   <div class="step"><i>2</i><span>Sur quel camion ?</span></div>${vehTiles(F.veh)}
   <div class="step"><i>3</i><span>Combien ?</span></div>${stepper("qte")}
   <div class="step"><i>4</i><span>Photo de la pièce usée rendue</span></div>${photoBtn("old","Photographier la pièce usée")}
   <div class="step"><i>5</i><span>Kilométrage du camion <em>facultatif</em></span></div><input class="bigin" data-f="km" inputmode="numeric" value="${esc(F.km||"")}" placeholder="ex. 152300">
   ${F.err?`<div class="err">${esc(F.err)}</div>`:""}
   <button class="send" data-act="b-mount-send" ${F.busy?"disabled":""}>${F.busy?"Enregistrement…":"Valider la sortie"}</button></div>`;
}

/* ===== LOGISTIQUE : demandes ===== */
let fDem="Nouvelle";
function vDemandes(){
  const list=S.demandes.filter(d=>!fDem||d.statut===fDem).sort(newest);
  const opts=["","Nouvelle","En validation","Commandée","Reçue à la base","Montée","Refusée"];
  return `<div class="panel"><div class="phead"><h2 class="grow">Demandes de la base</h2><select id="f-dem" style="width:auto">${opts.map(o=>`<option value="${o}"${o===fDem?" selected":""}>${o||"Toutes"}</option>`).join("")}</select></div>
  ${list.length?`<div class="tbl"><table><thead><tr><th>N°</th><th>Date</th><th>Camion</th><th>Pièce</th><th class="num">Qté</th><th>Photo</th><th>Statut</th><th></th></tr></thead><tbody>${list.map(d=>{const c=d.commande_id?byId("commandes",d.commande_id):null;return `<tr><td class="ref">${esc(d.num)}${d.urgent?' <span class="chip bad">Urgent</span>':""}</td><td>${dt(d.created_at)}<div class="sub">${esc(who(d.created_by))}</div></td><td>${esc(vName(d.vehicule_id))}</td><td>${esc(d.piece||"Voir la photo")}${d.motif?`<div class="sub">${esc(d.motif)}</div>`:""}</td><td class="num">${d.qte}</td><td>${thumb(d.photo,"Demande")}</td><td>${chip("demande",d.statut)}${c?`<div class="sub">${esc(c.num)}</div>`:""}</td><td class="num">${d.statut==="Nouvelle"&&canDo("bc")?`<button class="btn sm primary" data-act="bc-new" data-id="${d.id}">Créer le bon de commande</button> <button class="btn sm" data-act="dem-refuse" data-id="${d.id}">Refuser</button>`:""}</td></tr>`}).join("")}</tbody></table></div>`:`<div class="empty">${fDem==="Nouvelle"?"Aucune nouvelle demande à traiter.":"Aucune demande."}</div>`}</div>`;
}

/* ===== Bons de commande ===== */
let fBc="";
function vCommandes(){
  const list=S.commandes.filter(b=>!fBc||b.statut===fBc).sort(newest);
  const opts=["","À valider","Validé","Refusé","Reçu partiel","Reçu","Facturé","Payé"];
  return `<div class="panel"><div class="phead"><h2 class="grow">Bons de commande</h2><select id="f-bc" style="width:auto">${opts.map(o=>`<option value="${o}"${o===fBc?" selected":""}>${o||"Tous"}</option>`).join("")}</select></div>
  ${list.length?`<div class="tbl"><table><thead><tr><th>N°</th><th>Date</th><th>Fournisseur</th><th>Camion</th><th class="num">Total</th><th>Statut</th><th>Réception</th><th>Facture</th></tr></thead><tbody>${list.map(b=>{const f=S.factures.find(x=>x.commande_id===b.id);const nr=S.receptions.filter(r=>r.commande_id===b.id).length;return `<tr class="click" data-act="bc-open" data-id="${b.id}"><td class="ref">${esc(b.num)}</td><td>${dt(b.created_at)}</td><td>${esc(b.fournisseur)}</td><td>${esc(vName(b.vehicule_id))}</td><td class="num">${xaf(b.total)}</td><td>${chip("bc",b.statut)}</td><td>${nr?`${nr} bon(s)`:'<span class="sub">—</span>'}</td><td>${f?chip("facture",f.statut):'<span class="sub">—</span>'}</td></tr>`}).join("")}</tbody></table></div>`:'<div class="empty">Aucun bon de commande.</div>'}</div>`;
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

/* ===== Stock ===== */
function vStock(){
  const items=[...S.stock].sort((a,b)=>String(a.designation).localeCompare(b.designation,"fr"));
  const mv=[...S.mouvements].sort(newest).slice(0,200);
  return `<div class="stack"><div class="panel"><div class="phead"><h2 class="grow">Stock de la base</h2></div>
  ${items.length?`<div class="tbl"><table><thead><tr><th>Pièce</th><th class="num">En stock</th><th>Dernière entrée</th><th>Dernière sortie</th></tr></thead><tbody>${items.map(s=>`<tr><td>${esc(s.designation)}</td><td class="num"><b>${s.qte}</b></td><td>${dt(s.derniere_entree)}</td><td>${dt(s.derniere_sortie)}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty">Le stock se remplit à chaque réception de livraison.</div>'}</div>
  <div class="panel"><div class="phead"><h2 class="grow">Mouvements</h2><span class="sub">Chaque entrée et sortie, avec la personne et la photo</span></div>
  ${mv.length?`<div class="tbl"><table><thead><tr><th>Date</th><th>Mouvement</th><th>Pièce</th><th class="num">Qté</th><th>Camion</th><th>Référence</th><th>Par</th><th>Photo</th></tr></thead><tbody>${mv.map(m=>`<tr><td>${dtt(m.created_at)}</td><td>${m.type==="entree"?'<span class="chip ok">Entrée</span>':'<span class="chip orange">Sortie</span>'}</td><td>${esc(designation(m.stock_id))}</td><td class="num">${m.type==="entree"?"+":"−"}${m.qte}</td><td>${m.vehicule_id?esc(vName(m.vehicule_id)):""}${m.km?`<div class="sub">${fmt(m.km)} km</div>`:""}</td><td class="ref">${esc(m.ref||"")}</td><td>${esc(who(m.created_by))}</td><td>${thumb(m.photo,"Photo")}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty">Aucun mouvement.</div>'}</div></div>`;
}

/* ===== Camions ===== */
function vCamions(){
  const vs=[...S.vehicules].sort(vSort);
  return `<div class="panel"><div class="phead"><h2 class="grow">Camions</h2>${canDo("km")?'<button class="btn primary" data-act="km-releve">Relever les kilomètres (WhatsGPS)</button>':""}${canDo("veh")?'<button class="btn" data-act="veh-edit" data-id="">Ajouter un camion</button>':""}</div>
  ${vs.length?`<div class="tbl"><table><thead><tr><th>Code</th><th>Immatriculation</th><th>Type</th><th>Chauffeur</th><th>Statut</th><th class="num">Kilométrage</th><th>Relevé le</th><th class="num">Pièces montées</th><th></th></tr></thead><tbody>${vs.map(v=>{const n=S.mouvements.filter(m=>m.type==="sortie"&&m.vehicule_id===v.id).reduce((s,m)=>s+m.qte,0);return `<tr><td class="ref">${esc(v.code)}</td><td>${esc(v.immat||"")||'<span class="sub">à renseigner</span>'}</td><td>${esc(v.type||"")}</td><td>${esc(v.chauffeur||"")}</td><td><span class="chip ${v.statut==="En panne"?"bad":v.statut==="Hors parc"?"":"ok"}">${esc(v.statut)}</span></td><td class="num">${v.km?fmt(v.km):""}</td><td>${dt(v.km_le)}</td><td class="num">${n||""}</td><td class="num">${canDo("veh")?`<button class="btn sm" data-act="veh-edit" data-id="${v.id}">Modifier</button>`:""}</td></tr>`}).join("")}</tbody></table></div>`:'<div class="empty">Aucun camion.</div>'}</div>
  <p class="sub" style="margin-top:10px">Relevez les kilomètres sur WhatsGPS chaque lundi et à chaque panne.</p>`;
}

/* ===== Journal ===== */
function vJournal(){
  const j=S.journal;
  return `<div class="panel"><div class="phead"><h2 class="grow">Journal</h2><span class="sub">Toutes les actions, avec la personne et l'heure. Rien ne peut y être effacé.</span></div>
  ${j.length?`<div class="tbl"><table><thead><tr><th>Date</th><th>Personne</th><th>Rôle</th><th>Action</th><th>Référence</th></tr></thead><tbody>${j.map(e=>`<tr><td>${dtt(e.at)}</td><td>${esc(who(e.par))}</td><td>${esc(ROLES[e.role]||e.role||"")}</td><td>${esc(e.action)}</td><td class="ref">${esc(e.ref)}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty">Aucune action enregistrée.</div>'}</div>`;
}

/* ===== DG ===== */
function vValider(){
  const list=S.commandes.filter(b=>b.statut==="À valider").sort(newest);
  return `<div class="stack"><h2>Bons de commande à valider</h2><p class="sub">Une commande n'est valable que si elle est validée ici. Un accord donné par téléphone ne suffit pas.</p>
  ${list.length?`<div class="valid">${list.map(b=>{const d=b.demande_id?byId("demandes",b.demande_id):null;return `<div class="vcard"><div class="row"><span class="ref">${esc(b.num)}</span>${d&&d.urgent?'<span class="chip bad">Urgent : camion arrêté</span>':""}<span class="grow"></span><span class="amount">${xaf(b.total)}</span></div>
   <div><b>${esc(b.fournisseur)}</b> · ${esc(vName(b.vehicule_id))}</div>
   <div class="sub">${lignesDe(b.id).map(l=>`${esc(l.designation)} × ${l.qte} à ${xaf(l.pu)}`).join("<br>")}</div>
   <div class="docs">${d?docItem(d.photo,"Demande "+d.num):""}${docItem(b.devis,"Devis")}</div>
   ${b.note?`<div class="sub">Note : ${esc(b.note)}</div>`:""}
   <div class="sub">Préparé par ${esc(who(b.created_by))} le ${dt(b.created_at)}${d?` · demande ${esc(d.num)} du ${dt(d.created_at)}`:""}</div>
   ${canDo("valider")?`<div class="vbtns"><button class="btn ok" data-act="bc-ok" data-id="${b.id}">Valider</button><button class="btn bad" data-act="bc-no" data-id="${b.id}">Refuser</button></div>`:'<div class="sub">Seul le DG peut valider.</div>'}</div>`}).join("")}</div>`:'<div class="empty panel">Rien à valider pour le moment.</div>'}</div>`;
}
function vBord(){
  const m=new Date(),m0=new Date(m.getFullYear(),m.getMonth(),1).getTime();
  const bcM=S.commandes.filter(b=>ts(b.created_at)>=m0&&!["À valider","Refusé"].includes(b.statut));
  const ouvertes=S.demandes.filter(d=>!["Montée","Refusée"].includes(d.statut)).length;
  const attente=S.commandes.filter(b=>["Validé","Reçu partiel"].includes(b.statut)).length;
  const bloq=S.factures.filter(f=>f.statut==="Bloquée").length;
  const payer=S.factures.filter(f=>f.statut==="Conforme").reduce((s,f)=>s+(+f.montant||0),0);
  const panne=S.vehicules.filter(v=>v.statut==="En panne").length;
  const parV={};for(const b of bcM){parV[b.vehicule_id||"—"]=(parV[b.vehicule_id||"—"]||0)+(+b.total||0)}
  const rows=Object.entries(parV).sort((a,b)=>b[1]-a[1]);
  return `<div class="stack"><div class="kpis">
   <div class="kpi"><span>Commandé ce mois</span><b>${fmt(bcM.reduce((s,b)=>s+(+b.total||0),0))}</b><span style="text-transform:none;letter-spacing:0">XAF, ${bcM.length} bon(s) validé(s)</span></div>
   <div class="kpi"><span>Demandes en cours</span><b>${ouvertes}</b></div>
   <div class="kpi"><span>Livraisons attendues</span><b>${attente}</b></div>
   <div class="kpi"><span>Factures bloquées</span><b>${bloq}</b></div>
   <div class="kpi"><span>À payer (conformes)</span><b>${fmt(payer)}</b><span style="text-transform:none;letter-spacing:0">XAF</span></div>
   <div class="kpi"><span>Camions en panne</span><b>${panne}</b></div>
  </div>
  <div class="panel"><div class="phead"><h2 class="grow">Commandes validées ce mois par camion</h2></div>${rows.length?`<div class="tbl"><table><thead><tr><th>Camion</th><th class="num">Montant</th></tr></thead><tbody>${rows.map(([v,x])=>`<tr><td>${esc(vName(v))}</td><td class="num">${xaf(x)}</td></tr>`).join("")}</tbody></table></div>`:'<div class="empty">Aucune commande validée ce mois.</div>'}</div></div>`;
}

/* ===== Administration ===== */
function vParams(){
  const ps=[...S.profils].sort((a,b)=>ts(a.created_at)-ts(b.created_at));
  const ident=p=>{const e=p.email||"";return e.endsWith("@"+CFG.domaine)?e.slice(0,-(CFG.domaine.length+1)):e};
  return `<div class="stack"><div class="panel"><div class="phead"><h2 class="grow">Comptes</h2><button class="btn primary" data-act="cpt-new">Créer un compte</button></div>
  <div class="db"><p class="sub">Créez un compte par personne. Donnez-lui son identifiant et son mot de passe. Une personne sans rôle ou désactivée ne voit rien.</p></div>
  ${ps.length?`<div class="tbl"><table><thead><tr><th>Personne</th><th>Identifiant</th><th>Rôle</th><th>Accès</th><th></th></tr></thead><tbody>${ps.map(p=>p.id===me.id?`<tr><td>${esc(p.nom)} (vous)</td><td>${esc(ident(p))}</td><td>Administration</td><td><span class="chip ok">Actif</span></td><td class="num"><button class="btn sm" data-act="mon-mdp">Changer mon mot de passe</button></td></tr>`:`<tr><td>${esc(p.nom)}</td><td>${esc(ident(p))}</td><td><select data-role="${p.id}" style="width:auto"><option value="">Aucun accès</option>${["base","logistique","dg","admin"].map(k=>`<option value="${k}"${p.role===k?" selected":""}>${ROLES[k]}</option>`).join("")}</select></td><td>${p.actif?`<button class="btn sm" data-act="cpt-actif" data-id="${p.id}" data-v="0">Désactiver</button>`:`<button class="btn sm ok" data-act="cpt-actif" data-id="${p.id}" data-v="1">Réactiver</button>`}</td><td class="num"><button class="btn sm" data-act="cpt-mdp" data-id="${p.id}">Changer le mot de passe</button></td></tr>`).join("")}</tbody></table></div>`:""}</div>
  <div class="panel"><div class="phead"><h2 class="grow">Validation du DG</h2></div><div class="db">
   <div class="f" style="max-width:360px"><label for="seuil">Validation obligatoire au-dessus de (XAF)</label><input id="seuil" type="number" min="0" value="${+S.seuil||0}"></div>
   <p class="sub">0 = toutes les commandes passent par le DG (recommandé). Sous le seuil, la commande est validée automatiquement et le journal l'indique.</p>
   <div><button class="btn primary" data-act="seuil-save">Enregistrer</button></div></div></div></div>`;
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
   <div class="f"><label>Historique</label><div class="hist">${hist.map(h=>`<div>${dtt(h.at)} · ${esc(who(h.par))} · ${esc(h.action)}</div>`).join("")||"—"}</div></div>`,null,null);
}

/* ---------- Actions ---------- */
const H={};
H.tab=d=>{tab=d.k;screen="home";F={};render(true)};
H.go=d=>{screen=d.s;F={qte:1};render(true);window.scrollTo(0,0);if(d.s==="recv")charger()};
H.pick=d=>{if(d.k==="urgent")F.urgent=d.v==="1";else F[d.k]=d.v||null;
  if(d.k==="bc"&&d.v){const b=S.attendues.find(x=>x.id===d.v);if(!b){F.bc=null;return render(true)}(b.lignes||[]).forEach((l,i)=>F["r"+i]=Math.max(0,l.qte-(l.recu||0)))}
  if(d.k==="item"&&d.v){F.qte=1}
  F.err="";render(true)};
H.qty=d=>{let max=99;if(screen==="mount"&&F.item){const s=byId("stock",F.item);max=s?s.qte:1}
  const min=d.k==="qte"?1:0;F[d.k]=Math.min(max,Math.max(min,(+F[d.k]||0)+(+d.d)));render(true)};
H["lb-close"]=()=>$("#lightbox").close();
H.view=async d=>{const p=d.p;await signer([p]);const u=urlCache[p];if(!u){toast("Document indisponible");return}
  $("#lbopen").href=u;$("#lbb").innerHTML=isImgPath(p)?`<img src="${esc(u)}" alt="Document">`:'<p>Ce document est un fichier PDF. Utilisez le bouton « Ouvrir ».</p>';$("#lightbox").showModal()};
H["dlg-cancel"]=()=>$("#dlg").close();
H.logout=async()=>{await sb.auth.signOut();};
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
  const km=parseInt(String(F.km||"").replace(/\D/g,""),10)||null;
  action(()=>rpc("stp2i_sortir_piece",{p_stock:s.id,p_vehicule:F.veh,p_qte:Math.min(F.qte||1,s.qte),p_photo:F.old,p_km:km}),"Sortie enregistrée");
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
  <div class="f"><label for="c-role">Rôle</label><select id="c-role">${["base","logistique","dg","admin"].map(k=>`<option value="${k}">${ROLES[k]}</option>`).join("")}</select></div></div>
  <div class="f"><label for="c-pw">Mot de passe (6 caractères minimum)</label><input id="c-pw" autocomplete="new-password"></div>
  <p class="sub">Communiquez l'identifiant et le mot de passe à la personne en main propre.</p>`,"Créer le compte",async()=>{
  const r=await fonction({action:"creer",nom:val("c-nom"),identifiant:val("c-id"),mot_de_passe:$("#c-pw").value,role:val("c-role")});
  openDlg("Compte créé",`<p>Donnez ces informations à la personne :</p><p>Identifiant : <b>${esc(r.identifiant||r.email)}</b></p><p class="sub">Le mot de passe est celui que vous venez de choisir.</p>`,null,null);charger();return false});
H["cpt-mdp"]=dd=>{const p=byId("profils",dd.id);openDlg("Nouveau mot de passe pour "+(p.nom||p.email),`<div class="f"><label for="m-pw">Nouveau mot de passe (6 caractères minimum)</label><input id="m-pw" autocomplete="new-password"></div>`,"Enregistrer",async()=>{
  await fonction({action:"mot_de_passe",id:p.id,mot_de_passe:$("#m-pw").value});toast("Mot de passe changé")})};
H["mon-mdp"]=()=>openDlg("Changer mon mot de passe",`<div class="f"><label for="mm-pw">Nouveau mot de passe (6 caractères minimum)</label><input id="mm-pw" type="password" autocomplete="new-password"></div>`,"Enregistrer",async()=>{
  const pw=$("#mm-pw").value; if(pw.length<6) throw "Le mot de passe doit faire au moins 6 caractères.";
  const {error}=await sb.auth.updateUser({password:pw}); if(error) throw error; toast("Mot de passe changé")});
H["cpt-actif"]=async dd=>{const p=byId("profils",dd.id);try{await rpc("stp2i_definir_role",{p_user:p.id,p_role:p.role,p_actif:dd.v==="1"});toast(dd.v==="1"?"Compte réactivé":"Compte désactivé");charger()}catch(e){toast(errMsg(e))}};

document.addEventListener("click",e=>{const el=e.target.closest("[data-act]");if(!el)return;const a=el.dataset.act;if(H[a]){if(el.tagName==="BUTTON"&&el.type!=="submit")e.preventDefault();H[a](el.dataset,el)}});
document.addEventListener("input",e=>{const t=e.target;
  if(t.dataset.f){F[t.dataset.f]=t.value}
  if(t.id==="lg-id")F.lgid=t.value;
  if(t.id&&/^l-[qp]-/.test(t.id))bcTotal();
});
document.addEventListener("change",async e=>{const t=e.target;
  if(t.id==="viewas"){viewAs=t.value;try{localStorage.setItem("stp2i-viewas",viewAs)}catch(x){}tab=null;screen="home";F={};render(true)}
  if(t.id==="f-dem"){fDem=t.value;render(true)}
  if(t.id==="f-bc"){fBc=t.value;render(true)}
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
    boot="login";render(true);return; // l'administrateur existe déjà : plus d'écran de premier démarrage
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
