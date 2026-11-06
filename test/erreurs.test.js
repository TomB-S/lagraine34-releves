// === CE QUE VÉRIFIE CE FICHIER ===
// Ce que voit le commerçant quand quelque chose ne va pas (compte non autorisé, Cyclos en panne, bug interne), et ce que le serveur écrit dans
// son JOURNAL pour qu'on puisse diagnostiquer. Deux exigences : des messages clairs, sans détail technique, et un journal utile mais
// qui ne contient jamais de mot de passe, de jeton ni de montant. Utilise le harnais et le faux Cyclos (`force` simule les pannes).
// Notions de base (assert, async, statuts HTTP) : voir test/statique.test.js.
// Clear error messages and server log (diagnosis without sensitive data).
import assert from "node:assert/strict";
import { appTest, USER } from "../test-support/harness.js";
import { entry } from "../test-support/fake-cyclos.js";

const RANGE = { start: "2026-01-10T00:00", end: "2026-01-10T23:59" };
// Le message exact affiché quand Cyclos refuse l'accès aux comptes (écrit en dur pour détecter tout changement involontaire).
const NO_ACCOUNT = "Cyclos refuse l'accès aux comptes de cet utilisateur. Soit il n'a pas de compte de monnaie, soit l'accès par l'API ne lui est pas autorisé. Contactez l'association.";

// Raccourci : envoie la demande de relevé (POST) sur la route voulue avec le jeton CSRF (voir test/connexion.test.js).
const post = (app, path, csrf) => app.request(path, { method: "POST", form: { csrf, ...RANGE } });

// Chaque test de cette boucle est joué deux fois : pour la page et pour le PDF.
for (const path of ["/releve", "/releve.pdf"]) {
  // Intention : si Cyclos répond 403 (interdit) à la liste des comptes (compte sans compte de monnaie, ou accès API non autorisé), on affiche un
  // message dédié « Accès aux comptes refusé », avec la charte (icône + « Erreur : », sans style en ligne), la session reste ouverte et
  // utilisable ensuite. Avant, l'utilisateur voyait une erreur 500 incompréhensible.
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

// Intention : un 403 sur l'historique (et non sur la liste des comptes) garde le message générique « n'a pas l'autorisation » :
// les deux cas ne doivent pas être confondus.
appTest("403 sur GET /self/accounts/{type}/history : message générique", async (app) => {
  const csrf = await app.loggedIn();
  app.cyclos.state.entries = [entry(1)];
  app.cyclos.force("GET /self/accounts/membre/history", 403);
  const html = await (await post(app, "/releve", csrf)).text();
  assert.match(html, /n'a pas l'autorisation d'utiliser cet outil/);
  assert.ok(!html.includes("Accès aux comptes refusé"));
  assert.equal((await app.request("/filtres")).status, 200, "session conservée");
});

// Intention : pour chaque réponse d'erreur de Cyclos, UNE ligne dans le journal (méthode, chemin, statut, code d'erreur de Cyclos), sans les dates ni les
// paramètres du chemin. Ça permet de comprendre une panne sans rien exposer. Aucune ligne pour les réponses réussies (2xx).
// `app.logs` est le journal capté par le harnais.
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

// Intention (sécurité) : le journal ne contient JAMAIS d'identifiant, de mot de passe, de jeton, de montant, de nom ni de jeton CSRF. On provoque
// des erreurs avec des valeurs reconnaissables, puis on cherche chacune dans tout le journal.
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

// Intention : si Cyclos est injoignable (connexion coupée), le commerçant voit « Impossible de joindre Cyclos » (502) et la cause réseau est
// notée dans le journal. 502 = « passerelle défaillante » : le problème vient de Cyclos ou du réseau, pas de notre outil.
appTest("502 : échec réseau -> 'Impossible de joindre Cyclos', journalisé", async (app) => {
  const csrf = await app.loggedIn();
  app.cyclos.force("GET /self/accounts", "drop");
  const res = await post(app, "/releve", csrf);
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "Impossible de joindre Cyclos");
  assert.ok(app.logs.some((l) => l.startsWith("Cyclos injoignable ou en erreur : network error")), app.logs.join("\n"));
});

// Intention : un BUG de notre propre code (ici on le provoque avec une réponse mal formée) donne 500 « Erreur interne », bien distinct du 502,
// sans détail technique pour le navigateur, mais avec le message et la pile d'appels dans le journal pour le développeur.
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

// Même principe : tableau vide pour la page et pour le PDF.
for (const path of ["/releve", "/releve.pdf"]) {
  // Intention : si Cyclos répond « OK » mais avec une liste de comptes VIDE, on se comporte comme pour un refus (même message), on le note dans le journal,
  // et on ne tombe pas dans une erreur 500. La session reste utilisable.
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
