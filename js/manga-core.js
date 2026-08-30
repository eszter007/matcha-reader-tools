/* Manga converter core: pure logic ported line-for-line from matcha-reader's
 * tools/manga_convert/convert_manga.py (grid panel detection path).
 *
 * Given identical input pixels, panels.idx / panels.dat / meta.bin / toc.idx
 * produced here are byte-identical to the Python tool run with --no-ocr.
 * No DOM or canvas dependencies in this file — the browser pipeline lives in
 * manga-ui.js, and Node tests exercise these functions directly.
 */
"use strict";

const MANGA_FORMAT_VERSION = 2;   // v2 adds a per-panel translation string
const TOC_FORMAT_VERSION = 1;
const META_FORMAT_VERSION = 1;
/* Panel crops live in their own subfolder so the book folder holds only page images: the device
 * walks every entry of the book folder when opening a book, and a crop per panel dominated that
 * scan (measured 6499ms for 2396 entries, of which 219 were pages and 974 were crops). Matches
 * convert_manga.py:PANEL_CROP_SUBDIR. The device still reads the older flat layout. */
const PANEL_CROP_SUBDIR = "panels";

const MANGA_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);

const mangaEncoder = new TextEncoder();

function mangaFileExt(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.substring(i).toLowerCase();
}

function isImageName(name) {
  return MANGA_IMAGE_EXTS.has(mangaFileExt(name));
}

function baseName(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.substring(i + 1);
}

/* ── Page ordering (matches FsHelpers::sortFileList on the device) ── */

/* Natural sort key: list of [group, len, str] triples. Cover and copyright
 * pages are pinned to the front (see convert_manga.py:_natural_sort_key). */
function naturalSortKey(path) {
  const name = baseName(path);
  const lower = name.toLowerCase();
  if (lower.includes("cover")) return [[-2, 0, ""]];
  if (lower.includes("copyright")) return [[-1, 0, ""]];
  const parts = [];
  let i = 0;
  while (i < name.length) {
    if (name[i] >= "0" && name[i] <= "9") {
      let j = i;
      while (j < name.length && name[j] >= "0" && name[j] <= "9") j++;
      const numStr = name.substring(i, j).replace(/^0+/, "");
      parts.push([0, numStr.length, numStr]);
      i = j;
    } else {
      parts.push([1, 0, name[i].toLowerCase()]);
      i += 1;
    }
  }
  return parts;
}

function compareNaturalKeys(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const [g1, l1, s1] = a[i];
    const [g2, l2, s2] = b[i];
    if (g1 !== g2) return g1 - g2;
    if (l1 !== l2) return l1 - l2;
    if (s1 !== s2) return s1 < s2 ? -1 : 1;
  }
  return a.length - b.length;
}

function naturalSortPaths(paths) {
  return paths
    .map((p) => ({ p, k: naturalSortKey(p) }))
    .sort((x, y) => compareNaturalKeys(x.k, y.k))
    .map((x) => x.p);
}

/* ── Panel detection: white-gutter grid heuristic ─────────────── */

/* PIL Image.convert("L") luminance (ITU-R 601-2), bit-exact. */
/* ── XTC / XTCH (Xteink native page format) ───────────────────
 *
 * Ported from the firmware's reader, not from a Python tool -- convert_manga.py has no XTC
 * export, so there is no reference output to diff against. Layout per lib/Xtc/Xtc/XtcTypes.h
 * and src/activities/reader/XtcReaderActivity.cpp:
 *
 *   file:  56-byte header, then a 16-byte page-table entry per page, then the page data
 *   page:  22-byte XTG/XTH header, then the bitmap
 *   XTG (1-bit):  row-major, 8 px/byte, MSB = leftmost, and 0 = BLACK (inverted vs the usual)
 *   XTH (2-bit):  two bit planes; columns right-to-left, 8 vertical px/byte, MSB = topmost;
 *                 value = (bit1 << 1) | bit2, 0=white 1=dark grey 2=light grey 3=black
 */
const XTC_MAGIC = 0x00435458;  // "XTC\0"
const XTG_MAGIC = 0x00475458;  // "XTG\0" -- 1-bit page
const XTH_MAGIC = 0x00485458;  // "XTH\0" -- 2-bit page
const XTC_HEADER_SIZE = 56;
const XTC_PAGE_ENTRY_SIZE = 16;
const XTG_PAGE_HEADER_SIZE = 22;

/* 1-bit page. `gray` is one byte per pixel; anything below `threshold` becomes black.
 * Dither first (floydSteinbergMono) for photographic art -- this is a hard threshold. */
