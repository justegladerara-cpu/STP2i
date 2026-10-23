# STP2i Achats et Parc

Application web de STP2i (Pointe-Noire) pour suivre les demandes de pièces, les bons de commande, les réceptions à la base, le stock, les factures fournisseurs et les camions.

C'est le premier module du futur système de gestion STP2i. Les modules suivants (pannes et entretien, HSE, etc.) viendront s'ajouter au même endroit.

## Le circuit

1. **Chef de base** (téléphone, gros boutons) : *Nouvelle demande* avec la photo de la demande écrite du chef mécanicien.
2. **Logistique** : prépare le bon de commande (fournisseur, lignes, prix, devis).
3. **DG** : *Valider* ou *Refuser*. C'est la seule validation qui compte : un accord par téléphone ne suffit pas.
4. **Chef de base** : *Réception livraison* avec la photo du bon de livraison. La base ne voit que les commandes validées par le DG, et elle ne voit pas les prix.
5. **Chef de base** : *Pièce montée*, avec la photo de la pièce usée rendue. Pas de pièce neuve sans pièce usée.
6. **Logistique** : enregistre la facture. Le contrôle est automatique :
   - le bon de commande est validé par le DG ;
   - la livraison a été reçue en entier à la base ;
   - le montant est identique au bon de commande ;
   - il n'y a pas de doublon.
7. **DG** : marque payées les factures « Conforme ». Une facture bloquée ne peut pas être payée.

Chaque action est inscrite dans le journal (qui, quand, quoi). Rien ne peut être supprimé depuis l'application.

## Rôles

| Rôle | Voit | Peut faire |
|---|---|---|
| Chef de base | camions, demandes, stock (sans prix) | demande, réception, sortie de pièce |
| Logistique | tout | bons de commande, refus de demande, factures, camions, kilomètres WhatsGPS |
| Direction générale | tout | valider ou refuser les bons de commande, payer les factures conformes |
| Administration | tout | créer les comptes, attribuer les rôles, changer les mots de passe, régler le seuil de validation |

## Architecture

- `index.html`, `app.js`, `style.css`, `config.js` : l'application. Ce sont des fichiers statiques publiés par GitHub Pages.
- La base de données est sur **Supabase**, projet *agence-elite-platform*. Tout ce qui concerne STP2i est préfixé `stp2i_` : tables, fonctions et dossier de fichiers `stp2i-documents`.
- La sécurité est assurée par la base de données, pas par la page :
  - les tables sont en lecture seule selon le rôle (RLS) ;
  - toute écriture passe par une fonction `stp2i_…` qui vérifie le rôle, applique la règle et écrit le journal.
- `supabase/migrations/` garde une copie du schéma, des règles et des fonctions. La base est partagée avec agence-elite-platform : tout changement de base passe par une migration dans ce dépôt-là et par le canal justegladerara-cpu/agence-elite-platform#83 (voir `CLAUDE.md`).
- `supabase/functions/stp2i-comptes` est la fonction serveur qui crée les comptes, sans e-mail de confirmation. L'identifiant `gloria` devient `gloria@stp2i.app`.

## Mise en ligne (GitHub Pages)

1. Sur GitHub, ouvrez **Settings → Pages**.
2. Choisissez *Source : Deploy from a branch*, puis *Branch : main*, dossier */ (root)*, et cliquez **Save**.
3. Après une minute, l'adresse s'affiche : `https://justegladerara-cpu.github.io/STP2i/`.

## Premier démarrage

1. Ouvrez l'adresse. L'écran *Premier démarrage* apparaît une seule fois : créez le compte administrateur.
2. Dans **Comptes et réglages**, créez un compte par personne :
   - le chef de base ;
   - Mme Gloria et Mme Bénitia (Logistique) ;
   - M. Rodrigue Tchibinda (Direction générale).
3. Remettez à chacun son identifiant et son mot de passe.
4. Dans l'onglet **Camions**, la logistique complète les immatriculations et les chauffeurs. CE-01 à CE-07 et MC-01 sont déjà créés.

Le seuil de validation est à 0 : toutes les commandes passent par le DG. L'administrateur peut le changer.
