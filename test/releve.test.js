// === WHAT THIS FILE CHECKS ===
// The product itself: the end-of-service ticket, on screen (POST /releve) and as a PDF (POST /releve.pdf). We check that the reading of
// transactions at Cyclos is complete (several pages), that dates are sent correctly, that totals match the lines, that texts coming
// from Cyclos are protected, and that the PDF says the same as the screen. For the merchant: a correct ticket is their till.
// Uses the harness and the fake Cyclos (test-support/), and pdf-text.js to read the PDF. Basic notions: test/statique.test.js.
// POST /releve (page) and POST /releve.pdf, with the fake Cyclos.
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { appTest } from "../test-support/harness.js";
import { entry } from "../test-support/fake-cyclos.js";
import { pdfPages } from "../test-support/pdf-text.js";

const RANGE = { start: "2026-01-10T00:00", end: "2026-01-10T23:59" };
// NNBSP = narrow no-break space (U+202F), used between thousands in amounts ("1 234,50").
const NNBSP = "\u202f";

// n transactions, most recent first like Cyclos; one in four is outgoing.
// Builds `count` fictitious transactions, most recent first like Cyclos, with a mix of received and sent amounts.
function history(count) {
  const list = [];
  for (let n = count - 1; n >= 0; n -= 1) {
    list.push(entry(n, { amount: n % 4 === 3 ? "-2.50" : `${(n % 7) + 1}.25` }));
  }
  return list;
}

// Converts a displayed amount ("1 234,50") into cents (123450): we thus compare integers, without rounding error.
const cents = (text) => Math.round(Number(text.replaceAll(NNBSP, "").replace(",", ".")) * 100);

