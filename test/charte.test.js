// Tests de la charte graphique. Lancer : npm test
// Le serveur est démarré dans un processus séparé, sur un port libre ; aucun
// appel à Cyclos n'est fait (seules les pages qui s'affichent sans session
// sont testées : connexion et « Requête refusée »).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";

const ROOT = new URL("../", import.meta.url);
const EXPECTED_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

let child;
let base;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`serveur arrêté (code ${code})`)));
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Serveur démarré")) resolve();
    });
  });
});

after(() => child?.kill());

// Pages HTML qui s'affichent sans session.
async function pages() {
  const login = await fetch(`${base}/`);
  const refused = await fetch(`${base}/connexion`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "login=a&password=b",
  });
  assert.equal(refused.status, 403);
  return { login: await login.text(), refused: await refused.text() };
}

test("GET /logo.png : image, cache et revalidation 304 comme /style.css", async () => {
  const res = await fetch(`${base}/logo.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  const css = await fetch(`${base}/style.css`);
  assert.equal(res.headers.get("cache-control"), css.headers.get("cache-control"));
  assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
  const etag = res.headers.get("etag");
  assert.match(etag, /^"[0-9a-f]{16}"$/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(bytes, readFileSync(new URL("logo-lagraine34.png", ROOT)));
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");

  const again = await fetch(`${base}/logo.png`, { headers: { "If-None-Match": etag } });
  assert.equal(again.status, 304);
  assert.equal((await again.arrayBuffer()).byteLength, 0);
});

test("polices : woff2 servies par nous, autres chemins refusés", async () => {
  for (const name of [
    "roboto-latin-400-normal",
    "roboto-latin-700-normal",
    "voltaire-latin-400-normal",
  ]) {
    const res = await fetch(`${base}/fonts/${name}.woff2`);
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get("content-type"), "font/woff2");
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), "wOF2");
  }
  for (const path of ["/fonts/LICENSES.txt", "/fonts/", "/fonts/../server.js", "/logo-lagraine34.png"]) {
    const res = await fetch(`${base}${path}`);
    assert.notEqual(res.status, 200, path);
  }
});

test("CSP exacte, sur les pages comme sur les fichiers statiques", async () => {
  for (const path of ["/", "/style.css", "/logo.png", "/fonts/roboto-latin-400-normal.woff2"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP, path);
  }
  assert.ok(!EXPECTED_CSP.includes("unsafe-"));
  assert.ok(!/https?:|\/\/|script-src/.test(EXPECTED_CSP));
});

test("pages : ni style=, ni <style, ni <script", async () => {
  const { login, refused } = await pages();
  for (const html of [login, refused]) {
    assert.ok(!/\sstyle\s*=/i.test(html));
    assert.ok(!/<style/i.test(html));
    assert.ok(!/<script/i.test(html));
  }
});

test("pages : en-tête avec logo (alt, width, height) et feuille de style", async () => {
  const { login, refused } = await pages();
  for (const html of [login, refused]) {
    assert.match(html, /<link rel="stylesheet" href="\/style\.css">/);
    const img = html.match(/<img [^>]*>/)?.[0];
    assert.ok(img, "balise <img>");
    assert.match(img, /src="\/logo\.png"/);
    assert.match(img, /alt="[^"]+"/);
    assert.match(img, /width="\d+"/);
    assert.match(img, /height="\d+"/);
  }
});

test("erreur : libellé et icône en plus de la couleur", async () => {
  const { refused } = await pages();
  assert.match(refused, /class="erreur" role="alert"/);
  assert.match(refused, /<strong>Erreur :<\/strong>/);
  assert.match(refused, /aria-hidden="true">⚠</);
});

test("source : aucun gabarit HTML de server.js n'utilise style=, <style ni <script", () => {
  const source = readFileSync(new URL("server.js", ROOT), "utf8");
  assert.ok(!/\sstyle\s*=\s*["']/i.test(source));
  assert.ok(!/<style/i.test(source));
  assert.ok(!/<script/i.test(source));
});

test("style.css : couleurs définies une seule fois, dans :root", () => {
  const css = readFileSync(new URL("style.css", ROOT), "utf8");
  const root = css.match(/:root\s*{[^}]*}/)[0];
  const outside = css.replace(root, "");
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(outside), "couleur hexadécimale hors :root");
  assert.ok(!/\b(rgba?|hsla?)\(/i.test(outside), "rgb()/hsl() hors :root");
  for (const hex of ["#227a44", "#23a455", "#ec111b", "#202020", "#707070", "#b7b4b4"]) {
    assert.ok(root.toLowerCase().includes(hex), hex);
  }
  assert.ok(/font-display:\s*swap/.test(css));
});