function encodeXtgPage(gray, w, h, threshold = 128) {
  const rowBytes = (w + 7) >> 3;
  const out = new ByteWriter(XTG_PAGE_HEADER_SIZE + rowBytes * h);
  out.u32(XTG_MAGIC); out.u16(w); out.u16(h);
  out.u8(0); out.u8(0);                 // colorMode = monochrome, compression = none
  out.u32(rowBytes * h);
  out.u32(0); out.u32(0);               // md5 (optional) left zero
  const bmp = new Uint8Array(rowBytes * h).fill(0xff);  // 1 = white
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] < threshold) bmp[y * rowBytes + (x >> 3)] &= ~(1 << (7 - (x & 7)));
    }
  }
  out.bytes(bmp);
  return out.toUint8Array();
}

/* 2-bit page. Height MUST be a multiple of 8: the firmware sizes the buffer as
 * ((w*h+7)/8)*2 but indexes it as ((h+7)/8)*w per plane, and those agree only then --
 * otherwise it reads past what it allocated. Callers pad the image instead. */
function encodeXthPage(gray, w, h) {
  if (h % 8 !== 0) throw new Error(`XTH height must be a multiple of 8 (got ${h})`);
  const colBytes = h >> 3;
  const planeSize = (w * h + 7) >> 3;
  const out = new ByteWriter(XTG_PAGE_HEADER_SIZE + planeSize * 2);
  out.u32(XTH_MAGIC); out.u16(w); out.u16(h);
  out.u8(0); out.u8(0);
  out.u32(planeSize * 2);
  out.u32(0); out.u32(0);
  const plane1 = new Uint8Array(planeSize), plane2 = new Uint8Array(planeSize);
  for (let x = 0; x < w; x++) {
    const colIndex = w - 1 - x;
    for (let y = 0; y < h; y++) {
      // 4 levels, matching the reader's 0=white .. 3=black ordering.
      const v = 3 - (gray[y * w + x] >> 6);
      if (!v) continue;
      const off = colIndex * colBytes + (y >> 3);
      const bit = 7 - (y & 7);
      if (v & 2) plane1[off] |= 1 << bit;
      if (v & 1) plane2[off] |= 1 << bit;
    }
  }
  out.bytes(plane1); out.bytes(plane2);
  return out.toUint8Array();
}

/* Assemble the container.
 *
 * pages: [{bytes, w, h}] already encoded by encodeXtgPage/encodeXthPage, in reading order.
 * opts:  {isHq, title, author, language, toc:[{title, page}]}
 *
 * Layout matches both the firmware's reader and bigbag/epub-to-xtc-converter:
 *   header(56) | metadata(256) | chapters(96 each) | page index(16 each) | page data
 *
 * The container magic -- not the page magic -- is what tells the device the bit depth, so a
 * 2-bit book MUST say "XTCH" or its XTH pages get decoded as 1-bit. The reader also takes the
 * title from a fixed 0x38 and the author from 0xB8, which is the metadata block at offset 56,
 * and derives the chapter count from (pageTableOffset - chapterOffset) / 96 -- so the chapters
 * have to sit between the metadata and the index, not anywhere else. */
function buildXtcFile(pages, opts = {}) {
  const { isHq = false, title = "", author = "", language = "", toc = [] } = opts;
  const enc = new TextEncoder();
  const fit = (str, max) => enc.encode(str).subarray(0, max - 1);  // room for the NUL

  const HEADER = XTC_HEADER_SIZE, METADATA = 256, CHAPTER = 96;
  const chapterOffset = HEADER + METADATA;
  const indexOffset = chapterOffset + toc.length * CHAPTER;
  const dataOffset = indexOffset + pages.length * XTC_PAGE_ENTRY_SIZE;
  const total = dataOffset + pages.reduce((n, p) => n + p.bytes.length, 0);

  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  buf.set(enc.encode(isHq ? "XTCH" : "XTC\0"), 0);
  buf[4] = 1; buf[5] = 0;                       // version 1.0
  view.setUint16(6, pages.length, true);
  buf[8] = 0;                                   // readDirection (0 = L->R, as the reference writes)
  buf[9] = 1;                                   // hasMetadata
  buf[10] = 0;                                  // hasThumbnails
  buf[11] = toc.length ? 1 : 0;
  view.setUint32(12, 1, true);                  // currentPage, 1-based
  view.setBigUint64(0x10, BigInt(HEADER), true);        // metadataOffset
  view.setBigUint64(0x18, BigInt(indexOffset), true);   // pageTableOffset
  view.setBigUint64(0x20, BigInt(dataOffset), true);
  view.setBigUint64(0x28, 0n, true);                    // thumbOffset
  // Written as 64-bit: the header struct declares uint32 + padding here, but the reader seeks to
  // 0x30 and reads 8 bytes, so the two agree only if the padding is part of the value.
  view.setBigUint64(0x30, BigInt(toc.length ? chapterOffset : 0), true);

  buf.set(fit(title, 128), HEADER);
  buf.set(fit(author, 64), HEADER + 128);
  buf.set(fit(language, 16), HEADER + 224);
  // createTime deliberately left 0 rather than Date.now(): identical input should produce an
  // identical file, which a timestamp would break (and the reader never reads it).
  view.setUint16(HEADER + 244, 0, true);              // coverPage
  view.setUint16(HEADER + 246, toc.length, true);     // chapterCount

  toc.forEach((ch, i) => {
    const at = chapterOffset + i * CHAPTER;
    buf.set(fit(ch.title || `Chapter ${i + 1}`, 80), at);
    view.setUint16(at + 0x50, ch.page || 0, true);
    view.setUint16(at + 0x52, (toc[i + 1] ? toc[i + 1].page - 1 : pages.length - 1), true);
  });

  let off = dataOffset;
  pages.forEach((p, i) => {
    const at = indexOffset + i * XTC_PAGE_ENTRY_SIZE;
    view.setBigUint64(at, BigInt(off), true);
    view.setUint32(at + 8, p.bytes.length, true);
    view.setUint16(at + 12, p.w, true);
    view.setUint16(at + 14, p.h, true);
    buf.set(p.bytes, off);
    off += p.bytes.length;
  });
  return buf;
}

