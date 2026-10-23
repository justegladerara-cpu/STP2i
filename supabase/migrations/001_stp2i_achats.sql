-- STP2i Achats et Parc : schéma, droits et règles métier.
-- Toutes les tables, fonctions et le dossier de fichiers sont préfixés stp2i_ :
-- ils cohabitent avec la plateforme Agence Elite sans rien modifier d'elle.
-- Principe : les utilisateurs peuvent lire selon leur rôle, mais n'écrivent JAMAIS
-- directement dans les tables. Toute écriture passe par une fonction ci-dessous,
-- qui vérifie le rôle, applique la règle et écrit dans le journal.
-- Rien ne peut être supprimé depuis l'application.

create extension if not exists pgcrypto;

-- ---------- Profils et rôles ----------
create table public.stp2i_profils (
  id uuid primary key references auth.users(id) on delete cascade,
  nom text not null default '',
  email text,
  role text check (role in ('admin','base','logistique','dg')),
  actif boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.stp2i_mon_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.stp2i_profils where id = auth.uid() and actif
$$;

create or replace function public.stp2i_exiger(roles text[]) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if public.stp2i_mon_role() is null or not (public.stp2i_mon_role() = any(roles) or public.stp2i_mon_role() = 'admin' and 'admin' = any(roles)) then
    raise exception 'Action non autorisée pour votre rôle' using errcode = '42501';
  end if;
end $$;

-- Profil STP2i créé à la première connexion (sans rôle : l'administrateur l'attribue).
create or replace function public.stp2i_mon_profil() returns public.stp2i_profils
language plpgsql security definer set search_path = public as $$
declare p public.stp2i_profils;
begin
  if auth.uid() is null then raise exception 'Non connecté'; end if;
  insert into public.stp2i_profils (id, nom, email)
    select u.id, coalesce(nullif(u.raw_user_meta_data->>'nom',''), split_part(u.email,'@',1)), u.email from auth.users u where u.id = auth.uid()
    on conflict (id) do nothing;
  select * into p from public.stp2i_profils where id = auth.uid();
  return p;
end $$;

create or replace function public.stp2i_admin_existe() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.stp2i_profils where role = 'admin')
$$;

-- ---------- Réglages ----------
create table public.stp2i_reglages (
  id int primary key default 1 check (id = 1),
  seuil_validation numeric not null default 0
);
insert into public.stp2i_reglages default values;

-- ---------- Numérotation ----------
create table public.stp2i_compteurs (prefixe text, annee int, dernier int not null default 0, primary key (prefixe, annee));
create or replace function public.stp2i_prochain_num(p text) returns text
language plpgsql security definer set search_path = public as $$
declare y int := extract(year from now() at time zone 'Africa/Brazzaville'); n int;
begin
  insert into public.stp2i_compteurs (prefixe, annee, dernier) values (p, y, 1)
  on conflict (prefixe, annee) do update set dernier = public.stp2i_compteurs.dernier + 1
  returning dernier into n;
  return p || '-' || y || '-' || lpad(n::text, 3, '0');
end $$;

-- ---------- Tables métier ----------
create table public.stp2i_vehicules (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  immat text not null default '',
  type text not null default 'Camion-citerne eau',
  chauffeur text not null default '',
  statut text not null default 'En service' check (statut in ('En service','En panne','Hors parc')),
  km integer,
  km_le timestamptz,
  created_at timestamptz not null default now()
);

create table public.stp2i_demandes (
  id uuid primary key default gen_random_uuid(),
  num text not null unique,
  vehicule_id uuid not null references public.stp2i_vehicules(id),
  piece text not null default '',
  qte integer not null check (qte > 0),
  urgent boolean not null default false,
  photo text,
  statut text not null default 'Nouvelle' check (statut in ('Nouvelle','En validation','Commandée','Reçue à la base','Montée','Refusée')),
  motif text,
  commande_id uuid,
  created_by uuid not null default auth.uid() references public.stp2i_profils(id),
  created_at timestamptz not null default now()
);

