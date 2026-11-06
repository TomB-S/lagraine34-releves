// === LIRE EN PREMIER : à quoi sert ce fichier ? ===
// Ce n'est pas un test : c'est un OUTIL utilisé par les tests.
// Cyclos est le logiciel qui gère les comptes de la monnaie locale. Notre outil lui parle par une
// API REST, c'est-à-dire par des requêtes HTTP (une méthode + un chemin, par exemple « GET /self/accounts »)
// auxquelles Cyclos répond en JSON (un format texte pour des données : { "clé": "valeur" }).
// Dans les tests, on ne veut JAMAIS parler au vrai Cyclos : il faudrait du réseau, de vrais comptes, et les
// résultats changeraient d'un jour à l'autre. Ce fichier lance donc un petit serveur HTTP LOCAL qui répond
// comme Cyclos, avec des données inventées. Il imite seulement les routes que notre outil utilise :
//   POST   /auth/session                    connexion (identifiant + mot de passe -> jeton de session)
//   DELETE /auth/session                    déconnexion (le jeton est fermé côté Cyclos)
//   GET    /users/self                      nom d'affichage du commerçant
//   GET    /self/accounts                   liste des comptes du commerçant
//   GET    /self/accounts/membre            totaux (reçus, sortis, solde net) sur une période
//   GET    /self/accounts/membre/history    transactions, PAGE par PAGE
// Toute autre route répond 404. Les tests peuvent lui faire simuler : un mauvais mot de passe (401), un
// refus (403), une panne (500), une connexion coupée (« drop »), un jeton expiré, plusieurs pages de
// transactions, et la réponse « sans totaux » de la vraie instance. Voir `state` et les fonctions renvoyées
// tout en bas du fichier.
// Fake Cyclos for the tests: a small local HTTP server that imitates the
// endpoints used by the server. No external network, fictitious credentials.
import http from "node:http";

// Identifiants FICTIFS du commerçant de test. Aucun vrai mot de passe n'est utilisé dans ce projet.
export const USER = { login: "commercant", password: "motdepasse-de-test", display: "Boutique de Test" };

// Fabrique une transaction fictive. `n` sert à la rendre unique et à l'ordonner dans le temps
// (la n-ième est n minutes après la précédente) ; le montant par défaut est 10.00.
// Builds a history line in Cyclos' format (negative amount = outgoing payment).
export function entry(n, { amount = "10.00", date, description, who = "Client" } = {}) {
  const base = Date.parse("2026-01-10T08:00:00Z") + n * 60_000;
  return {
    transactionNumber: `T${String(n).padStart(5, "0")}`,
    date: date ?? new Date(base).toISOString(),
    amount,
    description: description ?? `Achat ${n}`,
    relatedAccount: { user: { display: `${who} ${n}` } },
  };
}

