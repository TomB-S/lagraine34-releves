// === WHAT THIS FILE CHECKS ===
// Everything that touches the merchant's identity: login, blocking after too many failures, session duration,
// logout, CSRF protection, Cyclos refusals (403) and outages. This is the core of security: a password
// that leaks or a session that never closes would be serious for the merchant. Uses the harness
// (test-support/harness.js: real server + fake Cyclos, never the real Cyclos). Basic notions (assert, async,
// HTTP statuses): see test/statique.test.js.
// Login, attempt throttling, sessions, logout, CSRF, 403 refusals.
// Real server + local fake Cyclos (see test-support/), never the real Cyclos.
// `mock` (from node:test) is used here to FAKE THE CLOCK: we can "advance time" by 20 minutes in one millisecond
// to test session expiry without waiting.
import { mock } from "node:test";
import assert from "node:assert/strict";
import { appTest, until, USER } from "../test-support/harness.js";
import { entry } from "../test-support/fake-cyclos.js";

const RANGE = { start: "2026-01-10T00:00", end: "2026-01-10T23:59" };
// One minute in milliseconds (JavaScript durations are in ms).
const MINUTE = 60_000;

// ------------------------------------------------------------ login

// Intention: after a successful login we are redirected (303) to /filtres with a session cookie, and the password
// is sent to Cyclos only ONCE. If this broke: password reused or exposed, or the Cyclos token visible in the page.
//
// Session cookie: a small piece of text that the server asks the browser to send back with every request, to recognise it.
// Its options: HttpOnly (unreadable by JavaScript, so it cannot be stolen by an XSS flaw), SameSite=Lax (not sent from
// another site), Max-Age=28800 (8 hours). The cookie only holds a random identifier, WITH NO link to the Cyclos token.
// Basic authentication: the `Authorization: Basic xxx` header holds "login:password" in base64 (a mere encoding).
// After login, the tool only uses the Cyclos token (`Session-Token` header).
appTest("connexion réussie : 303 vers /filtres, cookie de session, jeton Cyclos jamais exposé", async (app) => {
  const res = await app.login();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/filtres");
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /^session=[0-9a-f-]{36}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=28800$/);

  // A single call to Cyclos, with the password in Basic, only once.
  const calls = app.cyclos.calls("POST", "/auth/session");
  assert.equal(calls.length, 1);
  assert.equal(
    Buffer.from(calls[0].headers.authorization.replace("Basic ", ""), "base64").toString(),
    `${USER.login}:${USER.password}`,
  );

  const page = await app.request("/filtres");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Choisir la plage horaire/);
  assert.ok(!html.includes("jeton-1"), "le jeton Cyclos ne doit pas être dans la page");
  assert.ok(!cookie.includes("jeton-1"));
  // Later calls to Cyclos use the token, never the password.
  await app.request("/releve", { method: "POST", form: { csrf: await app.csrf(), ...RANGE } });
  for (const call of app.cyclos.state.requests.filter((r) => r.path !== "/auth/session" || r.method !== "POST")) {
    assert.equal(call.headers["session-token"], "jeton-1");
    assert.equal(call.headers.authorization, undefined);
  }
});

// Intention: a wrong password gives 401 (not authenticated), no cookie, and the typed text is not sent back in the page.
appTest("connexion refusée : 401, pas de cookie, page « Connexion échouée »", async (app) => {
  const res = await app.login({ password: "mauvais" });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
  const html = await res.text();
  assert.match(html, /Connexion échouée/);
  assert.match(html, /Identifiant ou mot de passe incorrect/);
  assert.ok(!html.includes("mauvais"));
  assert.equal((await app.request("/filtres")).status, 303); // still no session
});

// Intention: an incomplete form is refused without even bothering Cyclos (no useless call and no attempt counted).
appTest("connexion : champs vides -> 401 sans appeler Cyclos", async (app) => {
  for (const form of [{}, { login: "a" }, { password: "b" }, { login: "", password: "" }]) {
    const res = await app.request("/connexion", { method: "POST", form, headers: { Origin: app.base } });
    assert.equal(res.status, 401);
  }
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 0);
});

