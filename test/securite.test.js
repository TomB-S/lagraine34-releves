// === CE QUE VÉRIFIE CE FICHIER ===
// Les protections « de fond » du serveur : les en-têtes HTTP de sécurité envoyés sur CHAQUE réponse, le cache, l'absence de style ou de
// script dans le HTML, et la limite de taille des requêtes (10 ko). Pour le commerçant : un ticket qui ne reste pas dans le cache du
// navigateur, des pages qui ne peuvent pas être détournées. Utilise le harnais (test-support/harness.js) et le faux Cyclos.
// Notions de base (assert, async, statuts HTTP) : voir test/statique.test.js.
// Security headers, cache, body size limit, HTML without style/script.
import assert from "node:assert/strict";
import { appTest, rawRequest, EXPECTED_CSP } from "../test-support/harness.js";
import { entry } from "../test-support/fake-cyclos.js";

const RANGE = { start: "2026-01-10T00:00", end: "2026-01-10T23:59" };
// Adresse du téléchargement PDF, réutilisée dans le parcours de `everyResponse`.
const PDF_PATH = "/releve.pdf";

// Goes through one sample of each kind of server response.
// Returns [{ label, res, body }]; `secure` = the session cookie is Secure.
// Fonction d'aide : provoque UN exemple de chaque sorte de réponse du serveur (pages, redirections, erreurs 400/403/404/405/413/502,
// fichiers statiques, PDF...) et les rend toutes ensemble. Les tests ci-dessous parcourent cette liste pour vérifier qu'AUCUNE réponse
// n'échappe à la règle testée. Sans cela, on oublierait facilement un type de réponse (par exemple les pages d'erreur).
async function everyResponse(app) {
  const out = [];
  const take = async (label, promise) => {
    const res = await promise;
    out.push({ label, res, body: Buffer.from(await res.arrayBuffer()) });
    return res;
  };
  app.cyclos.state.entries = [entry(1), entry(2, { amount: "-1.00" })];

  await take("GET / (connexion)", app.request("/"));
  await take("POST /connexion refusé (Origin)", app.request("/connexion", { method: "POST", form: { login: "a", password: "b" } }));
  await take("POST /connexion 401", app.login({ password: "faux" }));
  await take("POST /connexion 303", app.login());
  const csrf = await app.csrf();
  await take("GET /filtres", app.request("/filtres"));
  await take("POST /releve 400", app.request("/releve", { method: "POST", form: { csrf, start: "x", end: "y" } }));
  await take("POST /releve 403 (CSRF)", app.request("/releve", { method: "POST", form: { start: RANGE.start, end: RANGE.end } }));
  await take("POST /releve 200", app.request("/releve", { method: "POST", form: { csrf, ...RANGE } }));
  await take("POST /releve.pdf 200", app.request(PDF_PATH, { method: "POST", form: { csrf, ...RANGE } }));
  app.cyclos.force("GET /self/accounts", 403);
  await take("POST /releve 403 (Cyclos)", app.request("/releve", { method: "POST", form: { csrf, ...RANGE } }));
  app.cyclos.force("GET /self/accounts", 500);
  await take("POST /releve 502", app.request("/releve", { method: "POST", form: { csrf, ...RANGE } }));
  app.cyclos.state.forced.clear();
  await take("GET /deconnexion 405", app.request("/deconnexion"));
  await take("GET /page-inconnue 404", app.request("/page-inconnue"));
  await take("POST /releve 413", app.request("/releve", { method: "POST", body: "x".repeat(10_001), headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
  for (const path of ["/style.css", "/logo.png", "/fonts/roboto-latin-400-normal.woff2", "/fonts/roboto-latin-700-normal.woff2", "/fonts/voltaire-latin-400-normal.woff2"]) {
    await take(`GET ${path}`, app.request(path));
  }
  const etag = out.find((r) => r.label === "GET /style.css").res.headers.get("etag");
  await take("GET /style.css 304", app.request("/style.css", { headers: { "If-None-Match": etag } }));
  await take("GET /fonts/inconnue.woff2 404", app.request("/fonts/inconnue.woff2"));
  await take("POST /deconnexion 303", app.request("/deconnexion", { method: "POST", form: { csrf } }));
  await take("POST /deconnexion sans session 303", app.request("/deconnexion", { method: "POST", form: {} }));
  return out;
}

// Intention : chaque réponse porte les en-têtes de sécurité. Si l'un manquait, une protection du navigateur serait désactivée :
//  - Content-Security-Policy (CSP) : liste ce que la page a le droit de charger ; ici seulement des fichiers de notre site, aucun script.
//    Même si un pirate parvenait à glisser du code dans une page, le navigateur refuserait de l'exécuter ou de contacter un autre site.
//  - X-Content-Type-Options: nosniff : le navigateur doit croire le type annoncé (il ne « devine » pas qu'un texte est un script).
//  - X-Frame-Options: DENY : nos pages ne peuvent pas être affichées dans un cadre d'un autre site (technique du « clickjacking »).
//  - Referrer-Policy : limite l'adresse d'origine communiquée aux autres sites (la page de connexion en a besoin, voir server.js).
//  - Strict-Transport-Security (HSTS) : impose HTTPS ; absent ici car il n'est activé qu'avec COOKIE_SECURE (tests suivants).
appTest("en-têtes de sécurité sur chaque type de réponse, CSP exacte", async (app) => {
  const responses = await everyResponse(app);
  assert.ok(responses.length >= 22, `${responses.length} réponses`);
  for (const { label, res } of responses) {
    assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP, label);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", label);
    assert.equal(res.headers.get("x-frame-options"), "DENY", label);
    assert.equal(res.headers.get("referrer-policy"), label === "GET / (connexion)" ? "same-origin" : "no-referrer", label);
    assert.equal(res.headers.get("strict-transport-security"), null, `${label} : pas de HSTS sans COOKIE_SECURE`);
  }
  assert.ok(!/unsafe-|https?:|script-src/.test(EXPECTED_CSP));
});

// Intention : les pages (qui contiennent des relevés) ne doivent être gardées ni en cache ni par le bouton « retour » du navigateur :
// `no-store`. Seuls les fichiers statiques (logo, CSS) sont cachés 1 heure. Sinon un relevé resterait lisible sur un poste partagé.
appTest("Cache-Control : no-store partout sauf fichiers statiques (public, 1 h)", async (app) => {
  for (const { label, res } of await everyResponse(app)) {
    const expected = /^GET \/(style\.css|logo\.png|fonts\/\S+\.woff2)( 304)?$/.test(label) && !label.includes("inconnue")
      ? "public, max-age=3600"
      : "no-store";
    assert.equal(res.headers.get("cache-control"), expected, label);
  }
});

// Intention : en production (HTTPS), l'option COOKIE_SECURE ajoute HSTS partout et l'attribut `Secure` au cookie de session
// (le cookie ne voyage alors que sur HTTPS), y compris au moment où il est effacé.
appTest("COOKIE_SECURE actif : HSTS sur chaque réponse, Secure sur le cookie posé et sur le cookie effacé", { cookieSecure: true }, async (app) => {
  const responses = await everyResponse(app);
  for (const { label, res } of responses) {
    assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000", label);
    assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP, label);
  }
  const cookies = responses.map((r) => r.res.headers.get("set-cookie")).filter(Boolean);
  assert.ok(cookies.length >= 2);
  for (const cookie of cookies) {
    assert.match(cookie, /^session=[^;]*; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+; Secure$/);
  }
  assert.ok(cookies.some((c) => /Max-Age=28800/.test(c)), "cookie de connexion");
  assert.ok(cookies.some((c) => /session=; .*Max-Age=0/.test(c)), "cookie effacé");
});

// Intention : sans l'option (développement en HTTP local), le cookie n'est pas `Secure`, sinon la connexion ne marcherait pas du tout.
appTest("COOKIE_SECURE inactif : cookie sans Secure", async (app) => {
  const res = await app.login();
  assert.ok(!/Secure/i.test(res.headers.get("set-cookie")));
});

// Intention : aucune page n'a de style ou de script « en ligne » (attribut style=, balises <style>/<script>, onclick=...) ni de ressource
// externe. C'est ce qui permet une CSP stricte : tout le style est dans style.css, servi par nous.
appTest("aucune réponse HTML ne contient style=, <style ni <script", async (app) => {
  const htmlResponses = (await everyResponse(app)).filter(({ res }) => /^text\/html/.test(res.headers.get("content-type") ?? ""));
  assert.ok(htmlResponses.length >= 8, `${htmlResponses.length} pages HTML`);
  for (const { label, body } of htmlResponses) {
    const html = body.toString("utf-8");
    assert.ok(!/\sstyle\s*=/i.test(html), `${label} : style=`);
    assert.ok(!/<style/i.test(html), `${label} : <style`);
    assert.ok(!/<script/i.test(html), `${label} : <script`);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `${label} : gestionnaire d'événement`);
    assert.ok(!/(src|href|action)="https?:/i.test(html), `${label} : ressource externe`);
  }
});

// Intention : chaque réponse annonce son type, et le texte est déclaré en UTF-8 : sinon les accents des pages françaises s'afficheraient mal.
appTest("pas de page sans type de contenu précis (texte et HTML en UTF-8)", async (app) => {
  for (const { label, res } of await everyResponse(app)) {
    const type = res.headers.get("content-type");
    if (res.status === 303 || res.status === 304) continue;
    assert.ok(type, label);
    if (/^text\//.test(type)) assert.match(type, /charset=utf-8$/, label);
  }
});

// ------------------------------------------------------------ body size

// Intention : une requête dont le corps dépasse 10 ko est refusée (413 « trop volumineux ») sur toutes les routes POST, et rien n'est transmis à
// Cyclos. Sans cette limite, un envoi énorme pourrait saturer la mémoire du serveur. `Connection: close` ferme la connexion après le refus.
appTest("corps de plus de 10 ko : 413 sur chaque route qui lit un corps, rien n'est envoyé à Cyclos", async (app) => {
  const csrf = await app.loggedIn();
  const calls = app.cyclos.state.requests.length;
  const big = `csrf=${csrf}&start=${"x".repeat(10_001)}`;
  for (const path of ["/releve", "/releve.pdf", "/deconnexion"]) {
    const res = await app.request(path, { method: "POST", body: big, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    assert.equal(res.status, 413, path);
    assert.equal(await res.text(), "Requête trop volumineuse");
    assert.equal(res.headers.get("connection"), "close");
  }
  const login = await app.request("/connexion", {
    method: "POST",
    body: `login=a&password=${"x".repeat(10_001)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: app.base },
  });
  assert.equal(login.status, 413);
  assert.equal(app.cyclos.state.requests.length, calls, "aucun appel à Cyclos");
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 1, "seule la connexion initiale");
});

// Cas limite : 10 000 octets sont acceptés (le refus vient d'une autre cause : dates absentes, 400), 10 001 sont refusés (413).
// Vérifie que la limite est exactement où on l'annonce.
appTest("corps de 10 000 octets exactement accepté (refusé pour une autre raison que la taille)", async (app) => {
  const csrf = await app.loggedIn();
  const padding = "x".repeat(10_000 - `csrf=${csrf}&p=`.length);
  const res = await app.request("/releve", { method: "POST", body: `csrf=${csrf}&p=${padding}`, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(`csrf=${csrf}&p=${padding}`.length, 10_000);
  assert.equal(res.status, 400); // valid token, but dates missing
  const over = await app.request("/releve", { method: "POST", body: `csrf=${csrf}&p=${padding}x`, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(over.status, 413);
});

// Intention : un corps peut arriver « en morceaux » (chunked), sans taille annoncée à l'avance. La limite doit aussi s'appliquer en
// comptant au fur et à mesure. `rawRequest` (harnais) permet d'envoyer ce genre de requête, ce que fetch ne sait pas faire facilement.
appTest("corps en morceaux (chunked) sans Content-Length qui dépasse 10 ko : 413", async (app) => {
  const csrf = await app.loggedIn();
  const headers = { Cookie: app.cookie, "Content-Type": "application/x-www-form-urlencoded", "Transfer-Encoding": "chunked" };
  const res = await rawRequest(app.base, {
    method: "POST",
    path: "/releve",
    headers,
    chunks: [`csrf=${csrf}&a=`, "x".repeat(6000), "y".repeat(6000)],
  });
  assert.equal(res.status, 413);
  assert.equal(res.headers["content-length"], undefined);
  assert.equal(res.body.toString(), "Requête trop volumineuse");
  assert.equal(res.headers.connection, "close");
  assert.equal(app.cyclos.calls("GET", "/self/accounts").length, 0);

  // A chunked body that stays under the limit is read normally.
  const small = await rawRequest(app.base, {
    method: "POST",
    path: "/releve",
    headers,
    chunks: [`csrf=${csrf}&start=2026`, "-01-10T00:00&end=2026-01-10T23:59"],
  });
  assert.equal(small.status, 200);
});

// Intention : même limite sur la connexion en morceaux, et Cyclos n'est jamais contacté.
appTest("corps chunked sur /connexion au-delà de la limite : 413", async (app) => {
  const res = await rawRequest(app.base, {
    method: "POST",
    path: "/connexion",
    headers: { Origin: app.base, "Content-Type": "application/x-www-form-urlencoded", "Transfer-Encoding": "chunked" },
    chunks: ["login=a&password=", "z".repeat(5000), "z".repeat(5000), "z".repeat(5000)],
  });
  assert.equal(res.status, 413);
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 0);
});

// Intention : après plusieurs requêtes refusées en 413, le serveur fonctionne toujours (ces requêtes ne le bloquent pas ni ne le font planter).
appTest("le serveur reste utilisable après des 413", async (app) => {
  for (let i = 0; i < 3; i += 1) {
    await rawRequest(app.base, {
      method: "POST",
      path: "/connexion",
      headers: { Origin: app.base, "Transfer-Encoding": "chunked" },
      chunks: ["x".repeat(6000), "x".repeat(6000)],
    });
  }
  assert.equal((await app.login()).status, 303);
});
