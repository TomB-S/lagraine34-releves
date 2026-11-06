// Static files: /style.css, /logo.png, /fonts/*.woff2.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appTest, rawRequest } from "../test-support/harness.js";

const ROOT = new URL("../", import.meta.url);
const FILES = [
  ["/style.css", "style.css", "text/css; charset=utf-8"],
  ["/logo.png", "logo-lagraine34.png", "image/png"],
  ["/fonts/roboto-latin-400-normal.woff2", "fonts/roboto-latin-400-normal.woff2", "font/woff2"],
  ["/fonts/roboto-latin-700-normal.woff2", "fonts/roboto-latin-700-normal.woff2", "font/woff2"],
  ["/fonts/voltaire-latin-400-normal.woff2", "fonts/voltaire-latin-400-normal.woff2", "font/woff2"],
];

appTest("fichiers statiques : bon type, cache public, ETag, contenu identique au fichier", async (app) => {
  const etags = new Set();
  for (const [route, file, type] of FILES) {
    const res = await app.request(route);
    assert.equal(res.status, 200, route);
    assert.equal(res.headers.get("content-type"), type, route);
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600", route);
    const etag = res.headers.get("etag");
    assert.match(etag, /^"[0-9a-f]{16}"$/, route);
    etags.add(etag);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), readFileSync(new URL(file, ROOT)), route);
    assert.equal(res.headers.get("set-cookie"), null, route);
  }
  assert.equal(etags.size, FILES.length, "un ETag par fichier");
});

appTest("fichiers statiques : signatures (PNG, woff2)", async (app) => {
  const png = Buffer.from(await (await app.request("/logo.png")).arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const [route] of FILES.slice(2)) {
    const font = Buffer.from(await (await app.request(route)).arrayBuffer());
    assert.equal(font.subarray(0, 4).toString(), "wOF2", route);
  }
});

appTest("fichiers statiques : 304 sans corps à la revalidation, 200 si l'ETag ne correspond pas", async (app) => {
  for (const [route] of FILES) {
    const first = await app.request(route);
    const etag = first.headers.get("etag");
    const again = await app.request(route, { headers: { "If-None-Match": etag } });
    assert.equal(again.status, 304, route);
    assert.equal(again.headers.get("etag"), etag, route);
    assert.equal(again.headers.get("cache-control"), "public, max-age=3600", route);
    assert.equal((await again.arrayBuffer()).byteLength, 0, route);
    const other = await app.request(route, { headers: { "If-None-Match": '"0000000000000000"' } });
    assert.equal(other.status, 200, route);
  }
});

appTest("fichiers statiques : accessibles sans session, aucun appel à Cyclos", async (app) => {
  for (const [route] of FILES) assert.equal((await app.request(route)).status, 200);
  assert.equal(app.cyclos.state.requests.length, 0);
});

appTest("/fonts/ : chemin non listé -> 404, y compris avec ../ ou ses variantes encodées", async (app) => {
  const paths = [
    "/fonts/",
    "/fonts",
    "/fonts/inconnue.woff2",
    "/fonts/LICENSES.txt",
    "/fonts/roboto-latin-400-normal.woff",
    "/fonts/ROBOTO-LATIN-400-NORMAL.WOFF2",
    "/fonts/roboto-latin-400-normal.woff2/",
    "/fonts/../server.js",
    "/fonts/../package.json",
    "/fonts/../fonts/roboto-latin-400-normal.woff2/../../server.js",
    "/fonts/%2e%2e/server.js",
    "/fonts/..%2fserver.js",
    "/fonts/%2e%2e%2fserver.js",
    "/fonts/..\\server.js",
    "/fonts//roboto-latin-400-normal.woff2",
    "/fonts/roboto-latin-400-normal.woff2%00.png",
    "/fonts/roboto-latin-400-normal.woff2?x=../../server.js",
    "/logo-lagraine34.png",
    "/server.js",
    "/package.json",
    "/ticket-pdf.js",
    "/node_modules/luxon/package.json",
    "/.git/config",
    "/STYLE.CSS",
    "/style.css/",
  ];
  for (const path of paths) {
    const res = await rawRequest(app.base, { path });
    const expected = path.includes("?") ? 200 : 404; // the query (?x=) is ignored for the route
    assert.equal(res.status, expected, path);
    if (expected === 404) {
      assert.equal(res.body.toString(), "Page introuvable", path);
      assert.equal(res.headers["cache-control"], "no-store", path);
    }
    assert.ok(!/createServer|"name": "prod"/.test(res.body.toString("latin1")), `${path} : fichier du serveur exposé`);
  }
});

appTest("fichiers statiques : seule la méthode GET est servie", async (app) => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await app.request("/style.css", { method });
    assert.equal(res.status, 404, method);
  }
});