// Intention: a login or password with accents, ":" or Japanese characters is correctly sent to Cyclos (in UTF-8).
// Otherwise these merchants could never log in. We decode the Basic header that was sent to check.
appTest("connexion : identifiants avec accents et caractères non latins transmis en UTF-8", async (app) => {
  const res = await app.login({ login: "Élodie", password: "pässwörd:日本" });
  assert.equal(res.status, 401); // unknown to the fake Cyclos, but the request was indeed made
  const [call] = app.cyclos.calls("POST", "/auth/session");
  assert.equal(
    Buffer.from(call.headers.authorization.replace("Basic ", ""), "base64").toString("utf-8"),
    "Élodie:pässwörd:日本",
  );
});

// Intention: after 5 failures from the same address, further attempts are blocked (429 "too many requests"), even with the right
// password, and no longer reach Cyclos. This prevents guessing a password by repeated tries. `Retry-After` says when to try again.
appTest("429 après 5 échecs depuis la même adresse, même avec le bon mot de passe", async (app) => {
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await app.login({ password: "faux" })).status, 401, `essai ${i + 1}`);
  }
  const blocked = await app.login();
  assert.equal(blocked.status, 429);
  const retryAfter = Number(blocked.headers.get("retry-after"));
  assert.ok(retryAfter > 0 && retryAfter <= 15 * 60, `Retry-After = ${retryAfter}`);
  assert.match(await blocked.text(), /Trop d'échecs de connexion.*Réessayez dans 15 minutes/);
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 5, "le 6e essai n'atteint pas Cyclos");
  assert.equal(blocked.headers.get("set-cookie"), null);
});

// Intention: the block is not permanent: it lifts after 15 minutes. We do not wait: `sweep` (the server's periodic
// cleanup) is called with a future date.
appTest("429 : le blocage se lève après 15 minutes (nettoyage périodique)", async (app) => {
  for (let i = 0; i < 5; i += 1) await app.login({ password: "faux" });
  assert.equal((await app.login()).status, 429);
  app.server.sweep(Date.now() + 14 * MINUTE);
  assert.equal((await app.login()).status, 429, "pas encore 15 minutes");
  app.server.sweep(Date.now() + 15 * MINUTE + 1000);
  assert.equal((await app.login()).status, 303);
});

// Intention: only genuinely wrong passwords count. A rights refusal (403) or a Cyclos outage (500) must not
// block an honest merchant.
appTest("429 : seuls les identifiants refusés comptent (403 et pannes de Cyclos non)", async (app) => {
  app.cyclos.force("POST /auth/session", 403);
  for (let i = 0; i < 7; i += 1) assert.equal((await app.login()).status, 403);
  app.cyclos.force("POST /auth/session", 500);
  for (let i = 0; i < 7; i += 1) assert.equal((await app.login()).status, 502);
  app.cyclos.state.forced.clear();
  assert.equal((await app.login()).status, 303);
});

// Intention (security): the login form is only accepted if it comes from a page of OUR site. The `Origin` header (or, failing that,
// `Referer`) says where the request comes from; a malicious site cannot forge it from a browser. This is a CSRF-type protection
// for the login (see the "CSRF" tests further down). Refused cases: other site, "null", missing header.
appTest("Origin étranger, absent ou « null » : connexion refusée avant tout appel à Cyclos", async (app) => {
  const attempt = (headers) => app.request("/connexion", { method: "POST", form: { login: USER.login, password: USER.password }, headers });
  for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }, {}, { Referer: "https://evil.example/page" }, { Origin: "http://127.0.0.1:1" }]) {
    const res = await attempt(headers);
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.match(await res.text(), /Origine de la requête non autorisée/);
    assert.equal(res.headers.get("set-cookie"), null);
  }
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 0);
  // Same origin, through Origin or, failing that, Referer.
  assert.equal((await attempt({ Origin: app.base })).status, 303);
  app.cookie = "";
  assert.equal((await attempt({ Referer: `${app.base}/` })).status, 303);
});

