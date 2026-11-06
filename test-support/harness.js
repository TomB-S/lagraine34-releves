// Démarre le vrai serveur (port aléatoire) face à un faux Cyclos, et fournit
// un petit client HTTP qui garde le cookie de session.
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
