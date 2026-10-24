-- STP2i : plan de travail du jour, qui remplace le fichier Excel « PLAN DE TRAVAIL ».
-- Même structure que le fichier :
--   en-tête par camion : chauffeur, guide, téléphone, zone de travail (et camion en panne) ;
--   courses : liste à livrer, courses restantes de la veille, observation, camion affecté, faite ou non ;
--   bas de page : véhicules en attente à la base, agents en attente, remarques (absences, problèmes).
-- Totaux (prévues, faites, restantes, pourcentage de livraison) calculés par l'application.
-- Rien d'Agence Elite n'est touché.

create table public.stp2i_plan_jour (
  jour date primary key,
  notes text not null default '',
  vehicules_attente text not null default '',
  agents_attente text not null default '',
  maj_par uuid default auth.uid() references public.stp2i_profils(id),
  maj_le timestamptz not null default now()
);

create table public.stp2i_plan_equipes (
  jour date not null references public.stp2i_plan_jour(jour) on delete cascade,
  vehicule_id uuid not null references public.stp2i_vehicules(id),
  chauffeur text not null default '',
  guide text not null default '',
  telephone text not null default '',
  zone text not null default '',
  en_panne boolean not null default false,
  primary key (jour, vehicule_id)
);

create table public.stp2i_plan_courses (
  id uuid primary key default gen_random_uuid(),
  jour date not null references public.stp2i_plan_jour(jour) on delete cascade,
  ordre int not null default 0,
  nom text not null check (length(trim(nom)) > 0),
  origine text not null default 'À livrer' check (origine in ('À livrer','Restante')),
  vehicule_id uuid references public.stp2i_vehicules(id),
  faite boolean not null default false,
  observation text not null default '',
  faite_le timestamptz
);
create index stp2i_plan_courses_jour on public.stp2i_plan_courses (jour, ordre);

-- Enregistre tout le plan d'un jour (en-tête, équipes, courses). Les courses du jour sont remplacées par la liste envoyée.
create or replace function public.stp2i_plan_enregistrer(p_jour date, p_entete jsonb, p_equipes jsonb, p_courses jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare e jsonb; c jsonb; n int := 0; i int := 0; prev jsonb;
begin
  perform public.stp2i_exiger(array['logistique','admin']);
  if p_jour is null then raise exception 'Indiquez le jour'; end if;
  insert into public.stp2i_plan_jour as j (jour, notes, vehicules_attente, agents_attente)
    values (p_jour, coalesce(trim(p_entete->>'notes'),''), coalesce(trim(p_entete->>'vehicules_attente'),''), coalesce(trim(p_entete->>'agents_attente'),''))
  on conflict (jour) do update set notes = excluded.notes, vehicules_attente = excluded.vehicules_attente,
    agents_attente = excluded.agents_attente, maj_par = auth.uid(), maj_le = now();

  delete from public.stp2i_plan_equipes where jour = p_jour;
  for e in select * from jsonb_array_elements(coalesce(p_equipes,'[]')) loop
    if not exists (select 1 from public.stp2i_vehicules where id = (e->>'vehicule_id')::uuid) then raise exception 'Camion inconnu'; end if;
    insert into public.stp2i_plan_equipes (jour, vehicule_id, chauffeur, guide, telephone, zone, en_panne)
      values (p_jour, (e->>'vehicule_id')::uuid, coalesce(trim(e->>'chauffeur'),''), coalesce(trim(e->>'guide'),''),
              coalesce(trim(e->>'telephone'),''), coalesce(trim(e->>'zone'),''), coalesce((e->>'en_panne')::boolean, false));
  end loop;

  -- On garde l'heure à laquelle une course a été marquée faite.
  select coalesce(jsonb_object_agg(id::text, faite_le), '{}') into prev from public.stp2i_plan_courses where jour = p_jour and faite;
  delete from public.stp2i_plan_courses where jour = p_jour;
  for c in select * from jsonb_array_elements(coalesce(p_courses,'[]')) loop
    i := i + 1;
    if coalesce(trim(c->>'nom'),'') = '' then continue; end if;
    if nullif(c->>'vehicule_id','') is not null and not exists (select 1 from public.stp2i_vehicules where id = (c->>'vehicule_id')::uuid) then raise exception 'Camion inconnu'; end if;
    insert into public.stp2i_plan_courses (id, jour, ordre, nom, origine, vehicule_id, faite, observation, faite_le)
      values (coalesce(nullif(c->>'id','')::uuid, gen_random_uuid()), p_jour, i, upper(regexp_replace(trim(c->>'nom'), '\s+', ' ', 'g')),
              case when c->>'origine' = 'Restante' then 'Restante' else 'À livrer' end,
              nullif(c->>'vehicule_id','')::uuid, coalesce((c->>'faite')::boolean, false), coalesce(trim(c->>'observation'),''),
              case when coalesce((c->>'faite')::boolean, false) then coalesce((prev->>(c->>'id'))::timestamptz, now()) end);
    n := n + 1;
  end loop;
  perform public.stp2i_journaliser('Plan de travail enregistré (' || n || ' course(s))', to_char(p_jour, 'DD/MM/YYYY'));
  return n;
end $$;

alter table public.stp2i_plan_jour enable row level security;
alter table public.stp2i_plan_equipes enable row level security;
alter table public.stp2i_plan_courses enable row level security;
create policy stp2i_plan_jour_lecture on public.stp2i_plan_jour for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_plan_equipes_lecture on public.stp2i_plan_equipes for select to authenticated using (public.stp2i_mon_role() is not null);
create policy stp2i_plan_courses_lecture on public.stp2i_plan_courses for select to authenticated using (public.stp2i_mon_role() is not null);

revoke execute on function public.stp2i_plan_enregistrer(date, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.stp2i_plan_enregistrer(date, jsonb, jsonb, jsonb) to authenticated;

alter publication supabase_realtime add table public.stp2i_plan_jour, public.stp2i_plan_equipes, public.stp2i_plan_courses;
