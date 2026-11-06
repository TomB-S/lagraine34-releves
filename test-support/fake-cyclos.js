// Fake Cyclos for the tests: a small local HTTP server that imitates the
// endpoints used by the server. No external network, fictitious credentials.
import http from "node:http";

export const USER = { login: "commercant", password: "motdepasse-de-test", display: "Boutique de Test" };

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

export async function startFakeCyclos() {
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

    const forced = state.forced.get(key);
    if (forced) {
      if (forced === "drop") return req.socket.destroy();
      return json(res, forced, { code: forced === 401 ? "loggedOut" : forced === 403 ? "forbidden" : "unknownError" });
    }

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
