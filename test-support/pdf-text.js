// === READ THIS FIRST: what is this file for? ===
// To check the content of a PDF in a test, its TEXT must be readable. A PDF is not plain text:
// it is a container of objects whose page content is compressed (the "Flate" algorithm, as in a zip).
// Rather than add a library (the project wants no more dependencies), this file does a MINIMAL reading:
// it finds the compressed blocks, decompresses them, and extracts the texts that pdfkit wrote.
// It cannot read everything: it only suits PDFs produced by our tool. Used by test/releve.test.js and
// test/totaux-calcules.test.js. A `Buffer` is Node's way of representing raw bytes (see test/statique.test.js).
// Minimal reading of the text of a PDF produced by pdfkit, without dependency:
// streams are Flate-compressed, texts are written in hexadecimal (<..> Tj
// or [<..> n <..>] TJ) with the standard fonts (one byte per character,
// Windows-1252). Enough to check the content of a ticket.
import { inflateSync } from "node:zlib";

// Receives the bytes of the PDF and returns an array: one text per page (lines separated by "\n").
export function pdfPages(buffer) {
  const raw = buffer.toString("latin1");
  const pages = [];
  for (const match of raw.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    let content;
    try {
      content = inflateSync(buffer.subarray(start, end)).toString("latin1");
    } catch {
      continue; // not a Flate stream (image, fonts...)
    }
    if (!/\bBT\b/.test(content)) continue; // not a text page
    pages.push(content);
  }
  return pages.map(textOf);
}

// pdfkit standard fonts: one byte per character, in Windows-1252 (€, –, « »...).
// The PDF's standard fonts store characters on one byte, following the Windows-1252 table
// (the one that contains é, è, € ...). The TextDecoder turns these bytes back into real text.
const WIN_1252 = new TextDecoder("windows-1252");

// In the PDF, text is written in hexadecimal: "43 61 66 e9" for "Café". We convert to bytes then to text.
function decode(hex) {
  return WIN_1252.decode(Buffer.from(hex, "hex"));
}

// The two ways the PDF writes text: `<hex> Tj` (one piece) and `[<hex> n <hex>] TJ` (several pieces
// with spacing adjustments). This regular expression finds them all and glues the pieces back together.
function textOf(content) {
  const lines = [];
  for (const m of content.matchAll(/\[((?:<[0-9a-fA-F]*>|[^\]<])*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
    if (m[2] !== undefined) lines.push(decode(m[2]));
    else lines.push([...m[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => decode(x[1])).join(""));
  }
  return lines.join("\n");
}
