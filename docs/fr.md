# Eloverblik (Danemark)

Intégration non officielle, sans lien avec Energinet ni avec Eloverblik. Elle
lit la consommation électrique horaire de vos points de comptage danois par
l'**API client officielle d'Eloverblik** (Energinet DataHub) et en alimente le
suivi d'énergie de Gladys. Lecture seule : rien n'est jamais modifié sur votre
compte.

> Cette intégration n'a jamais été testée avec un vrai compte Eloverblik : elle
> est écrite d'après la description officielle de l'API (Swagger). Vos retours
> sont les bienvenus.

## Ce qu'il faut

- Un point de comptage électrique danois (consommation) et MitID pour vous
  connecter à [eloverblik.dk](https://eloverblik.dk/).
- Gladys 5.3.0 ou plus récent.

## Créer le jeton

1. Connectez-vous à [eloverblik.dk](https://eloverblik.dk/) avec MitID (client
   particulier).
2. Vérifiez que vos points de comptage sont liés à votre compte (ils
   apparaissent sur la page d'accueil).
3. Ouvrez le menu **Partage de données** (_Datadeling_), puis créez un jeton
   pour l'API. Donnez-lui un nom, par exemple « Gladys », et copiez-le : c'est
   un long texte en trois parties séparées par des points, affiché une seule
   fois.
4. Dans Gladys, ouvrez l'intégration, collez le jeton dans **Jeton
   Eloverblik** et enregistrez.

Le jeton est valable **un an**. Le statut de l'intégration donne sa date de
fin : créez-en un nouveau sur eloverblik.dk avant cette date et enregistrez-le
dans Gladys.

Le jeton est gardé par Gladys dans sa base, jamais réaffiché, et envoyé
seulement à Eloverblik (`api.eloverblik.dk`). Il n'est jamais écrit dans les
journaux, le statut ni `/data`.

## Créer les appareils

Après l'enregistrement, l'intégration liste vos points de comptage de
**consommation** (type E17 ; les points de production ne sont pas lus, 10
points au plus). Ouvrez **Découverte** et créez les appareils voulus : chacun
s'appelle « Compteur Eloverblik …1234 » (seulement les 4 derniers chiffres du
numéro du point) et a une seule fonction, **Consommation (30 min)**.

Seuls les appareils créés sont lus. Le bouton **Tester le jeton** demande un
jeton d'accès et liste vos points (au plus une fois par minute).

## Comment arrivent les données

- Eloverblik publie la consommation avec **un ou deux jours de retard**.
  L'intégration lit une fois par jour, à partir de 09:00 (heure danoise, une
  minute propre à votre installation, jusqu'à 12:00), et ne demande que les
  jours pas encore complets. Tant qu'hier est incomplet, elle relit 4 heures
  plus tard, 4 fois par jour au plus.
- À la première lecture, elle prend **31 jours** en arrière. Après un arrêt,
  elle rattrape au plus 92 jours. Les 3 derniers jours complets sont relus avec
  les suivants : une valeur estimée remplacée par une mesure est corrigée.
- Chaque heure est coupée en **deux demi-heures égales** (le suivi d'énergie de
  Gladys travaille par demi-heure). Une heure qu'Eloverblik marque non
  disponible (qualité A02) ou incomplète (A05) reste **inconnue** : elle n'est
  jamais comptée 0. Un jour auquel il manque une heure est redemandé pendant 10
  jours, puis abandonné.
- La consommation entre dans le suivi d'énergie avec la date de chaque
  demi-heure (`publishEnergyConsumption`) : il n'y a ni index cumulé ni valeur
  en direct.

## Coûts et contrats d'énergie

Cette intégration n'a pas de contrat à elle. Pour voir les coûts, rattachez un
contrat d'énergie à la consommation dans Gladys, par exemple le contrat danois
de l'intégration **Energi Data Service** (tarifs du réseau, Energinet,
elafgift et prix spot DK1/DK2). Les tarifs danois qui dépendent de l'heure ont
besoin de la consommation par demi-heure : c'est ce que publie cette
intégration.

## Limites de l'API Eloverblik

L'intégration reste très en dessous des limites publiées : 30 requêtes par
jour au plus, une à la fois, à 2 secondes d'écart ; le jeton d'accès aux
données (valable 24 heures) est gardé en mémoire et renouvelé après 20 heures ;
deux demandes de jeton ne sont jamais à moins de 5 minutes d'écart, même après
un redémarrage (l'heure est gardée dans `/data` ; la limite est de 2 par
minute et par IP).

- **429 (trop de requêtes)** ou **503 (DataHub indisponible)** et autres 5xx :
  toutes les requêtes s'arrêtent (le `Retry-After` de la réponse s'il est
  donné, sinon 15 minutes, doublées à chaque fois jusqu'à 6 heures). La pause
  survit à un redémarrage.
- **Jeton refusé** (la demande de jeton répond 401, ou 403 / un code d'erreur
  de l'API) : plus rien n'est demandé ; le statut le dit. Enregistrez un
  nouveau jeton, ou appuyez sur Tester quand le jeton fonctionne à nouveau.
- Un 401 ou 403 sur une route de **données** n'est pas un refus de votre
  jeton : le jeton d'accès est oublié et un nouveau est demandé à la lecture
  suivante.
- Une erreur sur un point de comptage (pas de données, relation expirée…)
  s'affiche dans le statut avec son code (par exemple `E30015`) ; les autres
  points continuent.

## Ce que garde `/data`

`/data/eloverblik.json` garde : l'heure de la dernière lecture et de la
dernière demande de jeton, le compte des requêtes du jour, la pause, une marque
du jeton refusé (8 bits d'une empreinte salée, rien qui permette de retrouver
le jeton) et, par point de comptage (désigné par une empreinte à clé, jamais
son numéro), le dernier jour complet.

## En cas de problème

- **« Eloverblik ne liste aucun point de comptage de consommation »** : liez
  vos points de comptage sur eloverblik.dk (le jeton ne voit que les points
  liés à votre compte).
- **« Compteur …1234 : E20010 »** (relation introuvable) ou **E30016**
  (relation expirée) : liez à nouveau le point de comptage sur eloverblik.dk.
- **« E30015 »** : pas encore de données pour la période ; elle est
  redemandée.
- **« not_listed »** : un appareil créé n'est plus parmi les points de comptage
  du jeton.
- Le fuseau horaire de Gladys doit être celui du Danemark (ou la même heure) :
  les jours sont des jours danois.

## Source des données

Données : Eloverblik, Energinet DataHub, les données de votre propre compteur,
lues avec le jeton que vous avez créé.
