// === LIRE EN PREMIER : à quoi sert ce fichier ? ===
// Le « harnais » (en anglais harness) est la boîte à outils commune à presque tous les tests.
// Pour chaque test d'intégration, il démarre : (1) un faux Cyclos (test-support/fake-cyclos.js) et
// (2) le VRAI serveur de l'outil (server.js), branché sur ce faux Cyclos. Il fournit aussi un petit « navigateur »
// (`app.request`) qui garde le cookie de session entre deux requêtes, comme un vrai navigateur.
// Un test écrit donc : « je me connecte, je demande un relevé, je regarde la réponse ». Rien n'est simulé côté
// serveur : on teste le vrai code, seul Cyclos est remplacé. Chaque test a ses propres serveurs, sur un port libre
// choisi au hasard, et tout est arrêté à la fin : les tests ne se gênent pas entre eux.
// Starts the real server (random port) against a fake Cyclos, and provides
// a small HTTP client that keeps the session cookie.
import http from "node:http";
import { test, mock } from "node:test";
import { startServer } from "../server.js";
import { startFakeCyclos, USER } from "./fake-cyclos.js";

// La politique de sécurité de contenu (CSP) attendue, écrite en dur : un en-tête HTTP qui dit au navigateur
// ce que la page a le droit de charger (ici : uniquement des fichiers du site lui-même). Voir test/securite.test.js.
export const EXPECTED_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// Les tests importent USER depuis le harnais pour n'avoir qu'un seul point d'entrée.
export { USER };

// Prépare un environnement complet et renvoie `app`, l'objet que les tests manipulent :
// `app.request(...)` (envoyer une requête), `app.login()` / `app.loggedIn()` (se connecter), `app.cyclos` (piloter le
// faux Cyclos), `app.server` (le vrai serveur), `app.close()` (tout arrêter). `options` est transmis à startServer()
// dans server.js (par exemple { cookieSecure: true } ou des durées de session courtes).
export async function setup(options = {}) {
  const cyclos = await startFakeCyclos();
  const server = await startServer({
    port: 0,
    host: "127.0.0.1",
    cyclosBaseUrl: cyclos.url,
    ...options,
  });
  const base = `http://127.0.0.1:${server.port}`;
  // Le « cookie jar » : un cookie est un petit texte que le serveur demande au navigateur de renvoyer à chaque
  // requête. Ici, c'est le cookie `session` qui prouve qu'on est connecté. On le garde nous-mêmes car fetch (le client HTTP
  // de Node) n'a pas de mémoire des cookies.
  let cookie = "";

  // fetch without following redirects; adds the current session cookie.
  // `redirect: "manual"` : fetch ne suit pas les redirections (303). Ainsi les tests voient la 303 elle-même
  // et son en-tête `Location`, au lieu de la page d'arrivée. `form` envoie un formulaire HTML classique
  // (type application/x-www-form-urlencoded : « a=1&b=2 »).
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
  // Envoie le formulaire de connexion. L'en-tête `Origin` indique de quel site vient la requête ; le serveur
  // le vérifie (protection CSRF de la connexion, voir test/connexion.test.js). Renvoie la réponse brute (303 si OK).
  async function login({ login = USER.login, password = USER.password } = {}) {
    const res = await request("/connexion", {
      method: "POST",
      form: { login, password },
      headers: { Origin: base },
    });
    return res;
  }

  // Lit la page /filtres et en extrait le jeton CSRF caché dans le formulaire (`<input type="hidden" name="csrf">`).
  // Ce jeton est exigé pour les actions POST ; voir test/connexion.test.js pour l'explication du CSRF.
  async function csrf() {
    const html = await (await request("/filtres")).text();
    return html.match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  }

  // Raccourci : se connecter (échoue bruyamment si la connexion est refusée) puis renvoyer le jeton CSRF,
  // prêt à servir pour un POST /releve.
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
// Certaines actions du serveur se font « en arrière-plan » (par exemple fermer le jeton chez Cyclos après
// une déconnexion). `until` réessaie toutes les 20 ms (au plus 2 s) jusqu'à ce que la condition soit vraie, sinon il lève une erreur.
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
// `appTest` remplace `test` pour les tests d'intégration : il enveloppe le test avec `setup()` au début et
// `app.close()` à la fin (même si le test échoue : bloc `finally`). Il remplace aussi console.log/error par un
// enregistreur, pour que le test puisse vérifier ce que le serveur écrit dans son journal (`app.logs`) sans polluer l'écran.
// Usage : appTest("titre", async (app) => { ... }) ou appTest("titre", { options }, async (app) => { ... }).
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
// Pour les cas où fetch « arrange » trop la requête (chemins bizarres comme /fonts/../server.js, corps envoyé
// en morceaux). On utilise ici le module `http` de Node, plus bas niveau : ce qu'on écrit est envoyé tel quel.
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
