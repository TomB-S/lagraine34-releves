// Totaux du résumé quand Cyclos répond sans incoming/outgoing/netInflow
// (comportement observé sur la vraie instance) : calculés à partir des
// transactions si la liste est complète, "Non disponible" sinon.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DateTime } from "luxon";
import { appTest } from "../test-support/harness.js";
import { entry } from "../test-support/fake-cyclos.js";
import { pdfPages } from "../test-support/pdf-text.js";
import { ticketModel } from "../server.js";

const RANGE = { start: "2026-01-10T00:00", end: "2026-01-10T23:59" };
const NNBSP = " ";
const NA = "Non disponible";

// Lignes avec les montants donnés (la plus récente en premier, comme Cyclos).
const withAmounts = (amounts) =>
  amounts.map((amount, n) => entry(n, { amount })).reverse();

// n lignes : trois reçues pour une sortie.
function history(count) {
  const list = [];
  for (let n = count - 1; n >= 0; n -= 1) {
    list.push(entry(n, { amount: n % 4 === 3 ? "-2.50" : `${(n % 7) + 1}.25` }));
  }
  return list;
}

const summaryOf = (html) => [...html.matchAll(/<dt>(.*?)<\/dt>\s*<dd>(.*?)<\/dd>/g)].map((m) => [m[1], m[2]]);
const rowsOf = (html) => [...html.matchAll(/<li class="ligne">/g)];
const fr = (cents) => {
  const abs = Math.abs(cents);
  const integer = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP);
  return `${integer},${String(abs % 100).padStart(2, "0")}`;
};

async function ask(app, state, path = "/releve") {
  Object.assign(app.cyclos.state, state);
  const csrf = await app.loggedIn();
  return app.request(path, { method: "POST", form: { csrf, ...RANGE } });
}
const page = async (app, state) => (await ask(app, state)).text();

// Le résumé tel qu'imprimé dans le PDF : [libellé, valeur] (espaces fines -> espaces).
async function pdfSummary(app, state, labels) {
  const res = await ask(app, state, "/releve.pdf");
  assert.equal(res.status, 200);
  const text = pdfPages(Buffer.from(await res.arrayBuffer())).join("\n");
  const lines = text.split("\n");
  return {
    text,
    summary: labels.map((label) => {
      const at = lines.indexOf(label);
      assert.ok(at >= 0, `libellé absent du PDF : ${label}`);
      return [label, lines[at + 1]];
    }),
  };
}
const asPdf = (summary) => summary.map(([label, value]) => [label, value.replaceAll(NNBSP, " ")]);

// ------------------------------------------------- totaux calculés par le code

appTest("sans indicateurs : totaux calculés sur plusieurs pages (450 lignes, 3 pages)", async (app) => {
  const entries = history(450);
  const html = await page(app, { entries, indicators: false });
  assert.equal(app.cyclos.calls("GET", "/self/accounts/membre/history").length, 3);
  assert.ok(!html.includes('class="avertissement"'));

  const cents = (e) => Math.round(Number(e.amount) * 100);
  const incoming = entries.filter((e) => cents(e) > 0);
  const outgoing = entries.filter((e) => cents(e) < 0);
  const inSum = incoming.reduce((t, e) => t + cents(e), 0);
  const outSum = outgoing.reduce((t, e) => t - cents(e), 0);
  assert.deepEqual(summaryOf(html), [
    [`${incoming.length} paiements reçus`, fr(inSum)],
    [`${outgoing.length} paiements sortis`, fr(outSum)],
    ["Solde net", `${inSum - outSum >= 0 ? "+" : "-"}${fr(inSum - outSum)}`],
  ]);
  // Et la somme des lignes affichées est bien égale au solde net.
  const shown = [...html.matchAll(/<span class="montant">(.*?)<\/span>/g)].map((m) =>
    Math.round(Number(m[1].replaceAll(NNBSP, "").replace(",", ".")) * 100));
  assert.equal(shown.reduce((t, c) => t + c, 0), inSum - outSum);
});

