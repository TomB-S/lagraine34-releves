// === READ THIS FIRST: what is this file for? ===
// The "harness" is the toolbox shared by almost all tests.
// For each integration test, it starts: (1) a fake Cyclos (test-support/fake-cyclos.js) and
// (2) the REAL server of the tool (server.js), connected to that fake Cyclos. It also provides a small "browser"
// (`app.request`) that keeps the session cookie between two requests, like a real browser.
// A test thus reads: "I log in, I ask for a statement, I look at the answer". Nothing is simulated on the
// server side: the real code is tested, only Cyclos is replaced. Each test has its own servers, on a free port
// chosen at random, and everything is stopped at the end: tests do not disturb each other.
// Starts the real server (random port) against a fake Cyclos, and provides
// a small HTTP client that keeps the session cookie.
import http from "node:http";
import { test, mock } from "node:test";
import { startServer } from "../server.js";
import { startFakeCyclos, USER } from "./fake-cyclos.js";

// The expected Content Security Policy (CSP), written out in full: an HTTP header telling the browser
// what the page may load (here: only files from the site itself). See test/securite.test.js.
export const EXPECTED_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// Tests import USER from the harness so that there is a single entry point.
export { USER };

// Prepares a complete environment and returns `app`, the object tests work with:
// `app.request(...)` (send a request), `app.login()` / `app.loggedIn()` (log in), `app.cyclos` (drive the
// fake Cyclos), `app.server` (the real server), `app.close()` (stop everything). `options` is passed on to startServer()
// in server.js (for example { cookieSecure: true } or short session durations).
export async function setup(options = {}) {
  const cyclos = await startFakeCyclos();
  const server = await startServer({
    port: 0,
    host: "127.0.0.1",
    cyclosBaseUrl: cyclos.url,
    ...options,
  });
  const base = `http://127.0.0.1:${server.port}`;
  // The "cookie jar": a cookie is a small piece of text that the server asks the browser to send back with every
  // request. Here it is the `session` cookie that proves we are logged in. We keep it ourselves because fetch (Node's HTTP client)
  // does not remember cookies.
  let cookie = "";

  // fetch without following redirects; adds the current session cookie.
  // `redirect: "manual"`: fetch does not follow redirections (303). Tests therefore see the 303 itself
  // and its `Location` header, instead of the destination page. `form` sends a classic HTML form
  // (type application/x-www-form-urlencoded: "a=1&b=2").
  async function request(path, { method = "GET", form, headers = {}, body } = {}) {
    const init = { method, redirect: "manual", headers: { ...headers } };
    if (cookie) init.headers.Cookie = cookie;
    if (form) {
      init.headers["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      init.body = body;
    }
    const res = await fetch(`${base}${path}`, init);
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0].replace(/^session=$/, "");
    return res;
  }

  // Login with the fictitious credentials; returns the CSRF token of the /filtres page.
  // Sends the login form. The `Origin` header says which site the request comes from; the server
  // checks it (CSRF protection of the login, see test/connexion.test.js). Returns the raw response (303 if OK).
  async function login({ login = USER.login, password = USER.password } = {}) {
    const res = await request("/connexion", {
      method: "POST",
      form: { login, password },
      headers: { Origin: base },
    });
    return res;
  }

  // Reads the /filtres page and extracts the CSRF token hidden in the form (`<input type="hidden" name="csrf">`).
  // This token is required for POST actions; see test/connexion.test.js for an explanation of CSRF.
  async function csrf() {
    const html = await (await request("/filtres")).text();
    return html.match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  }

  // Shortcut: log in (fails loudly if the login is refused) then return the CSRF token,
  // ready to be used for a POST /releve.
  async function loggedIn() {
    const res = await login();
    if (res.status !== 303) throw new Error(`connexion refusée (${res.status})`);
    return csrf();
  }

  return {
    base,
    cyclos,
    server,
    request,
    login,
    csrf,
    loggedIn,
    get cookie() {
      return cookie;
    },
    set cookie(value) {
      cookie = value;
    },
    async close() {
      await server.close();
      await cyclos.close();
    },
  };
}

// Waits (up to 2 s) for a condition to become true, for example the arrival
// of a call with no awaited answer (closing of the Cyclos token).
// Some actions of the server happen "in the background" (for example closing the token at Cyclos after
// a logout). `until` retries every 20 ms (2 s at most) until the condition is true, otherwise it throws an error.
export async function until(condition, what = "condition") {
  for (let i = 0; i < 100; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Délai dépassé : ${what}`);
}

// A test with its own server and its own fake Cyclos (random port),
// stopped at the end. `app.logs` holds everything the server wrote with
// console.* during the test (which therefore does not show in the output).
// `appTest` replaces `test` for integration tests: it wraps the test with `setup()` at the start and
// `app.close()` at the end (even if the test fails: `finally` block). It also replaces console.log/error with a
// recorder, so that a test can check what the server writes to its log (`app.logs`) without cluttering the screen.
// Usage: appTest("title", async (app) => { ... }) or appTest("title", { options }, async (app) => { ... }).
export function appTest(name, optionsOrFn, maybeFn) {
  const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
  test(name, async () => {
    const logs = [];
    for (const level of ["log", "info", "warn", "error"]) {
      mock.method(console, level, (...args) => logs.push(args.map(String).join(" ")));
    }
    const app = await setup(options);
    app.logs = logs;
    try {
      await fn(app);
    } finally {
      mock.timers.reset();
      mock.restoreAll();
      await app.close();
    }
  });
}

// Raw HTTP request (path sent as is, body in chunks possible), for
// what fetch normalises or refuses to send.
// For cases where fetch "tidies up" the request too much (odd paths like /fonts/../server.js, body sent
// in chunks). Here we use Node's lower-level `http` module: what we write is sent as is.
export function rawRequest(base, { method = "GET", path = "/", headers = {}, chunks } = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, method, path, headers, agent: false }, (res) => {
      const parts = [];
      res.on("data", (part) => parts.push(part));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on("error", reject);
    for (const chunk of chunks ?? []) req.write(chunk);
    req.end();
  });
}