// Démarre le faux Cyclos et renvoie de quoi le piloter : son adresse (`url`), son état (`state`)
// et quelques fonctions (`force`, `expireTokens`, `calls`, `close`). `async` : la fonction attend (`await`)
// que le serveur soit prêt avant de rendre la main ; voir test/statique.test.js pour l'explication d'async/await.
export async function startFakeCyclos() {
  // `state` est la mémoire du faux Cyclos. Les tests la MODIFIENT avant d'agir pour fabriquer la situation
  // voulue (par exemple `app.cyclos.state.entries = [...]` pour choisir les transactions renvoyées).
  const state = {
    requests: [], // { method, path, headers, query } of each call received
    tokens: new Set(),
    deleted: [], // tokens closed by DELETE /auth/session
    entries: [], // most recent first, like Cyclos
    pageSize: null, // when set, forces the page size (otherwise the requested one)
    totals: null, // when set, replaces the computed totals
    // false: reproduces the real instance, which answers without incoming, outgoing
    // or netInflow (only balances and credit limits).
    indicators: true,
    accountsBody: undefined, // when set, replaces the answer to GET /self/accounts
    displayName: USER.display,
    // Forced answers: "METHOD /path" -> status (e.g. "GET /self/accounts": 403).
    forced: new Map(),
    currency: { name: "Graines", decimalDigits: 2 },
    counter: 0,
  };

  function json(res, status, body, headers = {}) {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  // Chaque requête reçue passe ici. On la note dans `state.requests` : les tests pourront ainsi vérifier
  // ce que NOTRE serveur a envoyé à Cyclos (quels appels, avec quels en-têtes). `key` ressemble à « GET /self/accounts ».
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fake");
    const path = url.pathname.replace(/^\/api/, "");
    const key = `${req.method} ${path}`;
    state.requests.push({
      method: req.method,
      path,
      headers: req.headers,
      query: url.searchParams,
    });
    req.resume();

    // Situation forcée : si un test a demandé « cette route doit échouer », on répond tout de suite avec ce
    // statut (401, 403, 500...) sans regarder le reste. « drop » coupe la connexion : le client reçoit une erreur réseau.
    const forced = state.forced.get(key);
    if (forced) {
      if (forced === "drop") return req.socket.destroy();
      return json(res, forced, { code: forced === 401 ? "loggedOut" : forced === 403 ? "forbidden" : "unknownError" });
    }

    // Connexion. L'en-tête HTTP `Authorization: Basic xxx` contient « identifiant:motdepasse » encodé en base64
    // (un simple codage, pas du chiffrement). On le décode (`Buffer` : voir test/statique.test.js) et on compare à USER.
    // Si c'est bon, on invente un jeton de session (« jeton-1 », « jeton-2 »...) ; sinon 401 (non authentifié).
    if (key === "POST /auth/session") {
      const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
      const [login, ...rest] = Buffer.from(encoded ?? "", "base64").toString("utf-8").split(":");
      if (scheme !== "Basic" || login !== USER.login || rest.join(":") !== USER.password) {
        return json(res, 401, { code: "login" });
      }
      const token = `jeton-${++state.counter}`;
      state.tokens.add(token);
      return json(res, 200, { sessionToken: token, user: { display: USER.display }, permissions: ["secret"] });
    }

    // Après la connexion, notre outil n'envoie plus le mot de passe : il envoie le jeton dans l'en-tête `Session-Token`.
    // Un jeton inconnu (ou expiré) est refusé avec 401, comme le ferait le vrai Cyclos.
    const token = req.headers["session-token"];
    if (!state.tokens.has(token)) return json(res, 401, { code: "loggedOut" });

    if (key === "DELETE /auth/session") {
      state.tokens.delete(token);
      state.deleted.push(token);
      res.writeHead(204);
      return res.end();
    }
    if (key === "GET /users/self") return json(res, 200, { display: state.displayName });
    if (key === "GET /self/accounts") {
      if (state.accountsBody !== undefined) return json(res, 200, state.accountsBody);
      return json(res, 200, [{ type: { internalName: "membre" }, currency: state.currency }]);
    }
    // Totaux de la période. « membre » est le type du compte fictif. Avec `state.indicators = false`, on imite la vraie
    // instance, qui ne renvoie pas les totaux reçus/sortis : c'est alors à notre outil de les calculer (voir test/totaux-calcules.test.js).
    if (key === "GET /self/accounts/membre") {
      if (!state.indicators) {
        return json(res, 200, {
          status: {
            balance: "125.00",
            availableBalance: "125.00",
            creditLimit: "0.00",
            reservedAmount: "0.00",
            beginDate: "2026-01-01T00:00:00.000+01:00",
            endDate: "2026-02-01T00:00:00.000+01:00",
            upperCreditLimit: "1000.00",
          },
        });
      }
      if (state.totals) return json(res, 200, { status: state.totals });
      const sum = (list) => list.reduce((total, e) => total + Math.abs(Number(e.amount)), 0).toFixed(2);
      const incoming = state.entries.filter((e) => Number(e.amount) > 0);
      const outgoing = state.entries.filter((e) => Number(e.amount) < 0);
      return json(res, 200, {
        status: {
          incoming: { count: incoming.length, sum: sum(incoming) },
          outgoing: { count: outgoing.length, sum: sum(outgoing) },
          netInflow: (Number(sum(incoming)) - Number(sum(outgoing))).toFixed(2),
        },
      });
    }
    // Historique PAGINÉ : au lieu de tout renvoyer d'un coup, Cyclos découpe en pages. Le client demande `page` (0, 1, 2...)
    // et `pageSize` (lignes par page) ; l'en-tête `X-Has-Next-Page: true` dit s'il reste une page à lire.
    if (key === "GET /self/accounts/membre/history") {
      const page = Number(url.searchParams.get("page") ?? 0);
      const size = state.pageSize ?? Number(url.searchParams.get("pageSize") ?? 40);
      const slice = state.entries.slice(page * size, (page + 1) * size);
      const hasNext = (page + 1) * size < state.entries.length;
      return json(res, 200, slice, { "X-Has-Next-Page": String(hasNext) });
    }
    json(res, 404, { code: "notFound" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    // Ce que les tests reçoivent pour piloter le faux Cyclos :
    url: `http://127.0.0.1:${server.address().port}/api`,
    state,
    // Every token becomes invalid (token expired on the Cyclos side).
    expireTokens: () => state.tokens.clear(),
    // Calls "METHOD /path" answer with this status ("drop" cuts the connection).
    force: (key, status) => state.forced.set(key, status),
    calls: (method, path) => state.requests.filter((r) => r.method === method && r.path === path),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