/* Fraction of a page's ink that falls inside the given panel rects (0..1).
 *
 * Panels-only books have no full page to fall back on, so anything the detector missed would be
 * unreachable. Measuring INK rather than area is what makes this useful: panels never tile a page
 * -- gutters, margins and the space around a splash are blank, so an area test would fail every
 * page. What matters is whether the drawn content is inside a panel.
 *
 * "Ink" is a pixel darker than `inkThreshold`, which assumes dark-on-light artwork (true for
 * manga); an inverted page reads as almost all ink and simply keeps its full page, which is the
 * safe direction to be wrong in. Returns 1 for a blank page (nothing to miss).
 *
 * rects are [x1, y1, x2, y2] in the same pixel space as gray/w/h. */
function panelInkCoverage(gray, w, h, rects, inkThreshold = 200) {
  const covered = new Uint8Array(w * h);
  for (const [x1, y1, x2, y2] of rects) {
    const rx1 = Math.max(0, Math.min(w, Math.round(x1)));
    const ry1 = Math.max(0, Math.min(h, Math.round(y1)));
    const rx2 = Math.max(0, Math.min(w, Math.round(x2)));
    const ry2 = Math.max(0, Math.min(h, Math.round(y2)));
    for (let y = ry1; y < ry2; y++) covered.fill(1, y * w + rx1, y * w + rx2);
  }
  let ink = 0, inkInside = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] >= inkThreshold) continue;
    ink++;
    if (covered[i]) inkInside++;
  }
  return ink === 0 ? 1 : inkInside / ink;
}

function grayFromRGBA(rgba, w, h) {
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (rgba[p] * 19595 + rgba[p + 1] * 38470 + rgba[p + 2] * 7471 + 0x8000) >>> 16;
  }
  return gray;
}

/* Collapse boundary points that would create a too-small segment. */
function mergeSmallGaps(splits, minSize) {
  if (splits.length <= 2) return splits;
  const merged = [splits[0]];
  for (let i = 1; i < splits.length; i++) {
    const s = splits[i];
    if (s - merged[merged.length - 1] < minSize) continue;
    merged.push(s);
  }
  if (merged[merged.length - 1] !== splits[splits.length - 1]) {
    merged[merged.length - 1] = splits[splits.length - 1];
  }
  return merged;
}

/* Detect panel rectangles by finding solid white gutter bands.
 * gray: Uint8Array of w*h luminance values. Returns [[x1,y1,x2,y2], ...]. */
