// === WHAT THIS FILE CHECKS ===
// UNIT tests: we directly call small functions of server.js and ticket-pdf.js, without a server,
// without a network, without the fake Cyclos (which is why it does not use the harness). They are "pure": same input,
// same output. These are the ones that decide on the dates typed, the display of amounts, the escaping of HTML
// and the text of the ticket. For a merchant: a correct ticket (right period, right amounts). For security:
// no text coming from elsewhere can inject code into the page. Basic notions (test, assert, async):
// see test/statique.test.js.
// Unit tests of the pure functions (no server, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
// First, before server.js: removes the terminal's environment variables (HISTORY_MAX_ROWS is read when server.js is loaded).
import "../test-support/env-propre.js";
import {
  escapeHtml,
  formatAmount,
  parseRange,
  pdfFilename,
  presetRange,
  ticketModel,
} from "../server.js";
import { pdfText } from "../ticket-pdf.js";

// Time zone: "10 am" means nothing without saying WHERE. The merchants are in France: everything is computed in
// Paris time (Europe/Paris), which changes twice a year (summer time in March, winter time in October).
const ZONE = "Europe/Paris";
// Small shortcut to build a date in Paris time (the Luxon library provides the DateTime type).
const at = (iso) => DateTime.fromISO(iso, { zone: ZONE });
// A fixed "fake current time", passed to the functions: the test results thus do not depend on the day they are run.
const NOW = at("2026-11-05T12:00:30"); // Thursday, winter time

// ---------------------------------------------------------------- dates

// Intention: a normal range is accepted, and the end includes the LAST minute (11:59 goes up to 11:59:59.999).
// Otherwise a sale at 11:59:30 would vanish from the ticket. `parseRange` reads the two dates typed in the form.
test("parseRange : plage valide, la dernière minute est incluse", () => {
  const r = parseRange("2026-11-05T08:00", "2026-11-05T11:59", NOW);
  assert.equal(r.error, undefined);
  assert.equal(r.clamped, false);
  assert.equal(r.from.toISO(), "2026-11-05T08:00:00.000+01:00");
  assert.equal(r.to.toFormat("HH:mm"), "11:59");
  assert.equal(r.until.toFormat("HH:mm:ss.SSS"), "11:59:59.999");
});

// Intention: a badly written date (empty, with seconds, in the wrong format...) is refused with a clear message
// for the merchant, instead of causing an error further on.
test("parseRange : format invalide", () => {
  for (const bad of ["", undefined, null, "2026-11-05 08:00", "05/11/2026 08:00", "2026-11-05T08:00:30", "2026-11-5T8:00", "abc"]) {
    assert.match(parseRange(bad, "2026-11-05T09:00", NOW).error, /Date de début invalide.*format attendu/, String(bad));
    assert.match(parseRange("2026-11-05T08:00", bad, NOW).error, /Date de fin invalide.*format attendu/, String(bad));
  }
});

