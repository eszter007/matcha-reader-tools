/* Font converter: TTF/OTF → .cpfont v4 for CrossPoint / Matcha Reader.
 *
 * Port of lib/EpdFont/scripts/fontconvert_sdcard.py. Binary layout (header,
 * style TOC, intervals, glyph records, kern classes, ligatures, 2-bit
 * bitmaps) matches the Python tool exactly. The difference is the
 * rasterizer: the Python tool renders glyphs with FreeType; here the
 * browser's own font engine renders them onto a canvas, so individual glyph
 * pixels may differ slightly (antialiasing/hinting) while metrics, layout
 * data, and structure are equivalent.
 */
"use strict";

const CPFONT_VERSION = 4;

/* Interval presets, copied from fontconvert_sdcard.py. */
const INTERVAL_PRESETS = {
  "ascii":       [[0x0020, 0x007E]],
  "latin1":      [[0x0080, 0x00FF]],
  "latin-ext":   [[0x0020, 0x007E], [0x0080, 0x00FF], [0x0100, 0x024F],
                  [0x02B0, 0x02FF], [0x1E00, 0x1EFF], [0x2000, 0x206F],
                  [0xFB00, 0xFB06]],
  "greek":       [[0x0370, 0x03FF], [0x1F00, 0x1FFF]],
  "cyrillic":    [[0x0400, 0x04FF], [0x0500, 0x052F]],
  "hebrew":      [[0x0590, 0x05FF], [0xFB1D, 0xFB4F]],
  "georgian":    [[0x10A0, 0x10FF], [0x2D00, 0x2D2F]],
  "armenian":    [[0x0530, 0x058F]],
  "ethiopic":    [[0x1200, 0x137F], [0x1380, 0x139F], [0x2D80, 0x2DDF]],
  "vietnamese":  [[0x01A0, 0x01B0], [0x1EA0, 0x1EF9]],
  "punctuation": [[0x2000, 0x206F]],
  "cjk":         [[0x3000, 0x303F], [0x3040, 0x309F], [0x30A0, 0x30FF],
                  [0x4E00, 0x9FFF], [0xF900, 0xFAFF], [0xFF00, 0xFFEF]],
  "cjk-ext":     [[0x2100, 0x214F], [0x2150, 0x218F], [0x2190, 0x21FF],
                  [0x2460, 0x24FF], [0x25A0, 0x25FF], [0x2600, 0x26FF],
                  [0x2E80, 0x2EFF], [0x2F00, 0x2FDF], [0x3000, 0x303F],
                  [0x3040, 0x309F], [0x30A0, 0x30FF], [0x3100, 0x312F],
                  [0x3190, 0x319F], [0x31F0, 0x31FF], [0x3200, 0x32FF],
                  [0x3300, 0x33FF], [0x4E00, 0x9FFF], [0xF900, 0xFAFF],
                  [0xFE30, 0xFE4F], [0xFF00, 0xFFEF]],
  "hangul":      [[0xAC00, 0xD7AF], [0x1100, 0x11FF], [0x3130, 0x318F]],
  "cherokee":    [[0x13A0, 0x13FF], [0xAB70, 0xABBF]],
  "tifinagh":    [[0x2D30, 0x2D7F]],
  "symbols":     [[0x2070, 0x209F], [0x20A0, 0x20CF], [0x2150, 0x218F],
                  [0x2190, 0x21FF], [0x2200, 0x22FF], [0x2500, 0x257F],
                  [0x25A0, 0x25FF], [0x2600, 0x26FF], [0x2700, 0x27BF]],
  "reading":     [[0x0020, 0x024F], [0x02B0, 0x02FF], [0x0300, 0x036F], [0x0370, 0x03FF],
                  [0x0400, 0x04FF], [0x1E00, 0x1EFF], [0x2000, 0x206F],
                  [0x2070, 0x209F], [0x20A0, 0x20CF], [0x2150, 0x218F],
                  [0x2190, 0x21FF], [0x2200, 0x22FF], [0x2500, 0x257F],
                  [0x25A0, 0x25FF], [0x2600, 0x26FF], [0x2700, 0x27BF],
                  [0x2900, 0x29FF], [0x2E00, 0x2E7F], [0x3000, 0x303F],
                  [0xFB00, 0xFB06]],
  "builtin":     [[0x0000, 0x007F], [0x0080, 0x00FF], [0x0100, 0x017F],
                  [0x01A0, 0x01A1], [0x01AF, 0x01B0], [0x01C4, 0x021F],
                  [0x0300, 0x036F], [0x0400, 0x04FF],
                  [0x1EA0, 0x1EF9], [0x2000, 0x206F], [0x20A0, 0x20CF],
                  [0x2070, 0x209F], [0x2190, 0x21FF], [0x2200, 0x22FF],
                  [0xFB00, 0xFB06]],
};

