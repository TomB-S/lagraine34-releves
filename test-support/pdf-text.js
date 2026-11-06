// === LIRE EN PREMIER : à quoi sert ce fichier ? ===
// Pour vérifier le contenu d'un PDF dans un test, il faut pouvoir en LIRE le texte. Un PDF n'est pas du texte brut :
// c'est un conteneur d'objets, dont le contenu des pages est compressé (algorithme « Flate », comme dans un zip).
// Plutôt que d'ajouter une bibliothèque (le projet n'en veut pas de plus), ce fichier fait une lecture MINIMALE :
// il repère les blocs compressés, les décompresse, et extrait les textes que pdfkit a écrits.
// Il ne sait pas tout lire : il ne convient qu'aux PDF produits par notre outil. Utilisé par test/releve.test.js et
// test/totaux-calcules.test.js. Un `Buffer` est la façon qu'a Node de représenter des octets bruts (voir test/statique.test.js).
// Minimal reading of the text of a PDF produced by pdfkit, without dependency:
// streams are Flate-compressed, texts are written in hexadecimal (<..> Tj
// or [<..> n <..>] TJ) with the standard fonts (one byte per character,
// Windows-1252). Enough to check the content of a ticket.
import { inflateSync } from "node:zlib";

// Reçoit les octets du PDF et renvoie un tableau : un texte par page (lignes séparées par « \n »).
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
// Les polices standard du PDF stockent les caractères sur un octet, selon la table Windows-1252
// (celle qui contient é, è, € ...). Le TextDecoder retraduit ces octets en vrai texte.
const WIN_1252 = new TextDecoder("windows-1252");

// Dans le PDF, le texte est écrit en hexadécimal : « 43 61 66 e9 » pour « Café ». On convertit en octets puis en texte.
function decode(hex) {
  return WIN_1252.decode(Buffer.from(hex, "hex"));
}

// Les deux écritures de texte du PDF : `<hex> Tj` (un morceau) et `[<hex> n <hex>] TJ` (plusieurs morceaux
// avec des ajustements d'espacement). Cette expression régulière les repère toutes et recolle les morceaux.
function textOf(content) {
  const lines = [];
  for (const m of content.matchAll(/\[((?:<[0-9a-fA-F]*>|[^\]<])*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
    if (m[2] !== undefined) lines.push(decode(m[2]));
    else lines.push([...m[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => decode(x[1])).join(""));
  }
  return lines.join("\n");
}
