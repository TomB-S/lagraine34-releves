// === CE QUE VÉRIFIE CE FICHIER ===
// Le calcul des TOTAUX du ticket (paiements reçus, sortis, solde net). Sur la vraie instance, Cyclos ne renvoie pas ces totaux : c'est donc
// NOTRE code qui les calcule à partir des transactions. Une erreur ici = un solde faux sur le ticket du commerçant. On vérifie la
// précision (centimes exacts), le cas « liste trop longue » (on affiche « Non disponible » plutôt qu'un chiffre faux), et que l'écran et le
// PDF disent la même chose. Utilise le faux Cyclos en mode `indicators: false` qui imite la vraie instance. Notions de base : test/statique.test.js.
// Summary totals when Cyclos answers without incoming/outgoing/netInflow
// (behaviour observed on the real instance): computed from the
// transactions if the list is complete, "Non disponible" otherwise.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DateTime } from "luxon";
import { appTest } from "../test-support/harness.js";
import { entry } from "../test-support/fake-cyclos.js";
import { pdfPages } from "../test-support/pdf-text.js";
import { ticketModel } from "../server.js";

const RANGE = { start: "2026-01-10T00:00", end: "2026-01-10T23:59" };
// Espace fine insécable (U+202F) entre les milliers des montants affichés.
const NNBSP = " ";
// Texte affiché quand un total ne peut pas être garanti. Mieux vaut « Non disponible » qu'un faux chiffre.
const NA = "Non disponible";

// Lines with the given amounts (most recent first, like Cyclos).
// Fabrique des transactions à partir d'une liste de montants (texte), la plus récente en premier comme Cyclos.
const withAmounts = (amounts) =>
  amounts.map((amount, n) => entry(n, { amount })).reverse();

// n lines: three incoming for one outgoing.
// Fabrique `count` transactions mélangées (trois reçues pour une sortie).
function history(count) {
  const list = [];
  for (let n = count - 1; n >= 0; n -= 1) {
    list.push(entry(n, { amount: n % 4 === 3 ? "-2.50" : `${(n % 7) + 1}.25` }));
  }
  return list;
}

// Lit les trois lignes du résumé dans la page : [libellé, montant].
const summaryOf = (html) => [...html.matchAll(/<dt>(.*?)<\/dt>\s*<dd>(.*?)<\/dd>/g)].map((m) => [m[1], m[2]]);
const rowsOf = (html) => [...html.matchAll(/<li class="ligne">/g)];
// Écrit un nombre de centimes à la française (123450 -> « 1 234,50 ») pour comparer avec la page.
const fr = (cents) => {
  const abs = Math.abs(cents);
  const integer = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP);
  return `${integer},${String(abs % 100).padStart(2, "0")}`;
};

// Applique l'état au faux Cyclos, se connecte et envoie la demande de relevé (page ou PDF).
async function ask(app, state, path = "/releve") {
  Object.assign(app.cyclos.state, state);
  const csrf = await app.loggedIn();
  return app.request(path, { method: "POST", form: { csrf, ...RANGE } });
}
// Raccourci : le HTML de la page de relevé.
const page = async (app, state) => (await ask(app, state)).text();

// The summary as printed in the PDF: [label, value] (narrow spaces -> spaces).
// Relève dans le PDF les montants qui suivent les libellés du résumé, pour les comparer à la page.
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
// Dans le PDF les espaces fines sont des espaces normales ; on convertit la valeur de la page pour comparer.
const asPdf = (summary) => summary.map(([label, value]) => [label, value.replaceAll(NNBSP, " ")]);

// ------------------------------------------------- totals computed by the code