// Extracts the three summary lines from the HTML page: [label, amount]. A regular expression reads the <dt>/<dd> tags.
function summaryOf(html) {
  return [...html.matchAll(/<dt>(.*?)<\/dt>\s*<dd>(.*?)<\/dd>/g)].map((m) => [m[1], m[2]]);
}
// The transaction lines of the page (one <li class="ligne"> per transaction).
const rowsOf = (html) => [...html.matchAll(/<li class="ligne">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
// The amounts displayed in the detail.
const amountsOf = (html) => [...html.matchAll(/<span class="montant">(.*?)<\/span>/g)].map((m) => m[1]);

// Shortcut: applies the wanted state to the fake Cyclos, logs in, and asks for the statement (page or PDF). Returns the response.
async function statement(app, state = {}, path = "/releve", range = RANGE) {
  Object.assign(app.cyclos.state, state);
  const csrf = await app.loggedIn();
  return app.request(path, { method: "POST", form: { csrf, ...range } });
}

// ------------------------------------------------------------ /releve

// Intention: the ticket is COMPLETE and CONSISTENT: all transactions are read despite pagination, dates are sent to Cyclos in the right
// format, and the sum of the displayed lines equals the summary. If this broke: sales would be missing or the balance would be wrong.
//
// Pagination: Cyclos does not return 450 lines at once but in pages of 200; the tool asks for page 0, 1, 2... as long as Cyclos
// announces a next page. UTC: Cyclos receives dates in universal time (UTC); Paris in January = UTC+1, so midnight in
// Paris is sent as 23:00 the day before. The test checks this offset.
appTest("/releve : relevé cohérent avec les totaux sur plusieurs pages (450 lignes, 3 pages)", async (app) => {
  const entries = history(450);
  const res = await statement(app, { entries });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html; charset=utf-8$/);
  const html = await res.text();

  // Three pages of 200 requested, in order.
  const pages = app.cyclos.calls("GET", "/self/accounts/membre/history");
  assert.deepEqual(pages.map((p) => [p.query.get("page"), p.query.get("pageSize")]), [["0", "200"], ["1", "200"], ["2", "200"]]);
  // Bounds are sent in UTC (Paris in January = UTC+1), the end including the last minute.
  for (const call of [...pages, ...app.cyclos.calls("GET", "/self/accounts/membre")]) {
    assert.deepEqual(call.query.getAll("datePeriod"), ["2026-01-09T23:00:00.000Z", "2026-01-10T22:59:59.999Z"]);
  }

  // All lines are there, oldest to most recent, without duplicates.
  const numbers = [...html.matchAll(/<span class="numero">(.*?)<\/span>/g)].map((m) => m[1]);
  assert.equal(numbers.length, 450);
  assert.deepEqual(numbers, entries.map((e) => e.transactionNumber).reverse());
  assert.ok(!html.includes('class="avertissement"'));

  // The summary is Cyclos' one, and the sum of the displayed lines equals it.
  const summary = summaryOf(html);
  const incoming = entries.filter((e) => Number(e.amount) > 0);
  const outgoing = entries.filter((e) => Number(e.amount) < 0);
  assert.equal(summary[0][0], `${incoming.length} paiements reçus`);
  assert.equal(summary[1][0], `${outgoing.length} paiements sortis`);
  assert.equal(summary[2][0], "Solde net");
  const displayed = amountsOf(html).map(cents);
  assert.equal(displayed.filter((c) => c > 0).reduce((a, b) => a + b, 0), cents(summary[0][1]));
  assert.equal(-displayed.filter((c) => c < 0).reduce((a, b) => a + b, 0), cents(summary[1][1]));
  assert.equal(displayed.reduce((a, b) => a + b, 0), cents(summary[2][1]));
  assert.match(summary[2][1], /^\+/);

  assert.match(html, /<p class="commercant">Boutique de Test<\/p>/);
  assert.match(html, /<p class="periode">Du 10\/01\/2026 00:00 au 10\/01\/2026 23:59<\/p>/);
  assert.match(html, /Montants en Graines/);
  // PDF form: same dates, session CSRF token.
  assert.match(html, /action="\/releve\.pdf"[\s\S]*name="csrf" value="[0-9a-f]{64}"[\s\S]*name="start" value="2026-01-10T00:00"[\s\S]*name="end" value="2026-01-10T23:59"/);
});

// Intention: if Cyclos returns pages smaller than requested (50 instead of 200), the tool still keeps reading to the end,
// guided by the `X-Has-Next-Page` header and not by an assumption. Otherwise the ticket would be cut without warning.
appTest("/releve : Cyclos donne des pages plus petites que demandé, la lecture suit l'en-tête X-Has-Next-Page", async (app) => {
  const res = await statement(app, { entries: history(130), pageSize: 50 });
  assert.equal(rowsOf(await res.text()).length, 130);
  assert.equal(app.cyclos.calls("GET", "/self/accounts/membre/history").length, 3);
});

// Intention: a period with no sale gives a valid ticket at zero ("Aucune transaction sur cette plage"), not an error.
appTest("/releve : aucune transaction", async (app) => {
  const html = await (await statement(app, { entries: [] })).text();
  assert.match(html, /Aucune transaction sur cette plage/);
  assert.equal(rowsOf(html).length, 0);
  assert.deepEqual(summaryOf(html), [["0 paiement reçu", "0,00"], ["0 paiement sorti", "0,00"], ["Solde net", "0,00"]]);
});

// Intention: beyond 2000 transactions, the detail is cut (the most recent are kept) AND a warning says so. The summary stays
// correct because Cyclos computed it over the whole period. Reading stops at the cap instead of downloading all 2500 lines.
appTest("/releve : plafond de 2000 lignes -> avertissement, les plus récentes gardées, totaux exacts", async (app) => {
  const entries = history(2500);
  const html = await (await statement(app, { entries })).text();
  assert.match(html, /<p class="avertissement" role="alert">Attention : la liste est limitée aux 2000 transactions les plus récentes/);
  assert.match(html, /totaux du résumé restent exacts/);
  const numbers = [...html.matchAll(/<span class="numero">(.*?)<\/span>/g)].map((m) => m[1]);
  assert.equal(numbers.length, 2000);
  assert.equal(numbers[0], "T00500", "la plus ancienne gardée");
  assert.equal(numbers.at(-1), "T02499", "la plus récente");
  // The summary counts the 2500 transactions, not the 2000 displayed.
  const incoming = entries.filter((e) => Number(e.amount) > 0).length;
  assert.equal(summaryOf(html)[0][0], `${incoming} paiements reçus`);
  assert.ok(app.cyclos.calls("GET", "/self/accounts/membre/history").length <= 11, "lecture arrêtée au plafond");
});

// Edge case: exactly 2000 lines = nothing left out, so no warning; 2001 = one line left out, so a warning.
appTest("/releve : exactement 2000 lignes -> pas d'avertissement ; 2001 -> avertissement", async (app) => {
  const csrf = await app.loggedIn();
  app.cyclos.state.entries = history(2000);
  let html = await (await app.request("/releve", { method: "POST", form: { csrf, ...RANGE } })).text();
  assert.equal(rowsOf(html).length, 2000);
  assert.ok(!html.includes("avertissement"));
  app.cyclos.state.entries = history(2001);
  html = await (await app.request("/releve", { method: "POST", form: { csrf, ...RANGE } })).text();
  assert.equal(rowsOf(html).length, 2000);
  assert.match(html, /class="avertissement"/);
});

// Intention: the merchant's name is a "nice to have": if Cyclos does not give it (500 error), the ticket is still produced, without a name.
appTest("/releve : nom d'affichage indisponible -> relevé sans nom", async (app) => {
  app.cyclos.force("GET /users/self", 500);
  const html = await (await statement(app, { entries: history(3) })).text();
  assert.ok(!html.includes('class="commercant"'));
  assert.equal(rowsOf(html).length, 3);
});

// Intention: but a 401 (expired token) during this request is serious: back to the login, session closed.
appTest("/releve : 401 sur le nom d'affichage -> session close, retour à /", async (app) => {
  app.cyclos.force("GET /users/self", 401);
  const res = await statement(app, { entries: history(3) });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
});

// Intention (security): names and descriptions come from Cyclos, hence from any user. A booby-trapped name containing <script> or <img onerror>
// must be displayed as text, never interpreted by the browser (XSS flaw). See `escapeHtml` in test/unit.test.js.
appTest("/releve : valeurs de Cyclos échappées (nom, contrepartie, description)", async (app) => {
  const hostile = '<script>alert(1)</script><style>*{}</style><img src=x onerror=alert(1)> & "q"';
  app.cyclos.state.displayName = hostile;
  const e = entry(1, { description: hostile });
  e.relatedAccount = { user: { display: hostile } };
  const html = await (await statement(app, { entries: [e] })).text();
  assert.ok(!/<script|<style|<img src=x|<b>/i.test(html), "balise brute dans la page");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&amp; &quot;q&quot;"));
});

// Intention: wrong dates give 400 with the form displayed again (and what the user typed, escaped), and Cyclos is NOT called.
// The same set of cases is tried on the page and on the PDF.
appTest("/releve : dates invalides -> 400 sur la page des filtres, valeurs saisies conservées, Cyclos non appelé", async (app) => {
  const csrf = await app.loggedIn();
  const cases = [
    [{ start: "hier", end: RANGE.end }, /Date de début invalide/],
    [{ start: RANGE.start, end: "" }, /Date de fin invalide/],
    [{ start: RANGE.end, end: RANGE.start }, /La fin doit être après le début/],
    [{ start: "2025-01-01T00:00", end: "2026-01-10T00:00" }, /ne peut pas dépasser 31 jours/],
    [{ start: "2999-01-01T00:00", end: "2999-01-02T00:00" }, /Le début ne peut pas être dans le futur/],
    [{ start: "2026-03-29T02:30", end: "2026-03-29T10:00" }, /n'existe pas : elle est sautée/],
    [{ start: '"><b>x', end: RANGE.end }, /Date de début invalide/],
  ];
  for (const path of ["/releve", "/releve.pdf"]) {
    for (const [dates, message] of cases) {
      const res = await app.request(path, { method: "POST", form: { csrf, ...dates } });
      assert.equal(res.status, 400, `${path} ${JSON.stringify(dates)}`);
      assert.match(res.headers.get("content-type"), /^text\/html/);
      const html = await res.text();
      assert.match(html, message);
      assert.match(html, /<h1>Choisir la plage horaire<\/h1>/);
      assert.ok(!html.includes('"><b>'), "saisie échappée");
    }
  }
  assert.equal(app.cyclos.calls("GET", "/self/accounts").length, 0);
  const typed = await (await app.request("/releve", { method: "POST", form: { csrf, start: "n'importe quoi", end: "2026-01-10T10:00" } })).text();
  assert.ok(typed.includes('value="n\'importe quoi"'));
});

// Intention: a future end is accepted but sent to Cyclos as "now", not as a date that has not yet arrived.
// Dates are computed from the real time, so that the test stays true whatever the day.
appTest("/releve : fin dans le futur acceptée (ramenée à maintenant)", async (app) => {
  const csrf = await app.loggedIn();
  // Start yesterday, end tomorrow (Paris time), computed relative to now.
  const paris = (days) => DateTime.now().setZone("Europe/Paris").plus({ days }).toFormat("yyyy-MM-dd'T'HH:mm");
  const res = await app.request("/releve", { method: "POST", form: { csrf, start: paris(-1), end: paris(1) } });
  assert.equal(res.status, 200);
  const [totals] = app.cyclos.calls("GET", "/self/accounts/membre");
  const [, until] = totals.query.getAll("datePeriod");
  assert.ok(Date.parse(until) <= Date.now() && Date.now() - Date.parse(until) < 60_000, until);
});

// Intention: the shortcuts (yesterday, 6 hours, unknown) prefill the form with well-formed dates, and the hidden CSRF token is
// the session's one. If the field were empty or malformed, the merchant would have to retype everything.
appTest("/filtres : préréglages et champs préremplis, jeton CSRF propre à la session", async (app) => {
  const csrf = await app.loggedIn();
  for (const preset of ["", "?preset=hier", "?preset=6h", "?preset=nimportequoi"]) {
    const html = await (await app.request(`/filtres${preset}`)).text();
    assert.match(html, /id="start" name="start" value="\d{4}-\d\d-\d\dT\d\d:\d\d"/);
    assert.match(html, /id="end" name="end" value="\d{4}-\d\d-\d\dT\d\d:\d\d"/);
    assert.equal(html.match(/name="csrf" value="([0-9a-f]+)"/)[1], csrf);
  }
  const hier = await (await app.request("/filtres?preset=hier")).text();
  assert.match(hier, /name="start" value="[\d-]+T00:00"/);
  assert.match(hier, /name="end" value="[\d-]+T23:59"/);
});

// ------------------------------------------------------------ /releve.pdf

// Intention: the PDF is a real downloadable PDF (headers, dated file name), multi-page and numbered, and its content says EXACTLY
// the same as the page: same totals, same transactions in the same order. The text is read by `pdfPages` (test-support/pdf-text.js).
appTest("/releve.pdf : PDF valide, bons en-têtes, nom de fichier, contenu cohérent avec le ticket", async (app) => {
  const entries = history(120);
  const csrf = await app.loggedIn();
  app.cyclos.state.entries = entries;
  const htmlText = await (await app.request("/releve", { method: "POST", form: { csrf, ...RANGE } })).text();
  const res = await app.request("/releve.pdf", { method: "POST", form: { csrf, ...RANGE } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="ticket-2026-01-10_0000_2026-01-10_2359.pdf"');
  assert.equal(res.headers.get("cache-control"), "no-store");
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(Number(res.headers.get("content-length")), bytes.length);
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  assert.match(bytes.subarray(-10).toString(), /%%EOF\s*$/);

  const pages = pdfPages(bytes);
  assert.ok(pages.length >= 2, `120 lignes sur ${pages.length} page(s)`);
  const text = pages.join("\n");
  const lines = text.split("\n");

  assert.ok(lines.includes("Ticket de fin de service"));
  assert.ok(lines.includes("Boutique de Test"));
  assert.ok(lines.includes("Du 10/01/2026 00:00 au 10/01/2026 23:59"));
  assert.ok(lines.includes("Montants en Graines"));
  // Same summary as the HTML page (narrow spaces replaced by spaces).
  for (const [label, value] of summaryOf(htmlText)) {
    const at = lines.indexOf(label);
    assert.ok(at >= 0, label);
    assert.equal(lines[at + 1], value.replaceAll(NNBSP, " "));
  }
  // All transactions, each once, in the order of the page.
  const numbers = lines.filter((l) => /^T\d{5}$/.test(l));
  assert.deepEqual(numbers, entries.map((e) => e.transactionNumber).reverse());
  assert.deepEqual(
    lines.filter((l) => /^[+-]\d+,\d\d$/.test(l)).slice(-entries.length),
    amountsOf(htmlText).map((a) => a.replaceAll(NNBSP, " ")),
  );
  // Page numbering and column headers repeated on each page.
  pages.forEach((page, i) => {
    assert.ok(page.split("\n").includes(`Page ${i + 1} / ${pages.length}`), `numéro de la page ${i + 1}`);
  });
  assert.equal(lines.filter((l) => l === "N° de transaction").length, pages.length);
  assert.ok(!text.includes("avertissement") && !text.includes("Attention"));
});

// Intention: the warning about a truncated list is also in the PDF, not only on screen (otherwise the paper would lie by omission).
appTest("/releve.pdf : plafond atteint -> avertissement dans le PDF aussi", async (app) => {
  const res = await statement(app, { entries: history(2100) }, "/releve.pdf");
  assert.equal(res.status, 200);
  const text = pdfPages(Buffer.from(await res.arrayBuffer())).join("\n");
  assert.match(text, /Attention : la liste est limitée aux 2000 transactions les plus récentes/);
});

// Intention: a PDF with no transaction is produced correctly, on one page.
appTest("/releve.pdf : sans transaction", async (app) => {
  const res = await statement(app, { entries: [] }, "/releve.pdf");
  assert.equal(res.status, 200);
  const text = pdfPages(Buffer.from(await res.arrayBuffer())).join("\n");
  assert.match(text, /Aucune transaction sur cette plage/);
  assert.match(text, /Page 1 \/ 1/);
});

// Intention: the PDF only prints the letters of the standard font (French accents, €...). The rest becomes "?". The on-screen page,
// for its part, keeps everything (Cyrillic, Japanese, emoji). Known limit from the README, pinned here so it does not change by accident.
appTest("/releve.pdf : caractères hors Windows-1252 remplacés par ?, accents et € conservés ; la page HTML garde tout", async (app) => {
  const e = entry(1, { description: "Café 5 € Привет 😀", who: "Zoë" });
  e.relatedAccount = { user: { display: "Дмитрий" } };
  const csrf = await app.loggedIn();
  app.cyclos.state.entries = [e];
  app.cyclos.state.displayName = "Chez Élodie – 日本";
  const html = await (await app.request("/releve", { method: "POST", form: { csrf, ...RANGE } })).text();
  assert.ok(html.includes("Café 5 € Привет 😀") && html.includes("Дмитрий") && html.includes("日本"));
  const res = await app.request("/releve.pdf", { method: "POST", form: { csrf, ...RANGE } });
  const lines = pdfPages(Buffer.from(await res.arrayBuffer())).join("\n").split("\n");
  assert.ok(lines.includes("Café 5 € ?????? ?"), lines.join("|"));
  assert.ok(lines.includes("???????"));
  assert.ok(lines.includes("Chez Élodie – ??"));
});

// Intention: if Cyclos goes down at the time of the PDF, we answer a 502 error as text, never a "fake PDF" or a half-sent PDF.
appTest("/releve.pdf : Cyclos en panne -> 502, rien d'envoyé comme PDF", async (app) => {
  const res = await statement(app, { entries: history(3) }, "/releve.pdf");
  assert.equal(res.status, 200);
  app.cyclos.force("GET /self/accounts/membre", 500);
  const csrf = await app.csrf();
  const failed = await app.request("/releve.pdf", { method: "POST", form: { csrf, ...RANGE } });
  assert.equal(failed.status, 502);
  assert.match(failed.headers.get("content-type"), /^text\/plain/);
  assert.equal(failed.headers.get("content-disposition"), null);
});

// Intention: these routes only exist as POST (with a CSRF token); an address typed in the browser (GET) gives 404.
appTest("/releve.pdf : un accès en GET n'existe pas", async (app) => {
  await app.loggedIn();
  assert.equal((await app.request("/releve.pdf")).status, 404);
  assert.equal((await app.request("/releve")).status, 404);
});
