-- STP2i : parc complet (camions, pannes, entretien, carburant, papiers, stock par site,
-- fournisseurs, contrat client, HSE, papiers officiels).
-- Uniquement des objets stp2i_*. Rien de la plateforme Agence Elite n'est touché.
-- Règles inchangées : lecture selon le rôle, écriture seulement par fonction, tout est journalisé,
-- rien ne se supprime depuis l'application.

-- ============ 1. Camions : fiche et historique des chauffeurs ============
alter table public.stp2i_vehicules
  add column if not exists marque text not null default '',
  add column if not exists annee integer,
  add column if not exists notes text not null default '';

create table public.stp2i_affectations (
  id uuid primary key default gen_random_uuid(),
  vehicule_id uuid not null references public.stp2i_vehicules(id),
  chauffeur text not null,
  debut timestamptz not null default now(),
  fin timestamptz,
  motif text not null default '',
  created_by uuid default auth.uid() references public.stp2i_profils(id)
);
create index stp2i_affectations_vehicule on public.stp2i_affectations (vehicule_id, debut desc);

-- Chauffeurs déjà en place : point de départ de l'historique.
insert into public.stp2i_affectations (vehicule_id, chauffeur, debut, motif, created_by)
  select id, chauffeur, created_at, 'Chauffeur au démarrage', null from public.stp2i_vehicules where chauffeur <> '';

create or replace function public.stp2i_changer_chauffeur(p_vehicule uuid, p_chauffeur text, p_motif text) returns void
language plpgsql security definer set search_path = public as $$
declare v public.stp2i_vehicules;
begin
  perform public.stp2i_exiger(array['logistique','admin']);
  select * into v from public.stp2i_vehicules where id = p_vehicule for update;
  if v.id is null then raise exception 'Camion inconnu'; end if;
  if coalesce(trim(p_motif),'') = '' then raise exception 'Indiquez le motif du changement'; end if;
  if coalesce(trim(p_chauffeur),'') = v.chauffeur then raise exception 'C''est déjà le chauffeur de ce camion'; end if;
  update public.stp2i_affectations set fin = now() where vehicule_id = v.id and fin is null;
  if coalesce(trim(p_chauffeur),'') <> '' then
    insert into public.stp2i_affectations (vehicule_id, chauffeur, motif) values (v.id, trim(p_chauffeur), trim(p_motif));
  end if;
  update public.stp2i_vehicules set chauffeur = coalesce(trim(p_chauffeur),'') where id = v.id;
  perform public.stp2i_journaliser('Chauffeur de ' || v.code || ' : ' || coalesce(nullif(trim(p_chauffeur),''),'aucun') || ' (' || trim(p_motif) || ')', v.code);
end $$;

create or replace function public.stp2i_fiche_vehicule(p_id uuid, p_marque text, p_annee int, p_notes text) returns void
language plpgsql security definer set search_path = public as $$
declare v public.stp2i_vehicules;
begin
  perform public.stp2i_exiger(array['logistique','admin']);
  update public.stp2i_vehicules set marque = coalesce(trim(p_marque),''), annee = p_annee, notes = coalesce(p_notes,'') where id = p_id returning * into v;
  if v.id is null then raise exception 'Camion inconnu'; end if;
  perform public.stp2i_journaliser('Fiche camion mise à jour', v.code);
end $$;

-- L'ancienne fonction garde le même nom ; un changement de chauffeur y est maintenant gardé dans l'historique.
create or replace function public.stp2i_enregistrer_vehicule(p_id uuid, p_code text, p_immat text, p_type text, p_chauffeur text, p_statut text)
returns uuid language plpgsql security definer set search_path = public as $$
declare vid uuid; ancien text;
begin
  perform public.stp2i_exiger(array['logistique','admin']);
  if coalesce(trim(p_code),'') = '' then raise exception 'Indiquez le code'; end if;
  if p_id is null then
    insert into public.stp2i_vehicules (code, immat, type, chauffeur, statut) values (trim(p_code), coalesce(p_immat,''), coalesce(p_type,'Autre'), coalesce(trim(p_chauffeur),''), coalesce(p_statut,'En service')) returning id into vid;
    if coalesce(trim(p_chauffeur),'') <> '' then insert into public.stp2i_affectations (vehicule_id, chauffeur, motif) values (vid, trim(p_chauffeur), 'Camion ajouté'); end if;
    perform public.stp2i_journaliser('Camion ajouté', trim(p_code));
  else
    select chauffeur into ancien from public.stp2i_vehicules where id = p_id;
    update public.stp2i_vehicules set code = trim(p_code), immat = coalesce(p_immat,''), type = coalesce(p_type,'Autre'), chauffeur = coalesce(trim(p_chauffeur),''), statut = coalesce(p_statut,'En service') where id = p_id returning id into vid;
    if vid is null then raise exception 'Camion inconnu'; end if;
    if ancien is distinct from coalesce(trim(p_chauffeur),'') then
      update public.stp2i_affectations set fin = now() where vehicule_id = vid and fin is null;
      if coalesce(trim(p_chauffeur),'') <> '' then insert into public.stp2i_affectations (vehicule_id, chauffeur, motif) values (vid, trim(p_chauffeur), 'Fiche camion modifiée'); end if;
    end if;
    perform public.stp2i_journaliser('Camion modifié', trim(p_code));
  end if;
  return vid;
end $$;

