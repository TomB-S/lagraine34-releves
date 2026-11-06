// Minimal reading of the text of a PDF produced by pdfkit, without dependency:
// streams are Flate-compressed, texts are written in hexadecimal (<..> Tj
// or [<..> n <..>] TJ) with the standard fonts (one byte per character,
// Windows-1252). Enough to check the content of a ticket.
import { inflateSync } from "node:zlib";

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
const WIN_1252 = new TextDecoder("windows-1252");

function decode(hex) {
  return WIN_1252.decode(Buffer.from(hex, "hex"));
}

function textOf(content) {
  const lines = [];
  for (const m of content.matchAll(/\[((?:<[0-9a-fA-F]*>|[^\]<])*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
    if (m[2] !== undefined) lines.push(decode(m[2]));
    else lines.push([...m[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => decode(x[1])).join(""));
  }
  return lines.join("\n");
}
