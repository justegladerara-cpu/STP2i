-- STP2i : rôle HSE et documents du système de management (procédures, instructions,
-- enregistrements, politiques, registres), avec l'historique des versions.
-- Uniquement des objets stp2i_*. Aucune donnée réelle ici : l'inventaire est importé depuis l'application.

-- ============ Rôle « hse » ============
alter table public.stp2i_profils drop constraint if exists stp2i_profils_role_check;
alter table public.stp2i_profils add constraint stp2i_profils_role_check check (role in ('admin','base','logistique','dg','hse'));

create or replace function public.stp2i_definir_role(p_user uuid, p_role text, p_actif boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.stp2i_exiger(array['admin']);
  if p_user = auth.uid() then raise exception 'Vous ne pouvez pas modifier votre propre rôle'; end if;
  if p_role is not null and p_role not in ('admin','base','logistique','dg','hse') then raise exception 'Rôle inconnu'; end if;
  update public.stp2i_profils set role = p_role, actif = coalesce(p_actif, true) where id = p_user;
  perform public.stp2i_journaliser('Rôle de ' || (select coalesce(nullif(nom,''), email) from public.stp2i_profils where id = p_user) || ' : ' || coalesce(p_role,'aucun accès') || case when p_actif = false then ' (désactivé)' else '' end, '');
end $$;

-- Le responsable HSE peut déclarer et clore les événements, enregistrer les formations,
-- les papiers et les contrôles avant départ.
create or replace function public.stp2i_declarer_hse(p_type text, p_vehicule uuid, p_le timestamptz, p_lieu text, p_description text, p_gravite text, p_blesses boolean, p_photo text) returns text
language plpgsql security definer set search_path = public as $$
declare n text;
begin
  perform public.stp2i_exiger(array['base','logistique','admin','dg','hse']);
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
  perform public.stp2i_exiger(array['logistique','admin','dg','hse']);
  if coalesce(trim(p_actions),'') = '' then raise exception 'Dites ce qui a été fait pour que ça ne recommence pas'; end if;
  update public.stp2i_hse set statut = 'Clos', actions = trim(p_actions), clos_le = now() where id = p_id and statut = 'Ouvert' returning * into h;
  if h.id is null then raise exception 'Fiche introuvable ou déjà close'; end if;
  perform public.stp2i_journaliser(h.type || ' clos : ' || trim(p_actions), h.num);
end $$;

create or replace function public.stp2i_enregistrer_formation(p_personne text, p_theme text, p_le date, p_jusqu_au date, p_fichier text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.stp2i_exiger(array['logistique','admin','hse']);
  if coalesce(trim(p_personne),'') = '' or coalesce(trim(p_theme),'') = '' then raise exception 'Indiquez la personne et le thème'; end if;
  insert into public.stp2i_formations (personne, theme, faite_le, valable_jusqu_au, fichier) values (trim(p_personne), trim(p_theme), coalesce(p_le, current_date), p_jusqu_au, p_fichier);
  perform public.stp2i_journaliser('Formation ' || trim(p_theme) || ' : ' || trim(p_personne), '');
end $$;

create or replace function public.stp2i_enregistrer_papier(p_vehicule uuid, p_personne text, p_type text, p_numero text, p_date_fin date, p_fichier text) returns void
language plpgsql security definer set search_path = public as $$
declare qui text;
begin
  perform public.stp2i_exiger(array['logistique','admin','hse']);
  if coalesce(trim(p_type),'') = '' then raise exception 'Indiquez le type de papier'; end if;
  if p_date_fin is null then raise exception 'Indiquez la date de fin'; end if;
  if p_vehicule is null and coalesce(trim(p_personne),'') = '' then raise exception 'Choisissez un camion ou une personne'; end if;
  insert into public.stp2i_papiers (vehicule_id, personne, type, numero, date_fin, fichier)
    values (p_vehicule, coalesce(trim(p_personne),''), trim(p_type), coalesce(trim(p_numero),''), p_date_fin, p_fichier);
  qui := coalesce((select code from public.stp2i_vehicules where id = p_vehicule), trim(p_personne));
  perform public.stp2i_journaliser(trim(p_type) || ' de ' || qui || ' valable jusqu''au ' || to_char(p_date_fin,'DD/MM/YYYY'), qui);
end $$;

create or replace function public.stp2i_controle_depart(p_vehicule uuid, p_chauffeur text, p_points jsonb, p_km int, p_photo text, p_note text) returns text
language plpgsql security definer set search_path = public as $$
declare v public.stp2i_vehicules; bons boolean; mauvais text; pn text;
begin
  perform public.stp2i_exiger(array['base','logistique','admin','hse']);
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

-- Un contrôle qui trouve un problème déclare une panne : le responsable HSE doit pouvoir le faire.
create or replace function public.stp2i_declarer_panne(p_vehicule uuid, p_description text, p_photo text, p_km int) returns text
language plpgsql security definer set search_path = public as $$
declare v public.stp2i_vehicules; n text;
begin
  perform public.stp2i_exiger(array['base','logistique','admin','hse']);
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

-- ============ Documents du système de management (SMQ / QHSE) ============
create table public.stp2i_smq_documents (
  id uuid primary key default gen_random_uuid(),
  categorie text not null check (categorie in ('Procédure','Instruction','Enregistrement','Politique','Registre')),
  intitule text not null,
  reference text not null default '',
  service text not null default '',
  version text not null default '',
  date_creation date,
  date_maj date,
  objet_maj text not null default '',
  fichier text,
  revision_mois integer not null default 12 check (revision_mois between 1 and 60),
  actif boolean not null default true,
  created_by uuid default auth.uid() references public.stp2i_profils(id),
  created_at timestamptz not null default now(),
  maj_par uuid references public.stp2i_profils(id),
  maj_le timestamptz
);
create index stp2i_smq_categorie on public.stp2i_smq_documents (categorie, reference);

-- Chaque nouvelle version garde l'ancienne ici.
create table public.stp2i_smq_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.stp2i_smq_documents(id),
  version text not null default '',
  date_maj date,
  objet_maj text not null default '',
  fichier text,
  remplace_par uuid default auth.uid() references public.stp2i_profils(id),
  remplace_le timestamptz not null default now()
);

-- p_lignes = [{"categorie":"Procédure","intitule":"...","reference":"PRO 001","service":"QHSE","version":"V2",
--              "date_creation":"2025-07-14","date_maj":null,"objet_maj":"..."}, ...]
-- Un document déjà présent (même catégorie et même référence, ou même intitulé si pas de référence) n'est pas recréé.
create or replace function public.stp2i_smq_importer(p_lignes jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare l jsonb; n int := 0; cat text; ref text; titre text;
begin
  perform public.stp2i_exiger(array['hse','admin']);
  for l in select * from jsonb_array_elements(coalesce(p_lignes,'[]')) loop
    cat := l->>'categorie'; ref := coalesce(trim(l->>'reference'),''); titre := coalesce(trim(l->>'intitule'),'');
    if titre = '' then continue; end if;
    if cat not in ('Procédure','Instruction','Enregistrement','Politique','Registre') then raise exception 'Catégorie inconnue : %', cat; end if;
    if exists (select 1 from public.stp2i_smq_documents d where d.categorie = cat and (
         (upper(ref) not in ('','SO') and lower(regexp_replace(d.reference,'\s+','','g')) = lower(regexp_replace(ref,'\s+','','g')))
         or (upper(ref) in ('','SO') and lower(trim(d.intitule)) = lower(titre)))) then continue; end if;
    insert into public.stp2i_smq_documents (categorie, intitule, reference, service, version, date_creation, date_maj, objet_maj)
      values (cat, titre, ref, coalesce(trim(l->>'service'),''), coalesce(trim(l->>'version'),''),
              nullif(l->>'date_creation','')::date, nullif(l->>'date_maj','')::date, coalesce(trim(l->>'objet_maj'),''));
    n := n + 1;
  end loop;
  if n > 0 then perform public.stp2i_journaliser('Inventaire des documents HSE importé : ' || n || ' document(s)', ''); end if;
  return n;
end $$;

-- Création (p_id null) ou mise à jour. Si la version ou le fichier change, l'ancienne version va dans l'historique.
create or replace function public.stp2i_smq_enregistrer(p_id uuid, p_categorie text, p_intitule text, p_reference text, p_service text, p_version text,
  p_date_creation date, p_date_maj date, p_objet_maj text, p_fichier text, p_revision_mois int) returns uuid
language plpgsql security definer set search_path = public as $$
declare d public.stp2i_smq_documents; did uuid;
begin
  perform public.stp2i_exiger(array['hse','admin']);
  if coalesce(trim(p_intitule),'') = '' then raise exception 'Indiquez l''intitulé'; end if;
  if p_categorie not in ('Procédure','Instruction','Enregistrement','Politique','Registre') then raise exception 'Choisissez la catégorie'; end if;
  if p_id is null then
    insert into public.stp2i_smq_documents (categorie, intitule, reference, service, version, date_creation, date_maj, objet_maj, fichier, revision_mois)
      values (p_categorie, trim(p_intitule), coalesce(trim(p_reference),''), coalesce(trim(p_service),''), coalesce(trim(p_version),''),
              coalesce(p_date_creation, current_date), p_date_maj, coalesce(trim(p_objet_maj),''), p_fichier, coalesce(p_revision_mois,12))
      returning id into did;
    perform public.stp2i_journaliser('Document HSE ajouté : ' || trim(p_intitule), coalesce(trim(p_reference),''));
    return did;
  end if;
  select * into d from public.stp2i_smq_documents where id = p_id for update;
  if d.id is null then raise exception 'Document introuvable'; end if;
  if coalesce(trim(p_version),'') <> d.version or (p_fichier is not null and p_fichier is distinct from d.fichier) then
    insert into public.stp2i_smq_versions (document_id, version, date_maj, objet_maj, fichier)
      values (d.id, d.version, coalesce(d.date_maj, d.date_creation), d.objet_maj, d.fichier);
  end if;
  update public.stp2i_smq_documents set categorie = p_categorie, intitule = trim(p_intitule), reference = coalesce(trim(p_reference),''),
    service = coalesce(trim(p_service),''), version = coalesce(trim(p_version),''), date_creation = p_date_creation, date_maj = p_date_maj,
    objet_maj = coalesce(trim(p_objet_maj),''), fichier = coalesce(p_fichier, fichier), revision_mois = coalesce(p_revision_mois, revision_mois),
    maj_par = auth.uid(), maj_le = now()
    where id = d.id;
  perform public.stp2i_journaliser('Document HSE mis à jour : ' || trim(p_intitule) || coalesce(' (' || nullif(trim(p_version),'') || ')',''), coalesce(trim(p_reference),''));
  return d.id;
end $$;

create or replace function public.stp2i_smq_archiver(p_id uuid, p_actif boolean, p_motif text) returns void
language plpgsql security definer set search_path = public as $$
declare d public.stp2i_smq_documents;
begin
  perform public.stp2i_exiger(array['hse','admin']);
  if p_actif = false and coalesce(trim(p_motif),'') = '' then raise exception 'Dites pourquoi ce document n''est plus en vigueur'; end if;
  update public.stp2i_smq_documents set actif = coalesce(p_actif,true), maj_par = auth.uid(), maj_le = now() where id = p_id returning * into d;
  if d.id is null then raise exception 'Document introuvable'; end if;
  perform public.stp2i_journaliser(case when p_actif then 'Document HSE remis en vigueur : ' else 'Document HSE retiré : ' end || d.intitule || coalesce(' — ' || nullif(trim(p_motif),''),''), d.reference);
end $$;

alter table public.stp2i_smq_documents enable row level security;
alter table public.stp2i_smq_versions enable row level security;
-- Tout le personnel STP2i peut lire les procédures et les fiches.
create policy stp2i_smq_documents_lecture on public.stp2i_smq_documents for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_smq_versions_lecture on public.stp2i_smq_versions for select to authenticated using (public.stp2i_mon_role() is not null);
-- Le responsable HSE lit le journal.
drop policy if exists stp2i_journal_lecture on public.stp2i_journal;
create policy stp2i_journal_lecture on public.stp2i_journal for select to authenticated using (public.stp2i_mon_role() in ('admin','logistique','dg','hse'));

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

alter publication supabase_realtime add table public.stp2i_smq_documents;