function detectPanelsGrid(gray, w, h) {
  const threshold = 215;
  const purity = 0.95;
  const minGutter = Math.max(6, Math.trunc(h * 0.013));
  const minBandH = Math.max(Math.trunc(h * 0.05), 60);
  const minBandW = Math.max(Math.trunc(w * 0.06), 60);

  function isWhiteRow(y) {
    let white = 0;
    const row = y * w;
    for (let x = 0; x < w; x += 2) {
      if (gray[row + x] > threshold) white++;
    }
    return white > Math.floor(w / 2) * purity;
  }

  let hSplits = [0];
  let inGutter = false;
  let gutterStart = 0;
  for (let y = 0; y < h; y++) {
    const whiteRow = isWhiteRow(y);
    if (whiteRow && !inGutter) {
      inGutter = true;
      gutterStart = y;
    } else if (!whiteRow && inGutter) {
      if (y - gutterStart >= minGutter) {
        hSplits.push(Math.floor((gutterStart + y) / 2));
      }
      inGutter = false;
    }
  }
  hSplits.push(h);
  hSplits = mergeSmallGaps(hSplits, minBandH);

  const panels = [];
  for (let bandIdx = 0; bandIdx < hSplits.length - 1; bandIdx++) {
    const y1 = hSplits[bandIdx], y2 = hSplits[bandIdx + 1];

    function isWhiteCol(x) {
      let white = 0;
      for (let y = y1; y < y2; y += 2) {
        if (gray[y * w + x] > threshold) white++;
      }
      return white > Math.floor((y2 - y1) / 2) * purity;
    }

    let vSplits = [0];
    inGutter = false;
    gutterStart = 0;
    for (let x = 0; x < w; x++) {
      const whiteCol = isWhiteCol(x);
      if (whiteCol && !inGutter) {
        inGutter = true;
        gutterStart = x;
      } else if (!whiteCol && inGutter) {
        if (x - gutterStart >= minGutter) {
          vSplits.push(Math.floor((gutterStart + x) / 2));
        }
        inGutter = false;
      }
    }
    vSplits.push(w);
    vSplits = mergeSmallGaps(vSplits, minBandW);

    for (let colIdx = 0; colIdx < vSplits.length - 1; colIdx++) {
      panels.push([vSplits[colIdx], y1, vSplits[colIdx + 1], y2]);
    }
  }

  if (panels.length === 0) panels.push([0, 0, w, h]);
  return panels;
}

/* True when the panel covers almost the entire page in both dimensions. */
function isFullPagePanel(box, pageW, pageH, threshold = 0.95) {
  const w = Math.max(1, box[2] - box[0]);
  const h = Math.max(1, box[3] - box[1]);
  return w / Math.max(1, pageW) >= threshold && h / Math.max(1, pageH) >= threshold;
}

/* ── Device downscaling (--x3 / --x4) ─────────────────────────── */

/* Device screen sizes (portrait width × height), mirroring DEVICE_TARGETS in
 * convert_manga.py. Used to downscale pages/panels so the device never decodes
 * more pixels than its screen can show. */
const MANGA_DEVICE_TARGETS = { x3: [528, 792], x4: [480, 800] };

/* Compute the fitted size for an image of w×h against a device target (a
 * [tw, th] pair, or null to keep the original). Never upscales, never changes
 * aspect ratio. The firmware rotates a page/panel whose aspect doesn't match
 * the screen, so landscape images (w > h) are fitted against the swapped box.
 * Returns { w, h, resized }. Faithful port of convert_manga.py:fit_to_device's
 * dimension math (the actual pixel resample happens on a canvas in the UI). */
function fitToDeviceSize(w, h, target) {
  if (!Array.isArray(target) || target.length < 2) return { w, h, resized: false };
  let tw = target[0], th = target[1];
  if (w > h) { const t = tw; tw = th; th = t; }
  const scale = Math.min(tw / w, th / h);
  if (scale >= 1.0) return { w, h, resized: false };  // never upscale
  const nw = Math.min(tw, Math.max(1, Math.round(w * scale)));
  const nh = Math.min(th, Math.max(1, Math.round(h * scale)));
  return { w: nw, h: nh, resized: true };
}

/* ── Reading-order sort (topological "reads-before" graph) ────── */

function yOverlapFrac(a, b) {
  const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const minH = Math.min(a[3] - a[1], b[3] - b[1]);
  return Math.max(0, overlap) / Math.max(1, minH);
}

function sortPanelsMangaOrder(panels) {
  const n = panels.length;
  if (n <= 1) return panels;

  const OVERLAP_THRESHOLD = 0.3;
  const edges = Array.from({ length: n }, () => []);
  const inDegree = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const a = panels[i], b = panels[j];
      if (yOverlapFrac(a, b) > OVERLAP_THRESHOLD) {
        const aCx = (a[0] + a[2]) / 2, bCx = (b[0] + b[2]) / 2;
        if (aCx > bCx) { // same tier: right-to-left
          edges[i].push(j);
          inDegree[j]++;
        }
      } else {
        const aCy = (a[1] + a[3]) / 2, bCy = (b[1] + b[3]) / 2;
        if (aCy < bCy) { // different tiers: top-to-bottom
          edges[i].push(j);
          inDegree[j]++;
        }
      }
    }
  }

  function tieKey(i) {
    const [x1, y1, x2, y2] = panels[i];
    return [(y1 + y2) / 2, -(x1 + x2) / 2];
  }

  let available = [];
  for (let i = 0; i < n; i++) if (inDegree[i] === 0) available.push(i);
  const result = [];
  while (available.length) {
    available.sort((a, b) => {
      const ka = tieKey(a), kb = tieKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1];
    });
    const node = available.shift();
    result.push(node);
    for (const j of edges[node]) {
      inDegree[j]--;
      if (inDegree[j] === 0) available.push(j);
    }
  }

  if (result.length !== n) return panels; // cyclic constraints: keep original
  return result.map((i) => panels[i]);
}

