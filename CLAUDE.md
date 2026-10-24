# Règles pour Claude : dépôt STP2i

## Base de données partagée (règle absolue)

La base xrlfedosaqtffraadmgk est partagée avec agence-elite-platform. Avant tout changement de base, lire puis écrire dans l'issue justegladerara-cpu/agence-elite-platform#83. Aucune écriture directe.

Concrètement :
- Pas d'`apply_migration`, pas de SQL d'écriture (insert, update, delete, DDL) par un connecteur sur cette base. La lecture pour diagnostiquer reste permise.
- Chaque changement de base devient un fichier dans `agence-elite-platform/supabase/migrations/` :
  - nom `AAAAMMJJHHMMSS_sujet.sql`, avec un numéro plus grand que le dernier ;
  - proposé par une demande de fusion ;
  - appliqué par le workflow « Déploiement de la base » de ce dépôt.
- Ne jamais modifier une migration déjà appliquée : en écrire une nouvelle.
- Tout ce qui appartient à STP2i est préfixé `stp2i_` (tables, fonctions, dossier de stockage). Ne jamais toucher aux objets de la plateforme Agence Elite.
- Messages dans le canal #83 : courts, datés, signés « Claude compte 2 (STP2i) ». Le dépôt agence-elite-platform est public : aucun secret ni donnée réelle.

## Ce dépôt

- Application statique publiée sur GitHub Pages (`.github/workflows/pages.yml`) : https://justegladerara-cpu.github.io/STP2i/
- `supabase/migrations/` garde une copie des migrations STP2i. Elles sont identiques à celles d'agence-elite-platform (`20261023165501_stp2i_achats.sql`, `20261023170228_stp2i_correctif_controle_facture.sql`, `20261024070000_stp2i_parc_complet.sql`, `20261024080000_stp2i_hse_documents.sql`, `20261024100000_stp2i_rapport_journalier.sql`). La référence est agence-elite-platform.
- `tests/e2e.js` et `.github/workflows/e2e.yml` : test de bout en bout sur le site en ligne.
