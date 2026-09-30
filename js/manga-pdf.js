/* Manga PDF export: one JPEG per page, each page sized to its image, in the same reading order
 * as the EPUB (full page, then its panels). JPEGs are embedded as-is (DCTDecode), so nothing is
 * re-compressed here; the caller hands in JPEG bytes only.
 *
 * Pure byte logic (no DOM/canvas), like manga-epub.js. */
"use strict";

/* Colour components of a baseline/progressive JPEG (from its SOF marker), or 0 if not found. */
function jpegComponents(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const m = bytes[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return bytes[i + 9];
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return 0;
}

/* A PDF text string: UTF-16BE with BOM, as hex, so any title/author survives. */
function pdfTextString(s) {
  let hex = "FEFF";
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const units = cp > 0xffff
      ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)]
      : [cp];
    for (const u of units) hex += u.toString(16).toUpperCase().padStart(4, "0");
  }
  return `<${hex}>`;
}

/* images: [{bytes (JPEG, 1 or 3 components), w, h}]. Returns the PDF as a Uint8Array. */
function buildPdf({ title, author, images }) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let size = 0;
  const push = (b) => { chunks.push(b); size += b.length; };
  const text = (s) => push(enc.encode(s));
  const obj = (n, body) => { offsets[n] = size; text(`${n} 0 obj\n${body}\nendobj\n`); };

  text("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  // 1 catalog, 2 page tree, 3 info, then per image: page, content stream, image.
  const pageNums = images.map((_, i) => 4 + i * 3);
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${images.length} >>`);
  const info = [];
  if (title) info.push(`/Title ${pdfTextString(title)}`);
  if (author) info.push(`/Author ${pdfTextString(author)}`);
  obj(3, `<< ${info.join(" ")} /Producer (Matcha Reader Tools) >>`);

  images.forEach((im, i) => {
    const [page, content, image] = [pageNums[i], pageNums[i] + 1, pageNums[i] + 2];
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${im.w} ${im.h}] ` +
      `/Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`);
    const draw = `q ${im.w} 0 0 ${im.h} 0 0 cm /Im0 Do Q`;
    obj(content, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    const cs = jpegComponents(im.bytes) === 1 ? "/DeviceGray" : "/DeviceRGB";
    offsets[image] = size;
    text(`${image} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} ` +
      `/ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`);
    push(im.bytes);
    text("\nendstream\nendobj\n");
  });

  const xref = size;
  const count = 4 + images.length * 3;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  text(table + `trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

if (typeof module !== "undefined") module.exports = { buildPdf, jpegComponents, pdfTextString };
