import http from "node:http";
import { readFileSync, realpathSync } from "node:fs";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { renderTicketPdf } from "./ticket-pdf.js";

// Cyclos API address. CYCLOS_BASE_URL overrides the public demo (default),
// startServer() can override it again (tests).
const DEFAULT_BASE = "https://demo.cyclos.org/api";
let BASE = baseUrl(process.env.CYCLOS_BASE_URL);
const ZONE = "Europe/Paris";
const PORT = envNumber("PORT", 3000);
const COOKIE = "session";

// Cyclos base URL without trailing slash; empty or missing -> the demo.
function baseUrl(value) {
  return (value || DEFAULT_BASE).replace(/\/+$/, "");
}

// Reads a positive number from the environment, falls back to the default
// when the variable is missing or invalid.
function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Session limits: inactivity delay and absolute maximum hour.
let IDLE_MS = envNumber("SESSION_IDLE_MINUTES", 20) * 60_000;
let MAX_MS = envNumber("SESSION_MAX_HOURS", 8) * 3_600_000;
// Secure cookies only make sense over HTTPS, so this is opt-in (localhost is HTTP).
let COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
let SWEEP_INTERVAL_MS = 60_000;
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

// Format of <input type="datetime-local"> values (no seconds, no zone).
const INPUT_FORMAT = "yyyy-MM-dd'T'HH:mm";

// Static files, read once at startup and served on fixed routes (the CSP
// forbids inline styles, so every page links to /style.css; the logo and the
// fonts are served by us too, no external domain). Public and cacheable,
// unlike the pages (no-store by default), with ETag revalidation (304).
function staticAsset(file, contentType) {
  const body = readFileSync(new URL(file, import.meta.url));
  const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
  return { body, contentType, etag };
}

const STATIC_ASSETS = new Map([
  ["GET /style.css", staticAsset("./style.css", "text/css; charset=utf-8")],
  ["GET /logo.png", staticAsset("./logo-lagraine34.png", "image/png")],
  ...[
    "roboto-latin-400-normal",
    "roboto-latin-700-normal",
    "voltaire-latin-400-normal",
  ].map((name) => [
    `GET /fonts/${name}.woff2`,
    staticAsset(`./fonts/${name}.woff2`, "font/woff2"),
  ]),
]);