create table public.stp2i_commandes (
  id uuid primary key default gen_random_uuid(),
  num text not null unique,
  demande_id uuid references public.stp2i_demandes(id),
  vehicule_id uuid references public.stp2i_vehicules(id),
  fournisseur text not null,
  total numeric not null check (total >= 0),
  devis text,
  note text not null default '',
  statut text not null default 'À valider' check (statut in ('À valider','Validé','Refusé','Reçu partiel','Reçu','Facturé','Payé')),
  motif text,
  valide_par uuid references public.stp2i_profils(id),
  valide_le timestamptz,
  created_by uuid not null default auth.uid() references public.stp2i_profils(id),
  created_at timestamptz not null default now()
);
alter table public.stp2i_demandes add constraint stp2i_demandes_commande_fk foreign key (commande_id) references public.stp2i_commandes(id);

create table public.stp2i_commande_lignes (
  id uuid primary key default gen_random_uuid(),
  commande_id uuid not null references public.stp2i_commandes(id),
  position integer not null,
  designation text not null,
  qte integer not null check (qte > 0),
  pu numeric not null check (pu >= 0),
  recu integer not null default 0 check (recu >= 0)
);

create table public.stp2i_receptions (
  id uuid primary key default gen_random_uuid(),
  num text not null unique,
  commande_id uuid not null references public.stp2i_commandes(id),
  photo text not null,
  bl_num text not null default '',
  complet boolean not null,
  created_by uuid not null default auth.uid() references public.stp2i_profils(id),
  created_at timestamptz not null default now()
);

create table public.stp2i_reception_lignes (
  reception_id uuid not null references public.stp2i_receptions(id),
  ligne_id uuid not null references public.stp2i_commande_lignes(id),
  qte integer not null check (qte > 0),
  primary key (reception_id, ligne_id)
);

create table public.stp2i_stock (
  id uuid primary key default gen_random_uuid(),
  designation text not null,
  cle text not null unique,
  qte integer not null default 0 check (qte >= 0),
  derniere_entree timestamptz,
  derniere_sortie timestamptz
);

create table public.stp2i_mouvements (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('entree','sortie')),
  stock_id uuid not null references public.stp2i_stock(id),
  qte integer not null check (qte > 0),
  vehicule_id uuid references public.stp2i_vehicules(id),
  photo text,
  km integer,
  ref text not null default '',
  created_by uuid not null default auth.uid() references public.stp2i_profils(id),
  created_at timestamptz not null default now()
);

create table public.stp2i_factures (
  id uuid primary key default gen_random_uuid(),
  commande_id uuid not null references public.stp2i_commandes(id),
  numero text not null,
  fournisseur text not null,
  date_facture date,
  montant numeric not null check (montant >= 0),
  fichier text not null,
  statut text not null check (statut in ('Conforme','Bloquée','Payée')),
  motifs text[] not null default '{}',
  paye_le timestamptz,
  paye_ref text,
  paye_par uuid references public.stp2i_profils(id),
  created_by uuid not null default auth.uid() references public.stp2i_profils(id),
  created_at timestamptz not null default now()
);
create unique index stp2i_factures_un_par_commande on public.stp2i_factures (commande_id);
create unique index stp2i_factures_numero_unique on public.stp2i_factures (fournisseur, lower(numero));

create table public.stp2i_journal (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  par uuid references public.stp2i_profils(id),
  role text,
  action text not null,
  ref text not null default ''
);

create or replace function public.stp2i_journaliser(a text, r text default '') returns void
language sql security definer set search_path = public as $$
  insert into public.stp2i_journal (par, role, action, ref) values (auth.uid(), public.stp2i_mon_role(), a, coalesce(r,''))
$$;