appTest("sans indicateurs : précision décimale (0,1 + 0,2 = 0,30 exact)", async (app) => {
  const html = await page(app, { indicators: false, entries: withAmounts(["0.10", "0.20", "-0.10", "-0.20", "-0.20"]) });
  assert.deepEqual(summaryOf(html), [
    ["2 paiements reçus", "0,30"],
    ["3 paiements sortis", "0,50"],
    ["Solde net", "-0,20"],
  ]);
  // Beaucoup de petits montants : un flottant dériverait (0.1 * 10 000).
  const many = await page(app, { entries: withAmounts(Array(10000).fill("0.10")).slice(0, 1500) });
  assert.deepEqual(summaryOf(many), [
    ["1500 paiements reçus", "150,00"],
    ["0 paiement sorti", "0,00"],
    ["Solde net", "+150,00"],
  ]);
  // Montants entiers ou à une seule décimale, et gros montants.
  const mixed = await page(app, { entries: withAmounts(["5", "1234567.5", "-0.05"]) });
  assert.deepEqual(summaryOf(mixed), [
    ["2 paiements reçus", `1${NNBSP}234${NNBSP}572,50`],
    ["1 paiement sorti", "0,05"],
    ["Solde net", `+1${NNBSP}234${NNBSP}572,45`],
  ]);
});

appTest("sans indicateurs : plage vide -> 0 reçu, 0 sorti, net 0", async (app) => {
  const html = await page(app, { indicators: false, entries: [] });
  assert.match(html, /Aucune transaction sur cette plage/);
  assert.ok(!html.includes('class="avertissement"'));
  assert.deepEqual(summaryOf(html), [
    ["0 paiement reçu", "0,00"],
    ["0 paiement sorti", "0,00"],
    ["Solde net", "0,00"],
  ]);
});

appTest("sans indicateurs : une transaction à 0 n'est ni reçue ni sortie ; net négatif", async (app) => {
  const html = await page(app, { indicators: false, entries: withAmounts(["0.00", "-3.00"]) });
  assert.deepEqual(summaryOf(html), [
    ["0 paiement reçu", "0,00"],
    ["1 paiement sorti", "3,00"],
    ["Solde net", "-3,00"],
  ]);
});

appTest("sans indicateurs : monnaie sans décimale (decimalDigits 0)", async (app) => {
  const html = await page(app, { indicators: false, currency: { name: "Graines", decimalDigits: 0 }, entries: withAmounts(["10", "5", "-4"]) });
  assert.deepEqual(summaryOf(html), [
    ["2 paiements reçus", "15"],
    ["1 paiement sorti", "4"],
    ["Solde net", "+11"],
  ]);
});

appTest("sans indicateurs : montant illisible -> 'Non disponible', jamais inventé, détail conservé", async (app) => {
  const html = await page(app, { indicators: false, entries: withAmounts(["1.00", "abc"]) });
  assert.deepEqual(summaryOf(html).map(([, v]) => v), [NA, NA, NA]);
  assert.equal(rowsOf(html).length, 2);
});

// ------------------------------------------------------------- liste tronquée

appTest("sans indicateurs : exactement 2000 lignes -> totaux calculés, pas d'avertissement", async (app) => {
  const html = await page(app, { indicators: false, entries: withAmounts(Array(2000).fill("1.50")) });
  assert.equal(rowsOf(html).length, 2000);
  assert.ok(!html.includes('class="avertissement"'));
  assert.deepEqual(summaryOf(html), [
    ["2000 paiements reçus", `3${NNBSP}000,00`],
    ["0 paiement sorti", "0,00"],
    ["Solde net", `+3${NNBSP}000,00`],
  ]);
});

appTest("sans indicateurs : 2001 lignes -> 'Non disponible' x3, avertissement clair, détail affiché", async (app) => {
  const html = await page(app, { indicators: false, entries: withAmounts(Array(2001).fill("1.50")) });
  assert.equal(rowsOf(html).length, 2000, "le détail reste affiché");
  assert.deepEqual(summaryOf(html), [
    ["Paiements reçus", NA],
    ["Paiements sortis", NA],
    ["Solde net", NA],
  ]);
  assert.match(html, /<p class="avertissement" role="alert">Attention : la liste est limitée aux 2000 transactions les plus récentes/);
  assert.match(html, /totaux du résumé ne peuvent pas être calculés au-delà de 2000 transactions/);
  assert.ok(!html.includes("restent exacts"), "ne prétend pas que les totaux sont exacts");
  assert.ok(!/\+?0,00|3 000/.test(summaryOf(html).map(([, v]) => v).join()), "aucun faux chiffre");
});

// ------------------------------------------------------------ page et PDF

