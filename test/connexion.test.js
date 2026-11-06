// Connexion, limitation des tentatives, sessions, déconnexion, CSRF, refus 403.
// Vrai serveur + faux Cyclos local (voir test-support/), jamais le vrai Cyclos.
import { mock } from "node:test";
import assert from "node:assert/strict";
import { appTest, until, USER } from "../test-support/harness.js";
import { entry } from "../test-support/fake-cyclos.js";

const RANGE = { start: "2026-01-10T00:00", end: "2026-01-10T23:59" };
const MINUTE = 60_000;

// ------------------------------------------------------------ connexion

appTest("connexion réussie : 303 vers /filtres, cookie de session, jeton Cyclos jamais exposé", async (app) => {
  const res = await app.login();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/filtres");
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /^session=[0-9a-f-]{36}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=28800$/);

  // Un seul appel à Cyclos, avec le mot de passe en Basic, une seule fois.
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
  // Les appels suivants à Cyclos utilisent le jeton, jamais le mot de passe.
  await app.request("/releve", { method: "POST", form: { csrf: await app.csrf(), ...RANGE } });
  for (const call of app.cyclos.state.requests.filter((r) => r.path !== "/auth/session" || r.method !== "POST")) {
    assert.equal(call.headers["session-token"], "jeton-1");
    assert.equal(call.headers.authorization, undefined);
  }
});

appTest("connexion refusée : 401, pas de cookie, page « Connexion échouée »", async (app) => {
  const res = await app.login({ password: "mauvais" });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
  const html = await res.text();
  assert.match(html, /Connexion échouée/);
  assert.match(html, /Identifiant ou mot de passe incorrect/);
  assert.ok(!html.includes("mauvais"));
  assert.equal((await app.request("/filtres")).status, 303); // toujours pas de session
});

appTest("connexion : champs vides -> 401 sans appeler Cyclos", async (app) => {
  for (const form of [{}, { login: "a" }, { password: "b" }, { login: "", password: "" }]) {
    const res = await app.request("/connexion", { method: "POST", form, headers: { Origin: app.base } });
    assert.equal(res.status, 401);
  }
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 0);
});

appTest("connexion : identifiants avec accents et caractères non latins transmis en UTF-8", async (app) => {
  const res = await app.login({ login: "Élodie", password: "pässwörd:日本" });
  assert.equal(res.status, 401); // inconnus du faux Cyclos, mais la requête a bien été faite
  const [call] = app.cyclos.calls("POST", "/auth/session");
  assert.equal(
    Buffer.from(call.headers.authorization.replace("Basic ", ""), "base64").toString("utf-8"),
    "Élodie:pässwörd:日本",
  );
});

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

appTest("429 : le blocage se lève après 15 minutes (nettoyage périodique)", async (app) => {
  for (let i = 0; i < 5; i += 1) await app.login({ password: "faux" });
  assert.equal((await app.login()).status, 429);
  app.server.sweep(Date.now() + 14 * MINUTE);
  assert.equal((await app.login()).status, 429, "pas encore 15 minutes");
  app.server.sweep(Date.now() + 15 * MINUTE + 1000);
  assert.equal((await app.login()).status, 303);
});

appTest("429 : seuls les identifiants refusés comptent (403 et pannes de Cyclos non)", async (app) => {
  app.cyclos.force("POST /auth/session", 403);
  for (let i = 0; i < 7; i += 1) assert.equal((await app.login()).status, 403);
  app.cyclos.force("POST /auth/session", 500);
  for (let i = 0; i < 7; i += 1) assert.equal((await app.login()).status, 502);
  app.cyclos.state.forced.clear();
  assert.equal((await app.login()).status, 303);
});