/* ── 1-bit BMP output (Floyd-Steinberg dithering) ─────────────── */

/* Floyd-Steinberg error-diffusion dither of an 8-bit grayscale buffer down to
 * 1-bit black/white. Returns a Uint8Array of w*h values (1 = white, 0 = black).
 * Mirrors the intent of convert_manga.py's --mono path, which uses PIL's
 * Image.convert("L").convert("1") (Floyd-Steinberg is PIL's default dither):
 * threshold at 128, error diffused with the classic 7/3/5/1 kernel. Byte-exact
 * parity with PIL is not required — page and panel images are re-encoded in the
 * browser exactly like the JPEG path, and only the binary panels.idx/dat/
 * meta.bin/toc.idx files are compared byte-for-byte against the Python tool. */
function floydSteinbergMono(gray, w, h) {
  // Signed accumulator so diffused error can push a pixel outside 0..255.
  const acc = new Int32Array(gray.length);
  for (let i = 0; i < gray.length; i++) acc[i] = gray[i];

  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const oldVal = acc[i];
      const newVal = oldVal < 128 ? 0 : 255;
      out[i] = newVal ? 1 : 0;
      const err = oldVal - newVal;
      if (err === 0) continue;
      if (x + 1 < w) acc[i + 1] += (err * 7) >> 4;
      if (y + 1 < h) {
        if (x > 0) acc[i + w - 1] += (err * 3) >> 4;
        acc[i + w] += (err * 5) >> 4;
        if (x + 1 < w) acc[i + w + 1] += err >> 4;
      }
    }
  }
  return out;
}

/* Pack a 1-bit mono buffer (1 = white) into a standard uncompressed BI_RGB BMP:
 * 14-byte file header, 40-byte BITMAPINFOHEADER, a 2-entry black/white palette,
 * then bottom-up rows padded to a 4-byte stride with MSB-first bit packing.
 * This is exactly the shape the device's 1-bit fast path expects (see
 * lib/GfxRenderer/Bitmap.cpp in matcha-reader). */
function encodeBmp1bit(mono, w, h) {
  const rowBytes = ((w + 31) >> 5) << 2;   // 4-byte-aligned row stride
  const pixelBytes = rowBytes * h;
  const HEADER = 14 + 40 + 8;              // file header + DIB header + palette
  const out = new ByteWriter(HEADER + pixelBytes);

  // BMP file header (14 bytes).
  out.u8(0x42); out.u8(0x4d);              // "BM"
  out.u32(HEADER + pixelBytes);            // file size
  out.u32(0);                              // reserved
  out.u32(HEADER);                         // offset to pixel data

  // BITMAPINFOHEADER (40 bytes).
  out.u32(40);                             // header size
  out.u32(w);                              // width  (positive)
  out.u32(h);                              // height (positive → bottom-up)
  out.u16(1);                              // planes
  out.u16(1);                              // bits per pixel
  out.u32(0);                              // BI_RGB (uncompressed)
  out.u32(pixelBytes);                     // image byte size
  out.u32(0); out.u32(0);                  // x/y pixels-per-metre
  out.u32(2);                              // colours used
  out.u32(0);                              // important colours

  // Palette: index 0 = black, index 1 = white (stored B, G, R, reserved).
  out.u8(0); out.u8(0); out.u8(0); out.u8(0);
  out.u8(0xff); out.u8(0xff); out.u8(0xff); out.u8(0);

  // Pixel rows: bottom-up, MSB-first bits, zero-padded to rowBytes.
  const rowBuf = new Uint8Array(rowBytes);
  for (let y = h - 1; y >= 0; y--) {
    rowBuf.fill(0);
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mono[row + x]) rowBuf[x >> 3] |= 0x80 >> (x & 7);
    }
    out.bytes(rowBuf);
  }
  return out.toUint8Array();
}

/* Convenience: RGBA pixels → 1-bit Floyd-Steinberg-dithered BMP bytes. */
function encodeMonoBmpFromRGBA(rgba, w, h) {
  return encodeBmp1bit(floydSteinbergMono(grayFromRGBA(rgba, w, h), w, h), w, h);
}

/* ── Binary output ────────────────────────────────────────────── */

