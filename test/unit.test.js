// Unit tests of the pure functions (no server, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import {
  escapeHtml,
  formatAmount,
  parseRange,
  pdfFilename,
  presetRange,
  ticketModel,
} from "../server.js";
import { pdfText } from "../ticket-pdf.js";

const ZONE = "Europe/Paris";
const at = (iso) => DateTime.fromISO(iso, { zone: ZONE });
const NOW = at("2026-11-05T12:00:30"); // Thursday, winter time

// ---------------------------------------------------------------- dates

test("parseRange : plage valide, la dernière minute est incluse", () => {
  const r = parseRange("2026-11-05T08:00", "2026-11-05T11:59", NOW);
  assert.equal(r.error, undefined);
  assert.equal(r.clamped, false);
  assert.equal(r.from.toISO(), "2026-11-05T08:00:00.000+01:00");
  assert.equal(r.to.toFormat("HH:mm"), "11:59");
  assert.equal(r.until.toFormat("HH:mm:ss.SSS"), "11:59:59.999");
});

test("parseRange : format invalide", () => {
  for (const bad of ["", undefined, null, "2026-11-05 08:00", "05/11/2026 08:00", "2026-11-05T08:00:30", "2026-11-5T8:00", "abc"]) {
    assert.match(parseRange(bad, "2026-11-05T09:00", NOW).error, /Date de début invalide.*format attendu/, String(bad));
    assert.match(parseRange("2026-11-05T08:00", bad, NOW).error, /Date de fin invalide.*format attendu/, String(bad));
  }
});

