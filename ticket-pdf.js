import { readFileSync } from "node:fs";
import PDFDocument from "pdfkit";

// Logo of La Graine 34, read once at startup (same file as GET /logo.png).
// pdfkit embeds a PNG directly; drawn on the first page only, 104 x 40 pt.
const LOGO = readFileSync(new URL("./logo-lagraine34.png", import.meta.url));
const LOGO_WIDTH = 104;
const LOGO_HEIGHT = 40; // 200 x 77 px at that width, rounded

// pdfkit's built-in Helvetica only has the WinAnsi (Windows-1252) characters:
// Latin accents and French punctuation are fine, but anything else (other
// scripts, emoji, symbols) has no glyph. Such characters are replaced by "?".
const WIN_ANSI_EXTRAS = new Set(
  [..."€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"].map((c) => c.codePointAt(0)),
);

function isWinAnsi(codePoint) {
  return (
    (codePoint >= 0x20 && codePoint <= 0x7e) ||
    (codePoint >= 0xa1 && codePoint <= 0xff) ||
    WIN_ANSI_EXTRAS.has(codePoint)
  );
}

// Text safe to hand to the built-in font. Text comes from Cyclos (names,
// descriptions), so nothing is assumed about it.
export function pdfText(value) {
  let out = "";
  // Iterating a string yields whole code points (an emoji is one "?", not two).
  for (const char of String(value ?? "")) {
    const codePoint = char.codePointAt(0);
    if (codePoint === 0x202f || codePoint === 0xa0) out += " "; // narrow / no-break space
    else if (codePoint < 0x20 || codePoint === 0x7f) out += " "; // newlines, tabs, controls
    else out += isWinAnsi(codePoint) ? char : "?";
  }
  return out;
}

const PAGE_MARGINS = { top: 50, bottom: 60, left: 50, right: 50 };
const CONTENT_WIDTH = 595.28 - PAGE_MARGINS.left - PAGE_MARGINS.right;
const GREY = "#444444";
const RULE = "#999999";

// Detail table columns: date, number, counterparty, description, amount.
const COLUMNS = [
  { key: "when", title: "Date", width: 62 },
  { key: "number", title: "N° de transaction", width: 96 },
  { key: "counterparty", title: "Contrepartie", width: 104 },
  { key: "description", title: "Description", width: 157 },
  { key: "amount", title: "Montant", width: 76, align: "right" },
];
const CELL_GAP = 6;