appTest("Origin étranger, absent ou « null » : connexion refusée avant tout appel à Cyclos", async (app) => {
  const attempt = (headers) => app.request("/connexion", { method: "POST", form: { login: USER.login, password: USER.password }, headers });
  for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }, {}, { Referer: "https://evil.example/page" }, { Origin: "http://127.0.0.1:1" }]) {
    const res = await attempt(headers);
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.match(await res.text(), /Origine de la requête non autorisée/);
    assert.equal(res.headers.get("set-cookie"), null);
  }
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 0);
  // Même origine, par Origin ou, à défaut, par Referer.
  assert.equal((await attempt({ Origin: app.base })).status, 303);
  app.cookie = "";
  assert.equal((await attempt({ Referer: `${app.base}/` })).status, 303);
});

appTest("le mot de passe n'apparaît ni dans les réponses ni dans les logs", async (app) => {
  const secret = "S3cret-à-ne-jamais-voir";
  const seen = [];
  const note = async (res) => {
    seen.push(JSON.stringify([...res.headers]), await res.text());
  };

  await note(await app.login({ password: secret })); // refusé
  await note(await app.request("/connexion", { method: "POST", form: { login: USER.login, password: secret } })); // Origin manquant
  app.cyclos.force("POST /auth/session", 500);
  await note(await app.login({ password: secret })); // Cyclos en panne -> erreur journalisée
  app.cyclos.force("POST /auth/session", "drop");
  await note(await app.login({ password: secret })); // connexion coupée -> erreur journalisée
  app.cyclos.state.forced.clear();
  app.cyclos.force("POST /auth/session", 403);
  await note(await app.login({ password: secret }));
  app.cyclos.state.forced.clear();
  for (let i = 0; i < 5; i += 1) await app.login({ password: secret });
  await note(await app.login({ password: secret })); // 429

  // Connexion réussie : toutes les pages suivantes aussi.
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

appTest("Cyclos en panne à la connexion : 502, pas de session", async (app) => {
  app.cyclos.force("POST /auth/session", 500);
  const res = await app.login();
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "Impossible de joindre Cyclos");
  assert.equal((await app.request("/filtres")).status, 303);
});

// ------------------------------------------------------------ sessions

function mockClock() {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
}

appTest("session : expiration après 20 minutes d'inactivité, jeton Cyclos fermé", async (app) => {
  mockClock();
  await app.loggedIn();
  mock.timers.tick(19 * MINUTE);
  assert.equal((await app.request("/filtres")).status, 200); // l'activité prolonge la session
  mock.timers.tick(19 * MINUTE);
  assert.equal((await app.request("/filtres")).status, 200);
  mock.timers.tick(20 * MINUTE + 1);
  const res = await app.request("/filtres");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  await until(() => app.cyclos.state.deleted.includes("jeton-1"), "DELETE /auth/session");
  // La session n'existe plus, même avec l'ancien cookie.
  assert.equal((await app.request("/filtres")).status, 303);
});

appTest("session : durée absolue de 8 heures même avec une activité continue", async (app) => {
  mockClock();
  await app.loggedIn();
  for (let elapsed = 10; elapsed <= 470; elapsed += 10) {
    mock.timers.tick(10 * MINUTE);
    assert.equal((await app.request("/filtres")).status, 200, `après ${elapsed} min`);
  }
  mock.timers.tick(15 * MINUTE); // 8 h 05 au total, 15 min depuis la dernière activité
  const res = await app.request("/filtres");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  await until(() => app.cyclos.state.deleted.length === 1, "DELETE /auth/session");
});

appTest("session : durées configurables (idleMs, maxMs)", { idleMs: 1000, maxMs: 5000 }, async (app) => {
  mockClock();
  await app.loggedIn();
  mock.timers.tick(900);
  assert.equal((await app.request("/filtres")).status, 200);
  mock.timers.tick(1001);
  assert.equal((await app.request("/filtres")).status, 303);
});

appTest("nettoyage périodique : sessions expirées retirées et jeton fermé sans nouvelle requête", async (app) => {
  mockClock();
  await app.loggedIn();
  app.server.sweep(); // rien d'expiré : la session reste
  assert.equal(app.cyclos.state.deleted.length, 0);
  mock.timers.tick(21 * MINUTE);
  app.server.sweep();
  await until(() => app.cyclos.state.deleted.includes("jeton-1"), "DELETE /auth/session par le nettoyage");
});

appTest("nettoyage périodique : lancé tout seul à l'intervalle configuré", { sweepIntervalMs: 30 }, async (app) => {
  await app.loggedIn();
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 30 * MINUTE });
  await until(() => app.cyclos.state.deleted.includes("jeton-1"), "nettoyage automatique");
});