-- ---------- Lecture : RLS ----------
alter table public.stp2i_profils enable row level security;
alter table public.stp2i_reglages enable row level security;
alter table public.stp2i_compteurs enable row level security;
alter table public.stp2i_vehicules enable row level security;
alter table public.stp2i_demandes enable row level security;
alter table public.stp2i_commandes enable row level security;
alter table public.stp2i_commande_lignes enable row level security;
alter table public.stp2i_receptions enable row level security;
alter table public.stp2i_reception_lignes enable row level security;
alter table public.stp2i_stock enable row level security;
alter table public.stp2i_mouvements enable row level security;
alter table public.stp2i_factures enable row level security;
alter table public.stp2i_journal enable row level security;

-- Chacun voit son propre profil ; l'administrateur voit tout le monde ; tous les rôles voient les noms.
create policy stp2i_profils_lecture on public.stp2i_profils for select to authenticated
  using (id = auth.uid() or public.stp2i_mon_role() is not null);
create policy stp2i_reglages_lecture on public.stp2i_reglages for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_vehicules_lecture on public.stp2i_vehicules for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_demandes_lecture on public.stp2i_demandes for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_stock_lecture on public.stp2i_stock for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_mouvements_lecture on public.stp2i_mouvements for select to authenticated using (public.stp2i_mon_role() is not null);
-- Prix, bons de commande, factures et journal : pas pour la base.
create policy stp2i_commandes_lecture on public.stp2i_commandes for select to authenticated using (public.stp2i_mon_role() in ('admin','logistique','dg'));
create policy stp2i_lignes_lecture on public.stp2i_commande_lignes for select to authenticated using (public.stp2i_mon_role() in ('admin','logistique','dg'));
create policy stp2i_receptions_lecture on public.stp2i_receptions for select to authenticated using (public.stp2i_mon_role() in ('admin','logistique','dg'));
create policy stp2i_reception_lignes_lecture on public.stp2i_reception_lignes for select to authenticated using (public.stp2i_mon_role() in ('admin','logistique','dg'));
create policy stp2i_factures_lecture on public.stp2i_factures for select to authenticated using (public.stp2i_mon_role() in ('admin','logistique','dg'));
create policy stp2i_journal_lecture on public.stp2i_journal for select to authenticated using (public.stp2i_mon_role() in ('admin','logistique','dg'));
-- Aucune politique insert/update/delete : écriture uniquement par les fonctions.

-- ---------- Fonctions métier ----------

-- Base : commandes attendues, sans les prix.
create or replace function public.stp2i_commandes_attendues() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.stp2i_exiger(array['base','admin']);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'num', c.num, 'fournisseur', c.fournisseur, 'statut', c.statut, 'vehicule_id', c.vehicule_id,
      'lignes', (select jsonb_agg(jsonb_build_object('id', l.id, 'designation', l.designation, 'qte', l.qte, 'recu', l.recu) order by l.position)
                 from public.stp2i_commande_lignes l where l.commande_id = c.id))
      order by c.created_at desc)
    from public.stp2i_commandes c where c.statut in ('Validé','Reçu partiel')), '[]'::jsonb);
end $$;

create or replace function public.stp2i_creer_demande(p_vehicule uuid, p_piece text, p_qte int, p_urgent boolean, p_photo text)
returns text language plpgsql security definer set search_path = public as $$
declare n text;
begin
  perform public.stp2i_exiger(array['base','admin']);
  if coalesce(trim(p_piece),'') = '' and p_photo is null then raise exception 'Prenez une photo ou écrivez le nom de la pièce'; end if;
  n := public.stp2i_prochain_num('DP');
  insert into public.stp2i_demandes (num, vehicule_id, piece, qte, urgent, photo) values (n, p_vehicule, coalesce(trim(p_piece),''), greatest(p_qte,1), p_urgent, p_photo);
  perform public.stp2i_journaliser('Demande de pièce envoyée (' || (select code from public.stp2i_vehicules where id = p_vehicule) || ')', n);
  return n;
end $$;

