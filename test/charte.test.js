// === WHAT THIS FILE CHECKS ===
// The graphic charter of La Graine 34, as seen by the browser: each page has the stylesheet, the logo and the name of the tool; errors do not
// rely on colour alone (icon and the word "Erreur :", readable by screen readers); the declared fonts exist; colours
// are defined only once. For the merchant: a readable, accessible tool. Uses the harness and the fake Cyclos.
// Basic notions: test/statique.test.js.
// Tests of the graphic charter (HTML and CSS as the browser receives them).
// Run: npm test. Real server + local fake Cyclos, no external call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appTest } from "../test-support/harness.js";
import { entry } from "../test-support/fake-cyclos.js";

// ROOT: the project folder, used to re-read style.css from disk.
const ROOT = new URL("../", import.meta.url);
// A fixed period: the whole day of 10 January 2026.
const RANGE = { start: "2026-01-10T00:00", end: "2026-01-10T23:59" };

// One page of each kind, as HTML.
// Helper: visits ONE page of each kind (login, errors, filters, ticket, access denied, too many attempts...) and returns their HTML,
// filed by name. The following tests then check a rule on all these pages.
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

// Intention: ALL pages have the stylesheet, the French language, the viewport tag (correct display on a phone), and the logo
// with alternative text and dimensions (for screen readers and to stop the page "jumping" while loading).
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

// Intention (accessibility): an error message is never signalled by the red colour alone (invisible to a colour-blind person): it has an icon and the
// word "Erreur :", and `role="alert"` makes screen readers announce it. Pages without an error contain none.
appTest("erreurs : icône et libellé « Erreur : » en plus de la couleur, annoncées aux lecteurs d'écran", async (app) => {
  const all = await pages(app);
  for (const label of ["origine refusée", "connexion échouée", "filtres en erreur", "accès refusé", "trop de tentatives"]) {
    assert.match(all[label], /<p class="erreur" role="alert"><span class="icone" aria-hidden="true">⚠<\/span> <strong>Erreur :<\/strong>/, label);
  }
  for (const label of ["connexion", "filtres", "ticket"]) {
    assert.ok(!all[label].includes('class="erreur"'), `${label} : pas d'erreur`);
  }
});

// Intention: the "list limited" warning is also announced to screen readers (`role="alert"`).
appTest("ticket : avertissement de plafond avec role=alert", async (app) => {
  app.cyclos.state.entries = Array.from({ length: 2001 }, (_, n) => entry(2000 - n));
  const csrf = await app.loggedIn();
  const html = await (await app.request("/releve", { method: "POST", form: { csrf, ...RANGE } })).text();
  assert.match(html, /<p class="avertissement" role="alert">Attention : /);
});

// Intention: each font declared in the CSS is actually served (otherwise the browser would show a fallback font), no resource comes
// from an outside site, and `font-display: swap` displays the text right away while waiting for the font.
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

// Intention: the charter colours are declared only once (in `:root`, as variables) and never copied by hand elsewhere:
// changing a colour is done in one place. This test reads the file from disk: no server needed (hence `test` and not `appTest`).
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
