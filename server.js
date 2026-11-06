import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DateTime } from "luxon";

const BASE = "https://demo.cyclos.org/api";
const ZONE = "Europe/Paris";
const PORT = 3000;
const COOKIE = "session";

// Reads a positive number from the environment, falls back to the default
// when the variable is missing or invalid.
function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Session limits: inactivity delay and absolute maximum hour.
const IDLE_MS = envNumber("SESSION_IDLE_MINUTES", 20) * 60_000;
const MAX_MS = envNumber("SESSION_MAX_HOURS", 8) * 3_600_000;
// Secure cookies only make sense over HTTPS, so this is opt-in (localhost is HTTP).
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const SWEEP_INTERVAL_MS = 60_000;
// Largest accepted POST body.
const MAX_BODY_BYTES = 10_000;
// Login throttling: after LOGIN_MAX_FAILURES failures within LOGIN_WINDOW_MS
// from the same IP address, further attempts get a 429 until the window ends.
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;

// Local session store: our session id (the cookie value) ->
// { sessionToken, csrfToken, createdAt, lastSeenAt }.
// The Cyclos login and password are never stored: they are used once, in
// POST /connexion, to obtain a Cyclos session token, then dropped.
// A session ends on logout, after IDLE_MS without use, or after MAX_MS in total.
const sessions = new Map();

// Cyclos answered 401: bad credentials, or the session token is no longer valid.
class LoginError extends Error {}

// Cyclos answered 403: the account is known but not allowed to do this.
// This is not a login failure, the local session must be kept.
class AccessDeniedError extends Error {}

// A POST body is larger than MAX_BODY_BYTES.
class BodyTooLargeError extends Error {}

// Failed logins per IP address, in memory: ip -> { count, windowStart }.
// NOTE: the address is the one of the TCP peer. Behind a reverse proxy it will
// be the proxy's address, so every user would share one counter (not handled yet).
const loginFailures = new Map();

function loginBlockedUntil(ip, now = Date.now()) {
  const entry = loginFailures.get(ip);
  if (!entry || now - entry.windowStart >= LOGIN_WINDOW_MS) return 0;
  return entry.count >= LOGIN_MAX_FAILURES
    ? entry.windowStart + LOGIN_WINDOW_MS
    : 0;
}

function recordLoginFailure(ip, now = Date.now()) {
  const entry = loginFailures.get(ip);
  if (!entry || now - entry.windowStart >= LOGIN_WINDOW_MS) {
    loginFailures.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
}

// Authenticated Cyclos call: the Cyclos session token replaces the password.
async function api(path, sessionToken, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { "Session-Token": sessionToken },
  });

  if (response.status === 401) {
    throw new LoginError(`401 on ${path}`);
  }
  if (response.status === 403) {
    throw new AccessDeniedError(`403 on ${path}`);
  }
  if (!response.ok) {
    throw new Error(`${response.status} on ${path}`);
  }

  return response;
}

// Exchanges login + password for a Cyclos session token. Only the token is
// returned: the rest of the response (profile, permissions...) is discarded.
async function createCyclosSession(login, password) {
  // Buffer rather than btoa: btoa throws on accents and other non-Latin1 characters.
  const basic = Buffer.from(`${login}:${password}`, "utf-8").toString("base64");
  const response = await fetch(`${BASE}/auth/session`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}` },
  });

  if (response.status === 401) {
    throw new LoginError("401 on /auth/session");
  }
  if (response.status === 403) {
    throw new AccessDeniedError("403 on /auth/session");
  }
  if (!response.ok) {
    throw new Error(`${response.status} on /auth/session`);
  }

  const { sessionToken } = await response.json();
  return sessionToken;
}

// Closes the token on the Cyclos side. Failures are ignored on purpose: the
// local session is already gone, whatever Cyclos answers (network error,
// 401 because the token already expired...).
async function closeCyclosSession(sessionToken) {
  try {
    await api("/auth/session", sessionToken, { method: "DELETE" });
  } catch {
    // ignored on purpose
  }
}

// Parses "HH:mm" into hour/minute, or returns null if invalid.
function parseTime(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? "");
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

// The merchant's chosen time range, on the current day.
// The day is computed in ZONE, not in the machine's timezone,
// so the result is identical on a laptop in Paris and a UTC server.
async function fetchStatement(sessionToken, startTime, endTime) {
  const now = DateTime.now().setZone(ZONE);
  const from = now.startOf("day").set(startTime);
  const to = now.startOf("day").set(endTime);

  const period = new URLSearchParams();
  // Cyclos expects instants, so both bounds are converted back to UTC.
  period.append("datePeriod", from.toUTC().toISO());
  period.append("datePeriod", to.toUTC().toISO());

  const accounts = await (await api("/self/accounts", sessionToken)).json();
  const accountType = accounts[0].type.internalName;

  const totals = await (
    await api(`/self/accounts/${accountType}?${period}`, sessionToken)
  ).json();
  const entries = await (
    await api(`/self/accounts/${accountType}/history?${period}`, sessionToken)
  ).json();

  return { from, to, totals, entries };
}

// Values come from a remote API (or the user): escape them before putting them in HTML.
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function htmlPage(title, body) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
</head>
<body>
  ${body}
</body>
</html>`;
}

