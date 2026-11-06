// Lecture minimale du texte d'un PDF produit par pdfkit, sans dépendance :
// les flux sont compressés en Flate, les textes écrits en hexadécimal (<..> Tj
// ou [<..> n <..>] TJ) avec les polices standard (un octet par caractère,
// Windows-1252). Suffit pour vérifier le contenu d'un ticket.
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
      continue; // pas un flux Flate (image, polices...)
    }
    if (!/\bBT\b/.test(content)) continue; // pas une page de texte
    pages.push(content);
  }
  return pages.map(textOf);
}

function decode(hex) {
  return Buffer.from(hex, "hex").toString("latin1");
}

function textOf(content) {
  const lines = [];
  for (const m of content.matchAll(/\[((?:<[0-9a-fA-F]*>|[^\]<])*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
    if (m[2] !== undefined) lines.push(decode(m[2]));
    else lines.push([...m[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => decode(x[1])).join(""));
  }
  return lines.join("\n");
}