/* panelsWithText: [{box:[x1,y1,x2,y2], textBlocks:[{box:[x1,y1,x2,y2], text}],
 * translation}] — encodes one page's data (convert_manga.py:encode_page).
 * Note: text block boxes are stored as raw corner coordinates, matching the
 * Python tool byte-for-byte. */
function encodePage(panelsWithText) {
  const buf = new ByteWriter(256);
  const panelCount = Math.min(panelsWithText.length, 255);
  buf.u8(panelCount);
  buf.u8(0);

  for (const panel of panelsWithText.slice(0, panelCount)) {
    const [x1, y1, x2, y2] = panel.box;
    const w = x2 - x1, h = y2 - y1;
    const textBlocks = panel.textBlocks || [];
    const textCount = Math.min(textBlocks.length, 255);

    let translationBytes = mangaEncoder.encode(panel.translation || "");
    if (translationBytes.length > 0xffff) translationBytes = translationBytes.subarray(0, 0xffff);

    buf.u16(Math.max(0, x1));
    buf.u16(Math.max(0, y1));
    buf.u16(Math.max(0, w));
    buf.u16(Math.max(0, h));
    buf.u8(textCount);
    buf.u8(0);
    buf.u16(translationBytes.length);
    buf.bytes(translationBytes);

    for (const tb of textBlocks.slice(0, textCount)) {
      const [tx, ty, tw, th] = tb.box;
      let textBytes = mangaEncoder.encode(tb.text);
      if (textBytes.length > 0xffff) textBytes = textBytes.subarray(0, 0xffff);
      buf.u16(Math.max(0, tx));
      buf.u16(Math.max(0, ty));
      buf.u16(Math.max(0, tw));
      buf.u16(Math.max(0, th));
      buf.u16(textBytes.length);
      buf.bytes(textBytes);
    }
  }

  return buf.toUint8Array();
}

/* idxRecords: [{offset, length, w, h}]. Returns panels.idx bytes. */
function writePanelsIdx(idxRecords) {
  const out = new ByteWriter(8 + idxRecords.length * 12);
  out.u32(MANGA_FORMAT_VERSION);
  out.u32(idxRecords.length);
  for (const r of idxRecords) {
    out.u32(r.offset);
    out.u32(r.length);
    out.u16(r.w);
    out.u16(r.h);
  }
  return out.toUint8Array();
}

/* Country codes commonly typed in place of the language code. Left uncorrected,
 * each would open a second reading-stats bucket for a language that already has
 * one. Mirror of convert_manga.py:LANGUAGE_ALIASES. */
const LANGUAGE_ALIASES = { jp: "ja", cn: "zh", kr: "ko" };

/* Lowercase the language subtag and correct those aliases. Region/script subtags
 * keep their case ("zh-Hant" stays intact): the device reduces to the primary
 * subtag on its own, so there is no reason to discard the detail on disk.
 * Mirror of convert_manga.py:normalize_language. */
function normalizeLanguage(language) {
  const tag = String(language || "").trim();
  if (!tag) return "";
  let sep = tag.indexOf("-");
  if (sep < 0) sep = tag.indexOf("_");
  const primary = (sep >= 0 ? tag.slice(0, sep) : tag).toLowerCase();
  const rest = sep >= 0 ? tag.slice(sep + 1) : "";
  const corrected = LANGUAGE_ALIASES[primary] || primary;
  return rest ? corrected + "-" + rest : corrected;
}

/* language is written as an OPTIONAL TRAILER after the author bytes, and the
 * format version deliberately stays 1: firmware predating the field reads
 * exactly the header, title and author and never looks further, so it ignores
 * the extra bytes instead of rejecting the file. Newer firmware detects the
 * trailer by checking whether any bytes remain. Any future field must follow
 * the same rule -- append only, never reorder or resize what comes before. */
function writeMetaBin(title, author, language) {
  const lang = normalizeLanguage(language);
  if (!title && !author && !lang) return null;
  let titleBytes = mangaEncoder.encode(title || "");
  let authorBytes = mangaEncoder.encode(author || "");
  let languageBytes = mangaEncoder.encode(lang);
  if (titleBytes.length > 0xffff) titleBytes = titleBytes.subarray(0, 0xffff);
  if (authorBytes.length > 0xffff) authorBytes = authorBytes.subarray(0, 0xffff);
  if (languageBytes.length > 0xffff) languageBytes = languageBytes.subarray(0, 0xffff);
  const trailerLen = languageBytes.length ? 2 + languageBytes.length : 0;
  const out = new ByteWriter(8 + titleBytes.length + authorBytes.length + trailerLen);
  out.u32(META_FORMAT_VERSION);
  out.u16(titleBytes.length);
  out.u16(authorBytes.length);
  out.bytes(titleBytes);
  out.bytes(authorBytes);
  if (languageBytes.length) {
    out.u16(languageBytes.length);
    out.bytes(languageBytes);
  }
  return out.toUint8Array();
}