// Builds the PDF in memory and resolves with a Buffer. Nothing is sent to the
// client before this resolves, so the caller can still answer with a normal
// error page if anything fails.
export function renderTicketPdf(model) {
  return new Promise((resolve, reject) => {
    // Only the title is set. pdfkit itself always adds Producer/Creator
    // ("PDFKit") and the creation date; it needs them, so they stay. No author.
    const doc = new PDFDocument({
      size: "A4",
      margins: PAGE_MARGINS,
      bufferPages: true, // needed to write "Page i / n" once the total is known
      info: { Title: pdfText(model.title) },
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      draw(doc, model);
      addPageNumbers(doc);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function bottomLimit(doc) {
  return doc.page.height - PAGE_MARGINS.bottom;
}

function draw(doc, model) {
  const left = PAGE_MARGINS.left;

  doc.image(LOGO, left, PAGE_MARGINS.top, { width: LOGO_WIDTH, height: LOGO_HEIGHT });

  doc.fillColor("#000000").font("Helvetica-Bold").fontSize(18);
  doc.text(pdfText(model.title), left, PAGE_MARGINS.top + LOGO_HEIGHT + 12);
  doc.moveDown(0.4);

  if (model.merchantName) {
    doc.font("Helvetica-Bold").fontSize(13).text(pdfText(model.merchantName));
  }
  doc.font("Helvetica-Bold").fontSize(11).text(pdfText(model.period));
  doc.font("Helvetica").fontSize(10).fillColor(GREY);
  doc.text(pdfText(model.generated));
  doc.fillColor("#000000");

  // --- Summary
  heading(doc, "Résumé");
  doc.font("Helvetica").fontSize(10).fillColor(GREY);
  doc.text(pdfText(model.unit), left, doc.y);
  doc.fillColor("#000000").moveDown(0.4);
  for (const line of model.summary) {
    if (line.net) {
      doc.moveTo(left, doc.y).lineTo(left + CONTENT_WIDTH, doc.y).stroke("#000000");
      doc.moveDown(0.3);
    }
    const y = doc.y;
    doc.font(line.net ? "Helvetica-Bold" : "Helvetica").fontSize(line.net ? 12 : 11);
    doc.text(pdfText(line.label), left, y, { width: CONTENT_WIDTH - 130 });
    doc.font("Helvetica-Bold");
    doc.text(pdfText(line.value), left + CONTENT_WIDTH - 120, y, {
      width: 120,
      align: "right",
    });
    doc.y = y + (line.net ? 18 : 16);
  }

  // --- Detail
  // Keep the heading, the column header and at least one row together.
  if (doc.y + 90 > bottomLimit(doc)) doc.addPage();
  heading(doc, "Détail");

  if (model.warning) {
    doc.font("Helvetica-Bold").fontSize(10);
    const text = pdfText(model.warning);
    const boxHeight = doc.heightOfString(text, { width: CONTENT_WIDTH - 16 }) + 12;
    const top = doc.y;
    doc.rect(left, top, CONTENT_WIDTH, boxHeight).lineWidth(1).stroke("#000000");
    doc.text(text, left + 8, top + 6, { width: CONTENT_WIDTH - 16 });
    doc.y = top + boxHeight + 8;
  }

  if (model.rows.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(11).fillColor(GREY);
    doc.text(pdfText(model.emptyText), left, doc.y + 4);
    doc.fillColor("#000000");
    return;
  }

  tableHeader(doc);
  for (const row of model.rows) {
    tableRow(doc, row);
  }
}

function heading(doc, text) {
  const left = PAGE_MARGINS.left;
  doc.moveDown(0.9);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#000000");
  doc.text(pdfText(text), left, doc.y);
  doc.moveTo(left, doc.y + 1).lineTo(left + CONTENT_WIDTH, doc.y + 1).lineWidth(1).stroke("#000000");
  doc.y += 8;
}

function columnX(index) {
  let x = PAGE_MARGINS.left;
  for (let i = 0; i < index; i += 1) x += COLUMNS[i].width;
  return x;
}

// Column titles, drawn at the top of the table and again on every new page.
function tableHeader(doc) {
  const y = doc.y;
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#000000");
  COLUMNS.forEach((column, i) => {
    doc.text(pdfText(column.title), columnX(i), y, {
      width: column.width - CELL_GAP,
      align: column.align ?? "left",
      lineBreak: false,
    });
  });
  const lineY = y + 13;
  doc.moveTo(PAGE_MARGINS.left, lineY).lineTo(PAGE_MARGINS.left + CONTENT_WIDTH, lineY).lineWidth(1).stroke("#000000");
  doc.y = lineY + 4;
}

// One transaction. A row is never split across two pages: if it does not fit,
// it moves to the next page, under a repeated column header.
function tableRow(doc, row) {
  doc.font("Helvetica").fontSize(9);
  const cells = COLUMNS.map((column) => ({
    column,
    text: pdfText(row[column.key]),
  }));
  const height = Math.max(
    ...cells.map(({ column, text }) =>
      doc.heightOfString(text, { width: column.width - CELL_GAP }),
    ),
  );

  if (doc.y + height + 6 > bottomLimit(doc)) {
    doc.addPage();
    doc.y = PAGE_MARGINS.top;
    tableHeader(doc);
  }

  const y = doc.y;
  cells.forEach(({ column, text }, i) => {
    doc.font(column.key === "amount" ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    doc.text(text, columnX(i), y, {
      width: column.width - CELL_GAP,
      align: column.align ?? "left",
    });
  });
  const lineY = y + height + 3;
  doc.moveTo(PAGE_MARGINS.left, lineY).lineTo(PAGE_MARGINS.left + CONTENT_WIDTH, lineY).lineWidth(0.4).stroke(RULE);
  doc.y = lineY + 3;
}

// "Page i / n" centred in the bottom margin of every page.
function addPageNumbers(doc) {
  const { start, count } = doc.bufferedPageRange();
  for (let i = 0; i < count; i += 1) {
    doc.switchToPage(start + i);
    // Writing inside the bottom margin would otherwise trigger a new page.
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(8).fillColor(GREY);
    doc.text(`Page ${i + 1} / ${count}`, PAGE_MARGINS.left, doc.page.height - 35, {
      width: CONTENT_WIDTH,
      align: "center",
      lineBreak: false,
    });
  }
}
