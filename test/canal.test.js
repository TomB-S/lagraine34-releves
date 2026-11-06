// === CE QUE VÉRIFIE CE FICHIER ===
// Le « canal » Cyclos. Cyclos peut accorder des droits différents selon le canal par lequel on se connecte ; un compte professionnel, par exemple,
// peut n'avoir accès à ses comptes que par le canal « main ». La variable CYCLOS_CHANNEL fait envoyer l'en-tête HTTP `Channel` à Cyclos. On
// vérifie qu'il est envoyé sur TOUS les appels quand il est défini, absent sinon, et qu'une valeur douteuse est refusée au démarrage (pour ne
// jamais envoyer un en-tête bizarre à Cyclos). Utilise le harnais et le faux Cyclos. Notions de base : test/statique.test.js.
// Channel header sent to Cyclos (CYCLOS_CHANNEL variable), with the fake Cyclos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appTest, until } from "../test-support/harness.js";
import { startServer } from "../server.js";
import { entry } from "../test-support/fake-cyclos.js";

// Une période fixe utilisée par les tests : toute la journée du 10 janvier 2026.
const RANGE = { start: "2026-01-10T00:00", end: "2026-01-10T23:59" };

// Login, statement (history + totals), then logout (DELETE of the token).
// Joue un parcours complet (connexion, relevé, déconnexion) et renvoie la liste de TOUS les appels reçus par le faux Cyclos.
async function fullCycle(app) {
  app.cyclos.state.entries = [entry(1, { amount: "3.00" })];
  const csrf = await app.loggedIn();
  const res = await app.request("/releve", { method: "POST", form: { csrf, ...RANGE } });
  assert.equal(res.status, 200);
  await app.request("/deconnexion", { method: "POST", form: { csrf } });
  await until(() => app.cyclos.state.deleted.length === 1, "DELETE /auth/session");
  return app.cyclos.state.requests;
}

// Aide : filtre les appels reçus par méthode et chemin.
const seen = (requests, method, path) => requests.filter((r) => r.method === method && r.path === path);

// Intention : avec un canal défini, TOUS les appels vers Cyclos (connexion, totaux, historique, déconnexion) portent l'en-tête `Channel: main`.
// Si un seul l'oubliait, Cyclos pourrait répondre 403 sur cet appel-là.
appTest("CYCLOS_CHANNEL défini : Channel envoyé sur login, historique, totaux et logout", { cyclosChannel: "main" }, async (app) => {
  const requests = await fullCycle(app);
  assert.equal(seen(requests, "POST", "/auth/session").length, 1);
  assert.equal(seen(requests, "GET", "/self/accounts/membre/history").length, 1);
  assert.equal(seen(requests, "GET", "/self/accounts/membre").length, 1);
  assert.equal(seen(requests, "DELETE", "/auth/session").length, 1);
  assert.ok(requests.length >= 6);
  for (const r of requests) {
    assert.equal(r.headers.channel, "main", `${r.method} ${r.path}`);
  }
});

// Intention : sans la variable, aucun en-tête `Channel` n'est envoyé (comportement par défaut de Cyclos).
appTest("CYCLOS_CHANNEL absent : aucun en-tête Channel", async (app) => {
  const requests = await fullCycle(app);
  assert.ok(requests.length >= 6);
  for (const r of requests) {
    assert.equal("channel" in r.headers, false, `${r.method} ${r.path}`);
  }
});

// Idem avec une valeur vide : c'est « pas de canal ».
appTest("CYCLOS_CHANNEL vide : aucun en-tête Channel", { cyclosChannel: "" }, async (app) => {
  for (const r of await fullCycle(app)) assert.equal("channel" in r.headers, false);
});

// Intention (sécurité) : un nom de canal avec espace, retour à la ligne (tentative d'injecter un autre en-tête), accent, « / » ou plus de 32 caractères
// empêche le démarrage. `assert.rejects` vérifie que la promesse échoue avec le bon message. Ici `test` simple (pas de harnais) : on appelle `startServer` directement.
test("CYCLOS_CHANNEL invalide : startServer refuse de démarrer", async () => {
  for (const bad of ["main interface", "main\r\nX-Evil: 1", "café", "a/b", " main", "x".repeat(33)]) {
    await assert.rejects(startServer({ port: 0, host: "127.0.0.1", cyclosChannel: bad }), /CYCLOS_CHANNEL invalide/, JSON.stringify(bad));
  }
});

// Cas limite : exactement 32 caractères, avec tiret et soulignement, est accepté.
test("CYCLOS_CHANNEL à la limite (32 caractères, tiret, soulignement) : accepté", async () => {
  const server = await startServer({ port: 0, host: "127.0.0.1", cyclosChannel: `Ab_-${"9".repeat(28)}` });
  await server.close();
});

// Intention : lancé en vrai (`node server.js`), un canal invalide donne un message d'une ligne, sans pile d'appels illisible, un code de sortie 1
// (échec) et rien n'écoute. `spawn` lance un vrai processus Node, comme le ferait l'opérateur dans son terminal.
test("node server.js avec un canal invalide : message clair, pas de pile, code 1, rien n'écoute", async () => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, PORT: "0", CYCLOS_CHANNEL: "pas valide!" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 1);
  assert.match(output, /^CYCLOS_CHANNEL invalide/);
  assert.ok(!output.includes("Serveur démarré"));
  assert.ok(!/\n\s+at /.test(output), "pas de pile d'appels");
});

// Intention : au démarrage, le journal annonce le canal utilisé, pour que l'opérateur voie tout de suite s'il est bien configuré.
test("node server.js avec CYCLOS_CHANNEL=main : le journal annonce le canal", async () => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, PORT: String(20000 + Math.floor(Math.random() * 20000)), CYCLOS_CHANNEL: "main" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  try {
    for (let i = 0; i < 100 && !output.includes("Canal Cyclos"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.match(output, /^Serveur démarré sur http:\/\/localhost:\d+\nCanal Cyclos : main\n$/);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
});