function serveStatic(req, res, asset) {
  const headers = {
    "Cache-Control": "public, max-age=3600",
    ETag: asset.etag,
  };
  if (req.headers["if-none-match"] === asset.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": asset.contentType, ...headers });
  res.end(asset.body);
}

// Default and preset ranges for the filter form, in ZONE wall-clock time.
// An unknown preset is ignored (same as no preset: today so far).
function presetRange(preset, now = DateTime.now().setZone(ZONE)) {
  const minute = now.startOf("minute");
  switch (preset) {
    case "hier": {
      const yesterday = minute.minus({ days: 1 });
      return {
        start: yesterday.startOf("day"),
        end: yesterday.set({ hour: 23, minute: 59 }),
      };
    }
    case "6h":
      return { start: minute.minus({ hours: 6 }), end: minute };
    default:
      return { start: minute.startOf("day"), end: minute };
  }
}

const MAX_RANGE_DAYS = 31;
// The transaction list is read page by page, up to MAX_ROWS lines in total.
const PAGE_SIZE = envNumber("HISTORY_PAGE_SIZE", 200);
const MAX_ROWS = envNumber("HISTORY_MAX_ROWS", 2000);
const INPUT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// Parses one submitted datetime-local value. `label` ("début"/"fin") is used
// in messages. Returns { value } or { error }.
function parseInstant(text, label) {
  if (!INPUT_SHAPE.test(text ?? "")) {
    return {
      error: `Date de ${label} invalide : le format attendu est AAAA-MM-JJThh:mm (par exemple 2026-11-05T22:00).`,
    };
  }
  const value = DateTime.fromFormat(text, INPUT_FORMAT, { zone: ZONE });
  if (!value.isValid) {
    return { error: `La date de ${label} n'existe pas dans le calendrier.` };
  }
  // Luxon silently moves a time that falls in a DST gap (02:30 on the spring
  // change day becomes 03:30). If formatting back gives something else, the
  // wall-clock time the user typed does not exist.
  if (value.toFormat(INPUT_FORMAT) !== text) {
    return {
      error: `L'heure de ${label} saisie (${text.slice(8, 10)}/${text.slice(5, 7)}/${text.slice(0, 4)} à ${text.slice(11)}) n'existe pas : elle est sautée lors du passage à l'heure d'été. Choisissez une autre heure.`,
    };
  }
  return { value };
}

// Validates the submitted range. Returns { error } or
// { from, to, until, clamped }: `to` is the end shown to the user, `until` the
// end sent to Cyclos (the whole last minute is included, so a range ending at
// 23:59 contains 23:59:30), `clamped` tells that a future end was brought back to now.
function parseRange(startText, endText, now = DateTime.now().setZone(ZONE)) {
  const start = parseInstant(startText, "début");
  if (start.error) return start;
  const end = parseInstant(endText, "fin");
  if (end.error) return end;

  const from = start.value;
  if (from > now) {
    return { error: "Le début ne peut pas être dans le futur." };
  }

  let to = end.value;
  let until = to.plus({ minutes: 1 }).minus({ milliseconds: 1 });
  // A future end is accepted but cannot report anything beyond this instant.
  const clamped = until > now;
  if (clamped) {
    to = now.startOf("minute");
    until = now;
  }

  if (clamped ? until <= from : to <= from) {
    return { error: "La fin doit être après le début." };
  }
  if (to > from.plus({ days: MAX_RANGE_DAYS })) {
    return {
      error: `La plage ne peut pas dépasser ${MAX_RANGE_DAYS} jours.`,
    };
  }
  return { from, to, until, clamped };
}

// Display name of the logged-in user, or null when unavailable. Only the
// "display" field is requested and kept: the rest of the profile is never read.
// A 401 still propagates (the session is over); any other failure just omits the name.
async function fetchDisplayName(sessionToken) {
  try {
    const { display } = await (
      await api("/users/self?fields=display", sessionToken)
    ).json();
    return typeof display === "string" && display ? display : null;
  } catch (error) {
    if (error instanceof LoginError) throw error;
    return null;
  }
}

// Statement for the merchant's chosen range (DateTimes in ZONE, `until` is
// the inclusive end sent to Cyclos).
async function fetchStatement(sessionToken, { from, to, until }) {
  const period = new URLSearchParams();
  // Cyclos expects instants, so both bounds are converted back to UTC.
  period.append("datePeriod", from.toUTC().toISO());
  period.append("datePeriod", until.toUTC().toISO());

  const merchantName = await fetchDisplayName(sessionToken);
  const accounts = await (await api("/self/accounts", sessionToken)).json();
  const accountType = accounts[0].type.internalName;
  const currency = accounts[0].currency;

  const totals = await (
    await api(`/self/accounts/${accountType}?${period}`, sessionToken)
  ).json();
  // History pages, most recent first. Reading stops at MAX_ROWS lines; the
  // totals above come from a dedicated endpoint, so they stay exact anyway.
  const entries = [];
  let truncated = false;
  for (let page = 0; ; page += 1) {
    const response = await api(
      `/self/accounts/${accountType}/history?${period}&page=${page}&pageSize=${PAGE_SIZE}`,
      sessionToken,
    );
    entries.push(...(await response.json()));
    const hasNext = response.headers.get("x-has-next-page") === "true";
    if (entries.length > MAX_ROWS || (entries.length === MAX_ROWS && hasNext)) {
      truncated = true;
      entries.length = MAX_ROWS;
      break;
    }
    if (!hasNext) break;
  }

  return { from, to, totals, entries, truncated, merchantName, currency };
}

// Values come from a remote API (or the user): escape them before putting them in HTML.
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// An error message: never conveyed by colour alone (icon + "Erreur :" label).
function errorMessage(text) {
  return `<p class="erreur" role="alert"><span class="icone" aria-hidden="true">⚠</span> <strong>Erreur :</strong> ${text}</p>`;
}

function htmlPage(title, body) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/style.css">
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <header class="entete">
    <span class="logo"><img src="/logo.png" width="104" height="40" alt="La Graine 34, monnaie locale"></span>
    <span class="nom-outil">Relevés de service</span>
  </header>
  <div class="page">
  ${body}
  </div>
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
  ${errorMessage("Identifiant ou mot de passe incorrect.")}
  <p><a href="/">Réessayer</a></p>`,
  );
}

function renderTooManyAttempts(retryAfterSeconds) {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return htmlPage(
    "Trop de tentatives",
    `<h1>Trop de tentatives</h1>
  ${errorMessage(`Trop d'échecs de connexion depuis votre adresse. Réessayez dans ${minutes} minute${minutes > 1 ? "s" : ""}.`)}`,
  );
}

function renderForbidden(message, csrfToken) {
  const back = csrfToken
    ? `<p><a href="/filtres">Retour aux filtres</a></p>`
    : `<p><a href="/">Retour</a></p>`;
  return htmlPage(
    "Requête refusée",
    `<h1>Requête refusée</h1>
  ${errorMessage(escapeHtml(message))}
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
  ${errorMessage("Votre compte n'a pas l'autorisation d'utiliser cet outil.")}
  ${links}`,
  );
}

// `values` are the start/end strings to put in the fields: either computed
// by presetRange(), or (after a validation error) exactly what the user typed.
function renderFilters(csrfToken, values, error) {
  return htmlPage(
    "Choisir la plage horaire",
    `<h1>Choisir la plage horaire</h1>
  ${error ? errorMessage(escapeHtml(error)) : ""}
  <p class="raccourcis">Raccourcis :
    <a href="/filtres?preset=aujourdhui">Aujourd'hui</a>
    <a href="/filtres?preset=hier">Hier</a>
    <a href="/filtres?preset=6h">6 dernières heures</a>
  </p>
  <form method="post" action="/releve">
    <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
    <p><label for="start">Début</label>
      <input type="datetime-local" id="start" name="start" value="${escapeHtml(values.start)}" required></p>
    <p><label for="end">Fin</label>
      <input type="datetime-local" id="end" name="end" value="${escapeHtml(values.end)}" required></p>
    <p><button type="submit">Voir le relevé</button></p>
  </form>
  ${logoutForm(csrfToken)}`,
  );
}

// Field values for a range computed by the server.
function rangeValues({ start, end }) {
  return {
    start: start.toFormat(INPUT_FORMAT),
    end: end.toFormat(INPUT_FORMAT),
  };
}

// Formats a Cyclos amount string ("1234.5") the French way ("1 234,50", with a
// narrow no-break space between thousands). String based: no float rounding.
// `signed` adds "+" to positive amounts; negative ones always keep their "-".
function formatAmount(value, digits = 2, { signed = false } = {}) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) return String(value);
  const [, minus, integer, decimals = ""] = match;
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  const number =
    digits > 0 ? `${grouped},${decimals.padEnd(digits, "0")}` : grouped;
  const isZero = /^[0,\u202f]*$/.test(number);
  if (minus && !isZero) return `-${number}`;
  return signed && !isZero ? `+${number}` : number;
}

function plural(count, one, many) {
  return `${count} ${count > 1 ? many : one}`;
}

// Who is on the other side of a transaction (a member, or a system account).
function counterparty(entry) {
  const related = entry.relatedAccount;
  return related?.user?.display ?? related?.type?.name ?? "";
}

// The content of the ticket as plain strings (not escaped), shared by the HTML
// page and the PDF so that both always show the same thing.
function ticketModel({
  from,
  to,
  totals,
  entries,
  truncated,
  merchantName,
  currency,
}) {
  const digits = currency?.decimalDigits ?? 2;
  const { incoming, outgoing, netInflow } = totals.status;
  const net =
    netInflow ?? (Number(incoming.sum) - Number(outgoing.sum)).toFixed(digits);

  // Cyclos answers most recent first; the ticket reads oldest first.
  const ordered = [...entries]
    .reverse()
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    title: "Ticket de fin de service",
    merchantName,
    period: `Du ${from.toFormat("dd/MM/yyyy HH:mm")} au ${to.toFormat("dd/MM/yyyy HH:mm")}`,
    generated: `Ticket généré le ${DateTime.now().setZone(ZONE).toFormat("dd/MM/yyyy 'à' HH:mm")}`,
    unit: `Montants en ${currency?.name ?? ""}`,
    summary: [
      {
        label: plural(incoming.count, "paiement reçu", "paiements reçus"),
        value: formatAmount(incoming.sum, digits),
      },
      {
        label: plural(outgoing.count, "paiement sorti", "paiements sortis"),
        value: formatAmount(outgoing.sum, digits),
      },
      {
        label: "Solde net",
        value: formatAmount(net, digits, { signed: true }),
        net: true,
      },
    ],
    rows: ordered.map((entry) => ({
      // Each stored instant is rendered back into Paris wall-clock time.
      when: DateTime.fromISO(entry.date).setZone(ZONE).toFormat("dd/MM HH:mm"),
      number: entry.transactionNumber ?? "",
      counterparty: counterparty(entry),
      description: entry.description ?? "",
      amount: formatAmount(entry.amount, digits, { signed: true }),
    })),
    warning: truncated
      ? `Attention : la liste est limitée aux ${MAX_ROWS} transactions les plus récentes de la plage, les plus anciennes ne sont pas affichées. Les totaux du résumé restent exacts : ils sont calculés par Cyclos sur toute la plage, pas à partir de cette liste.`
      : "",
    emptyText: "Aucune transaction sur cette plage",
    // Range in the filter form's format, for the PDF download form.
    start: from.toFormat(INPUT_FORMAT),
    end: to.toFormat(INPUT_FORMAT),
  };
}

function renderStatement(statement, csrfToken) {
  const m = ticketModel(statement);

  const rows = m.rows
    .map(
      (row) => `<li class="ligne">
        <span class="date">${escapeHtml(row.when)}</span>
        <span class="numero">${escapeHtml(row.number)}</span>
        <span class="contrepartie">${escapeHtml(row.counterparty)}</span>
        <span class="description">${escapeHtml(row.description)}</span>
        <span class="montant">${escapeHtml(row.amount)}</span>
      </li>`,
    )
    .join("\n      ");

  const summary = m.summary
    .map(
      (
        line,
      ) => `<div${line.net ? ' class="net"' : ""}><dt>${escapeHtml(line.label)}</dt>
      <dd>${escapeHtml(line.value)}</dd></div>`,
    )
    .join("\n    ");

  return htmlPage(
    m.title,
    `<main class="ticket">
  <h1>${escapeHtml(m.title)}</h1>
  ${m.merchantName ? `<p class="commercant">${escapeHtml(m.merchantName)}</p>` : ""}
  <p class="periode">${escapeHtml(m.period)}</p>
  <p class="generation">${escapeHtml(m.generated)}</p>

  <h2>Résumé</h2>
  <p class="unite">${escapeHtml(m.unit)}</p>
  <dl class="resume">
    ${summary}
  </dl>

  <h2>Détail</h2>
  ${m.warning ? `<p class="avertissement" role="alert">${escapeHtml(m.warning)}</p>` : ""}
  ${
    rows
      ? `<ol class="detail">
      ${rows}
  </ol>`
      : `<p class="vide">${escapeHtml(m.emptyText)}</p>`
  }

  <div class="actions">
    <form method="post" action="/releve.pdf" class="telechargement">
      <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
      <input type="hidden" name="start" value="${escapeHtml(m.start)}">
      <input type="hidden" name="end" value="${escapeHtml(m.end)}">
      <button type="submit">Télécharger le PDF</button>
    </form>
    <p><a href="/filtres">Changer la plage horaire</a></p>
    ${logoutForm(csrfToken)}
  </div>
</main>`,
  );
}

// Shared by POST /releve and POST /releve.pdf: CSRF check, validation of the
// two submitted dates, then a fresh read from Cyclos. Nothing but the two
// dates is taken from the browser. When it cannot produce a statement it has
// already sent the error response (403, 400, redirect on 401...) and returns
// null; nothing is sent on success, so the caller picks the response format.
async function loadStatement(req, res, { id, session }) {
  const { csrfToken } = session;

  const form = new URLSearchParams(await readBody(req));
  if (!isValidCsrf(session, form.get("csrf"))) {
    send(
      res,
      403,
      "text/html",
      renderForbidden(
        "Jeton de sécurité absent ou invalide. Retournez aux filtres et recommencez.",
        csrfToken,
      ),
    );
    return null;
  }

  const values = {
    start: form.get("start") ?? "",
    end: form.get("end") ?? "",
  };
  const range = parseRange(values.start, values.end);
  if (range.error) {
    send(res, 400, "text/html", renderFilters(csrfToken, values, range.error));
    return null;
  }

  try {
    return await fetchStatement(session.sessionToken, range);
  } catch (error) {
    if (error instanceof LoginError) {
      // Cyclos no longer accepts the token (401 loggedOut): drop the local session.
      sessions.delete(id);
      redirect(res, "/", { "Set-Cookie": clearCookie });
      return null;
    }
    if (error instanceof AccessDeniedError) {
      // The account is not allowed to do this, but the session itself is fine.
      send(res, 403, "text/html", renderAccessDenied(csrfToken));
      return null;
    }
    throw error;
  }
}

// Download name built only from the validated dates (digits, "-", "_"):
// ticket-2026-11-05_0357_2026-11-05_2359.pdf
function pdfFilename({ from, to }) {
  const stamp = (date) => date.setLocale("en").toFormat("yyyy-MM-dd_HHmm");
  return `ticket-${stamp(from)}_${stamp(to)}.pdf`;
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

// Cleanup of expired sessions and of old login-failure counters, run
// periodically by startServer() (and callable directly, tests do).
function sweep(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (isExpired(session, now)) expireSession(id, session);
  }
  for (const [ip, entry] of loginFailures) {
    if (now - entry.windowStart >= LOGIN_WINDOW_MS) loginFailures.delete(ip);
  }
}

function cookieHeader(value, maxAgeSeconds) {
  return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${COOKIE_SECURE ? "; Secure" : ""}`;
}

