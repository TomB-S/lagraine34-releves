// === CE QUE VÉRIFIE CE FICHIER ===
// Tout ce qui touche à l'identité du commerçant : connexion, blocage après trop d'échecs, durée des sessions,
// déconnexion, protection CSRF, refus (403) de Cyclos et pannes. C'est le cœur de la sécurité : un mot de passe
// qui fuit ou une session qui ne se ferme pas serait grave pour le commerçant. Utilise le harnais
// (test-support/harness.js : vrai serveur + faux Cyclos, jamais le vrai Cyclos). Notions de base (assert, async,
// statuts HTTP) : voir test/statique.test.js.
// Login, attempt throttling, sessions, logout, CSRF, 403 refusals.
// Real server + local fake Cyclos (see test-support/), never the real Cyclos.
// `mock` (de node:test) sert ici à FAUSSER L'HORLOGE : on peut « avancer le temps » de 20 minutes en une milliseconde
// pour tester l'expiration des sessions sans attendre.
import { mock } from "node:test";
import assert from "node:assert/strict";
import { appTest, until, USER } from "../test-support/harness.js";
import { entry } from "../test-support/fake-cyclos.js";

const RANGE = { start: "2026-01-10T00:00", end: "2026-01-10T23:59" };
// Une minute en millisecondes (les durées de JavaScript sont en ms).
const MINUTE = 60_000;

// ------------------------------------------------------------ login

// Intention : après une bonne connexion on est redirigé (303) vers /filtres avec un cookie de session, et le mot de passe
// n'est envoyé à Cyclos qu'UNE fois. Si ça cassait : mot de passe réutilisé ou exposé, ou jeton Cyclos visible dans la page.
//
// Cookie de session : un petit texte que le serveur demande au navigateur de renvoyer à chaque requête, pour le reconnaître.
// Ses options : HttpOnly (illisible par du JavaScript, donc non volable par une faille XSS), SameSite=Lax (pas envoyé depuis
// un autre site), Max-Age=28800 (8 heures). Le cookie ne contient qu'un identifiant au hasard, SANS lien avec le jeton Cyclos.
// Authentification Basic : l'en-tête `Authorization: Basic xxx` contient « identifiant:motdepasse » en base64 (un simple codage).
// Après la connexion, l'outil n'utilise plus que le jeton Cyclos (en-tête `Session-Token`).
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

// Intention : un mauvais mot de passe donne 401 (non authentifié), aucun cookie, et le texte saisi n'est pas renvoyé dans la page.
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

// Intention : un formulaire incomplet est refusé sans même déranger Cyclos (pas d'appel inutile ni de tentative comptée).
appTest("connexion : champs vides -> 401 sans appeler Cyclos", async (app) => {
  for (const form of [{}, { login: "a" }, { password: "b" }, { login: "", password: "" }]) {
    const res = await app.request("/connexion", { method: "POST", form, headers: { Origin: app.base } });
    assert.equal(res.status, 401);
  }
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 0);
});

// Intention : un identifiant ou un mot de passe avec accents, « : » ou caractères japonais est envoyé correctement à Cyclos (en UTF-8).
// Sinon ces commerçants ne pourraient jamais se connecter. On décode l'en-tête Basic envoyé pour vérifier.
appTest("connexion : identifiants avec accents et caractères non latins transmis en UTF-8", async (app) => {
  const res = await app.login({ login: "Élodie", password: "pässwörd:日本" });
  assert.equal(res.status, 401); // unknown to the fake Cyclos, but the request was indeed made
  const [call] = app.cyclos.calls("POST", "/auth/session");
  assert.equal(
    Buffer.from(call.headers.authorization.replace("Basic ", ""), "base64").toString("utf-8"),
    "Élodie:pässwörd:日本",
  );
});

// Intention : après 5 échecs depuis la même adresse, les tentatives suivantes sont bloquées (429 « trop de requêtes »), même avec le bon
// mot de passe, et n'atteignent plus Cyclos. Cela empêche de deviner un mot de passe par essais répétés. `Retry-After` dit quand réessayer.
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

// Intention : le blocage n'est pas définitif : il se lève au bout de 15 minutes. On n'attend pas : `sweep` (le nettoyage
// périodique du serveur) est appelé avec une date future.
appTest("429 : le blocage se lève après 15 minutes (nettoyage périodique)", async (app) => {
  for (let i = 0; i < 5; i += 1) await app.login({ password: "faux" });
  assert.equal((await app.login()).status, 429);
  app.server.sweep(Date.now() + 14 * MINUTE);
  assert.equal((await app.login()).status, 429, "pas encore 15 minutes");
  app.server.sweep(Date.now() + 15 * MINUTE + 1000);
  assert.equal((await app.login()).status, 303);
});

