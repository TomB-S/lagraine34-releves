// === À LIRE EN PREMIER : ce fichier sert de MODÈLE ===
// Il vérifie que l'outil sert correctement ses fichiers « statiques » (la feuille de style, le logo, les polices) :
// bon type, mise en cache, protection contre la lecture d'autres fichiers du serveur (le code, la config). Pour un
// commerçant, c'est ce qui rend les pages lisibles et rapides ; pour la sécurité, c'est ce qui empêche qu'on
// aille lire server.js ou .git/ par l'URL. Il utilise le harnais (test-support/harness.js : vrai serveur + faux
// Cyclos). Le premier test est commenté pas à pas : lisez-le d'abord, les autres fichiers suivent le même schéma.
//
// Les trois temps d'un test : 1) PRÉPARER la situation, 2) AGIR (envoyer une requête), 3) VÉRIFIER la réponse.
//
// Notions utilisées dans tout le projet (expliquées ici une fois, les autres fichiers y renvoient) :
//  - `node:test` est le module de test intégré à Node ; `npm test` lance `node --test`, qui exécute tous les
//    fichiers *.test.js. Un test est une fonction : s'il ne se passe rien d'anormal il réussit, si une erreur
//    est levée il échoue. `appTest(titre, fonction)` (du harnais) est un `test` qui démarre les serveurs avant.
//  - `assert` (node:assert/strict) fournit les vérifications : `assert.equal(a, b)` échoue si a !== b ;
//    `assert.ok(x)` échoue si x est faux ; `assert.match(texte, /regex/)` échoue si le texte ne correspond pas ;
//    `assert.deepEqual` compare le contenu de tableaux/objets. Le dernier argument est le message affiché en cas d'échec.
//  - `async` / `await` : parler à un serveur prend du temps. `await` met le test en pause jusqu'à la réponse
//    (sans bloquer Node) ; une fonction qui contient `await` doit être déclarée `async`.
//  - En-têtes HTTP (headers) : des lignes d'information qui accompagnent chaque requête et chaque réponse
//    (Content-Type, Cache-Control...). Dans fetch on les lit avec `res.headers.get("nom")` (la casse n'a pas d'importance).
//  - `Buffer` : la représentation Node d'une suite d'octets (le contenu d'une image, d'une police, d'un PDF).
//  - Un statut HTTP est un code à trois chiffres : 200 = OK, 303 = redirection, 304 = « rien de nouveau »,
//    400 = requête invalide, 401 = non authentifié, 403 = interdit, 404 = introuvable, 5xx = panne côté serveur.
// Static files: /style.css, /logo.png, /fonts/*.woff2.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appTest, rawRequest } from "../test-support/harness.js";

// ROOT : le dossier du projet, pour relire les vrais fichiers sur le disque et les comparer à ce que sert le serveur.
const ROOT = new URL("../", import.meta.url);
// Un tableau de cas : [adresse demandée au serveur, fichier réel sur le disque, type de contenu attendu].
const FILES = [
  ["/style.css", "style.css", "text/css; charset=utf-8"],
  ["/logo.png", "logo-lagraine34.png", "image/png"],
  ["/fonts/roboto-latin-400-normal.woff2", "fonts/roboto-latin-400-normal.woff2", "font/woff2"],
  ["/fonts/roboto-latin-700-normal.woff2", "fonts/roboto-latin-700-normal.woff2", "font/woff2"],
  ["/fonts/voltaire-latin-400-normal.woff2", "fonts/voltaire-latin-400-normal.woff2", "font/woff2"],
];

// MODÈLE À RELIRE EN PREMIER. Intention : chaque fichier statique est servi avec le bon type, une durée de cache et
// un ETag, et son contenu est identique au fichier du disque. Si ça cassait : une police ou le logo pourrait s'afficher
// de travers, ou le navigateur ne le mettrait jamais en cache.
//
// Cache et ETag : `Cache-Control: public, max-age=3600` autorise le navigateur à garder le fichier 1 heure. L'ETag est
// une empreinte du contenu : au rechargement, le navigateur la renvoie et le serveur peut répondre 304 sans renvoyer le fichier.
// `async (app) => {...}` : la fonction du test ; `app` est fourni par appTest (voir test-support/harness.js).
appTest("fichiers statiques : bon type, cache public, ETag, contenu identique au fichier", async (app) => {
  // 1) PRÉPARER : un ensemble vide où l'on rangera les ETag vus ; un Set ne garde que des valeurs différentes.
  const etags = new Set();
  // On répète les mêmes vérifications pour chacun des cinq fichiers.
  for (const [route, file, type] of FILES) {
    // 2) AGIR : demander le fichier au vrai serveur, comme le ferait un navigateur. `await` attend la réponse.
    const res = await app.request(route);
    // 3) VÉRIFIER. D'abord le statut : 200 = trouvé. `route` en dernier argument s'affiche si le test échoue,
    // pour savoir QUEL fichier pose problème.
    assert.equal(res.status, 200, route);
    // Le type de contenu : sans lui le navigateur ne saurait pas qu'un fichier est du CSS ou une police.
    assert.equal(res.headers.get("content-type"), type, route);
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600", route);
    const etag = res.headers.get("etag");
    // `/^...$/` est une expression régulière (un motif de texte) : ici, 16 caractères hexadécimaux entre guillemets.
    assert.match(etag, /^"[0-9a-f]{16}"$/, route);
    etags.add(etag);
    // Le corps de la réponse (octets) doit être strictement identique au fichier lu sur le disque.
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), readFileSync(new URL(file, ROOT)), route);
    // Un fichier statique ne doit pas ouvrir de session : aucun cookie posé (`null` = en-tête absent).
    assert.equal(res.headers.get("set-cookie"), null, route);
  }
  // Cinq fichiers différents => cinq ETag différents (sinon l'empreinte ne distinguerait rien).
  assert.equal(etags.size, FILES.length, "un ETag par fichier");
});