// Intention : sans totaux fournis par Cyclos, l'outil les calcule lui-même sur toutes les pages, et le résultat est exact.
//
// Pourquoi des ENTIERS : en JavaScript, 0.1 + 0.2 donne 0.30000000000000004 (les nombres à virgule sont approximatifs). Pour de l'argent
// c'est inacceptable ; le serveur convertit donc chaque montant en centimes entiers avec des `BigInt` (entiers de taille illimitée,
// écrits 12n), additionne, puis remet la virgule. Ici le test refait le calcul de son côté en centimes pour comparer.
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
  // And the sum of the displayed lines does equal the net balance.
  const shown = [...html.matchAll(/<span class="montant">(.*?)<\/span>/g)].map((m) =>
    Math.round(Number(m[1].replaceAll(NNBSP, "").replace(",", ".")) * 100));
  assert.equal(shown.reduce((t, c) => t + c, 0), inSum - outSum);
});

// Intention : 0,10 + 0,20 fait exactement 0,30 ; 1500 fois 0,10 fait exactement 150,00 (un calcul à virgule dériverait) ; les montants entiers,
// à une décimale ou très grands sont bien lus. Les deux derniers cas reprennent sans le répéter l'état `indicators: false` posé au premier appel.
appTest("sans indicateurs : précision décimale (0,1 + 0,2 = 0,30 exact)", async (app) => {
  const html = await page(app, { indicators: false, entries: withAmounts(["0.10", "0.20", "-0.10", "-0.20", "-0.20"]) });
  assert.deepEqual(summaryOf(html), [
    ["2 paiements reçus", "0,30"],
    ["3 paiements sortis", "0,50"],
    ["Solde net", "-0,20"],
  ]);
  // Many small amounts: a float would drift (0.1 * 10 000).
  const many = await page(app, { entries: withAmounts(Array(10000).fill("0.10")).slice(0, 1500) });
  assert.deepEqual(summaryOf(many), [
    ["1500 paiements reçus", "150,00"],
    ["0 paiement sorti", "0,00"],
    ["Solde net", "+150,00"],
  ]);
  // Whole amounts or with a single decimal, and large amounts.
  const mixed = await page(app, { entries: withAmounts(["5", "1234567.5", "-0.05"]) });
  assert.deepEqual(summaryOf(mixed), [
    ["2 paiements reçus", `1${NNBSP}234${NNBSP}572,50`],
    ["1 paiement sorti", "0,05"],
    ["Solde net", `+1${NNBSP}234${NNBSP}572,45`],
  ]);
});

// Intention : pas de transaction = 0 reçu, 0 sorti, solde 0, sans erreur.
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

// Intention : une transaction de 0,00 n'est comptée ni comme reçue ni comme sortie ; un solde négatif s'affiche avec son signe.
appTest("sans indicateurs : une transaction à 0 n'est ni reçue ni sortie ; net négatif", async (app) => {
  const html = await page(app, { indicators: false, entries: withAmounts(["0.00", "-3.00"]) });
  assert.deepEqual(summaryOf(html), [
    ["0 paiement reçu", "0,00"],
    ["1 paiement sorti", "3,00"],
    ["Solde net", "-3,00"],
  ]);
});

// Intention : une monnaie sans centimes (decimalDigits 0) s'affiche sans virgule et se calcule en entiers justes.
appTest("sans indicateurs : monnaie sans décimale (decimalDigits 0)", async (app) => {
  const html = await page(app, { indicators: false, currency: { name: "Graines", decimalDigits: 0 }, entries: withAmounts(["10", "5", "-4"]) });
  assert.deepEqual(summaryOf(html), [
    ["2 paiements reçus", "15"],
    ["1 paiement sorti", "4"],
    ["Solde net", "+11"],
  ]);
});

// Intention : un montant inexploitable (« abc ») ne doit pas fabriquer un total : les trois lignes disent « Non disponible » mais le détail reste affiché.
appTest("sans indicateurs : montant illisible -> 'Non disponible', jamais inventé, détail conservé", async (app) => {
  const html = await page(app, { indicators: false, entries: withAmounts(["1.00", "abc"]) });
  assert.deepEqual(summaryOf(html).map(([, v]) => v), [NA, NA, NA]);
  assert.equal(rowsOf(html).length, 2);
});

// ------------------------------------------------------------- truncated list

// Cas limite : 2000 lignes = liste complète, donc on peut calculer les totaux, sans avertissement.
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

