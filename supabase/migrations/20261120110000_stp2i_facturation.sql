-- STP2i : facturation des clients (20/11/2026).
-- L'application ne garde que les factures que STP2i envoie à ses clients (ENI, KEP…) et le suivi de leur paiement.
-- Pas de bon de commande, pas de validation : on crée la facture, on l'imprime, puis on la marque payée
-- (ou annulée avec un motif ; une facture n'est jamais effacée ni modifiée après création).
-- Numérotation automatique et continue : FAC-AAAA-001, FAC-AAAA-002… (compteur stp2i_compteurs, préfixe FAC).
-- Certification SFEC (facture électronique du Congo, décret 2026-101) : la fonction serveur stp2i-sfec envoie la facture
-- à l'API SFEC (POST /api/v1/invoices, clé X-API-Key gardée dans les secrets du serveur, jamais dans la page),
-- puis écrit le résultat (signature, code court, QR code) par stp2i_facture_client_sfec_noter (réservée au serveur).
-- Une facture certifiée ne peut plus être annulée : il faudra un avoir (creditNote), prévu plus tard.
-- Les anciennes tables STP2i (achats, stock, parc, HSE…) ne sont NI modifiées NI effacées.
-- Rien d'Agence Elite n'est touché.

-- ---------- Clients ----------
create table public.stp2i_clients (
  id uuid primary key default gen_random_uuid(),
  nom text not null check (length(trim(nom)) > 0),
  adresse text not null default '',
  niu text not null default '',
  rccm text not null default '',
  contact text not null default '',
  telephone text not null default '',
  email text not null default '',
  type_sfec text not null default 'business' check (type_sfec in ('business','individual','government','foreign')),
  assujetti_tva boolean not null default true,
  actif boolean not null default true,
  created_by uuid default auth.uid() references public.stp2i_profils(id),
  created_at timestamptz not null default now()
);
create unique index stp2i_clients_nom_unique on public.stp2i_clients (lower(trim(nom)));

-- ---------- Factures ----------
create table public.stp2i_factures_clients (
  id uuid primary key default gen_random_uuid(),
  num text not null unique,
  client_id uuid not null references public.stp2i_clients(id),
  date_facture date not null,
  echeance date,
  objet text not null default '',
  reference text not null default '',      -- n° de contrat, de bon de commande du client, période…
  total_ht numeric(16,2) not null default 0,
  tva_18 numeric(16,2) not null default 0,
  tva_5 numeric(16,2) not null default 0,
  total_exonere numeric(16,2) not null default 0,
  total_ttc numeric(16,2) not null default 0,
  ras_taux numeric(4,1) not null default 0 check (ras_taux in (0,10,20)),   -- retenue à la source faite par le client
  ras_montant numeric(16,2) not null default 0,
  net_a_payer numeric(16,2) not null default 0,
  sfec_statut text not null default 'À envoyer' check (sfec_statut in ('À envoyer','Certifiée','Refusée')),
  sfec_env text not null default '',
  sfec_signature text not null default '',
  sfec_code text not null default '',
  sfec_qr text not null default '',
  sfec_date timestamptz,
  sfec_erreur text not null default '',
  statut text not null default 'Émise' check (statut in ('Émise','Payée','Annulée')),
  paye_le date,
  paye_ref text not null default '',
  paye_par uuid references public.stp2i_profils(id),
  annule_motif text not null default '',
  created_by uuid not null default auth.uid() references public.stp2i_profils(id),
  created_at timestamptz not null default now()
);
create index stp2i_factures_clients_date on public.stp2i_factures_clients (date_facture desc);

create table public.stp2i_factures_clients_lignes (
  id uuid primary key default gen_random_uuid(),
  facture_id uuid not null references public.stp2i_factures_clients(id),
  ordre int not null,
  designation text not null,
  unite text not null default '',
  type text not null default 'service' check (type in ('service','product')),
  qte numeric(14,3) not null check (qte > 0),
  pu numeric(16,2) not null check (pu >= 0),
  taux_tva int not null default 0 check (taux_tva in (0,5,18)),
  montant numeric(16,2) generated always as (round(qte * pu, 2)) stored,
  tva numeric(16,2) generated always as (round(round(qte * pu, 2) * taux_tva / 100, 2)) stored
);
create index stp2i_factures_clients_lignes_facture on public.stp2i_factures_clients_lignes (facture_id, ordre);

-- ---------- Lecture ----------
alter table public.stp2i_clients enable row level security;
alter table public.stp2i_factures_clients enable row level security;
alter table public.stp2i_factures_clients_lignes enable row level security;
create policy stp2i_clients_lecture on public.stp2i_clients for select to authenticated
  using (public.stp2i_mon_role() in ('admin','logistique','dg'));
create policy stp2i_factures_clients_lecture on public.stp2i_factures_clients for select to authenticated
  using (public.stp2i_mon_role() in ('admin','logistique','dg'));
create policy stp2i_factures_clients_lignes_lecture on public.stp2i_factures_clients_lignes for select to authenticated
  using (public.stp2i_mon_role() in ('admin','logistique','dg'));

-- ---------- Écriture : uniquement par ces fonctions ----------
-- Créer ou corriger une fiche client (p_id null = nouveau client).
create or replace function public.stp2i_client_enregistrer(p_id uuid, p_nom text, p_adresse text, p_niu text, p_rccm text, p_contact text,
  p_telephone text, p_email text, p_type_sfec text, p_assujetti_tva boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.stp2i_exiger(array['logistique','dg','admin']);
  if coalesce(trim(p_nom),'') = '' then raise exception 'Indiquez le nom du client'; end if;
  if coalesce(p_type_sfec,'business') not in ('business','individual','government','foreign') then raise exception 'Type de client inconnu'; end if;
  if coalesce(p_type_sfec,'business') in ('business','government') and length(coalesce(trim(p_niu),'')) not between 16 and 17 then
    raise exception 'Le NIU du client doit avoir 16 ou 17 caractères (obligatoire pour la facture électronique)';
  end if;
  if exists (select 1 from public.stp2i_clients where lower(trim(nom)) = lower(trim(p_nom)) and id is distinct from p_id) then
    raise exception 'Ce client existe déjà';
  end if;
  if p_id is null then
    insert into public.stp2i_clients (nom, adresse, niu, rccm, contact, telephone, email, type_sfec, assujetti_tva)
      values (trim(p_nom), coalesce(trim(p_adresse),''), coalesce(trim(p_niu),''), coalesce(trim(p_rccm),''), coalesce(trim(p_contact),''),
        coalesce(trim(p_telephone),''), coalesce(trim(p_email),''), coalesce(p_type_sfec,'business'), coalesce(p_assujetti_tva,true))
      returning id into v_id;
    perform public.stp2i_journaliser('Client ajouté : ' || trim(p_nom), '');
  else
    update public.stp2i_clients set nom = trim(p_nom), adresse = coalesce(trim(p_adresse),''), niu = coalesce(trim(p_niu),''),
      rccm = coalesce(trim(p_rccm),''), contact = coalesce(trim(p_contact),''), telephone = coalesce(trim(p_telephone),''),
      email = coalesce(trim(p_email),''), type_sfec = coalesce(p_type_sfec,'business'), assujetti_tva = coalesce(p_assujetti_tva,true)
      where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Client introuvable'; end if;
    perform public.stp2i_journaliser('Fiche client modifiée : ' || trim(p_nom), '');
  end if;
  return v_id;
end $$;

-- Créer une facture. p_lignes : [{designation, unite, type ('service'|'product'), qte, pu, taux_tva (0|5|18)}].
-- p_ras_taux : 0, 10 ou 20 (retenue à la source). Renvoie le numéro FAC-AAAA-NNN.
create or replace function public.stp2i_facture_client_creer(p_client uuid, p_date date, p_echeance date, p_objet text,
  p_reference text, p_ras_taux numeric, p_lignes jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_num text; l jsonb; i int := 0; m numeric; t int;
  ht numeric := 0; t18 numeric := 0; t5 numeric := 0; ex numeric := 0; ttc numeric; ras numeric; c public.stp2i_clients;
begin
  perform public.stp2i_exiger(array['logistique','dg','admin']);
  select * into c from public.stp2i_clients where id = p_client;
  if c.id is null then raise exception 'Choisissez le client'; end if;
  if p_date is null then raise exception 'Indiquez la date de la facture'; end if;
  if p_echeance is not null and p_echeance < p_date then raise exception 'L''échéance ne peut pas être avant la date de la facture'; end if;
  if coalesce(p_ras_taux,0) not in (0,10,20) then raise exception 'La retenue à la source est 0, 10 ou 20 %%'; end if;
  if jsonb_typeof(p_lignes) <> 'array' or jsonb_array_length(p_lignes) = 0 then raise exception 'Ajoutez au moins une ligne'; end if;
  for l in select * from jsonb_array_elements(p_lignes) loop
    if coalesce(trim(l->>'designation'),'') = '' then raise exception 'Chaque ligne doit avoir une désignation'; end if;
    if coalesce((l->>'qte')::numeric,0) <= 0 then raise exception 'La quantité doit être plus grande que 0'; end if;
    if (l->>'pu') is null or (l->>'pu')::numeric < 0 then raise exception 'Indiquez le prix unitaire de chaque ligne'; end if;
    t := coalesce((l->>'taux_tva')::int, 0);
    if t not in (0,5,18) then raise exception 'La TVA d''une ligne est 0, 5 ou 18 %%'; end if;
    if coalesce(l->>'type','service') not in ('service','product') then raise exception 'Type de ligne inconnu'; end if;
    m := round((l->>'qte')::numeric * (l->>'pu')::numeric, 2);
    ht := ht + m;
    if t = 18 then t18 := t18 + round(m * 18 / 100, 2); elsif t = 5 then t5 := t5 + round(m * 5 / 100, 2); else ex := ex + m; end if;
  end loop;
  ttc := ht + t18 + t5;
  ras := round(ttc * coalesce(p_ras_taux,0) / 100, 2);
  v_num := public.stp2i_prochain_num('FAC');
  insert into public.stp2i_factures_clients (num, client_id, date_facture, echeance, objet, reference,
      total_ht, tva_18, tva_5, total_exonere, total_ttc, ras_taux, ras_montant, net_a_payer)
    values (v_num, c.id, p_date, p_echeance, coalesce(trim(p_objet),''), coalesce(trim(p_reference),''),
      ht, t18, t5, ex, ttc, coalesce(p_ras_taux,0), ras, ttc - ras)
    returning id into v_id;
  for l in select * from jsonb_array_elements(p_lignes) loop
    i := i + 1;
    insert into public.stp2i_factures_clients_lignes (facture_id, ordre, designation, unite, type, qte, pu, taux_tva)
      values (v_id, i, trim(l->>'designation'), coalesce(trim(l->>'unite'),''), coalesce(l->>'type','service'),
        (l->>'qte')::numeric, (l->>'pu')::numeric, coalesce((l->>'taux_tva')::int, 0));
  end loop;
  perform public.stp2i_journaliser('Facture créée : ' || c.nom || ', ' || to_char(ttc,'FM999G999G999G990') || ' XAF', v_num);
  return v_num;
end $$;

-- Le client a payé.
create or replace function public.stp2i_facture_client_payer(p_id uuid, p_le date, p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare f public.stp2i_factures_clients;
begin
  perform public.stp2i_exiger(array['logistique','dg','admin']);
  select * into f from public.stp2i_factures_clients where id = p_id for update;
  if f.id is null then raise exception 'Facture introuvable'; end if;
  if f.statut <> 'Émise' then raise exception 'Cette facture est déjà %', lower(f.statut); end if;
  if p_le is not null and p_le < f.date_facture then raise exception 'La date de paiement ne peut pas être avant la date de la facture'; end if;
  update public.stp2i_factures_clients set statut = 'Payée', paye_le = coalesce(p_le, current_date), paye_ref = coalesce(trim(p_ref),''), paye_par = auth.uid()
    where id = f.id;
  perform public.stp2i_journaliser('Facture payée par le client : ' || to_char(f.total_ttc,'FM999G999G999G990') || ' XAF', f.num);
end $$;

-- Annuler une facture (erreur…). Elle reste dans la liste avec son numéro et le motif.
create or replace function public.stp2i_facture_client_annuler(p_id uuid, p_motif text) returns void
language plpgsql security definer set search_path = public as $$
declare f public.stp2i_factures_clients;
begin
  perform public.stp2i_exiger(array['logistique','dg','admin']);
  if coalesce(trim(p_motif),'') = '' then raise exception 'Indiquez le motif de l''annulation'; end if;
  select * into f from public.stp2i_factures_clients where id = p_id for update;
  if f.id is null then raise exception 'Facture introuvable'; end if;
  if f.statut <> 'Émise' then raise exception 'Une facture % ne peut pas être annulée', lower(f.statut); end if;
  if f.sfec_statut = 'Certifiée' then raise exception 'Cette facture est certifiée par la SFEC : il faut faire un avoir, pas une annulation'; end if;
  update public.stp2i_factures_clients set statut = 'Annulée', annule_motif = trim(p_motif) where id = f.id;
  perform public.stp2i_journaliser('Facture annulée : ' || trim(p_motif), f.num);
end $$;

-- Résultat de l'envoi à la SFEC. Appelée seulement par la fonction serveur stp2i-sfec (rôle service_role).
create or replace function public.stp2i_facture_client_sfec_noter(p_id uuid, p_ok boolean, p_env text, p_signature text,
  p_code text, p_qr text, p_date timestamptz, p_erreur text, p_par uuid) returns void
language plpgsql security definer set search_path = public as $$
declare f public.stp2i_factures_clients;
begin
  select * into f from public.stp2i_factures_clients where id = p_id for update;
  if f.id is null then raise exception 'Facture introuvable'; end if;
  if f.sfec_statut = 'Certifiée' then raise exception 'Facture déjà certifiée'; end if;
  if p_ok then
    update public.stp2i_factures_clients set sfec_statut = 'Certifiée', sfec_env = coalesce(p_env,''), sfec_signature = coalesce(p_signature,''),
      sfec_code = coalesce(p_code,''), sfec_qr = coalesce(p_qr,''), sfec_date = coalesce(p_date, now()), sfec_erreur = '' where id = f.id;
  else
    update public.stp2i_factures_clients set sfec_statut = 'Refusée', sfec_env = coalesce(p_env,''), sfec_erreur = left(coalesce(p_erreur,''), 2000) where id = f.id;
  end if;
  insert into public.stp2i_journal (par, role, action, ref)
    values (p_par, (select role from public.stp2i_profils where id = p_par),
      case when p_ok then 'Facture certifiée par la SFEC (' || coalesce(p_env,'') || ') : ' || coalesce(p_code,'') else 'Envoi SFEC refusé : ' || left(coalesce(p_erreur,''), 200) end, f.num);
end $$;

revoke execute on function public.stp2i_facture_client_sfec_noter(uuid, boolean, text, text, text, text, timestamptz, text, uuid) from public, anon, authenticated;
grant execute on function public.stp2i_facture_client_sfec_noter(uuid, boolean, text, text, text, text, timestamptz, text, uuid) to service_role;
revoke execute on function public.stp2i_client_enregistrer(uuid, text, text, text, text, text, text, text, text, boolean) from public, anon;
revoke execute on function public.stp2i_facture_client_creer(uuid, date, date, text, text, numeric, jsonb) from public, anon;
revoke execute on function public.stp2i_facture_client_payer(uuid, date, text) from public, anon;
revoke execute on function public.stp2i_facture_client_annuler(uuid, text) from public, anon;
grant execute on function public.stp2i_client_enregistrer(uuid, text, text, text, text, text, text, text, text, boolean) to authenticated;
grant execute on function public.stp2i_facture_client_creer(uuid, date, date, text, text, numeric, jsonb) to authenticated;
grant execute on function public.stp2i_facture_client_payer(uuid, date, text) to authenticated;
grant execute on function public.stp2i_facture_client_annuler(uuid, text) to authenticated;

alter publication supabase_realtime add table public.stp2i_clients, public.stp2i_factures_clients;
