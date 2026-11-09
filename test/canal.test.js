// === WHAT THIS FILE CHECKS ===
// The Cyclos "channel". Cyclos can grant different rights depending on the channel used to log in; a business account, for example,
// may only have access to its accounts through the "main" channel. The CYCLOS_CHANNEL variable makes the `Channel` HTTP header be sent to Cyclos. We
// check that it is sent on ALL calls when defined, absent otherwise, and that a dubious value is refused at startup (so as to never
// send an odd header to Cyclos). Uses the harness and the fake Cyclos. Basic notions: test/statique.test.js.
// Channel header sent to Cyclos (CYCLOS_CHANNEL variable), with the fake Cyclos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appTest, until } from "../test-support/harness.js";
import { envEnfant } from "../test-support/env-propre.js";
import { startServer } from "../server.js";
import { entry } from "../test-support/fake-cyclos.js";

// A fixed period used by the tests: the whole day of 10 January 2026.
const RANGE = { start: "2026-01-10T00:00", end: "2026-01-10T23:59" };

// Login, statement (history + totals), then logout (DELETE of the token).
// Plays a complete journey (login, statement, logout) and returns the list of ALL calls received by the fake Cyclos.
async function fullCycle(app) {
  app.cyclos.state.entries = [entry(1, { amount: "3.00" })];
  const csrf = await app.loggedIn();
  const res = await app.request("/releve", { method: "POST", form: { csrf, ...RANGE } });
  assert.equal(res.status, 200);
  await app.request("/deconnexion", { method: "POST", form: { csrf } });
  await until(() => app.cyclos.state.deleted.length === 1, "DELETE /auth/session");
  return app.cyclos.state.requests;
}

// Helper: filters the calls received by method and path.
const seen = (requests, method, path) => requests.filter((r) => r.method === method && r.path === path);

// Intention: with a channel defined, ALL calls to Cyclos (login, totals, history, logout) carry the `Channel: main` header.
// If a single one forgot it, Cyclos might answer 403 on that very call.
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

// Intention: without the variable, no `Channel` header is sent (Cyclos' default behaviour).
appTest("CYCLOS_CHANNEL absent : aucun en-tête Channel", async (app) => {
  const requests = await fullCycle(app);
  assert.ok(requests.length >= 6);
  for (const r of requests) {
    assert.equal("channel" in r.headers, false, `${r.method} ${r.path}`);
  }
});

// Same with an empty value: it means "no channel".
appTest("CYCLOS_CHANNEL vide : aucun en-tête Channel", { cyclosChannel: "" }, async (app) => {
  for (const r of await fullCycle(app)) assert.equal("channel" in r.headers, false);
});

// Intention (security): a channel name with a space, a line break (an attempt to inject another header), an accent, a "/" or more than 32 characters
// prevents startup. `assert.rejects` checks that the promise fails with the right message. Here a plain `test` (no harness): we call `startServer` directly.
test("CYCLOS_CHANNEL invalide : startServer refuse de démarrer", async () => {
  for (const bad of ["main interface", "main\r\nX-Evil: 1", "café", "a/b", " main", "x".repeat(33)]) {
    await assert.rejects(startServer({ port: 0, host: "127.0.0.1", cyclosChannel: bad }), /CYCLOS_CHANNEL invalide/, JSON.stringify(bad));
  }
});

// Edge case: exactly 32 characters, with a hyphen and an underscore, is accepted.
test("CYCLOS_CHANNEL à la limite (32 caractères, tiret, soulignement) : accepté", async () => {
  const server = await startServer({ port: 0, host: "127.0.0.1", cyclosChannel: `Ab_-${"9".repeat(28)}` });
  await server.close();
});

// Intention: launched for real (`node server.js`), an invalid channel gives a one-line message, with no unreadable call stack, an exit code of 1
// (failure) and nothing listening. `spawn` starts a real Node process, as the operator would in their terminal.
test("node server.js avec un canal invalide : message clair, pas de pile, code 1, rien n'écoute", async () => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("../", import.meta.url),
    env: envEnfant({ PORT: "0", CYCLOS_CHANNEL: "pas valide!" }),
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

// Intention: at startup, the log announces the channel in use, so that the operator immediately sees whether it is configured correctly.
test("node server.js avec CYCLOS_CHANNEL=main : le journal annonce le canal", async () => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("../", import.meta.url),
    env: envEnfant({ PORT: String(20000 + Math.floor(Math.random() * 20000)), CYCLOS_CHANNEL: "main" }),
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