// Intention : seuls les vrais mots de passe faux comptent. Un refus de droits (403) ou une panne de Cyclos (500) ne doivent
// pas bloquer un commerçant honnête.
appTest("429 : seuls les identifiants refusés comptent (403 et pannes de Cyclos non)", async (app) => {
  app.cyclos.force("POST /auth/session", 403);
  for (let i = 0; i < 7; i += 1) assert.equal((await app.login()).status, 403);
  app.cyclos.force("POST /auth/session", 500);
  for (let i = 0; i < 7; i += 1) assert.equal((await app.login()).status, 502);
  app.cyclos.state.forced.clear();
  assert.equal((await app.login()).status, 303);
});

// Intention (sécurité) : le formulaire de connexion n'est accepté que s'il vient d'une page de NOTRE site. L'en-tête `Origin` (ou, à défaut,
// `Referer`) indique d'où vient la requête ; un site pirate ne peut pas le falsifier depuis un navigateur. C'est une protection de type CSRF
// pour la connexion (voir les tests « CSRF » plus bas). Cas refusés : autre site, « null », en-tête absent.
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

// Intention (sécurité) : dans des situations très variées (refus, panne, connexion coupée, 429, succès), le mot de passe ne doit
// apparaître NI dans les réponses, NI dans le journal du serveur. On le note dans `seen`/`app.logs` et on cherche sa présence partout.
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

// Intention : si Cyclos ne répond pas correctement (500), l'outil répond 502 (« passerelle défaillante ») sans créer de session.
appTest("Cyclos en panne à la connexion : 502, pas de session", async (app) => {
  app.cyclos.force("POST /auth/session", 500);
  const res = await app.login();
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "Impossible de joindre Cyclos");
  assert.equal((await app.request("/filtres")).status, 303);
});

// ------------------------------------------------------------ sessions

// Fausse l'horloge (`Date`) : à partir d'ici, `mock.timers.tick(ms)` fait avancer le temps instantanément.
function mockClock() {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
}

// Intention : une session s'éteint après 20 minutes SANS ACTIVITÉ (chaque page consultée prolonge), et le jeton est aussi fermé
// chez Cyclos (DELETE). Sinon une session oubliée sur un poste partagé resterait ouverte.
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

// Intention : même sans jamais s'arrêter, une session ne dure pas plus de 8 heures. Sinon un cookie volé fonctionnerait indéfiniment.
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

// Intention : les durées viennent de la configuration (ici 1 s et 5 s via les options du test), pas de valeurs écrites en dur.
appTest("session : durées configurables (idleMs, maxMs)", { idleMs: 1000, maxMs: 5000 }, async (app) => {
  mockClock();
  await app.loggedIn();
  mock.timers.tick(900);
  assert.equal((await app.request("/filtres")).status, 200);
  mock.timers.tick(1001);
  assert.equal((await app.request("/filtres")).status, 303);
});

// Intention : le serveur fait lui-même le ménage des sessions expirées (sans attendre une nouvelle requête) et ferme leur jeton chez Cyclos.
appTest("nettoyage périodique : sessions expirées retirées et jeton fermé sans nouvelle requête", async (app) => {
  mockClock();
  await app.loggedIn();
  app.server.sweep(); // nothing expired: the session stays
  assert.equal(app.cyclos.state.deleted.length, 0);
  mock.timers.tick(21 * MINUTE);
  app.server.sweep();
  await until(() => app.cyclos.state.deleted.includes("jeton-1"), "DELETE /auth/session par le nettoyage");
});

// Intention : ce ménage se déclenche automatiquement à intervalle régulier (ici 30 ms), sans que le test l'appelle.
appTest("nettoyage périodique : lancé tout seul à l'intervalle configuré", { sweepIntervalMs: 30 }, async (app) => {
  await app.loggedIn();
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 30 * MINUTE });
  await until(() => app.cyclos.state.deleted.includes("jeton-1"), "nettoyage automatique");
});

// Intention : se déconnecter supprime la session locale, ferme le jeton chez Cyclos et efface le cookie (Max-Age=0).
// Ensuite l'ancien cookie ne donne plus accès à rien, même s'il était volé.
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

// Intention : même si Cyclos refuse ou ne répond pas à la fermeture du jeton, le commerçant est quand même déconnecté de NOTRE outil.
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

// Intention : cliquer « se déconnecter » alors que la session n'existe plus (expirée) ne provoque pas d'erreur : retour à l'accueil.
appTest("déconnexion sans session : redirection vers / et cookie effacé", async (app) => {
  const res = await app.request("/deconnexion", { method: "POST", form: {} });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
});

