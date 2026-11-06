// Starts the real server (random port) against a fake Cyclos, and provides
// a small HTTP client that keeps the session cookie.
import http from "node:http";
import { test, mock } from "node:test";
import { startServer } from "../server.js";
import { startFakeCyclos, USER } from "./fake-cyclos.js";

export const EXPECTED_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export { USER };

export async function setup(options = {}) {
  const cyclos = await startFakeCyclos();
  const server = await startServer({
    port: 0,
    host: "127.0.0.1",
    cyclosBaseUrl: cyclos.url,
    ...options,
  });
  const base = `http://127.0.0.1:${server.port}`;
  let cookie = "";

  // fetch without following redirects; adds the current session cookie.
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
  async function login({ login = USER.login, password = USER.password } = {}) {
    const res = await request("/connexion", {
      method: "POST",
      form: { login, password },
      headers: { Origin: base },
    });
    return res;
  }

  async function csrf() {
    const html = await (await request("/filtres")).text();
    return html.match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  }

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