let clearCookie = cookieHeader("", 0);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const route = `${req.method} ${pathname}`;

  // Security headers, on every response. writeHead() later merges its own
  // headers with these.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
    const asset = STATIC_ASSETS.get(route);
    if (asset) {
      serveStatic(req, res, asset);
      return;
    }

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
        const values = rangeValues(presetRange(url.searchParams.get("preset")));
        send(
          res,
          200,
          "text/html",
          renderFilters(session.session.csrfToken, values),
        );
        return;
      }

      case "POST /releve": {
        const session = getSession(req);
        if (!session) {
          redirect(res, "/");
          return;
        }
        // Answers itself (403, 400, 401...) and returns null when it cannot
        // produce a statement.
        const statement = await loadStatement(req, res, session);
        if (!statement) return;
        send(
          res,
          200,
          "text/html",
          renderStatement(statement, session.session.csrfToken),
        );
        return;
      }

      case "POST /releve.pdf": {
        const session = getSession(req);
        if (!session) {
          redirect(res, "/");
          return;
        }
        // Same protections as POST /releve; the data is read again from Cyclos.
        const statement = await loadStatement(req, res, session);
        if (!statement) return;

        // The whole PDF is built before any header is sent: a failure here
        // ends in the normal error handling below, not in a half-sent file.
        let pdf;
        try {
          pdf = await renderTicketPdf(ticketModel(statement));
        } catch (error) {
          console.error(error);
          send(res, 500, "text/plain", "Impossible de générer le PDF");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${pdfFilename(statement)}"`,
          "Content-Length": pdf.length,
          "Cache-Control": "no-store",
        });
        res.end(pdf);
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

