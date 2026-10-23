create or replace function public.stp2i_anomalies_facture(p_commande uuid, p_numero text, p_montant numeric, p_facture uuid default null)
returns text[] language plpgsql stable security definer set search_path = public as $$
declare c public.stp2i_commandes; v_out text[] := '{}';
begin
  select * into c from public.stp2i_commandes where id = p_commande;
  if c.id is null then return array['Bon de commande introuvable']; end if;
  if c.statut not in ('Validé','Reçu partiel','Reçu','Facturé','Payé') then v_out := array_append(v_out, 'Bon de commande non validé par le DG'); end if;
  if not exists (select 1 from public.stp2i_receptions where commande_id = c.id) then v_out := array_append(v_out, 'Aucun bon de réception à la base');
  elsif exists (select 1 from public.stp2i_commande_lignes where commande_id = c.id and recu < qte) then v_out := array_append(v_out, 'Livraison incomplète à la base'); end if;
  if round(p_montant) <> round(c.total) then v_out := array_append(v_out, ('Montant ' || to_char(p_montant,'FM999G999G999') || ' XAF différent du bon de commande (' || to_char(c.total,'FM999G999G999') || ' XAF)')); end if;
  if exists (select 1 from public.stp2i_factures where commande_id = c.id and id is distinct from p_facture) then v_out := array_append(v_out, 'Une autre facture existe déjà pour ce bon de commande'); end if;
  if exists (select 1 from public.stp2i_factures where fournisseur = c.fournisseur and lower(numero) = lower(trim(p_numero)) and id is distinct from p_facture) then v_out := array_append(v_out, 'Ce numéro de facture est déjà enregistré pour ce fournisseur'); end if;
  return v_out;
end $$;
revoke execute on function public.stp2i_anomalies_facture(uuid, text, numeric, uuid) from public, anon, authenticated;