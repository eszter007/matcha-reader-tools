/* Zero-dependency ZIP reader/writer + gzip/tar reader.
 *
 * Reading uses the browser's DecompressionStream for deflate/gzip, so no
 * compression library is bundled. Writing uses STORE (no compression) —
 * the payloads we produce (JPEG pages, binary indices) don't compress
 * meaningfully, and STORE keeps the writer trivial and fast on phones.
 */
"use strict";

const ZIP_UTF8_FLAG = 0x0800;

/* CP437 high half (0x80-0xFF), for zip entry names without the UTF-8 flag —
 * mirrors Python zipfile's decoding so name-based page ordering matches. */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅ" +
  "ÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
  "áíóúñÑªº¿⌐¬½¼¡«»" +
  "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧" +
  "╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩" +
  "≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

function decodeCp437(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  }
  return out;
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

class ZipReader {
  /* data: Uint8Array of the whole zip file. */
  constructor(data) {
    this.data = data;
    this.entries = this._readCentralDirectory();
  }

  _readCentralDirectory() {
    const d = this.data;
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    // Locate End Of Central Directory: scan backwards over the (possibly
    // present) zip comment for the EOCD signature.
    let eocd = -1;
    const minPos = Math.max(0, d.length - 22 - 0xffff);
    for (let i = d.length - 22; i >= minPos; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a zip file (no end-of-central-directory record)");
    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || offset === 0xffffffff) {
      throw new Error("Zip64 archives are not supported (file too large)");
    }

    const decoder = new TextDecoder("utf-8");
    const entries = [];
    for (let i = 0; i < count; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) {
        throw new Error("Corrupt zip central directory");
      }
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const size = view.getUint32(offset + 24, true);
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const nameBytes = d.subarray(offset + 46, offset + 46 + nameLen);
      const name = (flags & ZIP_UTF8_FLAG) ? decoder.decode(nameBytes) : decodeCp437(nameBytes);
      entries.push({
        name, method, size, compressedSize, localOffset,
        isDir: name.endsWith("/"),
      });
      offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  findEntry(name) {
    return this.entries.find((e) => e.name === name) || null;
  }

  async readEntry(entry) {
    const d = this.data;
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const lo = entry.localOffset;
    if (view.getUint32(lo, true) !== 0x04034b50) throw new Error(`Corrupt zip local header for ${entry.name}`);
    const nameLen = view.getUint16(lo + 26, true);
    const extraLen = view.getUint16(lo + 28, true);
    const start = lo + 30 + nameLen + extraLen;
    const raw = d.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return raw.slice();
    if (entry.method === 8) return await inflateRaw(raw);
    throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}`);
  }

  async readEntryByName(name) {
    const e = this.findEntry(name);
    if (!e) throw new Error(`Missing zip entry: ${name}`);
    return this.readEntry(e);
  }
}

/* CRC-32 (IEEE), table-driven. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

class ZipWriter {
  constructor() {
    this.parts = [];       // Uint8Array chunks in file order
    this.central = [];     // central directory records
    this.offset = 0;
    this.encoder = new TextEncoder();
  }

  /* data: Uint8Array. Directories are implicit (use paths with '/'). */
  addFile(path, data) {
    const nameBytes = this.encoder.encode(path);
    const crc = crc32(data);
    // Fixed DOS timestamp (2026-01-01 00:00) keeps output deterministic.
    const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
    const header = new ByteWriter(30 + nameBytes.length);
    header.u32(0x04034b50);
    header.u16(20);               // version needed
    header.u16(ZIP_UTF8_FLAG);    // flags: UTF-8 names
    header.u16(0);                // method: STORE
    header.u16(dosTime);
    header.u16(dosDate);
    header.u32(crc);
    header.u32(data.length);      // compressed size (== raw for STORE)
    header.u32(data.length);
    header.u16(nameBytes.length);
    header.u16(0);                // extra length
    header.bytes(nameBytes);
    this.parts.push(header.toUint8Array(), data);
    this.central.push({ nameBytes, crc, size: data.length, offset: this.offset, dosTime, dosDate });
    this.offset += header.length + data.length;
    if (this.offset >= 0xfffffff0) throw new Error("Output exceeds 4GB zip limit");
  }

  toBlob() {
    const cd = new ByteWriter(4096);
    const cdStart = this.offset;
    for (const rec of this.central) {
      cd.u32(0x02014b50);
      cd.u16(20); cd.u16(20);
      cd.u16(ZIP_UTF8_FLAG);
      cd.u16(0);                  // STORE
      cd.u16(rec.dosTime); cd.u16(rec.dosDate);
      cd.u32(rec.crc);
      cd.u32(rec.size); cd.u32(rec.size);
      cd.u16(rec.nameBytes.length);
      cd.u16(0); cd.u16(0);       // extra, comment
      cd.u16(0);                  // disk number
      cd.u16(0);                  // internal attrs
      cd.u32(0);                  // external attrs
      cd.u32(rec.offset);
      cd.bytes(rec.nameBytes);
    }
    const cdSize = cd.length;
    cd.u32(0x06054b50);                            // EOCD signature
    cd.u16(0); cd.u16(0);                          // disk numbers
    cd.u16(this.central.length); cd.u16(this.central.length);
    cd.u32(cdSize);                                // central directory size
    cd.u32(cdStart);                               // central directory offset
    cd.u16(0);                                     // comment length
    return new Blob([...this.parts, cd.toUint8Array()], { type: "application/zip" });
  }
}

/* Parse a tar archive (already decompressed). Returns [{name, data}]. */
function parseTar(bytes) {
  const files = [];
  const decoder = new TextDecoder("utf-8");
  let off = 0;
  while (off + 512 <= bytes.length) {
    const block = bytes.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break; // end-of-archive
    const nameEnd = block.indexOf(0);
    let name = decoder.decode(block.subarray(0, nameEnd < 0 || nameEnd > 100 ? 100 : nameEnd));
    const sizeStr = decoder.decode(block.subarray(124, 136)).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = block[156];
    // ustar prefix field
    if (decoder.decode(block.subarray(257, 262)) === "ustar") {
      const prefixEnd = block.indexOf(0, 345);
      const prefix = decoder.decode(block.subarray(345, prefixEnd < 0 || prefixEnd > 500 ? 500 : prefixEnd));
      if (prefix) name = prefix + "/" + name;
    }
    off += 512;
    if (type === 0x30 || type === 0) { // regular file
      files.push({ name, data: bytes.slice(off, off + size) });
    }
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

if (typeof module !== "undefined") {
  module.exports = { ZipReader, ZipWriter, crc32, parseTar, gunzip, inflateRaw, decodeCp437 };
}