/* Standard Unicode ligature codepoints for known input sequences. */
const STANDARD_LIGATURE_MAP = new Map([
  ["102,105", 0xFB01],          // fi
  ["102,108", 0xFB02],          // fl
  ["102,102", 0xFB00],          // ff
  ["102,102,105", 0xFB03],      // ffi
  ["102,102,108", 0xFB04],      // ffl
  ["383,116", 0xFB05],          // long-s + t
  ["115,116", 0xFB06],          // st
]);

/* "latin-ext,cjk,(0x2100-0x214F)" → merged sorted interval list, or null for 'all'. */
function resolveIntervals(presetStr) {
  const names = presetStr.split(",").map((n) => n.trim().toLowerCase()).filter((n) => n);
  if (names.includes("all")) return null;

  const all = [];
  for (const name of names) {
    const m = name.match(/^\(0x([0-9a-f]+)-0x([0-9a-f]+)\)$/);
    if (m) {
      const start = parseInt(m[1], 16), end = parseInt(m[2], 16);
      if (start > end || end > 0x10ffff) throw new Error(`Invalid hex range: ${name}`);
      all.push([start, end]);
    } else if (INTERVAL_PRESETS[name]) {
      all.push(...INTERVAL_PRESETS[name]);
    } else {
      throw new Error(`Unknown interval preset '${name}'. Available: ${Object.keys(INTERVAL_PRESETS).sort().join(", ")}, all`);
    }
  }
  all.push([0xFFFD, 0xFFFD]); // replacement character, always included

  all.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [start, end] of all) {
    if (merged.length && start <= merged[merged.length - 1][1] + 1) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/* Python round() (banker's rounding) — needed for kern value parity. */
function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/* Font design units → 4.4 signed fixed-point, clamped to int8. */
function fp4FromDesignUnits(du, scale) {
  const raw = roundHalfEven(du * scale * 16);
  return Math.max(-128, Math.min(127, raw));
}

/* ── Kerning ──────────────────────────────────────────────────── */

/* Extract kerning as {(leftCp,rightCp) → 4.4 fp adjust}, mirroring
 * extract_kerning_fonttools: legacy kern table + GPOS 'kern' feature. */
function extractKerning(font, codepoints, ppem) {
  // glyph id → [codepoints...] for requested cps (aliases preserved)
  const gidToCps = new Map();
  for (const cp of codepoints) {
    const gid = font.glyphId(cp);
    if (gid) {
      if (!gidToCps.has(gid)) gidToCps.set(gid, []);
      gidToCps.get(gid).push(cp);
    }
  }
  const gidSet = new Set(gidToCps.keys());

  const raw = new Map(); // "lg,rg" → design units
  for (const [key, val] of font.kernPairs()) {
    const [lg, rg] = key.split(",").map(Number);
    if (gidSet.has(lg) && gidSet.has(rg)) {
      raw.set(key, (raw.get(key) || 0) + val);
    }
  }
  for (const [key, val] of font.gposKernPairs(gidSet)) {
    raw.set(key, (raw.get(key) || 0) + val);
  }

  const scale = ppem / font.unitsPerEm;
  const result = new Map(); // "lcp,rcp" → adjust
  for (const [key, du] of raw) {
    const adjust = fp4FromDesignUnits(du, scale);
    if (adjust !== 0) {
      const [lg, rg] = key.split(",").map(Number);
      for (const lcp of gidToCps.get(lg)) {
        for (const rcp of gidToCps.get(rg)) {
          result.set(lcp + "," + rcp, adjust);
        }
      }
    }
  }
  return result;
}

/* Port of derive_kern_classes: group codepoints with identical kern
 * rows/columns into classes; returns the class maps and matrix. */
function deriveKernClasses(kernMap) {
  if (kernMap.size === 0) {
    return { leftClasses: [], rightClasses: [], matrix: [], leftCount: 0, rightCount: 0 };
  }

  const leftCps = new Set(), rightCps = new Set();
  for (const key of kernMap.keys()) {
    const [l, r] = key.split(",").map(Number);
    leftCps.add(l);
    rightCps.add(r);
  }
  const sortedLeft = [...leftCps].sort((a, b) => a - b);
  const sortedRight = [...rightCps].sort((a, b) => a - b);

  const leftProfileToClass = new Map();
  const leftClassMap = new Map();
  let leftClassId = 1;
  for (const lcp of sortedLeft) {
    const row = sortedRight.map((rcp) => kernMap.get(lcp + "," + rcp) || 0).join(",");
    if (!leftProfileToClass.has(row)) leftProfileToClass.set(row, leftClassId++);
    leftClassMap.set(lcp, leftProfileToClass.get(row));
  }

  const rightProfileToClass = new Map();
  const rightClassMap = new Map();
  let rightClassId = 1;
  for (const rcp of sortedRight) {
    const col = sortedLeft.map((lcp) => kernMap.get(lcp + "," + rcp) || 0).join(",");
    if (!rightProfileToClass.has(col)) rightProfileToClass.set(col, rightClassId++);
    rightClassMap.set(rcp, rightProfileToClass.get(col));
  }

  const leftCount = leftClassId - 1;
  const rightCount = rightClassId - 1;
  if (leftCount > 255 || rightCount > 255) {
    return { leftClasses: [], rightClasses: [], matrix: [], leftCount: 0, rightCount: 0,
      dropped: `kerning class count exceeds uint8 range (left=${leftCount}, right=${rightCount})` };
  }

  const matrix = new Array(leftCount * rightCount).fill(0);
  for (const [key, adjust] of kernMap) {
    const [lcp, rcp] = key.split(",").map(Number);
    const lc = leftClassMap.get(lcp) - 1;
    const rc = rightClassMap.get(rcp) - 1;
    matrix[lc * rightCount + rc] = adjust;
  }

  const leftClasses = [...leftClassMap.entries()].sort((a, b) => a[0] - b[0]);
  const rightClasses = [...rightClassMap.entries()].sort((a, b) => a[0] - b[0]);
  return { leftClasses, rightClasses, matrix, leftCount, rightCount };
}

/* ── Ligatures ────────────────────────────────────────────────── */

/* Port of extract_ligatures_fonttools. Returns [[packedPair, ligCp], ...]
 * sorted by packed key. */
function extractLigatures(font, codepointSet, warn) {
  const rev = font.reverseCmap(); // gid → cp

  const rawLigatures = new Map(); // "cp,cp,..." → lig cp
  for (const { sequence, ligGlyph } of font.gsubLigatures()) {
    if (!rev.has(sequence[0])) continue;
    const seqCps = [];
    let valid = true;
    for (const gid of sequence) {
      if (!rev.has(gid)) { valid = false; break; }
      seqCps.push(rev.get(gid));
    }
    if (!valid) continue;
    const seqKey = seqCps.join(",");
    let ligCp;
    if (rev.has(ligGlyph)) {
      ligCp = rev.get(ligGlyph);
    } else if (STANDARD_LIGATURE_MAP.has(seqKey)) {
      ligCp = STANDARD_LIGATURE_MAP.get(seqKey);
    } else {
      if (warn) warn(`ligatures: dropping ligature (${seqCps.map((c) => "U+" + c.toString(16).toUpperCase().padStart(4, "0")).join(", ")}): output glyph has no cmap entry`);
      continue;
    }
    rawLigatures.set(seqKey, ligCp);
  }

  // Only keep ligatures where all input/output codepoints are in the
  // generated glyph set and fit in 16 bits.
  const filtered = new Map();
  for (const [seqKey, ligCp] of rawLigatures) {
    const seq = seqKey.split(",").map(Number);
    if (!codepointSet.has(ligCp) || ligCp > 0xffff) continue;
    if (seq.some((cp) => cp > 0xffff)) continue;
    if (!seq.every((cp) => codepointSet.has(cp))) continue;
    filtered.set(seqKey, ligCp);
  }

  const pairs = [];
  for (const [seqKey, ligCp] of filtered) {
    const seq = seqKey.split(",").map(Number);
    if (seq.length === 2) {
      pairs.push([seq[0] * 0x10000 + seq[1], ligCp]);
    }
  }
  for (const [seqKey, ligCp] of filtered) {
    const seq = seqKey.split(",").map(Number);
    if (seq.length < 3) continue;
    const prefixKey = seq.slice(0, -1).join(",");
    const lastCp = seq[seq.length - 1];
    if (filtered.has(prefixKey)) {
      pairs.push([filtered.get(prefixKey) * 0x10000 + lastCp, ligCp]);
    } else if (warn) {
      warn(`ligatures: skipping ${seq.length}-char ligature: no intermediate ligature for prefix`);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs;
}

/* ── Rasterization (browser font engine via canvas) ───────────── */

let fontFaceCounter = 0;

/* Register font bytes as a loadable CSS font family; returns the name. */
async function registerFontFace(bytes) {
  const family = `cpfont-src-${++fontFaceCounter}`;
  const face = new FontFace(family, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  await face.load();
  document.fonts.add(face);
  return family;
}

/* Rasterize one codepoint with canvas; returns {width, height, left, top,
 * packed} where packed is the 2-bit bitmap (4 px/byte, MSB first). */
function rasterizeGlyph(ctx, family, pxSize, cp, scratch) {
  const ch = String.fromCodePoint(cp);
  ctx.font = `${pxSize}px "${family}"`;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#000";

  const m = ctx.measureText(ch);
  const margin = 3;
  const abbL = Math.ceil(Math.max(0, m.actualBoundingBoxLeft ?? pxSize)) + margin;
  const abbR = Math.ceil(Math.max(0, m.actualBoundingBoxRight ?? pxSize * 2)) + margin;
  const abbA = Math.ceil(Math.max(0, m.actualBoundingBoxAscent ?? pxSize * 1.5)) + margin;
  const abbD = Math.ceil(Math.max(0, m.actualBoundingBoxDescent ?? pxSize)) + margin;
  const cw = abbL + abbR, chh = abbA + abbD;
  if (cw > scratch.w || chh > scratch.h) return null; // caller regrows the canvas

  ctx.clearRect(0, 0, cw, chh);
  ctx.fillText(ch, abbL, abbA);
  const img = ctx.getImageData(0, 0, cw, chh).data;

  // Tight bounding box over nonzero alpha.
  let minX = cw, minY = chh, maxX = -1, maxY = -1;
  for (let y = 0; y < chh; y++) {
    for (let x = 0; x < cw; x++) {
      if (img[(y * cw + x) * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { width: 0, height: 0, left: 0, top: 0, packed: new Uint8Array(0) };

  const gw = maxX - minX + 1, gh = maxY - minY + 1;
  // Pack to 2-bit: alpha → 4-bit (>>4) → quantize at 12/8/4, matching the
  // Python tool's downsample; 4 pixels per byte, first pixel in high bits,
  // one continuous stream across rows.
  const packed = new Uint8Array(Math.ceil((gw * gh) / 4));
  let px = 0, nPx = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const a4 = img[(y * cw + x) * 4 + 3] >> 4;
      let v2 = 0;
      if (a4 >= 12) v2 = 3;
      else if (a4 >= 8) v2 = 2;
      else if (a4 >= 4) v2 = 1;
      px = (px << 2) | v2;
      nPx++;
      if (nPx % 4 === 0) {
        packed[(nPx >> 2) - 1] = px;
        px = 0;
      }
    }
  }
  if (nPx % 4 !== 0) {
    packed[packed.length - 1] = px << ((4 - (nPx % 4)) * 2);
  }

  return {
    width: gw,
    height: gh,
    left: minX - abbL,       // bearing X from the pen origin
    top: abbA - minY,        // distance from baseline up to the top row
    packed,
  };
}

/* Rasterize all glyphs of one style. Mirrors rasterize_font_style().
 * fontBytes/fallbackBytes: Uint8Array TTF/OTF data. */
async function rasterizeStyle(styleId, fontBytes, fallbackBytes, size, intervals, onProgress, warn) {
  const font = new SfntFont(fontBytes);
  const fallback = fallbackBytes ? new SfntFont(fallbackBytes) : null;
  const family = await registerFontFace(fontBytes);
  const fallbackFamily = fallbackBytes ? await registerFontFace(fallbackBytes) : null;

  // FreeType renders at `size` pt / 150 DPI.
  const pxSize = (size * 150) / 72;

  // Build or validate intervals.
  if (intervals === null) {
    const cps = new Set(font.allCodepoints());
    if (fallback) for (const cp of fallback.allCodepoints()) cps.add(cp);
    const sorted = [...cps].sort((a, b) => a - b);
    intervals = [];
    if (sorted.length) {
      let start = sorted[0], prev = start;
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === prev + 1) { prev = sorted[i]; continue; }
        intervals.push([start, prev]);
        start = prev = sorted[i];
      }
      intervals.push([start, prev]);
    }
  } else {
    const validated = [];
    for (const [iStart, iEnd] of intervals) {
      let start = iStart;
      for (let cp = iStart; cp <= iEnd; cp++) {
        const has = font.hasGlyph(cp) || (fallback && fallback.hasGlyph(cp));
        if (!has) {
          if (start < cp) validated.push([start, cp - 1]);
          start = cp + 1;
        }
      }
      if (start <= iEnd) validated.push([start, iEnd]);
    }
    intervals = validated;
  }
  const totalGlyphs = intervals.reduce((n, [s, e]) => n + e - s + 1, 0);

  // Scratch canvas, regrown on demand for oversized glyphs.
  const scratch = { w: Math.ceil(pxSize * 4), h: Math.ceil(pxSize * 4) };
  let canvas = makeCanvas(scratch.w, scratch.h);
  let ctx = canvas.getContext("2d", { willReadFrequently: true });

  const allGlyphs = [];
  let totalBitmapSize = 0;
  let done = 0;
  for (const [iStart, iEnd] of intervals) {
    for (let cp = iStart; cp <= iEnd; cp++) {
      let srcFont = font, srcFamily = family;
      if (!font.hasGlyph(cp) && fallback && fallback.hasGlyph(cp)) {
        srcFont = fallback;
        srcFamily = fallbackFamily;
      }
      if (!srcFont.hasGlyph(cp)) {
        allGlyphs.push({ width: 0, height: 0, advanceX: 0, left: 0, top: 0,
          dataLength: 0, dataOffset: totalBitmapSize, codePoint: cp, packed: new Uint8Array(0) });
        continue;
      }

      let r = rasterizeGlyph(ctx, srcFamily, pxSize, cp, scratch);
      if (r === null) {
        scratch.w *= 2; scratch.h *= 2;
        canvas = makeCanvas(scratch.w, scratch.h);
        ctx = canvas.getContext("2d", { willReadFrequently: true });
        r = rasterizeGlyph(ctx, srcFamily, pxSize, cp, scratch) ||
            { width: 0, height: 0, left: 0, top: 0, packed: new Uint8Array(0) };
      }
      if (r.width > 255 || r.height > 255) {
        if (warn) warn(`U+${cp.toString(16)} bitmap ${r.width}x${r.height} exceeds format limit; clipped`);
        r = { width: 0, height: 0, left: 0, top: 0, packed: new Uint8Array(0) };
      }

      const advDu = srcFont.advanceWidth(srcFont.glyphId(cp));
      // 12.4 fixed-point linear advance (FreeType linearHoriAdvance path).
      const advanceX = Math.floor((advDu * pxSize / srcFont.unitsPerEm) * 16 + 0.5);

      allGlyphs.push({
        width: r.width, height: r.height, advanceX,
        left: r.left, top: r.top,
        dataLength: r.packed.length, dataOffset: totalBitmapSize,
        codePoint: cp, packed: r.packed,
      });
      totalBitmapSize += r.packed.length;

      if (onProgress && ++done % 200 === 0) {
        onProgress(done, totalGlyphs);
        await new Promise((res) => setTimeout(res, 0)); // keep the UI alive
      }
    }
  }

  // Font-wide vertical metrics (FreeType face.size.* equivalents).
  const scalePx = pxSize / font.unitsPerEm;
  const advanceY = Math.ceil((font.ascender - font.descender + font.lineGap) * scalePx);
  const ascender = Math.ceil(font.ascender * scalePx);
  const descender = Math.floor(font.descender * scalePx);

  // Kerning + ligatures, from the same tables the Python tool reads.
  const ppem = (size * 150.0) / 72.0;
  const allCps = new Set(allGlyphs.map((g) => g.codePoint));
  let kernMap = extractKerning(font, allCps, ppem);
  // Drop SMP codepoints — the binary kern entry stores uint16 codepoints.
  for (const key of [...kernMap.keys()]) {
    const [l, r] = key.split(",").map(Number);
    if (l > 0xffff || r > 0xffff) kernMap.delete(key);
  }
  const kern = deriveKernClasses(kernMap);
  if (kern.dropped && warn) warn(kern.dropped);

  let ligaturePairs = extractLigatures(font, allCps, warn);
  if (ligaturePairs.length > 255) {
    if (warn) warn(`${ligaturePairs.length} ligature pairs exceeds 255, truncating`);
    ligaturePairs = ligaturePairs.slice(0, 255);
  }

  return {
    styleId, intervals, allGlyphs, totalBitmapSize,
    advanceY, ascender, descender,
    kernLeftClasses: kern.leftClasses, kernRightClasses: kern.rightClasses,
    kernMatrix: kern.matrix,
    kernLeftClassCount: kern.leftCount, kernRightClassCount: kern.rightCount,
    ligaturePairs,
    kernPairCount: kernMap.size,
  };
}

/* ── .cpfont v4 packing (byte-level port of the Python writers) ── */

function packStyleSections(sd) {
  const intervalsData = new ByteWriter(sd.intervals.length * 12);
  let offset = 0;
  for (const [iStart, iEnd] of sd.intervals) {
    intervalsData.u32(iStart);
    intervalsData.u32(iEnd);
    intervalsData.u32(offset);
    offset += iEnd - iStart + 1;
  }

  const glyphsData = new ByteWriter(sd.allGlyphs.length * 16);
  for (const g of sd.allGlyphs) {
    // EpdGlyph: width u8, height u8, advanceX u16 (12.4), left i16, top i16,
    // dataLength u16, 2 pad bytes, dataOffset u32 — 16 bytes.
    glyphsData.u8(g.width);
    glyphsData.u8(g.height);
    glyphsData.u16(g.advanceX);
    glyphsData.i16(g.left);
    glyphsData.i16(g.top);
    glyphsData.u16(g.dataLength);
    glyphsData.zeros(2);
    glyphsData.u32(g.dataOffset);
  }

  const kernLeft = new ByteWriter(sd.kernLeftClasses.length * 3);
  for (const [cp, cls] of sd.kernLeftClasses) { kernLeft.u16(cp); kernLeft.u8(cls); }
  const kernRight = new ByteWriter(sd.kernRightClasses.length * 3);
  for (const [cp, cls] of sd.kernRightClasses) { kernRight.u16(cp); kernRight.u8(cls); }

  const kernMatrix = new ByteWriter(sd.kernMatrix.length);
  for (const v of sd.kernMatrix) kernMatrix.i8(v);

  const ligatures = new ByteWriter(sd.ligaturePairs.length * 8);
  for (const [packedPair, ligCp] of sd.ligaturePairs) {
    ligatures.u32(packedPair);
    ligatures.u32(ligCp);
  }

  const bitmaps = new ByteWriter(sd.totalBitmapSize);
  for (const g of sd.allGlyphs) bitmaps.bytes(g.packed);

  return [
    intervalsData.toUint8Array(), glyphsData.toUint8Array(),
    kernLeft.toUint8Array(), kernRight.toUint8Array(),
    kernMatrix.toUint8Array(), ligatures.toUint8Array(),
    bitmaps.toUint8Array(),
  ];
}

/* styleData: array of results from rasterizeStyle (any subset of styles
 * 0-3). Returns the .cpfont file bytes. */
function generateCpfontBytes(styleData) {
  const HEADER_SIZE = 32;
  const STYLE_TOC_ENTRY_SIZE = 32;
  const flags = 1; // 2-bit greyscale
  const sorted = styleData.slice().sort((a, b) => a.styleId - b.styleId);

  const packed = sorted.map(packStyleSections);
  const dataStart = HEADER_SIZE + sorted.length * STYLE_TOC_ENTRY_SIZE;
  let currentOffset = dataStart;
  const styleOffsets = [];
  for (const sections of packed) {
    styleOffsets.push(currentOffset);
    currentOffset += sections.reduce((n, s) => n + s.length, 0);
  }

  const out = new ByteWriter(currentOffset);
  // Header: magic(8) + version(2) + flags(2) + styleCount(1) + reserved(19)
  out.bytes(new TextEncoder().encode("CPFONT"));
  out.zeros(2);
  out.u16(CPFONT_VERSION);
  out.u16(flags);
  out.u8(sorted.length);
  out.zeros(19);

  for (let i = 0; i < sorted.length; i++) {
    const sd = sorted[i];
    if (sd.advanceY > 255) {
      throw new Error(`advanceY (${sd.advanceY}) exceeds uint8 range — font size too large for this format`);
    }
    // styleId(1)+pad(3)+intervalCount(4)+glyphCount(4)+advanceY(1)+
    // ascender(2)+descender(2)+kernL(2)+kernR(2)+kernLCls(1)+kernRCls(1)+
    // ligCount(1)+dataOffset(4)+reserved(4) = 32
    out.u8(sd.styleId);
    out.zeros(3);
    out.u32(sd.intervals.length);
    out.u32(sd.allGlyphs.length);
    out.u8(sd.advanceY);
    out.i16(sd.ascender);
    out.i16(sd.descender);
    out.u16(sd.kernLeftClasses.length);
    out.u16(sd.kernRightClasses.length);
    out.u8(sd.kernLeftClassCount);
    out.u8(sd.kernRightClassCount);
    out.u8(sd.ligaturePairs.length);
    out.u32(styleOffsets[i]);
    out.zeros(4);
  }

  for (const sections of packed) {
    for (const s of sections) out.bytes(s);
  }
  return out.toUint8Array();
}

/* ── Page wiring ──────────────────────────────────────────────── */

const FONT_STYLES = [
  { id: 0, key: "regular", label: "Regular" },
  { id: 1, key: "bold", label: "Bold" },
  { id: 2, key: "italic", label: "Italic" },
  { id: 3, key: "bolditalic", label: "Bold Italic" },
];

async function runFontConversion() {
  const styleFiles = {};
  for (const s of FONT_STYLES) {
    const input = $(`font-${s.key}`);
    if (input.files.length) styleFiles[s.id] = input.files[0];
  }
  if (!Object.keys(styleFiles).length) {
    logLine("Choose at least one font file (Regular is the usual starting point).", "warn");
    return;
  }
  const fallbackInput = $("font-fallback");
  const fallbackFile = fallbackInput.files.length ? fallbackInput.files[0] : null;

  const sizes = [];
  for (const size of [12, 14, 16, 18]) {
    if ($(`font-size-${size}`).checked) sizes.push(size);
  }
  const customSizes = $("font-sizes-custom").value.trim();
  if (customSizes) {
    for (const s of customSizes.split(",")) {
      const n = parseInt(s.trim(), 10);
      if (Number.isInteger(n) && n > 0 && !sizes.includes(n)) sizes.push(n);
    }
  }
  sizes.sort((a, b) => a - b);
  if (!sizes.length) {
    logLine("Pick at least one point size.", "warn");
    return;
  }

  const selectedPresets = [...document.querySelectorAll(".font-preset:checked")].map((el) => el.value);
  const customIntervals = $("font-intervals-custom").value.trim();
  const presetStr = [...selectedPresets, ...(customIntervals ? [customIntervals] : [])].join(",");
  if (!presetStr) {
    logLine("Pick at least one Unicode coverage preset.", "warn");
    return;
  }

  let familyName = $("font-name").value.trim();
  if (!familyName) {
    let base = styleFiles[Math.min(...Object.keys(styleFiles).map(Number))].name.replace(/\.(ttf|otf|ttc)$/i, "");
    for (const suffix of ["-Regular", "-Bold", "-Italic", "-BoldItalic", "-regular", "-bold", "-italic", "-bolditalic"]) {
      if (base.endsWith(suffix)) { base = base.substring(0, base.length - suffix.length); break; }
    }
    familyName = base;
  }
  familyName = sanitizeFolderName(familyName).replace(/ /g, "");

  $("font-run").disabled = true;
  clearLog();
  const wakeLock = new WakeLock();
  await wakeLock.acquire();

  try {
    const intervals = resolveIntervals(presetStr);
    logLine(intervals === null
      ? "Coverage: every glyph in the font"
      : `Coverage: ${intervals.length} interval(s), up to ${intervals.reduce((n, [s, e]) => n + e - s + 1, 0)} glyphs`);

    const styleBytes = {};
    for (const [styleId, file] of Object.entries(styleFiles)) {
      styleBytes[styleId] = await readFileBytes(file);
    }
    const fallbackBytes = fallbackFile ? await readFileBytes(fallbackFile) : null;

    const zip = new ZipWriter();
    const warn = (msg) => logLine("  Warning: " + msg, "warn");

    for (const size of sizes) {
      logLine(`Generating ${familyName}_${size}.cpfont…`);
      const styleData = [];
      for (const [styleId, bytes] of Object.entries(styleBytes)) {
        const label = FONT_STYLES.find((s) => s.id === Number(styleId)).label;
        const sd = await rasterizeStyle(
          Number(styleId), bytes, fallbackBytes, size,
          intervals === null ? null : intervals.map((iv) => iv.slice()),
          (done, total) => setProgress(done, total, `${size}pt ${label}: ${done}/${total} glyphs`),
          warn);
        logLine(`  [${label.toLowerCase()}] ${sd.allGlyphs.length} glyphs, ` +
          `${formatBytes(sd.totalBitmapSize)} bitmap, ${sd.kernPairCount} kern pairs, ` +
          `${sd.ligaturePairs.length} ligatures`);
        styleData.push(sd);
      }
      const bytes = generateCpfontBytes(styleData);
      zip.addFile(`.fonts/${familyName}/${familyName}_${size}.cpfont`, bytes);
      logLine(`  ${familyName}_${size}.cpfont: ${formatBytes(bytes.length)}`);
    }

    const blob = zip.toBlob();
    logLine(`Done — ${formatBytes(blob.size)}. Unzip at the SD card root: fonts land in /.fonts/${familyName}/.`);
    downloadBlob(blob, `${familyName}-cpfont.zip`);
    setProgress(1, 1, "Complete");
  } catch (e) {
    logLine("Error: " + e.message, "error");
    console.error(e);
  } finally {
    $("font-run").disabled = false;
    wakeLock.release();
  }
}

if (typeof document !== "undefined" && document.getElementById("font-run")) {
  $("font-run").addEventListener("click", runFontConversion);
}

if (typeof module !== "undefined") {
  module.exports = {
    INTERVAL_PRESETS, resolveIntervals, roundHalfEven, fp4FromDesignUnits,
    extractKerning, deriveKernClasses, extractLigatures,
    packStyleSections, generateCpfontBytes,
  };
}
