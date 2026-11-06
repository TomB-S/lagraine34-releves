// Tests de la charte graphique (HTML et CSS tels que le navigateur les reçoit).
// Lancer : npm test. Vrai serveur + faux Cyclos local, aucun appel externe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appTest } from "../test-support/harness.js";
import { entry } from "../test-support/fake-cyclos.js";

const ROOT = new URL("../", import.meta.url);
const RANGE = { start: "2026-01-10T00:00", end: "2026-01-10T23:59" };

// Une page de chaque sorte, sous forme de HTML.
async function pages(app) {
  const html = {};
  const text = async (label, promise) => {
    html[label] = await (await promise).text();
  };
  app.cyclos.state.entries = [entry(1)];
  await text("connexion", app.request("/"));
  await text("origine refusée", app.request("/connexion", { method: "POST", form: { login: "a", password: "b" } }));
  await text("connexion échouée", app.login({ password: "faux" }));
  await app.login();
  const csrf = await app.csrf();
  await text("filtres", app.request("/filtres"));
  await text("filtres en erreur", app.request("/releve", { method: "POST", form: { csrf, start: "x", end: "y" } }));
  await text("ticket", app.request("/releve", { method: "POST", form: { csrf, ...RANGE } }));
  app.cyclos.force("GET /self/accounts", 403);
  await text("accès refusé", app.request("/releve", { method: "POST", form: { csrf, ...RANGE } }));
  app.cyclos.state.forced.clear();
  for (let i = 0; i < 5; i += 1) await app.login({ password: "faux" });
  app.cookie = "";
  await text("trop de tentatives", app.login());
  return html;
}

appTest("pages : feuille de style, en-tête avec logo (alt, width, height) et nom de l'outil", async (app) => {
  const all = await pages(app);
  assert.equal(Object.keys(all).length, 8);
  for (const [label, html] of Object.entries(all)) {
    assert.match(html, /<link rel="stylesheet" href="\/style\.css">/, label);
    assert.match(html, /<html lang="fr">/, label);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, label);
    const img = html.match(/<img [^>]*>/)?.[0];
    assert.ok(img, `${label} : <img>`);
    assert.match(img, /src="\/logo\.png"/, label);
    assert.match(img, /alt="[^"]+"/, label);
    assert.match(img, /width="\d+"/, label);
    assert.match(img, /height="\d+"/, label);
    assert.match(html, /class="nom-outil">Relevés de service</, label);
  }
});

appTest("erreurs : icône et libellé « Erreur : » en plus de la couleur, annoncées aux lecteurs d'écran", async (app) => {
  const all = await pages(app);
  for (const label of ["origine refusée", "connexion échouée", "filtres en erreur", "accès refusé", "trop de tentatives"]) {
    assert.match(all[label], /<p class="erreur" role="alert"><span class="icone" aria-hidden="true">⚠<\/span> <strong>Erreur :<\/strong>/, label);
  }
  for (const label of ["connexion", "filtres", "ticket"]) {
    assert.ok(!all[label].includes('class="erreur"'), `${label} : pas d'erreur`);
  }
});

appTest("ticket : avertissement de plafond avec role=alert", async (app) => {
  app.cyclos.state.entries = Array.from({ length: 2001 }, (_, n) => entry(2000 - n));
  const csrf = await app.loggedIn();
  const html = await (await app.request("/releve", { method: "POST", form: { csrf, ...RANGE } })).text();
  assert.match(html, /<p class="avertissement" role="alert">Attention : /);
});

appTest("style.css : chaque police déclarée est servie, polices en swap", async (app) => {
  const css = await (await app.request("/style.css")).text();
  const urls = [...css.matchAll(/url\(["']?(\/fonts\/[^)"']+)["']?\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 3, "polices déclarées");
  for (const url of urls) {
    const res = await app.request(url);
    assert.equal(res.status, 200, url);
    assert.equal(res.headers.get("content-type"), "font/woff2", url);
  }
  assert.ok(!/url\(["']?(https?:)?\/\//.test(css), "aucune ressource externe");
  assert.ok(!/@import/.test(css));
  assert.equal([...css.matchAll(/font-display:\s*swap/g)].length, css.match(/@font-face/g).length);
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
});