appTest("déconnexion : session supprimée, DELETE envoyé à Cyclos, cookie effacé", async (app) => {
  const csrf = await app.loggedIn();
  const oldCookie = app.cookie;
  const res = await app.request("/deconnexion", { method: "POST", form: { csrf } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  assert.match(res.headers.get("set-cookie"), /^session=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0$/);
  assert.deepEqual(app.cyclos.state.deleted, ["jeton-1"]);
  assert.equal(app.cyclos.calls("DELETE", "/auth/session")[0].headers["session-token"], "jeton-1");

  // L'ancien cookie ne donne plus rien.
  app.cookie = oldCookie;
  assert.equal((await app.request("/filtres")).status, 303);
  assert.equal((await app.request("/releve", { method: "POST", form: { csrf, ...RANGE } })).status, 303);
});

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

appTest("déconnexion sans session : redirection vers / et cookie effacé", async (app) => {
  const res = await app.request("/deconnexion", { method: "POST", form: {} });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
});

appTest("jeton Cyclos expiré (401 loggedOut) : session locale supprimée et retour à /", async (app) => {
  for (const path of ["/releve", "/releve.pdf"]) {
    // Chaque essai repart d'une session locale valide dont le jeton est refusé par Cyclos.
    const csrf = await app.loggedIn();
    app.cyclos.expireTokens();
    const res = await app.request(path, { method: "POST", form: { csrf, ...RANGE } });
    assert.equal(res.status, 303, path);
    assert.equal(res.headers.get("location"), "/");
    assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await app.request("/filtres")).status, 303, "session locale supprimée");
  }
});

appTest("401 de Cyclos au milieu de la lecture (comptes) : même redirection", async (app) => {
  const csrf = await app.loggedIn();
  app.cyclos.force("GET /self/accounts", 401);
  const res = await app.request("/releve", { method: "POST", form: { csrf, ...RANGE } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  assert.equal((await app.request("/filtres")).status, 303);
});

// ------------------------------------------------------------ CSRF

for (const path of ["/releve", "/releve.pdf", "/deconnexion"]) {
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

appTest("CSRF : jeton passé en paramètre d'URL ou en en-tête ignoré", async (app) => {
  const csrf = await app.loggedIn();
  const res = await app.request(`/releve?csrf=${csrf}`, { method: "POST", form: RANGE, headers: { "X-CSRF-Token": csrf } });
  assert.equal(res.status, 403);
});

appTest("sans session : /releve, /releve.pdf, /filtres redirigent vers / (aucun appel à Cyclos)", async (app) => {
  for (const [method, path] of [["GET", "/filtres"], ["POST", "/releve"], ["POST", "/releve.pdf"]]) {
    const res = await app.request(path, { method, form: method === "POST" ? RANGE : undefined });
    assert.equal(res.status, 303, path);
    assert.equal(res.headers.get("location"), "/");
  }
  assert.equal(app.cyclos.state.requests.length, 0);
});

appTest("cookie de session inconnu ou falsifié : traité comme absent", async (app) => {
  for (const cookie of ["session=abc", "session=", "session=00000000-0000-0000-0000-000000000000", "autre=1", "session"]) {
    app.cookie = cookie;
    assert.equal((await app.request("/filtres")).status, 303, cookie);
  }
});

appTest("GET /deconnexion : 405 avec Allow: POST, session conservée", async (app) => {
  await app.loggedIn();
  const res = await app.request("/deconnexion");
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
  assert.equal((await app.request("/filtres")).status, 200);
  assert.equal(app.cyclos.calls("DELETE", "/auth/session").length, 0);
});

// ------------------------------------------------------------ 403 de Cyclos

for (const path of ["/releve", "/releve.pdf"]) {
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
