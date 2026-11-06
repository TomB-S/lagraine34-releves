// === READ THIS FIRST: what is this file for? ===
// This is not a test: it is a TOOL used by the tests.
// Cyclos is the software that manages the local currency accounts. Our tool talks to it through a REST
// API, that is, through HTTP requests (a method + a path, for example "GET /self/accounts") to which Cyclos
// answers in JSON (a text format for data: { "key": "value" }).
// In the tests we NEVER want to talk to the real Cyclos: it would need a network, real accounts, and the
// results would change from one day to the next. This file therefore starts a small LOCAL HTTP server that
// answers like Cyclos, with made-up data. It only imitates the routes our tool uses:
//   POST   /auth/session                    login (login + password -> session token)
//   DELETE /auth/session                    logout (the token is closed on the Cyclos side)
//   GET    /users/self                      display name of the merchant
//   GET    /self/accounts                   list of the merchant's accounts
//   GET    /self/accounts/membre            totals (received, sent, net balance) over a period
//   GET    /self/accounts/membre/history    transactions, PAGE by page
// Any other route answers 404. The tests can make it simulate: a wrong password (401), a refusal (403),
// an outage (500), a cut connection ("drop"), an expired token, several pages of transactions, and the
// "no totals" answer of the real instance. See `state` and the functions returned at the very bottom of the file.
// Fake Cyclos for the tests: a small local HTTP server that imitates the
// endpoints used by the server. No external network, fictitious credentials.
import http from "node:http";

// FICTITIOUS credentials of the test merchant. No real password is used anywhere in this project.
export const USER = { login: "commercant", password: "motdepasse-de-test", display: "Boutique de Test" };

// Builds a fictitious transaction. `n` makes it unique and orders it in time (the n-th one is n minutes
// after the previous one); the default amount is 10.00.
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

// Starts the fake Cyclos and returns what is needed to drive it: its address (`url`), its state (`state`)
// and a few functions (`force`, `expireTokens`, `calls`, `close`). `async`: the function waits (`await`) for the
// server to be ready before handing back; see test/statique.test.js for an explanation of async/await.
export async function startFakeCyclos() {
  // `state` is the memory of the fake Cyclos. Tests MODIFY it before acting to build the wanted situation
  // (for example `app.cyclos.state.entries = [...]` to choose the transactions that are returned).
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

  // Every request received goes through here. It is recorded in `state.requests`: tests can then check what OUR
  // server sent to Cyclos (which calls, with which headers). `key` looks like "GET /self/accounts".
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

    // Forced situation: if a test asked "this route must fail", we answer right away with that status
    // (401, 403, 500...) without looking at anything else. "drop" cuts the connection: the client gets a network error.
    const forced = state.forced.get(key);
    if (forced) {
      if (forced === "drop") return req.socket.destroy();
      return json(res, forced, { code: forced === 401 ? "loggedOut" : forced === 403 ? "forbidden" : "unknownError" });
    }

    // Login. The HTTP header `Authorization: Basic xxx` holds "login:password" encoded in base64 (a mere encoding,
    // not encryption). We decode it (`Buffer`: see test/statique.test.js) and compare it with USER. If it matches, we invent
    // a session token ("jeton-1", "jeton-2"...); otherwise 401 (not authenticated).
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

    // After login, our tool no longer sends the password: it sends the token in the `Session-Token` header.
    // An unknown (or expired) token is refused with 401, as the real Cyclos would do.
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
    // Totals of the period. "membre" is the type of the fictitious account. With `state.indicators = false` we imitate the real
    // instance, which does not return the received/sent totals: our tool must then compute them (see test/totaux-calcules.test.js).
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
    // PAGINATED history: instead of returning everything at once, Cyclos splits it into pages. The client asks for `page` (0, 1, 2...)
    // and `pageSize` (lines per page); the `X-Has-Next-Page: true` header says whether another page remains to be read.
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
    // What the tests receive to drive the fake Cyclos:
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