/* entries: [[pageIndex, title], ...]. Returns toc.idx bytes. */
function writeTocIdx(entries, addCover = true) {
  // Defensive: pageIndex is written as u32, so anything negative would wrap into a huge
  // page number instead of failing. Callers already filter, but this is the last point
  // before the bytes are committed.
  entries = entries.filter(([pageIndex]) => Number.isInteger(pageIndex) && pageIndex >= 0);
  entries = entries.slice().sort((a, b) => a[0] - b[0]);
  if (addCover && (entries.length === 0 || entries[0][0] !== 0)) {
    entries = [[0, "Cover"], ...entries];
  }
  const out = new ByteWriter(64);
  out.u32(TOC_FORMAT_VERSION);
  out.u32(entries.length);
  for (const [pageIndex, title] of entries) {
    let titleBytes = mangaEncoder.encode(title);
    if (titleBytes.length > 0xffff) titleBytes = titleBytes.subarray(0, 0xffff);
    out.u32(pageIndex);
    out.u16(titleBytes.length);
    out.bytes(titleBytes);
  }
  return out.toUint8Array();
}

/* ── EPUB helpers (regex-based, mirroring the Python tool) ────── */

function pathDirname(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.substring(0, i);
}

function pathNorm(p) {
  const parts = p.split("/");
  const out = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else {
      out.push(part);
    }
  }
  return out.join("/") || ".";
}

function pathJoinNorm(dir, rel) {
  return pathNorm(dir ? dir + "/" + rel : rel);
}

/* Parse the OPF path out of META-INF/container.xml. */
function epubOpfPath(containerXml) {
  const m = containerXml.match(/full-path="([^"]+)"/);
  return m ? m[1] : null;
}

/* Returns {manifest: Map(id→href), spineIds: [id, ...]}. */
function epubParseOpf(opf) {
  const manifest = new Map();
  for (const m of opf.matchAll(/<item[^>]*id="([^"]+)"[^>]*href="([^"]+)"/g)) {
    manifest.set(m[1], m[2]);
  }
  for (const m of opf.matchAll(/<item[^>]*href="([^"]+)"[^>]*id="([^"]+)"/g)) {
    manifest.set(m[2], m[1]);
  }
  const spineIds = [...opf.matchAll(/<itemref[^>]*idref="([^"]+)"/g)].map((m) => m[1]);
  return { manifest, spineIds };
}

/* Decode the five predefined XML entities plus numeric character references.
 *
 * Metadata and chapter titles are pulled out of XML with regexes rather than a parser, so
 * whatever the file escaped arrives still escaped: a ComicInfo <Title>Tom &amp; Jerry</Title>
 * would otherwise reach meta.bin -- and the output folder name -- as the literal "Tom &amp;
 * Jerry". Deliberately NOT html.unescape's full HTML5 named-entity set: convert_manga.py
 * decodes exactly this set, and the two tools have to agree byte for byte. A single pass is
 * what makes "&amp;lt;" come back as "&lt;" rather than "<".
 * Mirror of convert_manga.py:xml_unescape. */
const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

function xmlUnescape(text) {
  return String(text).replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ent) => {
    if (ent[0] === "#") {
      const cp = ent[1] === "x" || ent[1] === "X"
        ? parseInt(ent.substring(2), 16)
        : parseInt(ent.substring(1), 10);
      if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return match;
      try { return String.fromCodePoint(cp); } catch (e) { return match; }
    }
    return Object.prototype.hasOwnProperty.call(XML_ENTITIES, ent) ? XML_ENTITIES[ent] : match;
  });
}

function epubMetadataFromOpf(opf) {
  let title = "", author = "", language = "";
  const t = opf.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/);
  if (t) title = xmlUnescape(t[1]).trim();
  const a = opf.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/);
  if (a) author = xmlUnescape(a[1]).trim();
  const l = opf.match(/<dc:language[^>]*>([^<]+)<\/dc:language>/);
  if (l) language = xmlUnescape(l[1]).trim();
  return { title, author, language };
}

function cbzMetadataFromComicInfo(xml) {
  let title = "", author = "", language = "";
  const t = xml.match(/<Title>([^<]+)<\/Title>/);
  if (t) title = xmlUnescape(t[1]).trim();
  const a = xml.match(/<Writer>([^<]+)<\/Writer>/);
  if (a) author = xmlUnescape(a[1]).trim();
  const l = xml.match(/<LanguageISO>([^<]+)<\/LanguageISO>/);
  if (l) language = xmlUnescape(l[1]).trim();
  return { title, author, language };
}

