// === CE QUE VÉRIFIE CE FICHIER ===
// Le démarrage réel de l'outil avec `node server.js`, tel que l'opérateur le lance. Les autres tests démarrent le serveur par du code ; ici on lance
// un VRAI processus Node (`spawn`) et on lit ce qu'il affiche. On vérifie que l'import du fichier ne démarre rien (important pour les tests), que
// le port (PORT) et l'adresse de Cyclos (CYCLOS_BASE_URL) de l'environnement sont bien pris en compte. Utilise le faux Cyclos.
// Notions de base (assert, async) : test/statique.test.js.
// "node server.js" starts as before; importing the file starts nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startFakeCyclos } from "../test-support/fake-cyclos.js";

// ROOT : le dossier du projet, où lancer `node server.js`.
const ROOT = new URL("../", import.meta.url);

// Lance un processus Node avec les variables d'environnement données, et rassemble tout ce qu'il écrit (sortie normale et erreurs)
// dans `output()`. `exited` est une promesse qui se réalise à la fin du processus.
function run(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, CYCLOS_CHANNEL: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, exited, output: () => output };
}

// Intention : IMPORTER server.js ne doit démarrer aucun serveur et ne rien afficher, sinon chaque fichier de test qui l'importe
// ouvrirait un port. Le processus doit se terminer seul, avec le code 0 (succès).
test("importer server.js ne démarre aucun serveur et le processus se termine", async () => {
  const { exited, output } = run(["--input-type=module", "-e", 'await import("./server.js")'], { PORT: "1" });
  assert.equal(await exited, 0);
  assert.equal(output(), "");
});

// Intention : lancé pour de bon, le serveur écoute sur le port demandé (variable PORT), affiche son adresse et le canal, et sert la page de
// connexion. Le port est tiré au hasard pour ne pas entrer en conflit avec un autre programme. Le bloc `finally` arrête toujours le processus.
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

// Intention : l'adresse de Cyclos donnée par la variable d'environnement CYCLOS_BASE_URL est bien utilisée pour la connexion (le faux Cyclos reçoit
// l'appel). On ajoute volontairement un « / » final pour vérifier qu'il est ignoré. Sans cela, l'outil interrogerait la démo de Cyclos.
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