appTest("sans indicateurs : page et PDF montrent le même résumé (calculé)", async (app) => {
  const state = { indicators: false, entries: history(120) };
  const html = await page(app, state);
  const expected = summaryOf(html);
  const { summary } = await pdfSummary(app, {}, expected.map(([label]) => label));
  assert.deepEqual(summary, asPdf(expected));
});

appTest("sans indicateurs : page et PDF montrent le même résumé et le même avertissement (tronqué)", async (app) => {
  const state = { indicators: false, entries: withAmounts(Array(2001).fill("1.50")) };
  const html = await page(app, state);
  const expected = summaryOf(html);
  assert.deepEqual(expected.map(([, v]) => v), [NA, NA, NA]);
  const { summary, text } = await pdfSummary(app, {}, expected.map(([label]) => label));
  assert.deepEqual(summary, asPdf(expected));
  assert.match(text.replace(/\s+/g, " "), /totaux du résumé ne peuvent pas être calculés au-delà de 2000 transactions/);
});

// ------------------------------------------------ mode avec indicateurs inchangé

appTest("avec indicateurs : les totaux de Cyclos sont repris tels quels (même s'ils diffèrent des lignes)", async (app) => {
  // Valeurs volontairement différentes de la somme des lignes : le code ne recalcule rien.
  const html = await page(app, {
    entries: withAmounts(["1.00", "-1.00"]),
    totals: { incoming: { count: 7, sum: "70.00" }, outgoing: { count: 3, sum: "30.00" }, netInflow: "40.00" },
  });
  assert.deepEqual(summaryOf(html), [
    ["7 paiements reçus", "70,00"],
    ["3 paiements sortis", "30,00"],
    ["Solde net", "+40,00"],
  ]);
});

appTest("avec indicateurs : liste tronquée -> totaux de Cyclos et mention 'restent exacts'", async (app) => {
  const entries = withAmounts(Array(2500).fill("2.00"));
  const html = await page(app, { entries });
  assert.deepEqual(summaryOf(html), [
    ["2500 paiements reçus", `5${NNBSP}000,00`],
    ["0 paiement sorti", "0,00"],
    ["Solde net", `+5${NNBSP}000,00`],
  ]);
  assert.match(html, /totaux du résumé restent exacts/);
  assert.ok(!html.includes(NA));
});

// --------------------------------------------------------- lecture défensive

const at = (text) => DateTime.fromFormat(text, "yyyy-MM-dd'T'HH:mm", { zone: "Europe/Paris" });
const base = {
  from: at("2026-01-10T08:00"),
  to: at("2026-01-10T18:00"),
  entries: [],
  truncated: false,
  merchantName: "Boutique",
  currency: { name: "Graines", decimalDigits: 2 },
};

test("ticketModel : totaux absents, vides ou incomplets -> pas d'exception, 'Non disponible'", () => {
  const cases = [
    undefined,
    null,
    {},
    { status: {} },
    { status: null },
    { status: { balance: "125.00", availableBalance: "125.00", creditLimit: "0.00", reservedAmount: "0.00", upperCreditLimit: "1000.00" } },
    { status: { incoming: { count: 1, sum: "1.00" } } },
    { status: { outgoing: { count: 1, sum: "1.00" } } },
    { status: { incoming: {}, outgoing: {} } },
    { status: { incoming: { count: 1, sum: "x" }, outgoing: { count: 1, sum: "1.00" } } },
  ];
  for (const totals of cases) {
    const m = ticketModel({ ...base, totals });
    assert.deepEqual(m.summary.map((s) => s.value), [NA, NA, NA], JSON.stringify(totals));
    assert.match(m.warning, /Non disponible/);
  }
});

test("ticketModel : totaux absents et liste tronquée -> avertissement dédié", () => {
  const m = ticketModel({ ...base, totals: { status: {} }, truncated: true });
  assert.match(m.warning, /ne peuvent pas être calculés au-delà de 2000 transactions/);
  assert.deepEqual(m.summary.map((s) => s.label), ["Paiements reçus", "Paiements sortis", "Solde net"]);
});

test("ticketModel : indicateurs présents sans netInflow -> net exact en entiers", () => {
  const m = ticketModel({ ...base, totals: { status: { incoming: { count: 2, sum: "0.30" }, outgoing: { count: 1, sum: "0.10" } } } });
  assert.deepEqual(m.summary.map((s) => s.value), ["0,30", "0,10", "+0,20"]);
  assert.equal(m.warning, "");
});