// Intention : vérifier que les fichiers sont VRAIMENT du PNG et du woff2 (leurs premiers octets, la « signature »),
// pas un texte d'erreur servi avec le mauvais type. Sinon le logo ou les polices seraient cassés.
appTest("fichiers statiques : signatures (PNG, woff2)", async (app) => {
  const png = Buffer.from(await (await app.request("/logo.png")).arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const [route] of FILES.slice(2)) {
    const font = Buffer.from(await (await app.request(route)).arrayBuffer());
    assert.equal(font.subarray(0, 4).toString(), "wOF2", route);
  }
});

// Intention : à la revalidation, si le navigateur envoie l'ETag qu'il connaît (`If-None-Match`), le serveur répond 304
// sans corps (économie de données) ; avec un ETag inconnu il renvoie le fichier complet (200). Sinon, soit on renverrait
// tout à chaque fois, soit on laisserait des fichiers périmés.
appTest("fichiers statiques : 304 sans corps à la revalidation, 200 si l'ETag ne correspond pas", async (app) => {
  for (const [route] of FILES) {
    const first = await app.request(route);
    const etag = first.headers.get("etag");
    const again = await app.request(route, { headers: { "If-None-Match": etag } });
    assert.equal(again.status, 304, route);
    assert.equal(again.headers.get("etag"), etag, route);
    assert.equal(again.headers.get("cache-control"), "public, max-age=3600", route);
    assert.equal((await again.arrayBuffer()).byteLength, 0, route);
    const other = await app.request(route, { headers: { "If-None-Match": '"0000000000000000"' } });
    assert.equal(other.status, 200, route);
  }
});

// Intention : le logo et le CSS doivent s'afficher sur la page de connexion, donc sans être connecté, et sans
// interroger Cyclos (le faux Cyclos n'a reçu aucune requête). Sinon la page de connexion serait sans style.
appTest("fichiers statiques : accessibles sans session, aucun appel à Cyclos", async (app) => {
  for (const [route] of FILES) assert.equal((await app.request(route)).status, 200);
  assert.equal(app.cyclos.state.requests.length, 0);
});

// Intention (sécurité) : seuls les cinq fichiers connus sont servis. Toute autre adresse — y compris les astuces
// « ../ » (remonter dans les dossiers, parfois encodé en %2e%2e) — doit donner 404 et ne jamais laisser lire server.js,
// package.json, .git/... Si ça cassait, un visiteur pourrait lire le code ou la configuration du serveur.
// `rawRequest` envoie le chemin tel quel, car fetch « nettoie » ces chemins avant de les envoyer.
appTest("/fonts/ : chemin non listé -> 404, y compris avec ../ ou ses variantes encodées", async (app) => {
  const paths = [
    "/fonts/",
    "/fonts",
    "/fonts/inconnue.woff2",
    "/fonts/LICENSES.txt",
    "/fonts/roboto-latin-400-normal.woff",
    "/fonts/ROBOTO-LATIN-400-NORMAL.WOFF2",
    "/fonts/roboto-latin-400-normal.woff2/",
    "/fonts/../server.js",
    "/fonts/../package.json",
    "/fonts/../fonts/roboto-latin-400-normal.woff2/../../server.js",
    "/fonts/%2e%2e/server.js",
    "/fonts/..%2fserver.js",
    "/fonts/%2e%2e%2fserver.js",
    "/fonts/..\\server.js",
    "/fonts//roboto-latin-400-normal.woff2",
    "/fonts/roboto-latin-400-normal.woff2%00.png",
    "/fonts/roboto-latin-400-normal.woff2?x=../../server.js",
    "/logo-lagraine34.png",
    "/server.js",
    "/package.json",
    "/ticket-pdf.js",
    "/node_modules/luxon/package.json",
    "/.git/config",
    "/STYLE.CSS",
    "/style.css/",
  ];
  for (const path of paths) {
    const res = await rawRequest(app.base, { path });
    const expected = path.includes("?") ? 200 : 404; // the query (?x=) is ignored for the route
    assert.equal(res.status, expected, path);
    if (expected === 404) {
      assert.equal(res.body.toString(), "Page introuvable", path);
      assert.equal(res.headers["cache-control"], "no-store", path);
    }
    assert.ok(!/createServer|"name": "prod"/.test(res.body.toString("latin1")), `${path} : fichier du serveur exposé`);
  }
});

// Intention : seule la méthode GET sert un fichier (POST, PUT, DELETE donnent 404). Sinon on exposerait des routes inutiles.
appTest("fichiers statiques : seule la méthode GET est servie", async (app) => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await app.request("/style.css", { method });
    assert.equal(res.status, 404, method);
  }
});