// Intention : si Cyclos répond 401 (le jeton a expiré chez eux), l'outil ferme la session locale et renvoie à la page de connexion,
// au lieu d'afficher une erreur incompréhensible. `expireTokens()` du faux Cyclos simule cette expiration.
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

// Intention : même réaction (retour à /) si le 401 arrive en cours de lecture (ici à la lecture des comptes), pas seulement au premier appel.
appTest("401 de Cyclos au milieu de la lecture (comptes) : même redirection", async (app) => {
  const csrf = await app.loggedIn();
  app.cyclos.force("GET /self/accounts", 401);
  const res = await app.request("/releve", { method: "POST", form: { csrf, ...RANGE } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  assert.equal((await app.request("/filtres")).status, 303);
});

// ------------------------------------------------------------ CSRF

// CSRF (Cross-Site Request Forgery) : un site pirate pourrait faire envoyer par le navigateur du commerçant, connecté, un formulaire
// vers notre outil (le cookie part tout seul). Parade : chaque session a un jeton secret au hasard, mis dans les formulaires de
// nos pages ; une action POST sans ce jeton est refusée (403). Un site pirate ne peut pas connaître ce jeton.
for (const path of ["/releve", "/releve.pdf", "/deconnexion"]) {
  // Intention : pour chaque route POST, un jeton absent, vide, faux, tronqué ou rallongé est refusé (403), sans appeler Cyclos et
  // sans fermer la session. Le test est répété pour /releve, /releve.pdf et /deconnexion (la boucle `for` crée 3 tests).
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

// Intention : le jeton d'une session A n'est pas valable dans la session B (chaque jeton est propre à sa session).
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

// Intention : seul le jeton dans le CORPS du formulaire compte ; dans l'adresse ou un en-tête, il est ignoré.
appTest("CSRF : jeton passé en paramètre d'URL ou en en-tête ignoré", async (app) => {
  const csrf = await app.loggedIn();
  const res = await app.request(`/releve?csrf=${csrf}`, { method: "POST", form: RANGE, headers: { "X-CSRF-Token": csrf } });
  assert.equal(res.status, 403);
});

// Intention : sans session, ces pages renvoient à la connexion (303) et on n'interroge jamais Cyclos.
appTest("sans session : /releve, /releve.pdf, /filtres redirigent vers / (aucun appel à Cyclos)", async (app) => {
  for (const [method, path] of [["GET", "/filtres"], ["POST", "/releve"], ["POST", "/releve.pdf"]]) {
    const res = await app.request(path, { method, form: method === "POST" ? RANGE : undefined });
    assert.equal(res.status, 303, path);
    assert.equal(res.headers.get("location"), "/");
  }
  assert.equal(app.cyclos.state.requests.length, 0);
});

// Intention : un cookie « session » inventé ou mal formé est traité comme une absence de session, jamais comme une erreur ou un accès.
appTest("cookie de session inconnu ou falsifié : traité comme absent", async (app) => {
  for (const cookie of ["session=abc", "session=", "session=00000000-0000-0000-0000-000000000000", "autre=1", "session"]) {
    app.cookie = cookie;
    assert.equal((await app.request("/filtres")).status, 303, cookie);
  }
});

// Intention : la déconnexion n'est possible que par POST (avec jeton CSRF) : un simple lien ou une image piégée ne doit pas pouvoir
// déconnecter quelqu'un. En GET : 405 (méthode non autorisée) et la session reste ouverte.
appTest("GET /deconnexion : 405 avec Allow: POST, session conservée", async (app) => {
  await app.loggedIn();
  const res = await app.request("/deconnexion");
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
  assert.equal((await app.request("/filtres")).status, 200);
  assert.equal(app.cyclos.calls("DELETE", "/auth/session").length, 0);
});

// ------------------------------------------------------------ Cyclos 403

// 403 (interdit) : Cyclos reconnaît l'utilisateur mais lui refuse cette action. Ce n'est pas une erreur de connexion : on garde la session.
for (const path of ["/releve", "/releve.pdf"]) {
  // Intention : un refus 403 de Cyclos sur les totaux donne une page « Accès refusé » claire, SANS fermer la session, et le
  // commerçant peut réessayer ensuite. (Le cas 403 sur la liste des comptes est dans test/erreurs.test.js.)
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

// Intention : un 403 dès la connexion affiche « Accès refusé » mais sans session ni cookie (rien à déconnecter).
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

// Intention : si Cyclos tombe en panne en plein relevé (500), le commerçant voit seulement « Impossible de joindre Cyclos » (aucun détail
// technique), la session est conservée, et la panne est notée dans le journal du serveur.
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
