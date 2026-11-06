// === WHAT THIS FILE CHECKS ===
// What the merchant sees when something goes wrong (account not allowed, Cyclos down, internal bug), and what the server writes to
// its LOG so that a diagnosis is possible. Two requirements: clear messages without technical detail, and a log that is useful but
// never contains a password, a token or an amount. Uses the harness and the fake Cyclos (`force` simulates outages).
// Basic notions (assert, async, HTTP statuses): see test/statique.test.js.
// Clear error messages and server log (diagnosis without sensitive data).
import assert from "node:assert/strict";
import { appTest, USER } from "../test-support/harness.js";
import { entry } from "../test-support/fake-cyclos.js";

const RANGE = { start: "2026-01-10T00:00", end: "2026-01-10T23:59" };
// The exact message displayed when Cyclos refuses access to the accounts (written out in full to detect any unintended change).
const NO_ACCOUNT = "Cyclos refuse l'accès aux comptes de cet utilisateur. Soit il n'a pas de compte de monnaie, soit l'accès par l'API ne lui est pas autorisé. Contactez l'association.";

// Shortcut: sends the statement request (POST) on the wanted route with the CSRF token (see test/connexion.test.js).
const post = (app, path, csrf) => app.request(path, { method: "POST", form: { csrf, ...RANGE } });

// Each test in this loop is played twice: for the page and for the PDF.
for (const path of ["/releve", "/releve.pdf"]) {
  // Intention: if Cyclos answers 403 (forbidden) to the list of accounts (user with no money account, or API access not allowed), a dedicated
  // message "Accès aux comptes refusé" is shown, following the charter (icon + "Erreur :", no inline style), the session stays open and
  // usable afterwards. Before, the user saw an incomprehensible 500 error.
  appTest(`403 sur GET /self/accounts (${path}) : message dédié, charte, session conservée`, async (app) => {
    const csrf = await app.loggedIn();
    app.cyclos.force("GET /self/accounts", 403);
    const res = await post(app, path, csrf);
    assert.equal(res.status, 403);
    assert.match(res.headers.get("content-type"), /^text\/html/);
    const html = await res.text();
    assert.ok(html.includes(NO_ACCOUNT));
    // Charter: icon, "Erreur :" label, role="alert", no inline style or script.
    assert.match(html, /<p class="erreur" role="alert"><span class="icone" aria-hidden="true">⚠<\/span> <strong>Erreur :<\/strong> Cyclos refuse/);
    assert.match(html, /<title>Accès aux comptes refusé<\/title>/);
    assert.match(html, /<h1>Accès aux comptes refusé<\/h1>/);
    assert.ok(!html.includes("Ce compte n'a pas de compte de monnaie"));
    assert.ok(!/style=|<style|<script/i.test(html));
    assert.ok(!html.includes("n'a pas l'autorisation d'utiliser cet outil"));
    assert.match(html, /<a href="\/filtres">Retour<\/a>/);
    assert.match(html, /action="\/deconnexion"/);
    assert.equal(res.headers.get("set-cookie"), null, "le cookie n'est pas effacé");
    assert.equal(app.cyclos.calls("DELETE", "/auth/session").length, 0);
    app.cyclos.state.forced.clear();
    assert.equal((await app.request("/filtres")).status, 200, "session toujours valide");
    assert.equal((await post(app, path, csrf)).status, 200, "et utilisable ensuite");
  });
}