// Intention (security): in very varied situations (refusal, outage, cut connection, 429, success), the password must
// appear NEITHER in the responses NOR in the server log. It is noted in `seen`/`app.logs` and we look for it everywhere.
appTest("le mot de passe n'apparaît ni dans les réponses ni dans les logs", async (app) => {
  const secret = "S3cret-à-ne-jamais-voir";
  const seen = [];
  const note = async (res) => {
    seen.push(JSON.stringify([...res.headers]), await res.text());
  };

  await note(await app.login({ password: secret })); // refused
  await note(await app.request("/connexion", { method: "POST", form: { login: USER.login, password: secret } })); // missing Origin
  app.cyclos.force("POST /auth/session", 500);
  await note(await app.login({ password: secret })); // Cyclos down -> error logged
  app.cyclos.force("POST /auth/session", "drop");
  await note(await app.login({ password: secret })); // connection cut -> error logged
  app.cyclos.state.forced.clear();
  app.cyclos.force("POST /auth/session", 403);
  await note(await app.login({ password: secret }));
  app.cyclos.state.forced.clear();
  for (let i = 0; i < 5; i += 1) await app.login({ password: secret });
  await note(await app.login({ password: secret })); // 429

  // Successful login: all the following pages too.
  await note(await app.login());
  await note(await app.request("/filtres"));
  await note(await app.request("/releve", { method: "POST", form: { csrf: await app.csrf(), ...RANGE } }));

  assert.ok(app.logs.length > 0, "les erreurs de Cyclos doivent être journalisées");
  for (const text of [...seen, ...app.logs]) {
    assert.ok(!text.includes(secret), "mot de passe en clair");
    assert.ok(!text.includes(USER.password), "mot de passe en clair");
    const basic = Buffer.from(`${USER.login}:${USER.password}`).toString("base64");
    assert.ok(!text.includes(basic), "identifiants en Basic");
  }
});

// Intention: if Cyclos does not answer correctly (500), the tool answers 502 ("bad gateway") without creating a session.
appTest("Cyclos en panne à la connexion : 502, pas de session", async (app) => {
  app.cyclos.force("POST /auth/session", 500);
  const res = await app.login();
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "Impossible de joindre Cyclos");
  assert.equal((await app.request("/filtres")).status, 303);
});

// ------------------------------------------------------------ sessions

// Fakes the clock (`Date`): from here on, `mock.timers.tick(ms)` makes time advance instantly.
function mockClock() {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
}

// Intention: a session ends after 20 minutes WITHOUT ACTIVITY (each page viewed extends it), and the token is also closed
// at Cyclos (DELETE). Otherwise a session forgotten on a shared computer would stay open.
appTest("session : expiration après 20 minutes d'inactivité, jeton Cyclos fermé", async (app) => {
  mockClock();
  await app.loggedIn();
  mock.timers.tick(19 * MINUTE);
  assert.equal((await app.request("/filtres")).status, 200); // activity extends the session
  mock.timers.tick(19 * MINUTE);
  assert.equal((await app.request("/filtres")).status, 200);
  mock.timers.tick(20 * MINUTE + 1);
  const res = await app.request("/filtres");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  await until(() => app.cyclos.state.deleted.includes("jeton-1"), "DELETE /auth/session");
  // The session no longer exists, even with the old cookie.
  assert.equal((await app.request("/filtres")).status, 303);
});

// Intention: even without ever stopping, a session lasts no more than 8 hours. Otherwise a stolen cookie would work forever.
appTest("session : durée absolue de 8 heures même avec une activité continue", async (app) => {
  mockClock();
  await app.loggedIn();
  for (let elapsed = 10; elapsed <= 470; elapsed += 10) {
    mock.timers.tick(10 * MINUTE);
    assert.equal((await app.request("/filtres")).status, 200, `après ${elapsed} min`);
  }
  mock.timers.tick(15 * MINUTE); // 8 h 05 in total, 15 min since the last activity
  const res = await app.request("/filtres");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  await until(() => app.cyclos.state.deleted.length === 1, "DELETE /auth/session");
});

