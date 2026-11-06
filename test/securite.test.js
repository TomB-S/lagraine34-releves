// === WHAT THIS FILE CHECKS ===
// The "background" protections of the server: the security HTTP headers sent on EVERY response, caching, the absence of style or
// script in the HTML, and the size limit of requests (10 kB). For the merchant: a ticket that does not stay in the browser's cache,
// pages that cannot be hijacked. Uses the harness (test-support/harness.js) and the fake Cyclos.
// Basic notions (assert, async, HTTP statuses): see test/statique.test.js.
// Security headers, cache, body size limit, HTML without style/script.
import assert from "node:assert/strict";
import { appTest, rawRequest, EXPECTED_CSP } from "../test-support/harness.js";
import { entry } from "../test-support/fake-cyclos.js";

const RANGE = { start: "2026-01-10T00:00", end: "2026-01-10T23:59" };
// Address of the PDF download, reused in the walk-through of `everyResponse`.
const PDF_PATH = "/releve.pdf";

// Goes through one sample of each kind of server response.
// Returns [{ label, res, body }]; `secure` = the session cookie is Secure.
// Helper: triggers ONE example of each kind of server response (pages, redirections, errors 400/403/404/405/413/502,
// static files, PDF...) and returns them all together. The tests below go through this list to check that NO response
// escapes the rule being tested. Without it, a type of response (for example the error pages) would easily be forgotten.
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

// Intention: every response carries the security headers. If one were missing, a browser protection would be switched off:
//  - Content-Security-Policy (CSP): lists what the page may load; here only files from our site, no script.
//    Even if an attacker managed to slip code into a page, the browser would refuse to run it or to contact another site.
//  - X-Content-Type-Options: nosniff: the browser must believe the announced type (it does not "guess" that a text is a script).
//  - X-Frame-Options: DENY: our pages cannot be displayed in a frame of another site (the "clickjacking" technique).
//  - Referrer-Policy: limits the origin address passed on to other sites (the login page needs it, see server.js).
//  - Strict-Transport-Security (HSTS): forces HTTPS; absent here because it is only enabled with COOKIE_SECURE (next tests).
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

// Intention: pages (which contain statements) must be kept neither in cache nor by the browser's "back" button:
// `no-store`. Only static files (logo, CSS) are cached for 1 hour. Otherwise a statement would stay readable on a shared computer.
appTest("Cache-Control : no-store partout sauf fichiers statiques (public, 1 h)", async (app) => {
  for (const { label, res } of await everyResponse(app)) {
    const expected = /^GET \/(style\.css|logo\.png|fonts\/\S+\.woff2)( 304)?$/.test(label) && !label.includes("inconnue")
      ? "public, max-age=3600"
      : "no-store";
    assert.equal(res.headers.get("cache-control"), expected, label);
  }
});

// Intention: in production (HTTPS), the COOKIE_SECURE option adds HSTS everywhere and the `Secure` attribute to the session cookie
// (the cookie then only travels over HTTPS), including when it is cleared.
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

// Intention: without the option (local HTTP development), the cookie is not `Secure`, otherwise login would not work at all.
appTest("COOKIE_SECURE inactif : cookie sans Secure", async (app) => {
  const res = await app.login();
  assert.ok(!/Secure/i.test(res.headers.get("set-cookie")));
});

// Intention: no page has "inline" style or script (style= attribute, <style>/<script> tags, onclick=...) or external
// resource. This is what allows a strict CSP: all the style is in style.css, served by us.
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

// Intention: every response announces its type, and text is declared as UTF-8: otherwise the accents of the French pages would display badly.
appTest("pas de page sans type de contenu précis (texte et HTML en UTF-8)", async (app) => {
  for (const { label, res } of await everyResponse(app)) {
    const type = res.headers.get("content-type");
    if (res.status === 303 || res.status === 304) continue;
    assert.ok(type, label);
    if (/^text\//.test(type)) assert.match(type, /charset=utf-8$/, label);
  }
});

// ------------------------------------------------------------ body size

// Intention: a request whose body exceeds 10 kB is refused (413 "too large") on all POST routes, and nothing is passed on to
// Cyclos. Without this limit, a huge upload could saturate the server's memory. `Connection: close` closes the connection after the refusal.
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

// Edge case: 10,000 bytes are accepted (the refusal comes from another cause: missing dates, 400), 10,001 are refused (413).
// Checks that the limit is exactly where we announce it.
appTest("corps de 10 000 octets exactement accepté (refusé pour une autre raison que la taille)", async (app) => {
  const csrf = await app.loggedIn();
  const padding = "x".repeat(10_000 - `csrf=${csrf}&p=`.length);
  const res = await app.request("/releve", { method: "POST", body: `csrf=${csrf}&p=${padding}`, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(`csrf=${csrf}&p=${padding}`.length, 10_000);
  assert.equal(res.status, 400); // valid token, but dates missing
  const over = await app.request("/releve", { method: "POST", body: `csrf=${csrf}&p=${padding}x`, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(over.status, 413);
});

// Intention: a body can arrive "in chunks" (chunked), with no size announced in advance. The limit must also apply by
// counting as it goes. `rawRequest` (harness) lets us send this kind of request, which fetch cannot easily do.
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

// Intention: same limit on the chunked login, and Cyclos is never contacted.
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

// Intention: after several requests refused with 413, the server still works (these requests neither block nor crash it).
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