/* Extract [(href, title)] entries from an EPUB3 nav document's toc nav. */
function epubTocFromNav(navXhtml, navPath) {
  const navDir = pathDirname(navPath);
  const entries = [];
  const tocM = navXhtml.match(/<nav[^>]*epub:type="toc"[^>]*>([\s\S]*?)<\/nav>/);
  if (!tocM) return entries;
  for (const aM of tocM[1].matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = pathJoinNorm(navDir, aM[1]);
    const title = xmlUnescape(aM[2].replace(/<[^>]+>/g, "")).trim();
    if (title) entries.push([href, title]);
  }
  return entries;
}

/* Extract [(href, title)] entries from an EPUB2 toc.ncx document. */
function epubTocFromNcx(ncx, ncxPath) {
  const ncxDir = pathDirname(ncxPath);
  const entries = [];
  for (const npM of ncx.matchAll(/<navPoint\b[\s\S]*?<\/navPoint>/g)) {
    const block = npM[0];
    const textM = block.match(/<text>([\s\S]*?)<\/text>/);
    const srcM = block.match(/<content[^>]*src="([^"]+)"/);
    if (textM && srcM) {
      const href = pathJoinNorm(ncxDir, srcM[1]);
      const title = xmlUnescape(textM[1]).trim();
      if (title) entries.push([href, title]);
    }
  }
  return entries;
}

/* Find the EPUB3 nav document href in an OPF, or null. */
function epubNavHref(opf) {
  let m = opf.match(/<item[^>]*properties="[^"]*\bnav\b[^"]*"[^>]*href="([^"]+)"/);
  if (m) return m[1];
  m = opf.match(/<item[^>]*href="([^"]+)"[^>]*properties="[^"]*\bnav\b[^"]*"/);
  return m ? m[1] : null;
}

/* Find the EPUB2 NCX href in an OPF, or null. */
function epubNcxHref(opf) {
  const ncxM = opf.match(/<spine[^>]*toc="([^"]+)"/);
  if (!ncxM) return null;
  const ncxId = ncxM[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let hrefM = opf.match(new RegExp(`<item[^>]*id="${ncxId}"[^>]*href="([^"]+)"`));
  if (!hrefM) hrefM = opf.match(new RegExp(`<item[^>]*href="([^"]+)"[^>]*id="${ncxId}"`));
  return hrefM ? hrefM[1] : null;
}

/* Parse the chapters textarea: one per line, "<page_index><TAB or |><title>". */
function parseTocText(text) {
  const entries = [];
  const warnings = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (!line.trim()) continue;
    const sep = line.includes("\t") ? "\t" : "|";
    const idx = line.indexOf(sep);
    if (idx < 0) {
      warnings.push(`Chapter line ${i + 1} not in "<page> ${sep === "\t" ? "TAB" : "|"} <title>" format, skipping`);
      continue;
    }
    const pageIndex = parseInt(line.substring(0, idx).trim(), 10);
    if (!Number.isInteger(pageIndex)) {
      warnings.push(`Chapter line ${i + 1} has a non-integer page index, skipping`);
      continue;
    }
    // Page indices are 0-based, and toc.idx stores them as u32. A negative one would wrap
    // (-5 becomes 4294967291) and point the device at a page that cannot exist -- the Python
    // tool's struct.pack refuses it outright, so drop the line and say why rather than
    // writing a chapter nobody can navigate to.
    if (pageIndex < 0) {
      warnings.push(`Chapter line ${i + 1} has a negative page index, skipping`);
      continue;
    }
    entries.push([pageIndex, line.substring(idx + 1).trim()]);
  }
  return { entries, warnings };
}

if (typeof module !== "undefined") {
  module.exports = {
    MANGA_FORMAT_VERSION, isImageName, baseName, mangaFileExt,
    naturalSortKey, compareNaturalKeys, naturalSortPaths,
    grayFromRGBA, mergeSmallGaps, detectPanelsGrid, isFullPagePanel, panelInkCoverage,
    floydSteinbergMono, encodeBmp1bit, encodeMonoBmpFromRGBA,
    MANGA_DEVICE_TARGETS, fitToDeviceSize,
    yOverlapFrac, sortPanelsMangaOrder,
    encodePage, writePanelsIdx, writeMetaBin, writeTocIdx, normalizeLanguage, PANEL_CROP_SUBDIR,
    encodeXtgPage, encodeXthPage, buildXtcFile,
    pathDirname, pathNorm, pathJoinNorm,
    epubOpfPath, epubParseOpf, epubMetadataFromOpf, cbzMetadataFromComicInfo, xmlUnescape,
    epubTocFromNav, epubTocFromNcx, epubNavHref, epubNcxHref, parseTocText,
  };
}