// Intention: the durations come from the configuration (here 1 s and 5 s via the test options), not from hard-coded values.
appTest("session : durées configurables (idleMs, maxMs)", { idleMs: 1000, maxMs: 5000 }, async (app) => {
  mockClock();
  await app.loggedIn();
  mock.timers.tick(900);
  assert.equal((await app.request("/filtres")).status, 200);
  mock.timers.tick(1001);
  assert.equal((await app.request("/filtres")).status, 303);
});

// Intention: the server cleans up expired sessions by itself (without waiting for a new request) and closes their token at Cyclos.
appTest("nettoyage périodique : sessions expirées retirées et jeton fermé sans nouvelle requête", async (app) => {
  mockClock();
  await app.loggedIn();
  app.server.sweep(); // nothing expired: the session stays
  assert.equal(app.cyclos.state.deleted.length, 0);
  mock.timers.tick(21 * MINUTE);
  app.server.sweep();
  await until(() => app.cyclos.state.deleted.includes("jeton-1"), "DELETE /auth/session par le nettoyage");
});

// Intention: this cleanup triggers automatically at a regular interval (here 30 ms), without the test calling it.
appTest("nettoyage périodique : lancé tout seul à l'intervalle configuré", { sweepIntervalMs: 30 }, async (app) => {
  await app.loggedIn();
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 30 * MINUTE });
  await until(() => app.cyclos.state.deleted.includes("jeton-1"), "nettoyage automatique");
});

// Intention: logging out deletes the local session, closes the token at Cyclos and clears the cookie (Max-Age=0).
// Afterwards the old cookie gives access to nothing, even if it had been stolen.
appTest("déconnexion : session supprimée, DELETE envoyé à Cyclos, cookie effacé", async (app) => {
  const csrf = await app.loggedIn();
  const oldCookie = app.cookie;
  const res = await app.request("/deconnexion", { method: "POST", form: { csrf } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  assert.match(res.headers.get("set-cookie"), /^session=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0$/);
  assert.deepEqual(app.cyclos.state.deleted, ["jeton-1"]);
  assert.equal(app.cyclos.calls("DELETE", "/auth/session")[0].headers["session-token"], "jeton-1");

  // The old cookie no longer gives anything.
  app.cookie = oldCookie;
  assert.equal((await app.request("/filtres")).status, 303);
  assert.equal((await app.request("/releve", { method: "POST", form: { csrf, ...RANGE } })).status, 303);
});

// Intention: even if Cyclos refuses or does not answer to the closing of the token, the merchant is still logged out of OUR tool.
appTest("déconnexion : réussit localement même si Cyclos refuse ou ne répond pas", async (app) => {
  for (const status of [401, 500, "drop"]) {
    const csrf = await app.loggedIn();
    app.cyclos.force("DELETE /auth/session", status);
    const res = await app.request("/deconnexion", { method: "POST", form: { csrf } });
    assert.equal(res.status, 303, String(status));
    assert.equal((await app.request("/filtres")).status, 303, String(status));
    app.cyclos.state.forced.clear();
  }
});

// Intention: clicking "log out" when the session no longer exists (expired) causes no error: back to the home page.
appTest("déconnexion sans session : redirection vers / et cookie effacé", async (app) => {
  const res = await app.request("/deconnexion", { method: "POST", form: {} });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
});

// Intention: if Cyclos answers 401 (the token expired on their side), the tool closes the local session and sends back to the login page,
// instead of showing an incomprehensible error. `expireTokens()` of the fake Cyclos simulates this expiry.
appTest("jeton Cyclos expiré (401 loggedOut) : session locale supprimée et retour à /", async (app) => {
  for (const path of ["/releve", "/releve.pdf"]) {
    // Each attempt starts from a valid local session whose token is refused by Cyclos.
    const csrf = await app.loggedIn();
    app.cyclos.expireTokens();
    const res = await app.request(path, { method: "POST", form: { csrf, ...RANGE } });
    assert.equal(res.status, 303, path);
    assert.equal(res.headers.get("location"), "/");
    assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await app.request("/filtres")).status, 303, "session locale supprimée");
  }
});

