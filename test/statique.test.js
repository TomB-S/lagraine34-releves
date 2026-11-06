// === READ THIS FIRST: this file is the MODEL ===
// It checks that the tool correctly serves its "static" files (the stylesheet, the logo, the fonts): right type,
// caching, protection against reading other files of the server (the code, the config). For a merchant, this is
// what makes pages readable and fast; for security, it is what prevents anyone from reading server.js or .git/
// through the URL. It uses the harness (test-support/harness.js: real server + fake Cyclos). The first test is
// commented step by step: read it first, the other files follow the same pattern.
//
// The three steps of a test: 1) ARRANGE the situation, 2) ACT (send a request), 3) CHECK the response.
//
// Notions used throughout the project (explained here once, the other files point back here):
//  - `node:test` is Node's built-in test module; `npm test` runs `node --test`, which executes all
//    *.test.js files. A test is a function: if nothing abnormal happens it passes, if an error is thrown
//    it fails. `appTest(title, function)` (from the harness) is a `test` that starts the servers first.
//  - `assert` (node:assert/strict) provides the checks: `assert.equal(a, b)` fails if a !== b;
//    `assert.ok(x)` fails if x is falsy; `assert.match(text, /regex/)` fails if the text does not match;
//    `assert.deepEqual` compares the content of arrays/objects. The last argument is the message shown on failure.
//  - `async` / `await`: talking to a server takes time. `await` pauses the test until the response arrives
//    (without blocking Node); a function that contains `await` must be declared `async`.
//  - HTTP headers: lines of information that go with every request and every response
//    (Content-Type, Cache-Control...). With fetch they are read with `res.headers.get("name")` (case does not matter).
//  - `Buffer`: Node's representation of a sequence of bytes (the content of an image, a font, a PDF).
//  - An HTTP status is a three-digit code: 200 = OK, 303 = redirection, 304 = "nothing new",
//    400 = invalid request, 401 = not authenticated, 403 = forbidden, 404 = not found, 5xx = server-side failure.
// Static files: /style.css, /logo.png, /fonts/*.woff2.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appTest, rawRequest } from "../test-support/harness.js";

// ROOT: the project folder, used to re-read the real files on disk and compare them with what the server serves.
const ROOT = new URL("../", import.meta.url);
// An array of cases: [address requested from the server, real file on disk, expected content type].
const FILES = [
  ["/style.css", "style.css", "text/css; charset=utf-8"],
  ["/logo.png", "logo-lagraine34.png", "image/png"],
  ["/fonts/roboto-latin-400-normal.woff2", "fonts/roboto-latin-400-normal.woff2", "font/woff2"],
  ["/fonts/roboto-latin-700-normal.woff2", "fonts/roboto-latin-700-normal.woff2", "font/woff2"],
  ["/fonts/voltaire-latin-400-normal.woff2", "fonts/voltaire-latin-400-normal.woff2", "font/woff2"],
];

// MODEL TO READ FIRST. Intention: each static file is served with the right type, a cache duration and
// an ETag, and its content is identical to the file on disk. If this broke: a font or the logo could display
// wrongly, or the browser would never cache it.
//
// Cache and ETag: `Cache-Control: public, max-age=3600` allows the browser to keep the file for 1 hour. The ETag is
// a fingerprint of the content: on reload, the browser sends it back and the server can answer 304 without resending the file.
// `async (app) => {...}`: the test function; `app` is provided by appTest (see test-support/harness.js).
appTest("fichiers statiques : bon type, cache public, ETag, contenu identique au fichier", async (app) => {
  // 1) ARRANGE: an empty set where we will put the ETags seen; a Set only keeps distinct values.
  const etags = new Set();
  // The same checks are repeated for each of the five files.
  for (const [route, file, type] of FILES) {
    // 2) ACT: ask the real server for the file, as a browser would. `await` waits for the response.
    const res = await app.request(route);
    // 3) CHECK. First the status: 200 = found. `route` as last argument is shown if the test fails,
    // to tell WHICH file is the problem.
    assert.equal(res.status, 200, route);
    // The content type: without it the browser would not know that a file is CSS or a font.
    assert.equal(res.headers.get("content-type"), type, route);
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600", route);
    const etag = res.headers.get("etag");
    // `/^...$/` is a regular expression (a text pattern): here, 16 hexadecimal characters between quotes.
    assert.match(etag, /^"[0-9a-f]{16}"$/, route);
    etags.add(etag);
    // The response body (bytes) must be strictly identical to the file read from disk.
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), readFileSync(new URL(file, ROOT)), route);
    // A static file must not open a session: no cookie set (`null` = header absent).
    assert.equal(res.headers.get("set-cookie"), null, route);
  }
  // Five different files => five different ETags (otherwise the fingerprint would distinguish nothing).
  assert.equal(etags.size, FILES.length, "un ETag par fichier");
});

// Intention: check that the files are REALLY PNG and woff2 (their first bytes, the "signature"),
// not an error text served with the wrong type. Otherwise the logo or the fonts would be broken.
appTest("fichiers statiques : signatures (PNG, woff2)", async (app) => {
  const png = Buffer.from(await (await app.request("/logo.png")).arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const [route] of FILES.slice(2)) {
    const font = Buffer.from(await (await app.request(route)).arrayBuffer());
    assert.equal(font.subarray(0, 4).toString(), "wOF2", route);
  }
});

// Intention: on revalidation, if the browser sends the ETag it knows (`If-None-Match`), the server answers 304
// without a body (saves data); with an unknown ETag it sends the whole file (200). Otherwise either everything would be
// resent every time, or stale files would be left in place.
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

// Intention: the logo and the CSS must display on the login page, hence without being logged in, and without
// querying Cyclos (the fake Cyclos received no request). Otherwise the login page would have no style.
appTest("fichiers statiques : accessibles sans session, aucun appel à Cyclos", async (app) => {
  for (const [route] of FILES) assert.equal((await app.request(route)).status, 200);
  assert.equal(app.cyclos.state.requests.length, 0);
});

// Intention (security): only the five known files are served. Any other address, including the
// "../" tricks (going up in the folders, sometimes encoded as %2e%2e), must give 404 and never let anyone read server.js,
// package.json, .git/... If this broke, a visitor could read the code or the configuration of the server.
// `rawRequest` sends the path as is, because fetch "cleans" these paths before sending them.
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

// Intention: only the GET method serves a file (POST, PUT, DELETE give 404). Otherwise we would expose useless routes.
appTest("fichiers statiques : seule la méthode GET est servie", async (app) => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await app.request("/style.css", { method });
    assert.equal(res.status, 404, method);
  }
});