create or replace function public.stp2i_refuser_demande(p_id uuid, p_motif text) returns void
language plpgsql security definer set search_path = public as $$
declare d public.stp2i_demandes;
begin
  perform public.stp2i_exiger(array['logistique','admin']);
  if coalesce(trim(p_motif),'') = '' then raise exception 'Indiquez le motif'; end if;
  update public.stp2i_demandes set statut = 'Refusée', motif = p_motif where id = p_id and statut = 'Nouvelle' returning * into d;
  if d.id is null then raise exception 'Demande introuvable ou déjà traitée'; end if;
  perform public.stp2i_journaliser('Demande refusée : ' || p_motif, d.num);
end $$;

-- p_lignes = [{"designation":"...","qte":2,"pu":18000}, ...]
create or replace function public.stp2i_creer_commande(p_demande uuid, p_fournisseur text, p_lignes jsonb, p_devis text, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare d public.stp2i_demandes; n text; cid uuid; tot numeric := 0; l jsonb; i int := 0; s numeric; auto boolean;
begin
  perform public.stp2i_exiger(array['logistique','admin']);
  select * into d from public.stp2i_demandes where id = p_demande for update;
  if d.id is null or d.statut <> 'Nouvelle' then raise exception 'Demande introuvable ou déjà traitée'; end if;
  if coalesce(trim(p_fournisseur),'') = '' then raise exception 'Indiquez le fournisseur'; end if;
  if jsonb_array_length(coalesce(p_lignes,'[]')) = 0 then raise exception 'Ajoutez au moins une ligne'; end if;
  for l in select * from jsonb_array_elements(p_lignes) loop
    if coalesce(trim(l->>'designation'),'') = '' or (l->>'qte')::int <= 0 or (l->>'pu')::numeric < 0 then raise exception 'Ligne incomplète'; end if;
    tot := tot + (l->>'qte')::int * (l->>'pu')::numeric;
  end loop;
  select seuil_validation into s from public.stp2i_reglages where id = 1;
  auto := s > 0 and tot <= s;
  n := public.stp2i_prochain_num('BC');
  insert into public.stp2i_commandes (num, demande_id, vehicule_id, fournisseur, total, devis, note, statut, valide_le)
    values (n, d.id, d.vehicule_id, trim(p_fournisseur), tot, p_devis, coalesce(p_note,''), case when auto then 'Validé' else 'À valider' end, case when auto then now() end)
    returning id into cid;
  for l in select * from jsonb_array_elements(p_lignes) loop
    i := i + 1;
    insert into public.stp2i_commande_lignes (commande_id, position, designation, qte, pu) values (cid, i, trim(l->>'designation'), (l->>'qte')::int, (l->>'pu')::numeric);
  end loop;
  update public.stp2i_demandes set statut = case when auto then 'Commandée' else 'En validation' end, commande_id = cid, motif = null where id = d.id;
  perform public.stp2i_journaliser('Bon de commande créé : ' || to_char(tot,'FM999G999G999') || ' XAF chez ' || trim(p_fournisseur) || case when auto then ' (sous le seuil, validé automatiquement)' else '' end, n || ' / ' || d.num);
  return n;
end $$;

create or replace function public.stp2i_valider_commande(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.stp2i_commandes;
begin
  perform public.stp2i_exiger(array['dg']);
  update public.stp2i_commandes set statut = 'Validé', valide_par = auth.uid(), valide_le = now() where id = p_id and statut = 'À valider' returning * into c;
  if c.id is null then raise exception 'Bon de commande introuvable ou déjà traité'; end if;
  update public.stp2i_demandes set statut = 'Commandée' where id = c.demande_id;
  perform public.stp2i_journaliser('Bon de commande validé : ' || to_char(c.total,'FM999G999G999') || ' XAF, ' || c.fournisseur, c.num);
end $$;

create or replace function public.stp2i_refuser_commande(p_id uuid, p_motif text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.stp2i_commandes;
begin
  perform public.stp2i_exiger(array['dg']);
  if coalesce(trim(p_motif),'') = '' then raise exception 'Indiquez le motif'; end if;
  update public.stp2i_commandes set statut = 'Refusé', motif = p_motif where id = p_id and statut = 'À valider' returning * into c;
  if c.id is null then raise exception 'Bon de commande introuvable ou déjà traité'; end if;
  update public.stp2i_demandes set statut = 'Nouvelle', commande_id = null, motif = 'Bon de commande ' || c.num || ' refusé : ' || p_motif where id = c.demande_id;
  perform public.stp2i_journaliser('Bon de commande refusé : ' || p_motif, c.num);
end $$;

-- p_lignes = [{"ligne_id":"...","qte":2}, ...]
create or replace function public.stp2i_receptionner(p_commande uuid, p_lignes jsonb, p_photo text, p_bl text)
returns text language plpgsql security definer set search_path = public as $$
declare c public.stp2i_commandes; n text; rid uuid; l jsonb; cl public.stp2i_commande_lignes; q int; k text; sid uuid; v_complet boolean; total_q int := 0;
begin
  perform public.stp2i_exiger(array['base','admin']);
  if p_photo is null then raise exception 'Prenez la photo du bon de livraison'; end if;
  select * into c from public.stp2i_commandes where id = p_commande for update;
  if c.id is null or c.statut not in ('Validé','Reçu partiel') then raise exception 'Cette commande n''est pas validée par le DG : ne pas accepter la livraison'; end if;
  n := public.stp2i_prochain_num('BR');
  insert into public.stp2i_receptions (num, commande_id, photo, bl_num, complet) values (n, c.id, p_photo, coalesce(p_bl,''), false) returning id into rid;
  for l in select * from jsonb_array_elements(coalesce(p_lignes,'[]')) loop
    q := coalesce((l->>'qte')::int, 0);
    if q <= 0 then continue; end if;
    select * into cl from public.stp2i_commande_lignes where id = (l->>'ligne_id')::uuid and commande_id = c.id for update;
    if cl.id is null then raise exception 'Ligne inconnue'; end if;
    update public.stp2i_commande_lignes set recu = recu + q where id = cl.id;
    insert into public.stp2i_reception_lignes (reception_id, ligne_id, qte) values (rid, cl.id, q);
    k := lower(regexp_replace(trim(cl.designation), '\s+', ' ', 'g'));
    insert into public.stp2i_stock (designation, cle, qte, derniere_entree) values (trim(cl.designation), k, q, now())
      on conflict (cle) do update set qte = public.stp2i_stock.qte + q, derniere_entree = now()
      returning id into sid;
    insert into public.stp2i_mouvements (type, stock_id, qte, photo, ref) values ('entree', sid, q, p_photo, n || ' / ' || c.num);
    total_q := total_q + q;
  end loop;
  if total_q = 0 then raise exception 'Indiquez au moins une pièce reçue'; end if;
  v_complet := not exists (select 1 from public.stp2i_commande_lignes where commande_id = c.id and recu < qte);
  update public.stp2i_receptions set complet = v_complet where id = rid;
  update public.stp2i_commandes set statut = case when v_complet then 'Reçu' else 'Reçu partiel' end where id = c.id;
  if v_complet then update public.stp2i_demandes set statut = 'Reçue à la base' where id = c.demande_id and statut not in ('Montée','Refusée'); end if;
  perform public.stp2i_journaliser('Livraison reçue de ' || c.fournisseur || case when v_complet then '' else ' (incomplète)' end, n || ' / ' || c.num);
  -- Une facture bloquée pour cette commande est recontrôlée.
  perform public.stp2i_controler_facture(f.id) from public.stp2i_factures f where f.commande_id = c.id and f.statut = 'Bloquée';
  return n;
end $$;

create or replace function public.stp2i_sortir_piece(p_stock uuid, p_vehicule uuid, p_qte int, p_photo text, p_km int)
returns void language plpgsql security definer set search_path = public as $$
declare s public.stp2i_stock; v public.stp2i_vehicules; d public.stp2i_demandes;
begin
  perform public.stp2i_exiger(array['base','admin']);
  if p_photo is null then raise exception 'Photo de la pièce usée obligatoire : pas de pièce neuve sans pièce usée rendue'; end if;
  select * into s from public.stp2i_stock where id = p_stock for update;
  if s.id is null or s.qte < greatest(p_qte,1) then raise exception 'Stock insuffisant'; end if;
  select * into v from public.stp2i_vehicules where id = p_vehicule;
  if v.id is null then raise exception 'Camion inconnu'; end if;
  update public.stp2i_stock set qte = qte - greatest(p_qte,1), derniere_sortie = now() where id = s.id;
  select * into d from public.stp2i_demandes where vehicule_id = v.id and statut = 'Reçue à la base' order by created_at limit 1;
  insert into public.stp2i_mouvements (type, stock_id, qte, vehicule_id, photo, km, ref) values ('sortie', s.id, greatest(p_qte,1), v.id, p_photo, p_km, coalesce(d.num,''));
  if p_km is not null and (v.km is null or p_km > v.km) then update public.stp2i_vehicules set km = p_km, km_le = now() where id = v.id; end if;
  if d.id is not null then update public.stp2i_demandes set statut = 'Montée' where id = d.id; end if;
  perform public.stp2i_journaliser(greatest(p_qte,1) || ' × ' || s.designation || ' montée(s) sur ' || v.code, coalesce(d.num,''));
end $$;

-- Contrôle d'une facture : renvoie la liste des anomalies (vide = conforme).
create or replace function public.stp2i_anomalies_facture(p_commande uuid, p_numero text, p_montant numeric, p_facture uuid default null)
returns text[] language plpgsql stable security definer set search_path = public as $$
declare c public.stp2i_commandes; v_out text[] := '{}';
begin
  select * into c from public.stp2i_commandes where id = p_commande;
  if c.id is null then return array['Bon de commande introuvable']; end if;
  if c.statut not in ('Validé','Reçu partiel','Reçu','Facturé','Payé') then v_out := v_out || 'Bon de commande non validé par le DG'; end if;
  if not exists (select 1 from public.stp2i_receptions where commande_id = c.id) then v_out := v_out || 'Aucun bon de réception à la base';
  elsif exists (select 1 from public.stp2i_commande_lignes where commande_id = c.id and recu < qte) then v_out := v_out || 'Livraison incomplète à la base'; end if;
  if round(p_montant) <> round(c.total) then v_out := v_out || ('Montant ' || to_char(p_montant,'FM999G999G999') || ' XAF différent du bon de commande (' || to_char(c.total,'FM999G999G999') || ' XAF)'); end if;
  if exists (select 1 from public.stp2i_factures where commande_id = c.id and id is distinct from p_facture) then v_out := v_out || 'Une autre facture existe déjà pour ce bon de commande'; end if;
  if exists (select 1 from public.stp2i_factures where fournisseur = c.fournisseur and lower(numero) = lower(trim(p_numero)) and id is distinct from p_facture) then v_out := v_out || 'Ce numéro de facture est déjà enregistré pour ce fournisseur'; end if;
  return v_out;
end $$;

create or replace function public.stp2i_enregistrer_facture(p_commande uuid, p_numero text, p_date date, p_montant numeric, p_fichier text)
returns text language plpgsql security definer set search_path = public as $$
declare c public.stp2i_commandes; a text[]; st text;
begin
  perform public.stp2i_exiger(array['logistique','admin']);
  if coalesce(trim(p_numero),'') = '' then raise exception 'Indiquez le numéro de facture'; end if;
  if p_fichier is null then raise exception 'Joignez la facture'; end if;
  select * into c from public.stp2i_commandes where id = p_commande;
  if c.id is null then raise exception 'Une facture sans bon de commande n''est pas acceptée'; end if;
  a := public.stp2i_anomalies_facture(c.id, p_numero, p_montant, null);
  if 'Une autre facture existe déjà pour ce bon de commande' = any(a) or 'Ce numéro de facture est déjà enregistré pour ce fournisseur' = any(a) then
    raise exception '%', array_to_string(a, ' ; ');
  end if;
  st := case when cardinality(a) = 0 then 'Conforme' else 'Bloquée' end;
  insert into public.stp2i_factures (commande_id, numero, fournisseur, date_facture, montant, fichier, statut, motifs)
    values (c.id, trim(p_numero), c.fournisseur, p_date, p_montant, p_fichier, st, a);
  if st = 'Conforme' then update public.stp2i_commandes set statut = 'Facturé' where id = c.id; end if;
  perform public.stp2i_journaliser('Facture ' || trim(p_numero) || ' enregistrée : ' || st, c.num);
  return st;
end $$;

create or replace function public.stp2i_controler_facture(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare f public.stp2i_factures; a text[]; st text;
begin
  if public.stp2i_mon_role() not in ('logistique','admin','base') then raise exception 'Action non autorisée pour votre rôle'; end if;
  select * into f from public.stp2i_factures where id = p_id for update;
  if f.id is null or f.statut = 'Payée' then return f.statut; end if;
  a := public.stp2i_anomalies_facture(f.commande_id, f.numero, f.montant, f.id);
  st := case when cardinality(a) = 0 then 'Conforme' else 'Bloquée' end;
  update public.stp2i_factures set statut = st, motifs = a where id = f.id;
  if st = 'Conforme' then update public.stp2i_commandes set statut = 'Facturé' where id = f.commande_id and statut in ('Reçu','Reçu partiel','Validé'); end if;
  perform public.stp2i_journaliser('Facture ' || f.numero || ' recontrôlée : ' || st, (select num from public.stp2i_commandes where id = f.commande_id));
  return st;
end $$;

create or replace function public.stp2i_payer_facture(p_id uuid, p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare f public.stp2i_factures;
begin
  perform public.stp2i_exiger(array['dg']);
  select * into f from public.stp2i_factures where id = p_id for update;
  if f.id is null then raise exception 'Facture introuvable'; end if;
  if f.statut <> 'Conforme' or cardinality(public.stp2i_anomalies_facture(f.commande_id, f.numero, f.montant, f.id)) > 0 then
    raise exception 'Facture non conforme : paiement impossible';
  end if;
  update public.stp2i_factures set statut = 'Payée', paye_le = now(), paye_ref = coalesce(p_ref,''), paye_par = auth.uid() where id = f.id;
  update public.stp2i_commandes set statut = 'Payé' where id = f.commande_id;
  perform public.stp2i_journaliser('Facture ' || f.numero || ' payée : ' || to_char(f.montant,'FM999G999G999') || ' XAF', (select num from public.stp2i_commandes where id = f.commande_id));
end $$;

create or replace function public.stp2i_enregistrer_vehicule(p_id uuid, p_code text, p_immat text, p_type text, p_chauffeur text, p_statut text)
returns uuid language plpgsql security definer set search_path = public as $$
declare vid uuid;
begin
  perform public.stp2i_exiger(array['logistique','admin']);
  if coalesce(trim(p_code),'') = '' then raise exception 'Indiquez le code'; end if;
  if p_id is null then
    insert into public.stp2i_vehicules (code, immat, type, chauffeur, statut) values (trim(p_code), coalesce(p_immat,''), coalesce(p_type,'Autre'), coalesce(p_chauffeur,''), coalesce(p_statut,'En service')) returning id into vid;
    perform public.stp2i_journaliser('Camion ajouté', trim(p_code));
  else
    update public.stp2i_vehicules set code = trim(p_code), immat = coalesce(p_immat,''), type = coalesce(p_type,'Autre'), chauffeur = coalesce(p_chauffeur,''), statut = coalesce(p_statut,'En service') where id = p_id returning id into vid;
    perform public.stp2i_journaliser('Camion modifié', trim(p_code));
  end if;
  return vid;
end $$;

-- p_releves = [{"id":"...","km":152300}, ...]
create or replace function public.stp2i_relever_km(p_releves jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare r jsonb; v public.stp2i_vehicules; n int := 0;
begin
  perform public.stp2i_exiger(array['logistique','admin']);
  for r in select * from jsonb_array_elements(coalesce(p_releves,'[]')) loop
    select * into v from public.stp2i_vehicules where id = (r->>'id')::uuid;
    if v.id is null then continue; end if;
    if v.km is not null and (r->>'km')::int < v.km then raise exception '% : le kilométrage ne peut pas baisser', v.code; end if;
    update public.stp2i_vehicules set km = (r->>'km')::int, km_le = now() where id = v.id; n := n + 1;
  end loop;
  if n > 0 then perform public.stp2i_journaliser('Relevé kilométrique WhatsGPS (' || n || ' camion(s))', ''); end if;
  return n;
end $$;

create or replace function public.stp2i_definir_role(p_user uuid, p_role text, p_actif boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.stp2i_exiger(array['admin']);
  if p_user = auth.uid() then raise exception 'Vous ne pouvez pas modifier votre propre rôle'; end if;
  if p_role is not null and p_role not in ('admin','base','logistique','dg') then raise exception 'Rôle inconnu'; end if;
  update public.stp2i_profils set role = p_role, actif = coalesce(p_actif, true) where id = p_user;
  perform public.stp2i_journaliser('Rôle de ' || (select coalesce(nullif(nom,''), email) from public.stp2i_profils where id = p_user) || ' : ' || coalesce(p_role,'aucun accès') || case when p_actif = false then ' (désactivé)' else '' end, '');
end $$;

create or replace function public.stp2i_definir_seuil(p_seuil numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.stp2i_exiger(array['admin']);
  update public.stp2i_reglages set seuil_validation = greatest(coalesce(p_seuil,0),0) where id = 1;
  perform public.stp2i_journaliser('Seuil de validation DG : ' || to_char(greatest(coalesce(p_seuil,0),0),'FM999G999G999') || ' XAF', '');
end $$;

-- Droits d'exécution : fonctions réservées aux utilisateurs connectés.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'stp2i\_%' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
-- Les fonctions internes ne sont pas appelables directement.
revoke execute on function public.stp2i_prochain_num(text) from authenticated;
revoke execute on function public.stp2i_journaliser(text, text) from authenticated;
revoke execute on function public.stp2i_exiger(text[]) from authenticated;
revoke execute on function public.stp2i_anomalies_facture(uuid, text, numeric, uuid) from authenticated;
-- Écran de premier démarrage : savoir si un administrateur existe déjà.
grant execute on function public.stp2i_admin_existe() to anon;

-- ---------- Stockage des photos et documents ----------
insert into storage.buckets (id, name, public) values ('stp2i-documents', 'stp2i-documents', false) on conflict (id) do nothing;
create policy stp2i_documents_envoi on storage.objects for insert to authenticated
  with check (bucket_id = 'stp2i-documents' and public.stp2i_mon_role() is not null);
create policy stp2i_documents_lecture on storage.objects for select to authenticated
  using (bucket_id = 'stp2i-documents' and public.stp2i_mon_role() is not null);
-- Pas de modification ni de suppression des documents.

-- ---------- Temps réel ----------
alter publication supabase_realtime add table public.stp2i_demandes, public.stp2i_commandes, public.stp2i_receptions, public.stp2i_stock, public.stp2i_mouvements, public.stp2i_factures, public.stp2i_vehicules, public.stp2i_profils, public.stp2i_journal;

-- ---------- Parc de départ (contrat ENI : 7 camions à eau + 1 mini citerne) ----------
insert into public.stp2i_vehicules (code, type) values
  ('CE-01','Camion-citerne eau'),('CE-02','Camion-citerne eau'),('CE-03','Camion-citerne eau'),('CE-04','Camion-citerne eau'),
  ('CE-05','Camion-citerne eau'),('CE-06','Camion-citerne eau'),('CE-07','Camion-citerne eau'),('MC-01','Mini citerne carburant')
on conflict (code) do nothing;