// Intention: same reaction (back to /) if the 401 arrives in the middle of the reading (here when reading accounts), not only on the first call.
appTest("401 de Cyclos au milieu de la lecture (comptes) : même redirection", async (app) => {
  const csrf = await app.loggedIn();
  app.cyclos.force("GET /self/accounts", 401);
  const res = await app.request("/releve", { method: "POST", form: { csrf, ...RANGE } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  assert.equal((await app.request("/filtres")).status, 303);
});

// ------------------------------------------------------------ CSRF

// CSRF (Cross-Site Request Forgery): a malicious site could make the logged-in merchant's browser send a form
// to our tool (the cookie goes along by itself). Defence: each session has a secret random token, put in the forms of
// our pages; a POST action without this token is refused (403). A malicious site cannot know this token.
for (const path of ["/releve", "/releve.pdf", "/deconnexion"]) {
  // Intention: for each POST route, a missing, empty, wrong, truncated or lengthened token is refused (403), without calling Cyclos and
  // without closing the session. The test is repeated for /releve, /releve.pdf and /deconnexion (the `for` loop creates 3 tests).
  appTest(`CSRF ${path} : refusé sans jeton, avec faux jeton, avec jeton vide ou tronqué ; session conservée`, async (app) => {
    const csrf = await app.loggedIn();
    const fake = "0".repeat(csrf.length);
    for (const form of [RANGE, { csrf: "", ...RANGE }, { csrf: fake, ...RANGE }, { csrf: csrf.slice(1), ...RANGE }, { csrf: `${csrf}0`, ...RANGE }]) {
      const res = await app.request(path, { method: "POST", form });
      assert.equal(res.status, 403, JSON.stringify(form.csrf));
      const html = await res.text();
      assert.match(html, /Requête refusée/);
      assert.match(html, /Jeton de sécurité absent ou invalide/);
      assert.ok(!html.includes(fake));
    }
    assert.equal(app.cyclos.calls("GET", "/self/accounts").length, 0, "aucune lecture Cyclos");
    assert.equal(app.cyclos.calls("DELETE", "/auth/session").length, 0, "aucune fermeture Cyclos");
    assert.equal((await app.request("/filtres")).status, 200, "la session reste ouverte");
  });
}

// Intention: the token of session A is not valid in session B (each token belongs to its own session).
appTest("CSRF : le jeton d'une autre session n'est pas accepté", async (app) => {
  const csrfA = await app.loggedIn();
  app.cookie = "";
  const csrfB = await app.loggedIn();
  assert.notEqual(csrfA, csrfB);
  for (const path of ["/releve", "/releve.pdf", "/deconnexion"]) {
    assert.equal((await app.request(path, { method: "POST", form: { csrf: csrfA, ...RANGE } })).status, 403, path);
  }
  assert.equal((await app.request("/deconnexion", { method: "POST", form: { csrf: csrfB } })).status, 303);
});

// Intention: only the token in the form BODY counts; in the address or a header, it is ignored.
appTest("CSRF : jeton passé en paramètre d'URL ou en en-tête ignoré", async (app) => {
  const csrf = await app.loggedIn();
  const res = await app.request(`/releve?csrf=${csrf}`, { method: "POST", form: RANGE, headers: { "X-CSRF-Token": csrf } });
  assert.equal(res.status, 403);
});

// Intention: without a session, these pages send back to the login (303) and Cyclos is never queried.
appTest("sans session : /releve, /releve.pdf, /filtres redirigent vers / (aucun appel à Cyclos)", async (app) => {
  for (const [method, path] of [["GET", "/filtres"], ["POST", "/releve"], ["POST", "/releve.pdf"]]) {
    const res = await app.request(path, { method, form: method === "POST" ? RANGE : undefined });
    assert.equal(res.status, 303, path);
    assert.equal(res.headers.get("location"), "/");
  }
  assert.equal(app.cyclos.state.requests.length, 0);
});

// Intention: an invented or malformed "session" cookie is treated as an absence of session, never as an error or an access.
appTest("cookie de session inconnu ou falsifié : traité comme absent", async (app) => {
  for (const cookie of ["session=abc", "session=", "session=00000000-0000-0000-0000-000000000000", "autre=1", "session"]) {
    app.cookie = cookie;
    assert.equal((await app.request("/filtres")).status, 303, cookie);
  }
});

// Intention: logout is only possible by POST (with a CSRF token): a simple link or a booby-trapped image must not be able to
// log someone out. With GET: 405 (method not allowed) and the session stays open.
appTest("GET /deconnexion : 405 avec Allow: POST, session conservée", async (app) => {
  await app.loggedIn();
  const res = await app.request("/deconnexion");
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
  assert.equal((await app.request("/filtres")).status, 200);
  assert.equal(app.cyclos.calls("DELETE", "/auth/session").length, 0);
});

// ------------------------------------------------------------ Cyclos 403

// 403 (forbidden): Cyclos recognises the user but refuses this action. This is not a login error: the session is kept.
for (const path of ["/releve", "/releve.pdf"]) {
  // Intention: a 403 refusal from Cyclos on the totals gives a clear "Accès refusé" page, WITHOUT closing the session, and the
  // merchant can try again afterwards. (The 403 case on the list of accounts is in test/erreurs.test.js.)
  appTest(`403 de Cyclos sur ${path} : page « Accès refusé », session conservée`, async (app) => {
    const csrf = await app.loggedIn();
    app.cyclos.force("GET /self/accounts/membre", 403);
    const res = await app.request(path, { method: "POST", form: { csrf, ...RANGE } });
    assert.equal(res.status, 403);
    assert.match(res.headers.get("content-type"), /^text\/html/);
    const html = await res.text();
    assert.match(html, /<title>Accès refusé<\/title>/);
    assert.match(html, /n'a pas l'autorisation d'utiliser cet outil/);
    assert.match(html, /<a href="\/filtres">Retour<\/a>/);
    assert.match(html, /action="\/deconnexion"/);
    assert.equal(res.headers.get("set-cookie"), null, "le cookie n'est pas effacé");
    assert.equal(app.cyclos.calls("DELETE", "/auth/session").length, 0);
    app.cyclos.state.forced.clear();
    assert.equal((await app.request("/filtres")).status, 200, "session toujours valide");
    const again = await app.request(path, { method: "POST", form: { csrf, ...RANGE } });
    assert.equal(again.status, 200, "et utilisable ensuite");
  });
}

// Intention: a 403 right at login shows "Accès refusé" but with no session or cookie (nothing to log out of).
appTest("403 de Cyclos à la connexion : « Accès refusé » sans session ni cookie", async (app) => {
  app.cyclos.force("POST /auth/session", 403);
  const res = await app.login();
  assert.equal(res.status, 403);
  const html = await res.text();
  assert.match(html, /Accès refusé/);
  assert.match(html, /<a href="\/">Retour<\/a>/);
  assert.ok(!html.includes('action="/deconnexion"'));
  assert.equal(res.headers.get("set-cookie"), null);
});

// Intention: if Cyclos goes down in the middle of a statement (500), the merchant only sees "Impossible de joindre Cyclos" (no technical
// detail), the session is kept, and the outage is noted in the server log.
appTest("pannes de Cyclos pendant un relevé : 502 sans fuite de détails, session conservée", async (app) => {
  const csrf = await app.loggedIn();
  for (const key of ["GET /self/accounts", "GET /self/accounts/membre", "GET /self/accounts/membre/history"]) {
    app.cyclos.force(key, 500);
    app.cyclos.state.entries = [entry(1)];
    const res = await app.request("/releve", { method: "POST", form: { csrf, ...RANGE } });
    assert.equal(res.status, 502, key);
    assert.equal(await res.text(), "Impossible de joindre Cyclos");
    app.cyclos.state.forced.clear();
  }
  assert.equal((await app.request("/filtres")).status, 200);
  assert.ok(app.logs.some((line) => line.includes("500 on")), "l'erreur est journalisée");
});
