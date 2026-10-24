-- STP2i : rapport journalier IVMS (suivi GPS des camions), qui remplace le fichier Excel « RAPPORT JOURNALIER ».
-- Même structure que le fichier : une ligne par camion et par jour.
--   km parcourus, infractions du jour précédent, heure de démarrage du conducteur, IVMS fonctionnel,
--   check 1 (fin 08h30), check 2 (fin 12h00), check 3 (fin 16h30) : emplacement, heure, observation,
--   check 4 (le lendemain) : heure de pause, heure de fin de service ; durée de travail = fin − pause − démarrage.
-- Rien d'Agence Elite n'est touché.

create table public.stp2i_rapport_jour (
  id uuid primary key default gen_random_uuid(),
  jour date not null,
  vehicule_id uuid not null references public.stp2i_vehicules(id),
  km numeric(10,2) check (km is null or km >= 0),
  infraction text not null default 'NON',
  demarrage time,
  ivms_ok boolean not null default true,
  c1_lieu text not null default '', c1_heure time, c1_obs text not null default '',
  c2_lieu text not null default '', c2_heure time, c2_obs text not null default '',
  c3_lieu text not null default '', c3_heure time, c3_obs text not null default '',
  pause time,
  fin time,
  duree interval generated always as (
    case when demarrage is not null and fin is not null and fin > demarrage
         then (fin - demarrage) - coalesce(pause - time '00:00', interval '0') end) stored,
  saisi_par uuid default auth.uid() references public.stp2i_profils(id),
  saisi_le timestamptz not null default now(),
  unique (jour, vehicule_id)
);
create index stp2i_rapport_jour_jour on public.stp2i_rapport_jour (jour desc);

-- Enregistre (ou corrige) les lignes d'un jour. p_lignes : [{vehicule_id, km, infraction, demarrage, ivms_ok,
-- c1_lieu, c1_heure, c1_obs, c2_..., c3_..., pause, fin}]
create or replace function public.stp2i_rapport_jour_enregistrer(p_jour date, p_lignes jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare l jsonb; n int := 0; t text := '';
begin
  perform public.stp2i_exiger(array['logistique','admin']);
  if p_jour is null then raise exception 'Indiquez le jour'; end if;
  if p_jour > current_date then raise exception 'Le rapport ne peut pas être fait pour un jour à venir'; end if;
  for l in select * from jsonb_array_elements(coalesce(p_lignes,'[]')) loop
    if not exists (select 1 from public.stp2i_vehicules where id = (l->>'vehicule_id')::uuid) then raise exception 'Camion inconnu'; end if;
    insert into public.stp2i_rapport_jour as r (jour, vehicule_id, km, infraction, demarrage, ivms_ok,
        c1_lieu, c1_heure, c1_obs, c2_lieu, c2_heure, c2_obs, c3_lieu, c3_heure, c3_obs, pause, fin)
      values (p_jour, (l->>'vehicule_id')::uuid, nullif(l->>'km','')::numeric, coalesce(nullif(trim(l->>'infraction'),''),'NON'),
        nullif(l->>'demarrage','')::time, coalesce((l->>'ivms_ok')::boolean, true),
        coalesce(trim(l->>'c1_lieu'),''), nullif(l->>'c1_heure','')::time, coalesce(trim(l->>'c1_obs'),''),
        coalesce(trim(l->>'c2_lieu'),''), nullif(l->>'c2_heure','')::time, coalesce(trim(l->>'c2_obs'),''),
        coalesce(trim(l->>'c3_lieu'),''), nullif(l->>'c3_heure','')::time, coalesce(trim(l->>'c3_obs'),''),
        nullif(l->>'pause','')::time, nullif(l->>'fin','')::time)
    on conflict (jour, vehicule_id) do update set km = excluded.km, infraction = excluded.infraction, demarrage = excluded.demarrage,
        ivms_ok = excluded.ivms_ok, c1_lieu = excluded.c1_lieu, c1_heure = excluded.c1_heure, c1_obs = excluded.c1_obs,
        c2_lieu = excluded.c2_lieu, c2_heure = excluded.c2_heure, c2_obs = excluded.c2_obs,
        c3_lieu = excluded.c3_lieu, c3_heure = excluded.c3_heure, c3_obs = excluded.c3_obs,
        pause = excluded.pause, fin = excluded.fin, saisi_par = auth.uid(), saisi_le = now();
    n := n + 1;
  end loop;
  if n > 0 then perform public.stp2i_journaliser('Rapport journalier enregistré (' || n || ' camion(s))', to_char(p_jour, 'DD/MM/YYYY')); end if;
  return n;
end $$;

alter table public.stp2i_rapport_jour enable row level security;
create policy stp2i_rapport_jour_lecture on public.stp2i_rapport_jour for select to authenticated using (public.stp2i_mon_role() is not null);

revoke execute on function public.stp2i_rapport_jour_enregistrer(date, jsonb) from public, anon;
grant execute on function public.stp2i_rapport_jour_enregistrer(date, jsonb) to authenticated;

alter publication supabase_realtime add table public.stp2i_rapport_jour;