test("parseRange : date absente du calendrier", () => {
  assert.match(parseRange("2026-02-30T10:00", "2026-03-01T10:00", NOW).error, /début n'existe pas dans le calendrier/);
  assert.match(parseRange("2026-11-01T10:00", "2026-13-01T10:00", NOW).error, /fin n'existe pas dans le calendrier/);
});

test("parseRange : fin avant le début, ou égale au début", () => {
  assert.equal(parseRange("2026-11-05T10:00", "2026-11-05T09:00", NOW).error, "La fin doit être après le début.");
  assert.equal(parseRange("2026-11-05T10:00", "2026-11-05T10:00", NOW).error, "La fin doit être après le début.");
});

test("parseRange : 31 jours au plus", () => {
  const ok = parseRange("2026-10-05T00:00", "2026-11-05T00:00", NOW);
  assert.equal(ok.error, undefined);
  assert.match(parseRange("2026-10-05T00:00", "2026-11-05T00:01", NOW).error, /ne peut pas dépasser 31 jours/);
  assert.match(parseRange("2026-01-01T00:00", "2026-11-05T00:00", NOW).error, /ne peut pas dépasser 31 jours/);
});

test("parseRange : début dans le futur refusé", () => {
  assert.equal(parseRange("2026-11-05T12:01", "2026-11-05T13:00", NOW).error, "Le début ne peut pas être dans le futur.");
  assert.equal(parseRange("2027-01-01T00:00", "2027-01-02T00:00", NOW).error, "Le début ne peut pas être dans le futur.");
});

test("parseRange : fin dans le futur ramenée à maintenant", () => {
  const r = parseRange("2026-11-05T10:00", "2026-11-06T10:00", NOW);
  assert.equal(r.error, undefined);
  assert.equal(r.clamped, true);
  assert.equal(r.to.toFormat("yyyy-MM-dd HH:mm"), "2026-11-05 12:00");
  assert.equal(r.until.toMillis(), NOW.toMillis());
});

test("parseRange : début à la seconde même de maintenant et fin future -> fin avant le début", () => {
  const now = at("2026-11-05T12:00:00");
  assert.equal(parseRange("2026-11-05T12:00", "2026-11-05T13:00", now).error, "La fin doit être après le début.");
});

test("parseRange : heure inexistante au passage à l'heure d'été (29 mars 2026, 02:30)", () => {
  const now = at("2026-04-01T12:00");
  const start = parseRange("2026-03-29T02:30", "2026-03-29T10:00", now);
  assert.match(start.error, /heure de début saisie \(29\/03\/2026 à 02:30\) n'existe pas/);
  const end = parseRange("2026-03-29T01:00", "2026-03-29T02:30", now);
  assert.match(end.error, /heure de fin saisie \(29\/03\/2026 à 02:30\) n'existe pas/);
  // The neighbouring hours exist.
  assert.equal(parseRange("2026-03-29T01:59", "2026-03-29T03:00", now).error, undefined);
});

test("parseRange : heure ambiguë (25 octobre 2026, 02:30) acceptée, seconde occurrence (heure d'hiver) retenue", () => {
  const now = at("2026-11-01T12:00");
  const r = parseRange("2026-10-25T02:30", "2026-10-25T10:00", now);
  assert.equal(r.error, undefined);
  // Known limit: 02:30 exists twice (+02:00 then +01:00), Luxon takes the
  // second without warning the user.
  assert.equal(r.from.offset, 60);
  assert.equal(r.from.toUTC().toISO(), "2026-10-25T01:30:00.000Z");
});

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

test("escapeHtml : & < > \" échappés, & une seule fois", () => {
  assert.equal(escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(escapeHtml("Tom & Jerry"), "Tom &amp; Jerry");
  assert.equal(escapeHtml("&lt;"), "&amp;lt;");
  assert.equal(escapeHtml(`" onfocus="x`), "&quot; onfocus=&quot;x");
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml("Café é ñ"), "Café é ñ");
});

// ---------------------------------------------------------------- amounts

test("formatAmount : format français, espace fine insécable entre les milliers", () => {
  assert.equal(formatAmount("1234.5"), "1\u202f234,50");
  assert.equal(formatAmount("1234567.89"), "1\u202f234\u202f567,89");
  assert.equal(formatAmount("12"), "12,00");
  assert.equal(formatAmount("0"), "0,00");
  assert.equal(formatAmount("999.99"), "999,99");
  assert.equal(formatAmount("1000"), "1\u202f000,00");
});

test("formatAmount : signes", () => {
  assert.equal(formatAmount("-12.3"), "-12,30");
  assert.equal(formatAmount("12.3", 2, { signed: true }), "+12,30");
  assert.equal(formatAmount("-12.3", 2, { signed: true }), "-12,30");
  assert.equal(formatAmount("0.00", 2, { signed: true }), "0,00");
  assert.equal(formatAmount("-0.00"), "0,00");
  assert.equal(formatAmount("-0.00", 2, { signed: true }), "0,00");
});

test("formatAmount : nombre de décimales de la monnaie, valeur illisible rendue telle quelle", () => {
  assert.equal(formatAmount("1500", 0), "1\u202f500");
  assert.equal(formatAmount("1.5", 3), "1,500");
  assert.equal(formatAmount("abc"), "abc");
  assert.equal(formatAmount(""), "");
  assert.equal(formatAmount("1e5"), "1e5");
});

// ---------------------------------------------------------------- PDF

test("pdfText : caractères de Windows-1252 conservés", () => {
  assert.equal(pdfText("Café Crème – « œuvre » 5 € ©"), "Café Crème – « œuvre » 5 € ©");
});

test("pdfText : espaces spéciaux, retours à la ligne et contrôles deviennent des espaces", () => {
  assert.equal(pdfText("1\u202f234,50"), "1 234,50");
  assert.equal(pdfText("a\u00a0b"), "a b");
  assert.equal(pdfText("a\nb\tc\rd\u0000e\u007ff"), "a b c d e f");
});

test("pdfText : hors Windows-1252 -> un seul « ? » par caractère, emoji compris", () => {
  assert.equal(pdfText("Привет"), "??????");
  assert.equal(pdfText("日本"), "??");
  assert.equal(pdfText("Merci 😀!"), "Merci ?!");
  assert.equal(pdfText("\u0080\u0081"), "??");
  assert.equal(pdfText("→"), "?");
});

test("pdfText : null, undefined, nombres", () => {
  assert.equal(pdfText(null), "");
  assert.equal(pdfText(undefined), "");
  assert.equal(pdfText(12.5), "12.5");
});

test("pdfFilename : chiffres, tirets et _ seulement, même avec une langue par défaut non latine", () => {
  const from = at("2026-11-05T03:57");
  const to = at("2026-11-05T23:59");
  assert.equal(pdfFilename({ from, to }), "ticket-2026-11-05_0357_2026-11-05_2359.pdf");
  const arabic = pdfFilename({ from: from.setLocale("ar"), to: to.setLocale("ar") });
  assert.equal(arabic, "ticket-2026-11-05_0357_2026-11-05_2359.pdf");
  assert.match(arabic, /^[A-Za-z0-9_.-]+$/);
});

// ---------------------------------------------------------------- summary

const totals = (incoming, outgoing, netInflow) => ({
  status: { incoming, outgoing, ...(netInflow === undefined ? {} : { netInflow }) },
});
const baseStatement = {
  from: at("2026-01-10T08:00"),
  to: at("2026-01-10T18:00"),
  entries: [],
  truncated: false,
  merchantName: "Boutique",
  currency: { name: "Graines", decimalDigits: 2 },
};

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

test("ticketModel : monnaie absente -> 2 décimales, nom d'unité vide ; nom du commerçant absent", () => {
  const m = ticketModel({ ...baseStatement, currency: undefined, merchantName: null, totals: totals({ count: 1, sum: "2" }, { count: 0, sum: "0" }) });
  assert.equal(m.unit, "Montants en ");
  assert.equal(m.summary[0].value, "2,00");
  assert.equal(m.merchantName, null);
});

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

test("ticketModel : avertissement quand la liste est tronquée", () => {
  const m = ticketModel({ ...baseStatement, truncated: true, totals: totals({ count: 0, sum: "0" }, { count: 0, sum: "0" }) });
  assert.match(m.warning, /limitée aux 2000 transactions les plus récentes/);
  assert.match(m.warning, /totaux du résumé restent exacts/);
});