-- ============ 2. Pannes ============
create table public.stp2i_pannes (
  id uuid primary key default gen_random_uuid(),
  num text not null unique,
  vehicule_id uuid not null references public.stp2i_vehicules(id),
  description text not null,
  photo text,
  km integer,
  statut text not null default 'Déclarée' check (statut in ('Déclarée','En réparation','Réparée')),
  en_reparation_le timestamptz,
  reparee_le timestamptz,
  reparation text not null default '',
  created_by uuid default auth.uid() references public.stp2i_profils(id),
  created_at timestamptz not null default now()
);
create index stp2i_pannes_vehicule on public.stp2i_pannes (vehicule_id, created_at desc);

create or replace function public.stp2i_declarer_panne(p_vehicule uuid, p_description text, p_photo text, p_km int) returns text
language plpgsql security definer set search_path = public as $$
declare v public.stp2i_vehicules; n text;
begin
  perform public.stp2i_exiger(array['base','logistique','admin']);
  select * into v from public.stp2i_vehicules where id = p_vehicule for update;
  if v.id is null then raise exception 'Camion inconnu'; end if;
  if coalesce(trim(p_description),'') = '' then raise exception 'Dites ce qui ne va pas'; end if;
  n := public.stp2i_prochain_num('PN');
  insert into public.stp2i_pannes (num, vehicule_id, description, photo, km) values (n, v.id, trim(p_description), p_photo, p_km);
  update public.stp2i_vehicules set statut = 'En panne' where id = v.id and statut = 'En service';
  if p_km is not null and (v.km is null or p_km > v.km) then update public.stp2i_vehicules set km = p_km, km_le = now() where id = v.id; end if;
  perform public.stp2i_journaliser('Panne déclarée sur ' || v.code || ' : ' || trim(p_description), n);
  return n;
end $$;