function renderLoginForm() {
  return htmlPage(
    "Connexion",
    `<h1>Connexion</h1>
  <form method="post" action="/connexion">
    <p><label>Identifiant : <input type="text" name="login" required autofocus></label></p>
    <p><label>Mot de passe : <input type="password" name="password" required></label></p>
    <p><button type="submit">Se connecter</button></p>
  </form>`,
  );
}

function renderLoginFailed() {
  return htmlPage(
    "Connexion échouée",
    `<h1>Connexion échouée</h1>
  <p>Identifiant ou mot de passe incorrect.</p>
  <p><a href="/">Réessayer</a></p>`,
  );
}

function renderTooManyAttempts(retryAfterSeconds) {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return htmlPage(
    "Trop de tentatives",
    `<h1>Trop de tentatives</h1>
  <p>Trop d'échecs de connexion depuis votre adresse. Réessayez dans ${minutes} minute${minutes > 1 ? "s" : ""}.</p>`,
  );
}

function renderForbidden(message, csrfToken) {
  const back = csrfToken
    ? `<p><a href="/filtres">Retour aux filtres</a></p>`
    : `<p><a href="/">Retour</a></p>`;
  return htmlPage(
    "Requête refusée",
    `<h1>Requête refusée</h1>
  <p>${escapeHtml(message)}</p>
  ${back}`,
  );
}

// Logout is a POST (a link must not be able to log someone out), so it is a
// small form carrying the session's CSRF token.
function logoutForm(csrfToken) {
  return `<form method="post" action="/deconnexion">
    <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
    <button type="submit">Se déconnecter</button>
  </form>`;
}

function renderAccessDenied(csrfToken) {
  const links = csrfToken
    ? `<p><a href="/filtres">Retour</a></p>\n  ${logoutForm(csrfToken)}`
    : `<p><a href="/">Retour</a></p>`;
  return htmlPage(
    "Accès refusé",
    `<h1>Accès refusé</h1>
  <p>Votre compte n'a pas l'autorisation d'utiliser cet outil.</p>
  ${links}`,
  );
}