// Starts the server and resolves with { port, close, sweep }. Nothing starts
// on import. State (sessions, login failures) is per process: one server at a
// time, and it starts empty. `options` (all optional) are meant for tests:
// port (0 = any free port), host, cyclosBaseUrl, cookieSecure, idleMs, maxMs,
// sweepIntervalMs. Defaults are the environment variables.
export function startServer(options = {}) {
  if (server.listening) {
    return Promise.reject(new Error("Le serveur est déjà démarré"));
  }
  BASE = baseUrl(options.cyclosBaseUrl ?? process.env.CYCLOS_BASE_URL);
  COOKIE_SECURE = options.cookieSecure ?? process.env.COOKIE_SECURE === "true";
  IDLE_MS = options.idleMs ?? envNumber("SESSION_IDLE_MINUTES", 20) * 60_000;
  MAX_MS = options.maxMs ?? envNumber("SESSION_MAX_HOURS", 8) * 3_600_000;
  SWEEP_INTERVAL_MS = options.sweepIntervalMs ?? 60_000;
  clearCookie = cookieHeader("", 0);
  sessions.clear();
  loginFailures.clear();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? PORT, options.host, () => {
      server.off("error", reject);
      const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
      timer.unref();
      resolve({
        port: server.address().port,
        sweep,
        close() {
          clearInterval(timer);
          return new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          });
        },
      });
    });
  });
}

// Pure functions exported for the unit tests.
export {
  escapeHtml,
  formatAmount,
  parseRange,
  pdfFilename,
  presetRange,
  ticketModel,
};

// "node server.js" starts the server as before; importing the file does not.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const { port } = await startServer();
  console.log(`Serveur démarré sur http://localhost:${port}`);
}
