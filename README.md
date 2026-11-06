# Relevés de service — La Graine 34

Petit serveur web qui permet à un commerçant de la monnaie locale de se
connecter avec son compte [Cyclos](https://www.cyclos.org/), de choisir une
plage horaire (31 jours au plus) et d'obtenir son **ticket de fin de service** :
nombre et total des paiements reçus et sortis, solde net, détail chronologique.
Le ticket s'affiche à l'écran (impression sur imprimante 80 mm possible) et se
télécharge en **PDF** (A4).

L'outil ne fait que lire : il ne modifie rien dans Cyclos et ne garde aucune
donnée sur disque.

## Prérequis

- Node.js 22 ou plus récent (développé et testé avec Node 24.16 ; les versions
  plus anciennes n'ont pas été essayées).
- Un accès réseau vers l'API Cyclos.

## Installation

```sh
npm install
```

Deux dépendances seulement : `luxon` (dates) et `pdfkit` (PDF, version exacte).

## Lancement

```sh
node server.js
```

Puis ouvrir <http://localhost:3000>. Sans configuration, l'outil interroge la
démo publique de Cyclos (`https://demo.cyclos.org/api`) ; pour un usage réel,
renseigner `CYCLOS_BASE_URL`.

```sh
CYCLOS_BASE_URL=https://cyclos.example.org/api PORT=8080 node server.js
```

## Variables d'environnement

| Nom | Rôle | Valeur par défaut |
| --- | --- | --- |
| `CYCLOS_BASE_URL` | Adresse de l'API Cyclos (avec `/api`) | `https://demo.cyclos.org/api` |
| `CYCLOS_CHANNEL` | Canal Cyclos, envoyé dans l'en-tête `Channel` sur tous les appels (connexion, historique, totaux, déconnexion). Lettres, chiffres, `-` et `_`, 32 caractères au maximum, sinon le serveur refuse de démarrer. `main` est le canal de l'interface officielle ; le canal prévu pour les outils externes devra être confirmé avec Cylaos. | aucun (en-tête non envoyé) |
| `PORT` | Port d'écoute | `3000` |
| `SESSION_IDLE_MINUTES` | Inactivité après laquelle la session se ferme | `20` |
| `SESSION_MAX_HOURS` | Durée maximale d'une session, activité ou non | `8` |
| `COOKIE_SECURE` | `true` : cookie `Secure` et en-tête HSTS (à activer derrière HTTPS) | désactivé |
| `HISTORY_PAGE_SIZE` | Lignes demandées à Cyclos par page | `200` |
| `HISTORY_MAX_ROWS` | Nombre maximal de lignes dans le détail | `2000` |

Une valeur numérique absente ou invalide (zéro, négative, texte) est remplacée
par la valeur par défaut. Seule la valeur exacte `true` active `COOKIE_SECURE`.

## Tests

```sh
npm test
```

Les tests utilisent `node:test` (rien à installer) et durent moins d'une
seconde. Ils démarrent le vrai serveur sur un port libre face à un **faux
Cyclos** local (`test-support/fake-cyclos.js`) : aucun appel à un service
externe, aucun vrai identifiant (les identifiants des tests sont fictifs).

- `test/unit.test.js` : dates, montants, échappement HTML, texte du PDF, résumé.
- `test/connexion.test.js` : connexion, limitation, sessions, CSRF, refus 403.
- `test/releve.test.js` : ticket à l'écran et PDF.
- `test/securite.test.js` : en-têtes, cache, limite de taille.
- `test/statique.test.js`, `test/charte.test.js`, `test/demarrage.test.js` :
  fichiers statiques, charte graphique, démarrage.

## Sécurité en bref

- **Pas de mot de passe conservé** : l'identifiant et le mot de passe servent
  une seule fois, à la connexion, pour obtenir un jeton de session Cyclos.
  Seul ce jeton est gardé (en mémoire) et utilisé ensuite. Le navigateur reçoit
  un identifiant de session aléatoire sans rapport avec le jeton, dans un
  cookie `HttpOnly` + `SameSite=Lax`.
- **Sessions** : fermées à la déconnexion (le jeton est aussi fermé côté
  Cyclos), après 20 minutes d'inactivité, ou au bout de 8 heures. Un jeton
  refusé par Cyclos ramène à la page de connexion.
- **CSRF** : chaque session a un jeton aléatoire exigé sur `POST /releve`,
  `/releve.pdf` et `/deconnexion` (comparaison à temps constant) ; la
  déconnexion par `GET` est refusée (405). La connexion vérifie l'en-tête
  `Origin` (ou `Referer`).
- **En-têtes** : Content-Security-Policy stricte (`default-src 'none'`, pas de
  script ni de style en ligne, rien d'externe), `X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Cache-Control: no-store` sur les
  pages, HSTS avec `COOKIE_SECURE=true`.
- **Limites** : 5 échecs de connexion par adresse IP et par 15 minutes (puis
  429) ; corps des requêtes limité à 10 ko ; plage de 31 jours ; détail limité
  à 2000 lignes (le résumé, calculé par Cyclos, reste exact et un
  avertissement est affiché) ; toutes les valeurs venant de Cyclos sont
  échappées.

## Limites connues

- **Adresse IP derrière un proxy** : le compteur d'échecs de connexion utilise
  l'adresse du pair TCP. Derrière un proxy inverse, tous les utilisateurs
  partagent donc le même compteur (5 échecs bloquent tout le monde).
- **Sessions perdues au redémarrage** : sessions et compteurs sont en mémoire ;
  redémarrer le serveur déconnecte tout le monde (les jetons Cyclos restent
  valides jusqu'à leur expiration côté Cyclos).
- **Instance unique** : pas de partage d'état entre plusieurs processus ni
  plusieurs serveurs ; ne pas répartir la charge sur plusieurs instances.
- **Totaux du résumé calculés par le code** : sur la vraie instance, Cyclos
  répond à `GET /self/accounts/{type}?datePeriod=…` sans `incoming`,
  `outgoing` ni `netInflow`. Quand ils manquent, le serveur calcule les
  totaux à partir des transactions lues (reçus = montants positifs, sortis =
  valeur absolue des négatifs, net = différence), en entiers (pas de
  flottants). Ce calcul n'est fait que si la liste est complète : au-delà de
  2000 transactions (`HISTORY_MAX_ROWS`), les trois lignes du résumé
  affichent « Non disponible », avec un avertissement (page et PDF) ; il faut
  alors réduire la plage. Quand Cyclos fournit les indicateurs, ils sont
  repris tels quels, sans recalcul.
- **PDF en Helvetica** : seules les lettres latines de Windows-1252 (accents
  français, €, guillemets…) sont imprimées ; tout autre caractère (alphabets
  non latins, emoji) devient `?` dans le PDF. La page à l'écran les affiche.
- **Heure ambiguë du passage à l'heure d'hiver** : une heure comme 02:30 le
  dernier dimanche d'octobre existe deux fois ; l'outil retient la seconde
  (heure d'hiver) sans prévenir. Les heures qui n'existent pas (passage à
  l'heure d'été) sont refusées avec un message.
- **Logo de 200 px** : un peu flou sur les écrans haute densité et à
  l'impression ; à remplacer par un fichier de plus grande taille quand il
  sera disponible.
- Les méthodes autres que celles prévues (par exemple `HEAD` sur `/style.css`)
  répondent 404.

## Avant la mise en production

- [ ] Servir **uniquement en HTTPS** (le serveur parle HTTP simple : le placer
      derrière un proxy inverse qui termine TLS) et rediriger HTTP vers HTTPS.
- [ ] Définir `COOKIE_SECURE=true` (cookie `Secure` + HSTS). Sans HTTPS, ne
      pas l'activer : la connexion ne fonctionnerait plus.
- [ ] Définir `CYCLOS_BASE_URL` vers le Cyclos de production (et pas la démo).
- [ ] Choisir l'hébergement et le laisser écouter seulement ce que le proxy
      doit voir (le serveur écoute sur toutes les interfaces ; pare-feu ou
      réseau privé entre le proxy et lui).
- [ ] Régler le proxy : en-têtes transmis, taille des corps (≥ 10 ko), délais ;
      et traiter la limite connue sur l'adresse IP (voir plus haut).
- [ ] Lancer le processus sous un service qui le redémarre (systemd, etc.),
      avec un utilisateur sans privilèges, et surveiller sa sortie (les
      erreurs de Cyclos y sont écrites, jamais les mots de passe).
- [ ] Mettre à jour Node.js et les dépendances régulièrement.
- [ ] Lancer `npm audit` avant chaque mise en production et après chaque mise
      à jour, puis `npm test`.

## Licences

Les polices Roboto et Voltaire servies par l'outil (`fonts/`) sont sous
licence SIL Open Font License 1.1 : voir [fonts/LICENSES.txt](fonts/LICENSES.txt).
Le logo est celui de La Graine 34.