function renderFilters(csrfToken, error) {
  return htmlPage(
    "Choisir la plage horaire",
    `<h1>Choisir la plage horaire</h1>
  ${error ? `<p>${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/releve">
    <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
    <p><label>Début : <input type="time" name="start" value="00:00" required></label></p>
    <p><label>Fin : <input type="time" name="end" value="23:59" required></label></p>
    <p><button type="submit">Voir le relevé</button></p>
  </form>
  ${logoutForm(csrfToken)}`,
  );
}

function renderStatement({ from, to, totals, entries }, csrfToken) {
  const rows = entries
    .map((entry) => {
      // Each stored instant is rendered back into Paris wall-clock time.
      const time = DateTime.fromISO(entry.date).setZone(ZONE).toFormat("HH:mm");
      return `<li>${time} — ${escapeHtml(entry.amount)} — ${escapeHtml(entry.description ?? "")}</li>`;
    })
    .join("\n      ");

  const { incoming, outgoing } = totals.status;

  return htmlPage(
    "Relevé",
    `<h1>Relevé du ${from.toFormat("dd/MM/yyyy")}</h1>
  <p>De ${from.toFormat("HH:mm")} à ${to.toFormat("HH:mm")}</p>
  <ul>
      ${rows || "<li>Aucune transaction sur cette plage</li>"}
  </ul>
  <p>Encaissé : ${escapeHtml(incoming.sum)} (${incoming.count} transactions)</p>
  <p>Sorti : ${escapeHtml(outgoing.sum)} (${outgoing.count} transactions)</p>
  <p><a href="/filtres">Changer la plage horaire</a></p>
  ${logoutForm(csrfToken)}`,
  );
}

function send(res, status, contentType, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": `${contentType}; charset=utf-8`,
    ...headers,
  });
  res.end(body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, ...headers });
  res.end();
}

// Reads a POST body as text, refusing anything above `limit` bytes.
// Rejects with BodyTooLargeError, from the declared Content-Length when there
// is one, or while streaming (chunked bodies). Nothing above the limit is kept.
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > limit) {
      req.resume(); // discard what the client sends, keep nothing
      reject(new BodyTooLargeError());
      return;
    }

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return; // keep draining, store nothing
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// POST /connexion has no session yet, hence no CSRF token: check instead that
// the request comes from a page of this server (Origin, or Referer if absent).
function isSameOrigin(req) {
  const source = req.headers.origin ?? req.headers.referer;
  if (!source) return false;
  try {
    return new URL(source).host === req.headers.host;
  } catch {
    return false; // includes the literal "null" origin
  }
}

// Constant-time comparison of the submitted CSRF token with the session's one.
function isValidCsrf(session, submitted) {
  const expected = Buffer.from(session.csrfToken);
  const given = Buffer.from(submitted ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function getSessionId(req) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=");
  }
  return null;
}

function isExpired(session, now = Date.now()) {
  return now - session.lastSeenAt > IDLE_MS || now - session.createdAt > MAX_MS;
}

// Removes an expired session and tries to close its Cyclos token (fire and forget).
function expireSession(id, session) {
  sessions.delete(id);
  closeCyclosSession(session.sessionToken);
}

// Returns { id, session } for a valid session cookie, otherwise null.
// An expired session is deleted and treated as absent.
function getSession(req) {
  const id = getSessionId(req);
  const session = id ? sessions.get(id) : undefined;
  if (!session) return null;

  const now = Date.now();
  if (isExpired(session, now)) {
    expireSession(id, session);
    return null;
  }

  session.lastSeenAt = now;
  return { id, session };
}

// Periodic cleanup of expired sessions and of old login-failure counters.
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (isExpired(session, now)) expireSession(id, session);
  }
  for (const [ip, entry] of loginFailures) {
    if (now - entry.windowStart >= LOGIN_WINDOW_MS) loginFailures.delete(ip);
  }
}, SWEEP_INTERVAL_MS).unref();

function cookieHeader(value, maxAgeSeconds) {
  return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${COOKIE_SECURE ? "; Secure" : ""}`;
}

const clearCookie = cookieHeader("", 0);

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${pathname}`;

  // Security headers, on every response. writeHead() later merges its own
  // headers with these.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  // The login page posts to /connexion, whose Origin check needs a usable
  // Origin header: browsers send "Origin: null" on form POSTs under
  // no-referrer, so this one page uses same-origin (still no referrer leaves the site).
  res.setHeader(
    "Referrer-Policy",
    route === "GET /" ? "same-origin" : "no-referrer",
  );
  // Statements must not stay in any cache nor in the back button.
  res.setHeader("Cache-Control", "no-store");
  if (COOKIE_SECURE) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }

  try {
    switch (route) {
      case "GET /":
        send(res, 200, "text/html", renderLoginForm());
        return;

      case "POST /connexion": {
        if (!isSameOrigin(req)) {
          send(
            res,
            403,
            "text/html",
            renderForbidden("Origine de la requête non autorisée."),
          );
          return;
        }

        const ip = req.socket.remoteAddress ?? "unknown";
        const blockedUntil = loginBlockedUntil(ip);
        if (blockedUntil) {
          const retryAfter = Math.ceil((blockedUntil - Date.now()) / 1000);
          send(res, 429, "text/html", renderTooManyAttempts(retryAfter), {
            "Retry-After": String(retryAfter),
          });
          return;
        }

        const form = new URLSearchParams(await readBody(req));
        const login = form.get("login") ?? "";
        const password = form.get("password") ?? "";

        if (!login || !password) {
          send(res, 401, "text/html", renderLoginFailed());
          return;
        }

        let sessionToken;
        try {
          // Checks the credentials and returns a Cyclos session token.
          sessionToken = await createCyclosSession(login, password);
        } catch (error) {
          if (error instanceof LoginError) {
            recordLoginFailure(ip);
            send(res, 401, "text/html", renderLoginFailed());
            return;
          }
          if (error instanceof AccessDeniedError) {
            send(res, 403, "text/html", renderAccessDenied());
            return;
          }
          throw error;
        }

        const id = randomUUID();
        const now = Date.now();
        sessions.set(id, {
          sessionToken,
          csrfToken: randomBytes(32).toString("hex"),
          createdAt: now,
          lastSeenAt: now,
        });
        redirect(res, "/filtres", {
          "Set-Cookie": cookieHeader(id, Math.floor(MAX_MS / 1000)),
        });
        return;
      }

      case "GET /filtres": {
        const session = getSession(req);
        if (!session) {
          redirect(res, "/");
          return;
        }
        send(res, 200, "text/html", renderFilters(session.session.csrfToken));
        return;
      }

      case "POST /releve": {
        const session = getSession(req);
        if (!session) {
          redirect(res, "/");
          return;
        }
        const { csrfToken } = session.session;

        const form = new URLSearchParams(await readBody(req));
        if (!isValidCsrf(session.session, form.get("csrf"))) {
          send(
            res,
            403,
            "text/html",
            renderForbidden(
              "Jeton de sécurité absent ou invalide. Retournez aux filtres et recommencez.",
              csrfToken,
            ),
          );
          return;
        }

        const startTime = parseTime(form.get("start"));
        const endTime = parseTime(form.get("end"));

        if (!startTime || !endTime) {
          send(
            res,
            400,
            "text/html",
            renderFilters(csrfToken, "Heures invalides."),
          );
          return;
        }
        if (DateTime.fromObject(startTime) >= DateTime.fromObject(endTime)) {
          send(
            res,
            400,
            "text/html",
            renderFilters(
              csrfToken,
              "L'heure de fin doit être après l'heure de début.",
            ),
          );
          return;
        }

        try {
          const statement = await fetchStatement(
            session.session.sessionToken,
            startTime,
            endTime,
          );
          send(res, 200, "text/html", renderStatement(statement, csrfToken));
        } catch (error) {
          if (error instanceof LoginError) {
            // Cyclos no longer accepts the token (401 loggedOut): drop the local session.
            sessions.delete(session.id);
            redirect(res, "/", { "Set-Cookie": clearCookie });
            return;
          }
          if (error instanceof AccessDeniedError) {
            // The account is not allowed to do this, but the session itself is fine.
            send(res, 403, "text/html", renderAccessDenied(csrfToken));
            return;
          }
          throw error;
        }
        return;
      }

      case "POST /deconnexion": {
        const session = getSession(req);
        if (!session) {
          // Nothing to close locally; just make sure the cookie is gone.
          redirect(res, "/", { "Set-Cookie": clearCookie });
          return;
        }

        const form = new URLSearchParams(await readBody(req));
        if (!isValidCsrf(session.session, form.get("csrf"))) {
          send(
            res,
            403,
            "text/html",
            renderForbidden(
              "Jeton de sécurité absent ou invalide. La session n'a pas été fermée.",
              session.session.csrfToken,
            ),
          );
          return;
        }

        sessions.delete(session.id);
        // Close the token on the Cyclos side too, then log out locally either way.
        await closeCyclosSession(session.session.sessionToken);
        redirect(res, "/", { "Set-Cookie": clearCookie });
        return;
      }

      case "GET /deconnexion":
        // Logging out must not be triggerable by a simple link or image.
        send(
          res,
          405,
          "text/plain",
          "Méthode non autorisée : la déconnexion se fait par POST",
          {
            Allow: "POST",
          },
        );
        return;

      default:
        send(res, 404, "text/plain", "Page introuvable");
    }
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      send(res, 413, "text/plain", "Requête trop volumineuse", {
        Connection: "close",
      });
      return;
    }
    console.error(error);
    send(res, 502, "text/plain", "Impossible de joindre Cyclos");
  }
});

server.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