// Intention: a 403 on the history (and not on the list of accounts) keeps the generic "n'a pas l'autorisation" message:
// the two cases must not be confused.
appTest("403 sur GET /self/accounts/{type}/history : message générique", async (app) => {
  const csrf = await app.loggedIn();
  app.cyclos.state.entries = [entry(1)];
  app.cyclos.force("GET /self/accounts/membre/history", 403);
  const html = await (await post(app, "/releve", csrf)).text();
  assert.match(html, /n'a pas l'autorisation d'utiliser cet outil/);
  assert.ok(!html.includes("Accès aux comptes refusé"));
  assert.equal((await app.request("/filtres")).status, 200, "session conservée");
});

// Intention: for each error response from Cyclos, ONE line in the log (method, path, status, Cyclos error code), without the dates or the
// path parameters. This makes an outage understandable without exposing anything. No line for successful (2xx) responses.
// `app.logs` is the log captured by the harness.
appTest("journal : une ligne par réponse non 2xx (méthode, chemin avec type de compte, statut, code Cyclos)", async (app) => {
  const csrf = await app.loggedIn();
  app.cyclos.force("GET /self/accounts", 403);
  await post(app, "/releve", csrf);
  assert.ok(app.logs.includes("Cyclos GET /self/accounts -> 403 code=forbidden"), app.logs.join("\n"));
  app.cyclos.state.forced.clear();

  app.cyclos.force("GET /self/accounts/membre/history", 403);
  app.cyclos.state.entries = [entry(1)];
  await post(app, "/releve", csrf);
  // Path with the account type, without the query string (dates).
  assert.ok(app.logs.includes("Cyclos GET /self/accounts/membre/history -> 403 code=forbidden"), app.logs.join("\n"));
  assert.ok(!app.logs.some((l) => l.includes("datePeriod") || l.includes("?")));

  // No Cyclos line for 2xx answers.
  app.cyclos.state.forced.clear();
  const before = app.logs.filter((l) => l.startsWith("Cyclos ")).length;
  assert.equal((await post(app, "/releve", csrf)).status, 200);
  assert.equal(app.logs.filter((l) => l.startsWith("Cyclos ")).length, before);
});

// Intention (security): the log NEVER contains a login, password, token, amount, name or CSRF token. We provoke
// errors with recognisable values, then look for each of them in the whole log.
appTest("journal : connexion refusée et panne 500 journalisées sans identifiants ni jeton", async (app) => {
  await app.login({ password: "mot-de-passe-faux-123" });
  assert.ok(app.logs.includes("Cyclos POST /auth/session -> 401 code=login"), app.logs.join("\n"));
  const csrf = await app.loggedIn();
  const token = [...app.cyclos.state.tokens][0];
  assert.ok(token);
  app.cyclos.state.entries = [entry(1, { amount: "98765.43" })];
  for (const key of ["GET /self/accounts", "GET /self/accounts/membre/history"]) {
    app.cyclos.force(key, 500);
    await post(app, "/releve", csrf);
    app.cyclos.state.forced.clear();
  }
  assert.ok(app.logs.includes("Cyclos GET /self/accounts -> 500 code=unknownError"));
  const all = app.logs.join("\n");
  for (const secret of [USER.password, "mot-de-passe-faux-123", token, "98765", csrf, USER.login, USER.display, "Session-Token", "Authorization", "Basic "]) {
    assert.ok(!all.includes(secret), `le journal contient : ${secret}`);
  }
});

// Intention: if Cyclos is unreachable (cut connection), the merchant sees "Impossible de joindre Cyclos" (502) and the network cause is
// noted in the log. 502 = "bad gateway": the problem comes from Cyclos or the network, not from our tool.
appTest("502 : échec réseau -> 'Impossible de joindre Cyclos', journalisé", async (app) => {
  const csrf = await app.loggedIn();
  app.cyclos.force("GET /self/accounts", "drop");
  const res = await post(app, "/releve", csrf);
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "Impossible de joindre Cyclos");
  assert.ok(app.logs.some((l) => l.startsWith("Cyclos injoignable ou en erreur : network error")), app.logs.join("\n"));
});

// Intention: a BUG in our own code (here provoked with a malformed response) gives 500 "Erreur interne", clearly distinct from 502,
// with no technical detail for the browser, but with the message and the call stack in the log for the developer.
appTest("exception interne -> 500 'Erreur interne', pas 'Impossible de joindre'; message et pile journalisés", async (app) => {
  const csrf = await app.loggedIn();
  app.cyclos.state.accountsBody = [{}]; // account without a type: the code reads type.internalName -> TypeError
  const res = await post(app, "/releve", csrf);
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.match(text, /^Erreur interne du serveur/);
  assert.ok(!text.includes("Impossible de joindre"));
  assert.ok(!text.includes("TypeError") && !text.includes("server.js"), "pas de détail pour le navigateur");
  const log = app.logs.find((l) => l.startsWith("Erreur interne du serveur"));
  assert.ok(log, app.logs.join("\n"));
  assert.match(log, /TypeError/);
  assert.match(log, /at .*server\.js/, "pile");
  assert.ok(!log.includes(USER.password));
  assert.equal((await app.request("/filtres")).status, 200, "session conservée");
});

// Same principle: empty array for the page and for the PDF.
for (const path of ["/releve", "/releve.pdf"]) {
  // Intention: if Cyclos answers "OK" but with an EMPTY list of accounts, we behave as for a refusal (same message), note it in the log,
  // and do not fall into a 500 error. The session stays usable.
  appTest(`GET /self/accounts : 200 avec tableau vide (${path}) -> même message, journalisé, session conservée`, async (app) => {
    const csrf = await app.loggedIn();
    app.cyclos.state.accountsBody = [];
    const res = await post(app, path, csrf);
    assert.equal(res.status, 403);
    const html = await res.text();
    assert.ok(html.includes(NO_ACCOUNT));
    assert.match(html, /<h1>Accès aux comptes refusé<\/h1>/);
    assert.match(html, /<strong>Erreur :<\/strong>/);
    assert.match(html, /action="\/deconnexion"/);
    assert.equal(res.headers.get("set-cookie"), null);
    const lines = app.logs.filter((l) => l.startsWith("Cyclos GET /self/accounts"));
    assert.deepEqual(lines, ["Cyclos GET /self/accounts -> 200 liste vide (aucun compte)"]);
    assert.ok(!app.logs.some((l) => l.startsWith("Erreur interne")));
    app.cyclos.state.accountsBody = undefined;
    assert.equal((await post(app, path, csrf)).status, 200, "session utilisable ensuite");
  });
}
