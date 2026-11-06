// « node server.js » démarre comme avant ; importer le fichier ne démarre rien.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startFakeCyclos } from "../test-support/fake-cyclos.js";

const ROOT = new URL("../", import.meta.url);

function run(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, exited, output: () => output };
}

test("importer server.js ne démarre aucun serveur et le processus se termine", async () => {
  const { exited, output } = run(["--input-type=module", "-e", 'await import("./server.js")'], { PORT: "1" });
  assert.equal(await exited, 0);
  assert.equal(output(), "");
});

test("node server.js : écoute sur PORT, annonce l'adresse, sert la page de connexion", async () => {
  const cyclos = await startFakeCyclos();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const { child, exited, output } = run(["server.js"], { PORT: String(port), CYCLOS_BASE_URL: cyclos.url, COOKIE_SECURE: "" });
  try {
    for (let i = 0; i < 100 && !output().includes("Serveur démarré"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(output().trim(), `Serveur démarré sur http://localhost:${port}`);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<h1>Connexion<\/h1>/);
  } finally {
    child.kill();
    await exited;
    await cyclos.close();
  }
});

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
