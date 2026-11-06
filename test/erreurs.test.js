// Messages d'erreur clairs et journal serveur (diagnostic sans donnée sensible).
import assert from "node:assert/strict";
import { appTest, USER } from "../test-support/harness.js";
import { entry } from "../test-support/fake-cyclos.js";

const RANGE = { start: "2026-01-10T00:00", end: "2026-01-10T23:59" };
const NO_ACCOUNT = "Cyclos refuse l'accès aux comptes de cet utilisateur. Soit il n'a pas de compte de monnaie, soit l'accès par l'API ne lui est pas autorisé. Contactez l'association.";

const post = (app, path, csrf) => app.request(path, { method: "POST", form: { csrf, ...RANGE } });

for (const path of ["/releve", "/releve.pdf"]) {
  appTest(`403 sur GET /self/accounts (${path}) : message dédié, charte, session conservée`, async (app) => {
    const csrf = await app.loggedIn();
    app.cyclos.force("GET /self/accounts", 403);
    const res = await post(app, path, csrf);
    assert.equal(res.status, 403);
    assert.match(res.headers.get("content-type"), /^text\/html/);
    const html = await res.text();
    assert.ok(html.includes(NO_ACCOUNT));
    // Charte : icône, libellé « Erreur : », role="alert", aucun style ni script en ligne.
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

appTest("403 sur GET /self/accounts/{type}/history : message générique", async (app) => {
  const csrf = await app.loggedIn();
  app.cyclos.state.entries = [entry(1)];
  app.cyclos.force("GET /self/accounts/membre/history", 403);
  const html = await (await post(app, "/releve", csrf)).text();
  assert.match(html, /n'a pas l'autorisation d'utiliser cet outil/);
  assert.ok(!html.includes("Accès aux comptes refusé"));
  assert.equal((await app.request("/filtres")).status, 200, "session conservée");
});

appTest("journal : une ligne par réponse non 2xx (méthode, chemin avec type de compte, statut, code Cyclos)", async (app) => {
  const csrf = await app.loggedIn();
  app.cyclos.force("GET /self/accounts", 403);
  await post(app, "/releve", csrf);
  assert.ok(app.logs.includes("Cyclos GET /self/accounts -> 403 code=forbidden"), app.logs.join("\n"));
  app.cyclos.state.forced.clear();

  app.cyclos.force("GET /self/accounts/membre/history", 403);
  app.cyclos.state.entries = [entry(1)];
  await post(app, "/releve", csrf);
  // Chemin avec le type de compte, sans la chaîne de requête (dates).
  assert.ok(app.logs.includes("Cyclos GET /self/accounts/membre/history -> 403 code=forbidden"), app.logs.join("\n"));
  assert.ok(!app.logs.some((l) => l.includes("datePeriod") || l.includes("?")));

  // Pas de ligne Cyclos pour les réponses 2xx.
  app.cyclos.state.forced.clear();
  const before = app.logs.filter((l) => l.startsWith("Cyclos ")).length;
  assert.equal((await post(app, "/releve", csrf)).status, 200);
  assert.equal(app.logs.filter((l) => l.startsWith("Cyclos ")).length, before);
});

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

appTest("502 : échec réseau -> 'Impossible de joindre Cyclos', journalisé", async (app) => {
  const csrf = await app.loggedIn();
  app.cyclos.force("GET /self/accounts", "drop");
  const res = await post(app, "/releve", csrf);
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "Impossible de joindre Cyclos");
  assert.ok(app.logs.some((l) => l.startsWith("Cyclos injoignable ou en erreur : network error")), app.logs.join("\n"));
});

appTest("exception interne -> 500 'Erreur interne', pas 'Impossible de joindre'; message et pile journalisés", async (app) => {
  const csrf = await app.loggedIn();
  app.cyclos.state.accountsBody = [{}]; // compte sans type : le code lit type.internalName -> TypeError
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

for (const path of ["/releve", "/releve.pdf"]) {
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
