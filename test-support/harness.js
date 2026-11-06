// Démarre le vrai serveur (port aléatoire) face à un faux Cyclos, et fournit
// un petit client HTTP qui garde le cookie de session.
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

  // fetch sans suivre les redirections ; ajoute le cookie de session courant.
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

  // Connexion avec les identifiants fictifs ; renvoie le jeton CSRF de la page /filtres.
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

// Attend (jusqu'à 2 s) qu'une condition devienne vraie, par exemple l'arrivée
// d'un appel sans réponse attendue (fermeture du jeton Cyclos).
export async function until(condition, what = "condition") {
  for (let i = 0; i < 100; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Délai dépassé : ${what}`);
}

// Un test avec son propre serveur et son propre faux Cyclos (port aléatoire),
// arrêtés à la fin. `app.logs` contient tout ce que le serveur a écrit avec
// console.* pendant le test (qui n'apparaît donc pas dans la sortie).
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

// Requête HTTP brute (chemin envoyé tel quel, corps en morceaux possible), pour
// ce que fetch normalise ou refuse d'envoyer.
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
