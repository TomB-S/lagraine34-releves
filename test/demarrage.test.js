// === WHAT THIS FILE CHECKS ===
// The real startup of the tool with `node server.js`, as the operator launches it. The other tests start the server through code; here we launch
// a REAL Node process (`spawn`) and read what it prints. We check that importing the file starts nothing (important for the tests), and that
// the port (PORT) and the Cyclos address (CYCLOS_BASE_URL) from the environment are taken into account. Uses the fake Cyclos.
// Basic notions (assert, async): test/statique.test.js.
// "node server.js" starts as before; importing the file starts nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startFakeCyclos } from "../test-support/fake-cyclos.js";
import { envEnfant } from "../test-support/env-propre.js";

// ROOT: the project folder, where `node server.js` is launched.
const ROOT = new URL("../", import.meta.url);

// Launches a Node process with the given environment variables, and gathers everything it writes (normal output and errors)
// in `output()`. `exited` is a promise that resolves when the process ends.
function run(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: envEnfant({ CYCLOS_CHANNEL: "", ...env }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, exited, output: () => output };
}

// Intention: IMPORTING server.js must start no server and print nothing, otherwise every test file that imports it
// would open a port. The process must end by itself, with code 0 (success).
test("importer server.js ne démarre aucun serveur et le processus se termine", async () => {
  const { exited, output } = run(["--input-type=module", "-e", 'await import("./server.js")'], { PORT: "1" });
  assert.equal(await exited, 0);
  assert.equal(output(), "");
});

// Intention: launched for real, the server listens on the requested port (PORT variable), prints its address and the channel, and serves the login
// page. The port is drawn at random so as not to clash with another program. The `finally` block always stops the process.
test("node server.js : écoute sur PORT, annonce l'adresse, sert la page de connexion", async () => {
  const cyclos = await startFakeCyclos();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const { child, exited, output } = run(["server.js"], { PORT: String(port), CYCLOS_BASE_URL: cyclos.url, COOKIE_SECURE: "" });
  try {
    for (let i = 0; i < 100 && !output().includes("Serveur démarré"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(output().trim(), `Serveur démarré sur http://localhost:${port}\nCanal Cyclos : (par defaut)`);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<h1>Connexion<\/h1>/);
  } finally {
    child.kill();
    await exited;
    await cyclos.close();
  }
});

// Intention: the Cyclos address given by the CYCLOS_BASE_URL environment variable is indeed used for the login (the fake Cyclos receives
// the call). We deliberately add a trailing "/" to check that it is ignored. Without this, the tool would query the Cyclos demo.
test("node server.js : CYCLOS_BASE_URL est bien utilisée pour la connexion", async () => {
  const cyclos = await startFakeCyclos();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const { child, exited, output } = run(["server.js"], { PORT: String(port), CYCLOS_BASE_URL: `${cyclos.url}/` });
  try {
    for (let i = 0; i < 100 && !output().includes("Serveur démarré"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const base = `http://127.0.0.1:${port}`;
    const res = await fetch(`${base}/connexion`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
      body: "login=commercant&password=motdepasse-de-test",
    });
    assert.equal(res.status, 303);
    assert.equal(cyclos.calls("POST", "/auth/session").length, 1);
  } finally {
    child.kill();
    await exited;
    await cyclos.close();
  }
});

// ---- .env file: read by "npm start" only, never by the tests or by "node server.js" ----

test("package.json : seul `start` lit .env, `test` ne le lit pas", async () => {
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  assert.equal(pkg.scripts.start, "node --env-file-if-exists=.env server.js");
  assert.doesNotMatch(pkg.scripts.test, /env-file/);
  // --env-file-if-exists appeared in Node 22.9.
  assert.equal(pkg.engines.node, ">=22.9");
});

test("--env-file-if-exists : le fichier remplit les variables, une variable déjà définie l'emporte, fichier absent toléré", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(`${tmpdir()}/lagraine-env-`);
  const envFile = `${dir}/.env`;
  await writeFile(envFile, "CYCLOS_CHANNEL=depuis-le-fichier\nPORT=1\n");
  const flag = `--env-file-if-exists=${envFile}`;
  const start = async (args, env) => {
    const { child, exited, output } = run(args, env);
    for (let i = 0; i < 100 && !output().includes("Canal Cyclos"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    child.kill();
    await exited;
    return output();
  };
  try {
    const port = String(20000 + Math.floor(Math.random() * 20000));
    // The file supplies the channel; its PORT=1 loses against the PORT given in front (port 1 would fail).
    let out = await start([flag, "server.js"], { PORT: port, CYCLOS_CHANNEL: undefined });
    assert.match(out, /Canal Cyclos : depuis-le-fichier/);
    // A variable set before the command wins over the file, even when empty.
    out = await start([flag, "server.js"], { PORT: port, CYCLOS_CHANNEL: "devant" });
    assert.match(out, /Canal Cyclos : devant/);
    out = await start([flag, "server.js"], { PORT: port, CYCLOS_CHANNEL: "" });
    assert.match(out, /Canal Cyclos : \(par defaut\)/);
    // No file: same behaviour as before, no error.
    out = await start([`--env-file-if-exists=${dir}/absent.env`, "server.js"], { PORT: port, CYCLOS_CHANNEL: "" });
    assert.match(out, /Canal Cyclos : \(par defaut\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