// Intention: 30 February or month 13 do not exist; we say so instead of silently correcting them.
test("parseRange : date absente du calendrier", () => {
  assert.match(parseRange("2026-02-30T10:00", "2026-03-01T10:00", NOW).error, /début n'existe pas dans le calendrier/);
  assert.match(parseRange("2026-11-01T10:00", "2026-13-01T10:00", NOW).error, /fin n'existe pas dans le calendrier/);
});

// Intention: a backwards (or empty) period is refused, otherwise we would ask Cyclos for an absurd period.
test("parseRange : fin avant le début, ou égale au début", () => {
  assert.equal(parseRange("2026-11-05T10:00", "2026-11-05T09:00", NOW).error, "La fin doit être après le début.");
  assert.equal(parseRange("2026-11-05T10:00", "2026-11-05T10:00", NOW).error, "La fin doit être après le début.");
});

// Intention: the range is limited to 31 days (exactly 31 is accepted, one more minute is refused),
// so as not to ask Cyclos for thousands of transactions.
test("parseRange : 31 jours au plus", () => {
  const ok = parseRange("2026-10-05T00:00", "2026-11-05T00:00", NOW);
  assert.equal(ok.error, undefined);
  assert.match(parseRange("2026-10-05T00:00", "2026-11-05T00:01", NOW).error, /ne peut pas dépasser 31 jours/);
  assert.match(parseRange("2026-01-01T00:00", "2026-11-05T00:00", NOW).error, /ne peut pas dépasser 31 jours/);
});

// Intention: there is nothing to report in the future; a future start is a typing mistake.
test("parseRange : début dans le futur refusé", () => {
  assert.equal(parseRange("2026-11-05T12:01", "2026-11-05T13:00", NOW).error, "Le début ne peut pas être dans le futur.");
  assert.equal(parseRange("2027-01-01T00:00", "2027-01-02T00:00", NOW).error, "Le début ne peut pas être dans le futur.");
});

// Intention: a future end is tolerated but brought back to "now" (`clamped`), since nothing exists afterwards.
// This way "until tonight" works in the middle of the afternoon.
test("parseRange : fin dans le futur ramenée à maintenant", () => {
  const r = parseRange("2026-11-05T10:00", "2026-11-06T10:00", NOW);
  assert.equal(r.error, undefined);
  assert.equal(r.clamped, true);
  assert.equal(r.to.toFormat("yyyy-MM-dd HH:mm"), "2026-11-05 12:00");
  assert.equal(r.until.toMillis(), NOW.toMillis());
});

// Edge case: start = now and a future end. Once the end is brought back to now, the end is not after the start:
// we must answer with the normal error, not crash.
test("parseRange : début à la seconde même de maintenant et fin future -> fin avant le début", () => {
  const now = at("2026-11-05T12:00:00");
  assert.equal(parseRange("2026-11-05T12:00", "2026-11-05T13:00", now).error, "La fin doit être après le début.");
});

// Intention: at the switch to summer time (29 March 2026), there is no 02:30: we go from 02:00 to 03:00.
// Luxon would silently shift it to 03:30; we want instead to warn the merchant, otherwise the ticket would cover
// a different period from the one they think.
test("parseRange : heure inexistante au passage à l'heure d'été (29 mars 2026, 02:30)", () => {
  const now = at("2026-04-01T12:00");
  const start = parseRange("2026-03-29T02:30", "2026-03-29T10:00", now);
  assert.match(start.error, /heure de début saisie \(29\/03\/2026 à 02:30\) n'existe pas/);
  const end = parseRange("2026-03-29T01:00", "2026-03-29T02:30", now);
  assert.match(end.error, /heure de fin saisie \(29\/03\/2026 à 02:30\) n'existe pas/);
  // The neighbouring hours exist.
  assert.equal(parseRange("2026-03-29T01:59", "2026-03-29T03:00", now).error, undefined);
});

// Known and ACCEPTED case: on 25 October 2026, 02:30 exists twice (summer then winter). The tool keeps the second, without warning.
// This test freezes that behaviour (it is listed in "Limites connues" of the README); if it changes, it is a choice to make again.
test("parseRange : heure ambiguë (25 octobre 2026, 02:30) acceptée, seconde occurrence (heure d'hiver) retenue", () => {
  const now = at("2026-11-01T12:00");
  const r = parseRange("2026-10-25T02:30", "2026-10-25T10:00", now);
  assert.equal(r.error, undefined);
  // Known limit: 02:30 exists twice (+02:00 then +01:00), Luxon takes the
  // second without warning the user.
  assert.equal(r.from.offset, 60);
  assert.equal(r.from.toUTC().toISO(), "2026-10-25T01:30:00.000Z");
});

// Intention: the shortcuts of the filters page (today, yesterday, 6 hours) give the right bounds, and an unknown
// shortcut falls back to "today" instead of causing an error.
test("presetRange : aujourd'hui, hier, 6 heures, préréglage inconnu", () => {
  const now = at("2026-11-05T12:34:56");
  const fmt = ({ start, end }) => [start.toFormat("yyyy-MM-dd HH:mm"), end.toFormat("yyyy-MM-dd HH:mm")];
  assert.deepEqual(fmt(presetRange("aujourdhui", now)), ["2026-11-05 00:00", "2026-11-05 12:34"]);
  assert.deepEqual(fmt(presetRange(undefined, now)), ["2026-11-05 00:00", "2026-11-05 12:34"]);
  assert.deepEqual(fmt(presetRange("inconnu", now)), ["2026-11-05 00:00", "2026-11-05 12:34"]);
  assert.deepEqual(fmt(presetRange("hier", now)), ["2026-11-04 00:00", "2026-11-04 23:59"]);
  assert.deepEqual(fmt(presetRange("6h", now)), ["2026-11-05 06:34", "2026-11-05 12:34"]);
});

// ---------------------------------------------------------------- HTML

// Intention (security): texts coming from Cyclos (names, descriptions) are inserted into a page. If they contained
// <script>, an attacker could have code run on the merchant's side (XSS flaw). `escapeHtml` replaces < > & " with
// entities (&lt; ...) so that the browser DISPLAYS them instead of interpreting them. The test also checks that we do not escape twice.
test("escapeHtml : & < > \" échappés, & une seule fois", () => {
  assert.equal(escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(escapeHtml("Tom & Jerry"), "Tom &amp; Jerry");
  assert.equal(escapeHtml("&lt;"), "&amp;lt;");
  assert.equal(escapeHtml(`" onfocus="x`), "&quot; onfocus=&quot;x");
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml("Café é ñ"), "Café é ñ");
});

// ---------------------------------------------------------------- amounts

// Intention: amounts display the French way (decimal comma, narrow no-break space between thousands:
// \u202f is the code of that space). A badly formatted amount on a ticket causes confusion.
test("formatAmount : format français, espace fine insécable entre les milliers", () => {
  assert.equal(formatAmount("1234.5"), "1\u202f234,50");
  assert.equal(formatAmount("1234567.89"), "1\u202f234\u202f567,89");
  assert.equal(formatAmount("12"), "12,00");
  assert.equal(formatAmount("0"), "0,00");
  assert.equal(formatAmount("999.99"), "999,99");
  assert.equal(formatAmount("1000"), "1\u202f000,00");
});

// Intention: the "+" is only added to positive amounts when requested, and zero never has a sign (no "-0,00").
test("formatAmount : signes", () => {
  assert.equal(formatAmount("-12.3"), "-12,30");
  assert.equal(formatAmount("12.3", 2, { signed: true }), "+12,30");
  assert.equal(formatAmount("-12.3", 2, { signed: true }), "-12,30");
  assert.equal(formatAmount("0.00", 2, { signed: true }), "0,00");
  assert.equal(formatAmount("-0.00"), "0,00");
  assert.equal(formatAmount("-0.00", 2, { signed: true }), "0,00");
});

// Intention: some currencies have no cents (0 decimals); and an unreadable value is returned as is
// rather than turned into a false figure.
test("formatAmount : nombre de décimales de la monnaie, valeur illisible rendue telle quelle", () => {
  assert.equal(formatAmount("1500", 0), "1\u202f500");
  assert.equal(formatAmount("1.5", 3), "1,500");
  assert.equal(formatAmount("abc"), "abc");
  assert.equal(formatAmount(""), "");
  assert.equal(formatAmount("1e5"), "1e5");
});

// ---------------------------------------------------------------- PDF

// Intention: the PDF uses a standard font that only knows the "Windows-1252" set (accented Latin letters, €, quotation marks...).
// These characters must go through intact. The following tests check what happens to the others.
test("pdfText : caractères de Windows-1252 conservés", () => {
  assert.equal(pdfText("Café Crème – « œuvre » 5 € ©"), "Café Crème – « œuvre » 5 € ©");
});

// Intention: special spaces (narrow, no-break) and control characters (line break, tab) have no
// shape in the PDF font; they are replaced by a plain space, so as not to break the layout.
test("pdfText : espaces spéciaux, retours à la ligne et contrôles deviennent des espaces", () => {
  assert.equal(pdfText("1\u202f234,50"), "1 234,50");
  assert.equal(pdfText("a\u00a0b"), "a b");
  assert.equal(pdfText("a\nb\tc\rd\u0000e\u007ff"), "a b c d e f");
});

// Intention: a character the font cannot draw (Cyrillic, Japanese, emoji) becomes ONE "?", only one even
// for an emoji, which counts as two units in JavaScript. Known limit of the PDF (see README).
test("pdfText : hors Windows-1252 -> un seul « ? » par caractère, emoji compris", () => {
  assert.equal(pdfText("Привет"), "??????");
  assert.equal(pdfText("日本"), "??");
  assert.equal(pdfText("Merci 😀!"), "Merci ?!");
  assert.equal(pdfText("\u0080\u0081"), "??");
  assert.equal(pdfText("→"), "?");
});

// Intention: a missing piece of data from Cyclos does not crash the building of the PDF.
test("pdfText : null, undefined, nombres", () => {
  assert.equal(pdfText(null), "");
  assert.equal(pdfText(undefined), "");
  assert.equal(pdfText(12.5), "12.5");
});

// Intention (security): the name of the downloaded file is built only with digits, hyphens and _. Even if the system language
// is Arabic (Arabic digits), the name stays made of digits 0-9: no strange character in the HTTP header.
test("pdfFilename : chiffres, tirets et _ seulement, même avec une langue par défaut non latine", () => {
  const from = at("2026-11-05T03:57");
  const to = at("2026-11-05T23:59");
  assert.equal(pdfFilename({ from, to }), "ticket-2026-11-05_0357_2026-11-05_2359.pdf");
  const arabic = pdfFilename({ from: from.setLocale("ar"), to: to.setLocale("ar") });
  assert.equal(arabic, "ticket-2026-11-05_0357_2026-11-05_2359.pdf");
  assert.match(arabic, /^[A-Za-z0-9_.-]+$/);
});

// ---------------------------------------------------------------- summary

// Helper for the following tests: builds the "totals" part as Cyclos returns it (received, sent, and sometimes the net balance).
const totals = (incoming, outgoing, netInflow) => ({
  status: { incoming, outgoing, ...(netInflow === undefined ? {} : { netInflow }) },
});
// A base statement (period, no lines, currency "Graines"), which each test completes with its own totals.
const baseStatement = {
  from: at("2026-01-10T08:00"),
  to: at("2026-01-10T18:00"),
  entries: [],
  truncated: false,
  merchantName: "Boutique",
  currency: { name: "Graines", decimalDigits: 2 },
};

// Intention: `ticketModel` prepares the content of the ticket (title, period, summary, lines); the screen AND the PDF use it,
// so they always show the same thing. Here, with Cyclos' totals, we check labels, amounts, period and the absence of a warning.
test("ticketModel : résumé avec solde net fourni par Cyclos", () => {
  const m = ticketModel({ ...baseStatement, totals: totals({ count: 3, sum: "1234.50" }, { count: 1, sum: "4.50" }, "1230.00") });
  assert.deepEqual(m.summary, [
    { label: "3 paiements reçus", value: "1\u202f234,50" },
    { label: "1 paiement sorti", value: "4,50" },
    { label: "Solde net", value: "+1\u202f230,00", net: true },
  ]);
  assert.equal(m.unit, "Montants en Graines");
  assert.equal(m.period, "Du 10/01/2026 08:00 au 10/01/2026 18:00");
  assert.match(m.generated, /^Ticket généré le \d\d\/\d\d\/\d{4} à \d\d:\d\d$/);
  assert.equal(m.title, "Ticket de fin de service");
  assert.equal(m.start, "2026-01-10T08:00");
  assert.equal(m.end, "2026-01-10T18:00");
  assert.equal(m.warning, "");
});

// Intention: if Cyclos does not give the net balance, we compute it (received - sent), negative or zero included, without rounding error
// (0.30 - 0.10 must give exactly 0.20; JavaScript's floating-point numbers would give 0.19999...).
test("ticketModel : solde net calculé quand Cyclos ne le donne pas, négatif, nul", () => {
  const negative = ticketModel({ ...baseStatement, totals: totals({ count: 1, sum: "5.00" }, { count: 2, sum: "12.25" }) });
  assert.equal(negative.summary[2].value, "-7,25");
  const zero = ticketModel({ ...baseStatement, totals: totals({ count: 0, sum: "0.00" }, { count: 0, sum: "0.00" }) });
  assert.deepEqual(zero.summary.map((s) => s.label), ["0 paiement reçu", "0 paiement sorti", "Solde net"]);
  assert.equal(zero.summary[2].value, "0,00");
  // 0.1 + 0.2: no floating-point rounding error.
  const floats = ticketModel({ ...baseStatement, totals: totals({ count: 2, sum: "0.30" }, { count: 0, sum: "0.10" }) });
  assert.equal(floats.summary[2].value, "+0,20");
});

// Intention: if the currency or the merchant's name is missing, the ticket is still built (2 decimals by default).
test("ticketModel : monnaie absente -> 2 décimales, nom d'unité vide ; nom du commerçant absent", () => {
  const m = ticketModel({ ...baseStatement, currency: undefined, merchantName: null, totals: totals({ count: 1, sum: "2" }, { count: 0, sum: "0" }) });
  assert.equal(m.unit, "Montants en ");
  assert.equal(m.summary[0].value, "2,00");
  assert.equal(m.merchantName, null);
});

// Intention: lines are sorted from oldest to most recent (Cyclos gives them in reverse), times are Paris time
// (summer and winter), and a missing counterparty gives an empty text. Otherwise the ticket would be hard to read.
test("ticketModel : lignes du plus ancien au plus récent, heure de Paris, contrepartie", () => {
  const entries = [
    { date: "2026-07-10T08:30:00.000Z", amount: "-3.00", transactionNumber: "C", description: "Remboursement", relatedAccount: { type: { name: "Compte système" } } },
    { date: "2026-01-10T08:00:00.000Z", amount: "10.5", transactionNumber: "A", description: "Pain", relatedAccount: { user: { display: "Alice" } } },
    { date: "2026-03-29T00:30:00.000Z", amount: "1", relatedAccount: {} },
  ];
  const m = ticketModel({ ...baseStatement, entries, totals: totals({ count: 2, sum: "11.5" }, { count: 1, sum: "3" }) });
  assert.deepEqual(m.rows.map((r) => r.when), ["10/01 09:00", "29/03 01:30", "10/07 10:30"]);
  assert.deepEqual(m.rows.map((r) => r.counterparty), ["Alice", "", "Compte système"]);
  assert.deepEqual(m.rows.map((r) => r.amount), ["+10,50", "+1,00", "-3,00"]);
  assert.deepEqual(m.rows.map((r) => r.number), ["A", "", "C"]);
  assert.deepEqual(m.rows.map((r) => r.description), ["Pain", "", "Remboursement"]);
});

// Intention: if the list is cut (too many transactions), the ticket must say so explicitly.
test("ticketModel : avertissement quand la liste est tronquée", () => {
  const m = ticketModel({ ...baseStatement, truncated: true, totals: totals({ count: 0, sum: "0" }, { count: 0, sum: "0" }) });
  assert.match(m.warning, /limitée aux 2000 transactions les plus récentes/);
  assert.match(m.warning, /totaux du résumé restent exacts/);
});