create or replace function public.stp2i_avancer_panne(p_id uuid, p_statut text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare p public.stp2i_pannes; v public.stp2i_vehicules;
begin
  perform public.stp2i_exiger(array['base','logistique','admin']);
  select * into p from public.stp2i_pannes where id = p_id for update;
  if p.id is null then raise exception 'Panne introuvable'; end if;
  if p.statut = 'Réparée' then raise exception 'Cette panne est déjà réparée'; end if;
  if p_statut = 'En réparation' and p.statut = 'Déclarée' then
    update public.stp2i_pannes set statut = 'En réparation', en_reparation_le = now() where id = p.id;
  elsif p_statut = 'Réparée' then
    if coalesce(trim(p_note),'') = '' then raise exception 'Dites ce qui a été réparé'; end if;
    update public.stp2i_pannes set statut = 'Réparée', reparee_le = now(), en_reparation_le = coalesce(en_reparation_le, now()), reparation = trim(p_note) where id = p.id;
    if not exists (select 1 from public.stp2i_pannes where vehicule_id = p.vehicule_id and statut <> 'Réparée' and id <> p.id) then
      update public.stp2i_vehicules set statut = 'En service' where id = p.vehicule_id and statut = 'En panne';
    end if;
  else
    raise exception 'Étape impossible';
  end if;
  select * into v from public.stp2i_vehicules where id = p.vehicule_id;
  perform public.stp2i_journaliser('Panne ' || v.code || ' : ' || p_statut || coalesce(' (' || nullif(trim(p_note),'') || ')',''), p.num);
end $$;

-- ============ 3. Entretien ============
create table public.stp2i_entretiens (
  id uuid primary key default gen_random_uuid(),
  vehicule_id uuid not null references public.stp2i_vehicules(id),
  type text not null,
  tous_km integer check (tous_km > 0),
  tous_jours integer check (tous_jours > 0),
  dernier_km integer,
  dernier_le date,
  unique (vehicule_id, type)
);
create table public.stp2i_entretiens_faits (
  id uuid primary key default gen_random_uuid(),
  entretien_id uuid not null references public.stp2i_entretiens(id),
  km integer,
  fait_le date not null,
  note text not null default '',
  created_by uuid default auth.uid() references public.stp2i_profils(id),
  created_at timestamptz not null default now()
);

create or replace function public.stp2i_definir_entretien(p_vehicule uuid, p_type text, p_tous_km int, p_tous_jours int, p_dernier_km int, p_dernier_le date) returns uuid
language plpgsql security definer set search_path = public as $$
declare eid uuid; v public.stp2i_vehicules;
begin
  perform public.stp2i_exiger(array['logistique','admin']);
  select * into v from public.stp2i_vehicules where id = p_vehicule;
  if v.id is null then raise exception 'Camion inconnu'; end if;
  if coalesce(trim(p_type),'') = '' then raise exception 'Indiquez le type d''entretien'; end if;
  if p_tous_km is null and p_tous_jours is null then raise exception 'Indiquez tous les combien de km ou de jours'; end if;
  insert into public.stp2i_entretiens (vehicule_id, type, tous_km, tous_jours, dernier_km, dernier_le)
    values (v.id, trim(p_type), p_tous_km, p_tous_jours, p_dernier_km, p_dernier_le)
    on conflict (vehicule_id, type) do update set tous_km = excluded.tous_km, tous_jours = excluded.tous_jours,
      dernier_km = coalesce(excluded.dernier_km, public.stp2i_entretiens.dernier_km), dernier_le = coalesce(excluded.dernier_le, public.stp2i_entretiens.dernier_le)
    returning id into eid;
  perform public.stp2i_journaliser('Entretien programmé : ' || trim(p_type) || ' sur ' || v.code, v.code);
  return eid;
end $$;

create or replace function public.stp2i_faire_entretien(p_id uuid, p_km int, p_le date, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare e public.stp2i_entretiens; v public.stp2i_vehicules;
begin
  perform public.stp2i_exiger(array['base','logistique','admin']);
  select * into e from public.stp2i_entretiens where id = p_id for update;
  if e.id is null then raise exception 'Entretien introuvable'; end if;
  insert into public.stp2i_entretiens_faits (entretien_id, km, fait_le, note) values (e.id, p_km, coalesce(p_le, current_date), coalesce(p_note,''));
  update public.stp2i_entretiens set dernier_km = coalesce(p_km, dernier_km), dernier_le = coalesce(p_le, current_date) where id = e.id;
  select * into v from public.stp2i_vehicules where id = e.vehicule_id;
  if p_km is not null and (v.km is null or p_km > v.km) then update public.stp2i_vehicules set km = p_km, km_le = now() where id = v.id; end if;
  perform public.stp2i_journaliser('Entretien fait : ' || e.type || ' sur ' || v.code, v.code);
end $$;

-- ============ 4. Carburant ============
create table public.stp2i_carburant (
  id uuid primary key default gen_random_uuid(),
  vehicule_id uuid not null references public.stp2i_vehicules(id),
  fait_le date not null,
  litres numeric not null check (litres > 0),
  prix_litre numeric not null check (prix_litre >= 0),
  montant numeric not null,
  km integer,
  fournisseur text not null default '',
  facture_num text not null default '',
  photo text,
  created_by uuid default auth.uid() references public.stp2i_profils(id),
  created_at timestamptz not null default now()
);
create index stp2i_carburant_vehicule on public.stp2i_carburant (vehicule_id, fait_le desc);

create or replace function public.stp2i_noter_plein(p_vehicule uuid, p_le date, p_litres numeric, p_prix numeric, p_km int, p_fournisseur text, p_facture text, p_photo text) returns void
language plpgsql security definer set search_path = public as $$
declare v public.stp2i_vehicules;
begin
  perform public.stp2i_exiger(array['base','logistique','admin']);
  select * into v from public.stp2i_vehicules where id = p_vehicule;
  if v.id is null then raise exception 'Camion inconnu'; end if;
  if coalesce(p_litres,0) <= 0 then raise exception 'Indiquez les litres'; end if;
  if coalesce(p_prix,-1) < 0 then raise exception 'Indiquez le prix du litre'; end if;
  insert into public.stp2i_carburant (vehicule_id, fait_le, litres, prix_litre, montant, km, fournisseur, facture_num, photo)
    values (v.id, coalesce(p_le, current_date), p_litres, p_prix, round(p_litres * p_prix), p_km, coalesce(trim(p_fournisseur),''), coalesce(trim(p_facture),''), p_photo);
  if p_km is not null and (v.km is null or p_km > v.km) then update public.stp2i_vehicules set km = p_km, km_le = now() where id = v.id; end if;
  perform public.stp2i_journaliser('Plein noté : ' || p_litres || ' L sur ' || v.code, coalesce(nullif(trim(p_facture),''), v.code));
end $$;

-- ============ 5. Papiers et dates de fin ============
-- Chaque renouvellement ajoute une ligne : l'ancienne reste dans l'historique.
create table public.stp2i_papiers (
  id uuid primary key default gen_random_uuid(),
  vehicule_id uuid references public.stp2i_vehicules(id),
  personne text not null default '',
  type text not null,
  numero text not null default '',
  date_fin date not null,
  fichier text,
  created_by uuid default auth.uid() references public.stp2i_profils(id),
  created_at timestamptz not null default now(),
  check (vehicule_id is not null or personne <> '')
);

create or replace function public.stp2i_enregistrer_papier(p_vehicule uuid, p_personne text, p_type text, p_numero text, p_date_fin date, p_fichier text) returns void
language plpgsql security definer set search_path = public as $$
declare qui text;
begin
  perform public.stp2i_exiger(array['logistique','admin']);
  if coalesce(trim(p_type),'') = '' then raise exception 'Indiquez le type de papier'; end if;
  if p_date_fin is null then raise exception 'Indiquez la date de fin'; end if;
  if p_vehicule is null and coalesce(trim(p_personne),'') = '' then raise exception 'Choisissez un camion ou une personne'; end if;
  insert into public.stp2i_papiers (vehicule_id, personne, type, numero, date_fin, fichier)
    values (p_vehicule, coalesce(trim(p_personne),''), trim(p_type), coalesce(trim(p_numero),''), p_date_fin, p_fichier);
  qui := coalesce((select code from public.stp2i_vehicules where id = p_vehicule), trim(p_personne));
  perform public.stp2i_journaliser(trim(p_type) || ' de ' || qui || ' valable jusqu''au ' || to_char(p_date_fin,'DD/MM/YYYY'), qui);
end $$;

-- ============ 6. Stock : familles, minimum, sites, transferts, inventaires ============
alter table public.stp2i_stock
  add column if not exists famille text not null default '',
  add column if not exists seuil_min integer not null default 0 check (seuil_min >= 0),
  add column if not exists rayon text not null default '';

create table public.stp2i_sites (
  nom text primary key,
  ordre integer not null default 0
);
insert into public.stp2i_sites (nom, ordre) values ('Base', 0), ('Direction', 1), ('Chantier', 2) on conflict do nothing;

-- Quantité hors de la base. La quantité à la base = stock.qte - sites - en route.
create table public.stp2i_stock_sites (
  stock_id uuid not null references public.stp2i_stock(id),
  site text not null references public.stp2i_sites(nom),
  qte integer not null default 0 check (qte >= 0),
  primary key (stock_id, site),
  check (site <> 'Base')
);

create table public.stp2i_transferts (
  id uuid primary key default gen_random_uuid(),
  num text not null unique,
  stock_id uuid not null references public.stp2i_stock(id),
  qte integer not null check (qte > 0),
  de_site text not null references public.stp2i_sites(nom),
  vers_site text not null references public.stp2i_sites(nom),
  statut text not null default 'En route' check (statut in ('En route','Reçu')),
  envoye_par uuid default auth.uid() references public.stp2i_profils(id),
  envoye_le timestamptz not null default now(),
  recu_par uuid references public.stp2i_profils(id),
  recu_le timestamptz,
  check (de_site <> vers_site)
);

alter table public.stp2i_mouvements
  add column if not exists site text not null default 'Base',
  add column if not exists motif text not null default '',
  add column if not exists ancienne_rendue boolean;

create or replace function public.stp2i_qte_site(p_stock uuid, p_site text) returns integer
language sql stable security definer set search_path = public as $$
  select case when p_site = 'Base' then
    (select qte from public.stp2i_stock where id = p_stock)
    - coalesce((select sum(qte) from public.stp2i_stock_sites where stock_id = p_stock), 0)
    - coalesce((select sum(qte) from public.stp2i_transferts where stock_id = p_stock and statut = 'En route'), 0)
  else coalesce((select qte from public.stp2i_stock_sites where stock_id = p_stock and site = p_site), 0) end
$$;

create or replace function public.stp2i_creer_article(p_designation text, p_famille text, p_seuil int, p_rayon text) returns uuid
language plpgsql security definer set search_path = public as $$
declare k text; sid uuid;
begin
  perform public.stp2i_exiger(array['logistique','admin']);
  if coalesce(trim(p_designation),'') = '' then raise exception 'Indiquez le nom de la pièce'; end if;
  k := lower(regexp_replace(trim(p_designation), '\s+', ' ', 'g'));
  insert into public.stp2i_stock (designation, cle, qte, famille, seuil_min, rayon) values (trim(p_designation), k, 0, coalesce(trim(p_famille),''), greatest(coalesce(p_seuil,0),0), coalesce(trim(p_rayon),''))
    on conflict (cle) do nothing returning id into sid;
  if sid is null then raise exception 'Cette pièce existe déjà dans le stock'; end if;
  perform public.stp2i_journaliser('Pièce ajoutée au stock : ' || trim(p_designation), '');
  return sid;
end $$;

create or replace function public.stp2i_definir_article(p_stock uuid, p_famille text, p_seuil int, p_rayon text) returns void
language plpgsql security definer set search_path = public as $$
declare s public.stp2i_stock;
begin
  perform public.stp2i_exiger(array['logistique','admin']);
  update public.stp2i_stock set famille = coalesce(trim(p_famille),''), seuil_min = greatest(coalesce(p_seuil,0),0), rayon = coalesce(trim(p_rayon),'') where id = p_stock returning * into s;
  if s.id is null then raise exception 'Pièce introuvable'; end if;
  perform public.stp2i_journaliser('Fiche pièce : ' || s.designation || ' (minimum ' || s.seuil_min || ')', '');
end $$;

create or replace function public.stp2i_envoyer_transfert(p_stock uuid, p_qte int, p_de text, p_vers text) returns text
language plpgsql security definer set search_path = public as $$
declare s public.stp2i_stock; n text;
begin
  perform public.stp2i_exiger(array['base','logistique','admin']);
  select * into s from public.stp2i_stock where id = p_stock for update;
  if s.id is null then raise exception 'Pièce introuvable'; end if;
  if coalesce(p_qte,0) <= 0 then raise exception 'Indiquez la quantité'; end if;
  if p_de = p_vers then raise exception 'Choisissez deux lieux différents'; end if;
  if not exists (select 1 from public.stp2i_sites where nom = p_vers) or not exists (select 1 from public.stp2i_sites where nom = p_de) then raise exception 'Lieu inconnu'; end if;
  if public.stp2i_qte_site(s.id, p_de) < p_qte then raise exception 'Pas assez de pièces à %', p_de; end if;
  if p_de <> 'Base' then update public.stp2i_stock_sites set qte = qte - p_qte where stock_id = s.id and site = p_de; end if;
  n := public.stp2i_prochain_num('TR');
  insert into public.stp2i_transferts (num, stock_id, qte, de_site, vers_site) values (n, s.id, p_qte, p_de, p_vers);
  perform public.stp2i_journaliser('Envoi de ' || p_qte || ' × ' || s.designation || ' : ' || p_de || ' vers ' || p_vers, n);
  return n;
end $$;

create or replace function public.stp2i_recevoir_transfert(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t public.stp2i_transferts; s public.stp2i_stock;
begin
  perform public.stp2i_exiger(array['base','logistique','admin']);
  select * into t from public.stp2i_transferts where id = p_id for update;
  if t.id is null or t.statut <> 'En route' then raise exception 'Envoi introuvable ou déjà reçu'; end if;
  if t.envoye_par = auth.uid() then raise exception 'La personne qui reçoit doit être différente de celle qui envoie'; end if;
  update public.stp2i_transferts set statut = 'Reçu', recu_par = auth.uid(), recu_le = now() where id = t.id;
  if t.vers_site <> 'Base' then
    insert into public.stp2i_stock_sites (stock_id, site, qte) values (t.stock_id, t.vers_site, t.qte)
      on conflict (stock_id, site) do update set qte = public.stp2i_stock_sites.qte + t.qte;
  end if;
  select * into s from public.stp2i_stock where id = t.stock_id;
  perform public.stp2i_journaliser('Reçu ' || t.qte || ' × ' || s.designation || ' à ' || t.vers_site, t.num);
end $$;

-- Pose d'une pièce sur un camion, depuis un lieu, avec la pièce usée rendue ou non.
-- Si la pièce était demandée pour un autre camion, le motif est obligatoire.
create or replace function public.stp2i_monter_piece(p_stock uuid, p_vehicule uuid, p_qte int, p_photo text, p_km int, p_site text, p_demande uuid, p_motif text, p_ancienne_rendue boolean)
returns void language plpgsql security definer set search_path = public as $$
declare s public.stp2i_stock; v public.stp2i_vehicules; d public.stp2i_demandes; q int := greatest(coalesce(p_qte,1),1); st text := coalesce(nullif(p_site,''),'Base');
begin
  perform public.stp2i_exiger(array['base','admin']);
  if p_photo is null then raise exception 'Photo de la pièce usée obligatoire : pas de pièce neuve sans pièce usée rendue'; end if;
  if p_ancienne_rendue is distinct from true and coalesce(trim(p_motif),'') = '' then raise exception 'Pièce usée non rendue : indiquez pourquoi'; end if;
  select * into s from public.stp2i_stock where id = p_stock for update;
  if s.id is null then raise exception 'Pièce introuvable'; end if;
  if public.stp2i_qte_site(s.id, st) < q then raise exception 'Stock insuffisant à %', st; end if;
  select * into v from public.stp2i_vehicules where id = p_vehicule;
  if v.id is null then raise exception 'Camion inconnu'; end if;
  if p_demande is not null then
    select * into d from public.stp2i_demandes where id = p_demande and statut = 'Reçue à la base';
    if d.id is null then raise exception 'Demande introuvable ou pas encore reçue'; end if;
    if d.vehicule_id <> v.id and coalesce(trim(p_motif),'') = '' then raise exception 'Cette pièce était demandée pour un autre camion : indiquez pourquoi'; end if;
  else
    select * into d from public.stp2i_demandes where vehicule_id = v.id and statut = 'Reçue à la base' order by created_at limit 1;
  end if;
  update public.stp2i_stock set qte = qte - q, derniere_sortie = now() where id = s.id;
  if st <> 'Base' then update public.stp2i_stock_sites set qte = qte - q where stock_id = s.id and site = st; end if;
  insert into public.stp2i_mouvements (type, stock_id, qte, vehicule_id, photo, km, ref, site, motif, ancienne_rendue)
    values ('sortie', s.id, q, v.id, p_photo, p_km, coalesce(d.num,''), st, coalesce(trim(p_motif),''), p_ancienne_rendue);
  if p_km is not null and (v.km is null or p_km > v.km) then update public.stp2i_vehicules set km = p_km, km_le = now() where id = v.id; end if;
  if d.id is not null then update public.stp2i_demandes set statut = 'Montée' where id = d.id; end if;
  perform public.stp2i_journaliser(q || ' × ' || s.designation || ' montée(s) sur ' || v.code
    || case when d.id is not null and d.vehicule_id <> v.id then ' (demandée pour un autre camion : ' || trim(p_motif) || ')' else '' end
    || case when p_ancienne_rendue is distinct from true then ' — pièce usée non rendue : ' || trim(p_motif) else '' end, coalesce(d.num,''));
end $$;

-- L'ancienne fonction reste (l'application en ligne l'appelle), mais ne prend que ce qui est à la base.
create or replace function public.stp2i_sortir_piece(p_stock uuid, p_vehicule uuid, p_qte int, p_photo text, p_km int)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.stp2i_monter_piece(p_stock, p_vehicule, p_qte, p_photo, p_km, 'Base', null, '', true);
end $$;

create table public.stp2i_inventaires (
  id uuid primary key default gen_random_uuid(),
  num text not null unique,
  site text not null references public.stp2i_sites(nom),
  lignes jsonb not null,
  ecarts integer not null default 0,
  note text not null default '',
  created_by uuid default auth.uid() references public.stp2i_profils(id),
  created_at timestamptz not null default now()
);

-- p_lignes = [{"stock_id":"...","compte":3}, ...] ; corrige le stock et garde la trace des écarts.
create or replace function public.stp2i_enregistrer_inventaire(p_site text, p_lignes jsonb, p_note text) returns text
language plpgsql security definer set search_path = public as $$
declare l jsonb; s public.stp2i_stock; theo int; c int; n text; e int := 0; res jsonb := '[]';
begin
  perform public.stp2i_exiger(array['base','logistique','admin']);
  if not exists (select 1 from public.stp2i_sites where nom = p_site) then raise exception 'Lieu inconnu'; end if;
  for l in select * from jsonb_array_elements(coalesce(p_lignes,'[]')) loop
    select * into s from public.stp2i_stock where id = (l->>'stock_id')::uuid for update;
    if s.id is null then continue; end if;
    c := (l->>'compte')::int;
    if c is null or c < 0 then raise exception 'Quantité comptée invalide pour %', s.designation; end if;
    theo := public.stp2i_qte_site(s.id, p_site);
    res := res || jsonb_build_object('stock_id', s.id, 'designation', s.designation, 'theorique', theo, 'compte', c);
    if c <> theo then
      e := e + 1;
      if theo + (s.qte - theo) + (c - theo) < 0 then raise exception 'Écart impossible pour %', s.designation; end if;
      update public.stp2i_stock set qte = qte + (c - theo) where id = s.id;
      if p_site <> 'Base' then
        insert into public.stp2i_stock_sites (stock_id, site, qte) values (s.id, p_site, c)
          on conflict (stock_id, site) do update set qte = c;
      end if;
    end if;
  end loop;
  if jsonb_array_length(res) = 0 then raise exception 'Comptez au moins une pièce'; end if;
  if e > 0 and coalesce(trim(p_note),'') = '' then raise exception 'Il y a des écarts : expliquez-les'; end if;
  n := public.stp2i_prochain_num('INV');
  insert into public.stp2i_inventaires (num, site, lignes, ecarts, note) values (n, p_site, res, e, coalesce(trim(p_note),''));
  perform public.stp2i_journaliser('Inventaire ' || p_site || ' : ' || jsonb_array_length(res) || ' pièce(s) comptée(s), ' || e || ' écart(s)', n);
  return n;
end $$;

-- ============ 7. Fournisseurs ============
create table public.stp2i_fournisseurs (
  id uuid primary key default gen_random_uuid(),
  nom text not null,
  telephone text not null default '',
  contact text not null default '',
  adresse text not null default '',
  delai_jours integer,
  notes text not null default '',
  created_at timestamptz not null default now()
);
create unique index stp2i_fournisseurs_nom on public.stp2i_fournisseurs (lower(nom));

create or replace function public.stp2i_enregistrer_fournisseur(p_id uuid, p_nom text, p_telephone text, p_contact text, p_adresse text, p_delai int, p_notes text) returns uuid
language plpgsql security definer set search_path = public as $$
declare fid uuid;
begin
  perform public.stp2i_exiger(array['logistique','admin']);
  if coalesce(trim(p_nom),'') = '' then raise exception 'Indiquez le nom du fournisseur'; end if;
  if p_id is null then
    insert into public.stp2i_fournisseurs (nom, telephone, contact, adresse, delai_jours, notes)
      values (trim(p_nom), coalesce(trim(p_telephone),''), coalesce(trim(p_contact),''), coalesce(trim(p_adresse),''), p_delai, coalesce(p_notes,'')) returning id into fid;
    perform public.stp2i_journaliser('Fournisseur ajouté : ' || trim(p_nom), '');
  else
    update public.stp2i_fournisseurs set nom = trim(p_nom), telephone = coalesce(trim(p_telephone),''), contact = coalesce(trim(p_contact),''), adresse = coalesce(trim(p_adresse),''), delai_jours = p_delai, notes = coalesce(p_notes,'')
      where id = p_id returning id into fid;
    if fid is null then raise exception 'Fournisseur introuvable'; end if;
    perform public.stp2i_journaliser('Fournisseur modifié : ' || trim(p_nom), '');
  end if;
  return fid;
end $$;

-- ============ 8. Contrat client : prix, jours de travail, pièces hors contrat ============
create table public.stp2i_contrat_prix (
  type text primary key,
  prix_mois numeric not null default 0 check (prix_mois >= 0),
  prix_m3 numeric not null default 0 check (prix_m3 >= 0)
);
create table public.stp2i_jours (
  vehicule_id uuid not null references public.stp2i_vehicules(id),
  jour date not null,
  statut text not null check (statut in ('Travaillé','Panne','Arrêt client','Repos')),
  m3 numeric not null default 0 check (m3 >= 0),
  note text not null default '',
  par uuid default auth.uid() references public.stp2i_profils(id),
  maj_le timestamptz not null default now(),
  primary key (vehicule_id, jour)
);
alter table public.stp2i_commandes
  add column if not exists hors_contrat boolean not null default false,
  add column if not exists hors_contrat_note text not null default '';

create or replace function public.stp2i_definir_prix_contrat(p_type text, p_prix_mois numeric, p_prix_m3 numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.stp2i_exiger(array['admin','dg']);
  if coalesce(trim(p_type),'') = '' then raise exception 'Indiquez le type de camion'; end if;
  insert into public.stp2i_contrat_prix (type, prix_mois, prix_m3) values (trim(p_type), greatest(coalesce(p_prix_mois,0),0), greatest(coalesce(p_prix_m3,0),0))
    on conflict (type) do update set prix_mois = excluded.prix_mois, prix_m3 = excluded.prix_m3;
  perform public.stp2i_journaliser('Prix du contrat mis à jour : ' || trim(p_type), '');
end $$;

-- p_jours = [{"vehicule_id":"...","jour":"2026-10-24","statut":"Travaillé","m3":12,"note":""}, ...]
create or replace function public.stp2i_noter_jours(p_jours jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare j jsonb; n int := 0;
begin
  perform public.stp2i_exiger(array['base','logistique','admin']);
  for j in select * from jsonb_array_elements(coalesce(p_jours,'[]')) loop
    if (j->>'statut') not in ('Travaillé','Panne','Arrêt client','Repos') then raise exception 'Statut de journée inconnu'; end if;
    if (j->>'jour')::date > current_date then raise exception 'On ne note pas un jour futur'; end if;
    insert into public.stp2i_jours (vehicule_id, jour, statut, m3, note) values ((j->>'vehicule_id')::uuid, (j->>'jour')::date, j->>'statut', greatest(coalesce((j->>'m3')::numeric,0),0), coalesce(j->>'note',''))
      on conflict (vehicule_id, jour) do update set statut = excluded.statut, m3 = excluded.m3, note = excluded.note, par = auth.uid(), maj_le = now();
    n := n + 1;
  end loop;
  if n > 0 then perform public.stp2i_journaliser('Journées de travail notées (' || n || ')', ''); end if;
  return n;
end $$;

create or replace function public.stp2i_marquer_hors_contrat(p_commande uuid, p_hors boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.stp2i_commandes;
begin
  perform public.stp2i_exiger(array['logistique','admin','dg']);
  if p_hors and coalesce(trim(p_note),'') = '' then raise exception 'Expliquez pourquoi c''est hors contrat'; end if;
  update public.stp2i_commandes set hors_contrat = coalesce(p_hors,false), hors_contrat_note = coalesce(trim(p_note),'') where id = p_commande returning * into c;
  if c.id is null then raise exception 'Bon de commande introuvable'; end if;
  perform public.stp2i_journaliser(case when p_hors then 'Marqué hors contrat : ' || trim(p_note) else 'Remis dans le contrat' end, c.num);
end $$;

-- ============ 9. HSE ============
create table public.stp2i_controles_depart (
  id uuid primary key default gen_random_uuid(),
  vehicule_id uuid not null references public.stp2i_vehicules(id),
  chauffeur text not null default '',
  points jsonb not null,
  ok boolean not null,
  km integer,
  photo text,
  note text not null default '',
  panne_num text,
  created_by uuid default auth.uid() references public.stp2i_profils(id),
  created_at timestamptz not null default now()
);
create index stp2i_controles_vehicule on public.stp2i_controles_depart (vehicule_id, created_at desc);

-- p_points = {"Pneus":true,"Freins":false,...} ; un point non bon déclare une panne tout seul.
create or replace function public.stp2i_controle_depart(p_vehicule uuid, p_chauffeur text, p_points jsonb, p_km int, p_photo text, p_note text) returns text
language plpgsql security definer set search_path = public as $$
declare v public.stp2i_vehicules; bons boolean; mauvais text; pn text;
begin
  perform public.stp2i_exiger(array['base','logistique','admin']);
  select * into v from public.stp2i_vehicules where id = p_vehicule;
  if v.id is null then raise exception 'Camion inconnu'; end if;
  if jsonb_typeof(p_points) <> 'object' or p_points = '{}'::jsonb then raise exception 'Cochez les points du contrôle'; end if;
  select string_agg(key, ', ') into mauvais from jsonb_each(p_points) where value <> 'true'::jsonb;
  bons := mauvais is null;
  if not bons then
    if p_photo is null then raise exception 'Un point n''est pas bon : prenez une photo'; end if;
    pn := public.stp2i_declarer_panne(v.id, 'Contrôle avant départ : ' || mauvais || coalesce(' — ' || nullif(trim(p_note),''),''), p_photo, p_km);
  end if;
  insert into public.stp2i_controles_depart (vehicule_id, chauffeur, points, ok, km, photo, note, panne_num)
    values (v.id, coalesce(nullif(trim(p_chauffeur),''), v.chauffeur), p_points, bons, p_km, p_photo, coalesce(trim(p_note),''), pn);
  if p_km is not null and (v.km is null or p_km > v.km) then update public.stp2i_vehicules set km = p_km, km_le = now() where id = v.id; end if;
  perform public.stp2i_journaliser('Contrôle avant départ ' || v.code || ' : ' || case when bons then 'tout est bon' else 'à revoir (' || mauvais || ')' end, coalesce(pn, v.code));
  return case when bons then 'ok' else pn end;
end $$;

create table public.stp2i_hse (
  id uuid primary key default gen_random_uuid(),
  num text not null unique,
  type text not null check (type in ('Accident','Presque accident','Inspection','Remarque')),
  vehicule_id uuid references public.stp2i_vehicules(id),
  survenu_le timestamptz not null,
  lieu text not null default '',
  description text not null,
  gravite text not null default 'Faible' check (gravite in ('Faible','Moyenne','Grave')),
  blesses boolean not null default false,
  photo text,
  statut text not null default 'Ouvert' check (statut in ('Ouvert','Clos')),
  actions text not null default '',
  clos_le timestamptz,
  created_by uuid default auth.uid() references public.stp2i_profils(id),
  created_at timestamptz not null default now()
);

create or replace function public.stp2i_declarer_hse(p_type text, p_vehicule uuid, p_le timestamptz, p_lieu text, p_description text, p_gravite text, p_blesses boolean, p_photo text) returns text
language plpgsql security definer set search_path = public as $$
declare n text;
begin
  perform public.stp2i_exiger(array['base','logistique','admin','dg']);
  if coalesce(trim(p_description),'') = '' then raise exception 'Racontez ce qui s''est passé'; end if;
  n := public.stp2i_prochain_num('HSE');
  insert into public.stp2i_hse (num, type, vehicule_id, survenu_le, lieu, description, gravite, blesses, photo)
    values (n, p_type, p_vehicule, coalesce(p_le, now()), coalesce(trim(p_lieu),''), trim(p_description), coalesce(p_gravite,'Faible'), coalesce(p_blesses,false), p_photo);
  perform public.stp2i_journaliser(p_type || ' déclaré' || coalesce(' (' || (select code from public.stp2i_vehicules where id = p_vehicule) || ')',''), n);
  return n;
end $$;

create or replace function public.stp2i_clore_hse(p_id uuid, p_actions text) returns void
language plpgsql security definer set search_path = public as $$
declare h public.stp2i_hse;
begin
  perform public.stp2i_exiger(array['logistique','admin','dg']);
  if coalesce(trim(p_actions),'') = '' then raise exception 'Dites ce qui a été fait pour que ça ne recommence pas'; end if;
  update public.stp2i_hse set statut = 'Clos', actions = trim(p_actions), clos_le = now() where id = p_id and statut = 'Ouvert' returning * into h;
  if h.id is null then raise exception 'Fiche introuvable ou déjà close'; end if;
  perform public.stp2i_journaliser(h.type || ' clos : ' || trim(p_actions), h.num);
end $$;

create table public.stp2i_formations (
  id uuid primary key default gen_random_uuid(),
  personne text not null,
  theme text not null,
  faite_le date not null,
  valable_jusqu_au date,
  fichier text,
  created_by uuid default auth.uid() references public.stp2i_profils(id),
  created_at timestamptz not null default now()
);

create or replace function public.stp2i_enregistrer_formation(p_personne text, p_theme text, p_le date, p_jusqu_au date, p_fichier text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.stp2i_exiger(array['logistique','admin']);
  if coalesce(trim(p_personne),'') = '' or coalesce(trim(p_theme),'') = '' then raise exception 'Indiquez la personne et le thème'; end if;
  insert into public.stp2i_formations (personne, theme, faite_le, valable_jusqu_au, fichier) values (trim(p_personne), trim(p_theme), coalesce(p_le, current_date), p_jusqu_au, p_fichier);
  perform public.stp2i_journaliser('Formation ' || trim(p_theme) || ' : ' || trim(p_personne), '');
end $$;

-- ============ 10. Papiers officiels : signature et cachet du DG ============
alter table public.stp2i_reglages
  add column if not exists signature_dg text,
  add column if not exists cachet text,
  add column if not exists societe text not null default 'STP2i';

create or replace function public.stp2i_definir_signature(p_signature text, p_cachet text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.stp2i_exiger(array['admin','dg']);
  update public.stp2i_reglages set signature_dg = coalesce(p_signature, signature_dg), cachet = coalesce(p_cachet, cachet) where id = 1;
  perform public.stp2i_journaliser('Signature ou cachet du DG mis à jour', '');
end $$;

-- ============ Lecture (RLS) ============
alter table public.stp2i_affectations enable row level security;
alter table public.stp2i_pannes enable row level security;
alter table public.stp2i_entretiens enable row level security;
alter table public.stp2i_entretiens_faits enable row level security;
alter table public.stp2i_carburant enable row level security;
alter table public.stp2i_papiers enable row level security;
alter table public.stp2i_sites enable row level security;
alter table public.stp2i_stock_sites enable row level security;
alter table public.stp2i_transferts enable row level security;
alter table public.stp2i_inventaires enable row level security;
alter table public.stp2i_fournisseurs enable row level security;
alter table public.stp2i_contrat_prix enable row level security;
alter table public.stp2i_jours enable row level security;
alter table public.stp2i_controles_depart enable row level security;
alter table public.stp2i_hse enable row level security;
alter table public.stp2i_formations enable row level security;

create policy stp2i_affectations_lecture on public.stp2i_affectations for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_pannes_lecture on public.stp2i_pannes for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_entretiens_lecture on public.stp2i_entretiens for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_entretiens_faits_lecture on public.stp2i_entretiens_faits for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_carburant_lecture on public.stp2i_carburant for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_papiers_lecture on public.stp2i_papiers for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_sites_lecture on public.stp2i_sites for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_stock_sites_lecture on public.stp2i_stock_sites for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_transferts_lecture on public.stp2i_transferts for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_inventaires_lecture on public.stp2i_inventaires for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_jours_lecture on public.stp2i_jours for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_controles_lecture on public.stp2i_controles_depart for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_hse_lecture on public.stp2i_hse for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_formations_lecture on public.stp2i_formations for select to authenticated using (public.stp2i_mon_role() is not null);
-- Fournisseurs et prix du contrat : pas pour la base.
create policy stp2i_fournisseurs_lecture on public.stp2i_fournisseurs for select to authenticated using (public.stp2i_mon_role() in ('admin','logistique','dg'));
create policy stp2i_contrat_prix_lecture on public.stp2i_contrat_prix for select to authenticated using (public.stp2i_mon_role() in ('admin','logistique','dg'));

-- ============ Droits d'exécution ============
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'stp2i\_%' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
revoke execute on function public.stp2i_prochain_num(text) from authenticated;
revoke execute on function public.stp2i_journaliser(text, text) from authenticated;
revoke execute on function public.stp2i_exiger(text[]) from authenticated;
revoke execute on function public.stp2i_anomalies_facture(uuid, text, numeric, uuid) from authenticated;
revoke execute on function public.stp2i_qte_site(uuid, text) from authenticated;
-- stp2i_admin_existe reste fermée aux visiteurs non connectés (migration 20261023201700).

-- ============ Temps réel ============
alter publication supabase_realtime add table public.stp2i_pannes, public.stp2i_carburant, public.stp2i_papiers, public.stp2i_transferts,
  public.stp2i_stock_sites, public.stp2i_jours, public.stp2i_controles_depart, public.stp2i_hse, public.stp2i_affectations, public.stp2i_entretiens;