// Intention : au-delà de 2000, la liste est coupée donc un total calculé serait faux : on affiche « Non disponible » trois fois avec un avertissement clair,
// et on ne prétend surtout pas que les totaux sont exacts.
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

// ------------------------------------------------------------ page and PDF

// Intention : l'écran et le PDF affichent exactement le même résumé (ils partagent la même fonction `ticketModel`).
appTest("sans indicateurs : page et PDF montrent le même résumé (calculé)", async (app) => {
  const state = { indicators: false, entries: history(120) };
  const html = await page(app, state);
  const expected = summaryOf(html);
  const { summary } = await pdfSummary(app, {}, expected.map(([label]) => label));
  assert.deepEqual(summary, asPdf(expected));
});

// Idem pour le cas « liste trop longue » : mêmes « Non disponible » et même avertissement sur l'écran et sur papier.
appTest("sans indicateurs : page et PDF montrent le même résumé et le même avertissement (tronqué)", async (app) => {
  const state = { indicators: false, entries: withAmounts(Array(2001).fill("1.50")) };
  const html = await page(app, state);
  const expected = summaryOf(html);
  assert.deepEqual(expected.map(([, v]) => v), [NA, NA, NA]);
  const { summary, text } = await pdfSummary(app, {}, expected.map(([label]) => label));
  assert.deepEqual(summary, asPdf(expected));
  assert.match(text.replace(/\s+/g, " "), /totaux du résumé ne peuvent pas être calculés au-delà de 2000 transactions/);
});

// ------------------------------------------------ indicators mode unchanged

// Intention : quand Cyclos fournit ses totaux, l'outil les reprend tels quels, sans recalcul. Le test met des valeurs volontairement différentes
// des lignes pour prouver qu'on n'a rien recalculé.
appTest("avec indicateurs : les totaux de Cyclos sont repris tels quels (même s'ils diffèrent des lignes)", async (app) => {
  // Values deliberately different from the sum of the lines: the code recomputes nothing.
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

// Intention : même avec la liste coupée, les totaux de Cyclos restent exacts (calculés par Cyclos sur toute la période) et l'avertissement le précise.
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

// --------------------------------------------------------- defensive reading

// Les tests qui suivent sont « unitaires » (sans serveur) : ils appellent directement `ticketModel`. `at` et `base` préparent une période et un relevé vides.
const at = (text) => DateTime.fromFormat(text, "yyyy-MM-dd'T'HH:mm", { zone: "Europe/Paris" });
const base = {
  from: at("2026-01-10T08:00"),
  to: at("2026-01-10T18:00"),
  entries: [],
  truncated: false,
  merchantName: "Boutique",
  currency: { name: "Graines", decimalDigits: 2 },
};

// Intention : lecture « défensive » : quelle que soit la forme des totaux renvoyés (absents, vides, partiels, illisibles), il n'y a jamais d'exception
// et le résumé dit « Non disponible ». Sinon une réponse inattendue de Cyclos ferait planter la page du commerçant.
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

// Intention : sans totaux ET avec une liste coupée, le message d'avertissement dédié est affiché.
test("ticketModel : totaux absents et liste tronquée -> avertissement dédié", () => {
  const m = ticketModel({ ...base, totals: { status: {} }, truncated: true });
  assert.match(m.warning, /ne peuvent pas être calculés au-delà de 2000 transactions/);
  assert.deepEqual(m.summary.map((s) => s.label), ["Paiements reçus", "Paiements sortis", "Solde net"]);
});

// Intention : si Cyclos donne reçus et sortis mais pas le net, le net est calculé en entiers (0,30 - 0,10 = +0,20 exact).
test("ticketModel : indicateurs présents sans netInflow -> net exact en entiers", () => {
  const m = ticketModel({ ...base, totals: { status: { incoming: { count: 2, sum: "0.30" }, outgoing: { count: 1, sum: "0.10" } } } });
  assert.deepEqual(m.summary.map((s) => s.value), ["0,30", "0,10", "+0,20"]);
  assert.equal(m.warning, "");
});
