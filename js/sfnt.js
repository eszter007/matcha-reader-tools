/* Minimal OpenType/TrueType (sfnt) table parser.
 *
 * Parses exactly what the .cpfont generator needs, mirroring what
 * fontconvert_sdcard.py obtains from FreeType and fontTools:
 *   head   — unitsPerEm
 *   hhea   — ascender / descender / lineGap, numberOfHMetrics
 *   maxp   — numGlyphs
 *   hmtx   — per-glyph advance widths (the unhinted linear advance)
 *   cmap   — codepoint → glyph id (formats 4 and 12)
 *   kern   — legacy pair kerning (version 0, format 0)
 *   GPOS   — 'kern' feature PairPos lookups (formats 1 and 2, incl. Extension)
 *   GSUB   — 'liga'/'rlig' ligature substitutions (incl. Extension)
 *   OS/2   — sTypo metrics fallback when hhea values are zero
 */
"use strict";

class SfntFont {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let base = 0;
    if (this._tag(0) === "ttcf") {
      // TrueType Collection: use the first font.
      base = this.view.getUint32(12);
    }
    const sfntVersion = this.view.getUint32(base);
    if (sfntVersion !== 0x00010000 && this._tag(base) !== "OTTO" && this._tag(base) !== "true") {
      throw new Error("Not a TrueType/OpenType font");
    }
    const numTables = this.view.getUint16(base + 4);
    this.tables = new Map();
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16;
      this.tables.set(this._tag(rec), {
        offset: this.view.getUint32(rec + 8),
        length: this.view.getUint32(rec + 12),
      });
    }
    if (!this.tables.has("head") || !this.tables.has("hhea") || !this.tables.has("cmap")) {
      throw new Error("Font is missing required tables (head/hhea/cmap)");
    }

    const head = this.tables.get("head").offset;
    this.unitsPerEm = this.view.getUint16(head + 18);

    const hhea = this.tables.get("hhea").offset;
    this.ascender = this.view.getInt16(hhea + 4);
    this.descender = this.view.getInt16(hhea + 6);
    this.lineGap = this.view.getInt16(hhea + 8);
    this.numberOfHMetrics = this.view.getUint16(hhea + 34);

    if ((this.ascender === 0 && this.descender === 0) && this.tables.has("OS/2")) {
      const os2 = this.tables.get("OS/2").offset;
      this.ascender = this.view.getInt16(os2 + 68);   // sTypoAscender
      this.descender = this.view.getInt16(os2 + 70);  // sTypoDescender
      this.lineGap = this.view.getInt16(os2 + 72);    // sTypoLineGap
    }

    this.numGlyphs = this.tables.has("maxp")
      ? this.view.getUint16(this.tables.get("maxp").offset + 4) : 0;

    this._parseCmap();
  }

  _tag(offset) {
    return String.fromCharCode(
      this.bytes[offset], this.bytes[offset + 1], this.bytes[offset + 2], this.bytes[offset + 3]);
  }

  /* ── cmap ─────────────────────────────────────────────────── */

  _parseCmap() {
    const v = this.view;
    const cmap = this.tables.get("cmap").offset;
    const numSub = v.getUint16(cmap + 2);
    const subs = [];
    for (let i = 0; i < numSub; i++) {
      const rec = cmap + 4 + i * 8;
      subs.push({
        platform: v.getUint16(rec),
        encoding: v.getUint16(rec + 2),
        offset: cmap + v.getUint32(rec + 4),
      });
    }
    // Preference order mirrors fontTools getBestCmap.
    const prefs = [[3, 10], [0, 6], [0, 4], [3, 1], [0, 3], [0, 2], [0, 1], [0, 0]];
    let chosen = null;
    for (const [p, e] of prefs) {
      chosen = subs.find((s) => s.platform === p && s.encoding === e);
      if (chosen) break;
    }
    if (!chosen) chosen = subs.find((s) => [4, 12].includes(v.getUint16(s.offset)));
    if (!chosen) throw new Error("No usable cmap subtable (need format 4 or 12)");

    const format = v.getUint16(chosen.offset);
    this.cmapMap = new Map(); // codepoint → glyph id
    if (format === 4) {
      const o = chosen.offset;
      const segCountX2 = v.getUint16(o + 6);
      const segCount = segCountX2 / 2;
      const endO = o + 14, startO = endO + segCountX2 + 2;
      const deltaO = startO + segCountX2, rangeO = deltaO + segCountX2;
      for (let seg = 0; seg < segCount; seg++) {
        const end = v.getUint16(endO + seg * 2);
        const start = v.getUint16(startO + seg * 2);
        const delta = v.getInt16(deltaO + seg * 2);
        const rangeOffset = v.getUint16(rangeO + seg * 2);
        if (start === 0xffff && end === 0xffff) continue;
        for (let cp = start; cp <= end; cp++) {
          let gid;
          if (rangeOffset === 0) {
            gid = (cp + delta) & 0xffff;
          } else {
            const idx = rangeO + seg * 2 + rangeOffset + (cp - start) * 2;
            if (idx + 1 >= this.bytes.length) continue;
            gid = v.getUint16(idx);
            if (gid !== 0) gid = (gid + delta) & 0xffff;
          }
          if (gid !== 0) this.cmapMap.set(cp, gid);
        }
      }
    } else if (format === 12) {
      const o = chosen.offset;
      const nGroups = v.getUint32(o + 12);
      for (let g = 0; g < nGroups; g++) {
        const rec = o + 16 + g * 12;
        const startCp = v.getUint32(rec);
        const endCp = v.getUint32(rec + 4);
        const startGid = v.getUint32(rec + 8);
        for (let cp = startCp; cp <= endCp; cp++) {
          this.cmapMap.set(cp, startGid + (cp - startCp));
        }
      }
    } else {
      throw new Error(`Unsupported cmap subtable format ${format}`);
    }
  }

  glyphId(cp) { return this.cmapMap.get(cp) || 0; }
  hasGlyph(cp) { return this.cmapMap.has(cp); }

  /* All mapped codepoints, ascending. */
  allCodepoints() { return [...this.cmapMap.keys()].sort((a, b) => a - b); }

  /* glyph id → codepoint map; when several codepoints share a glyph the
   * highest codepoint wins, matching fontTools' getBestCmap dict iteration
   * order in the Python tool. */
  reverseCmap() {
    const rev = new Map();
    for (const cp of this.allCodepoints()) rev.set(this.cmapMap.get(cp), cp);
    return rev;
  }

  /* ── hmtx ─────────────────────────────────────────────────── */

  advanceWidth(gid) {
    if (!this.tables.has("hmtx") || this.numberOfHMetrics === 0) return 0;
    const hmtx = this.tables.get("hmtx").offset;
    const i = Math.min(gid, this.numberOfHMetrics - 1);
    return this.view.getUint16(hmtx + i * 4);
  }

  /* ── kern (legacy table, version 0 format 0) ──────────────── */

  /* Returns Map "leftGid,rightGid" → accumulated design-unit value. */
  kernPairs() {
    const raw = new Map();
    if (!this.tables.has("kern")) return raw;
    const v = this.view;
    const o = this.tables.get("kern").offset;
    const version = v.getUint16(o);
    if (version !== 0) return raw; // Apple 'kern' version 1 — not used by the Python tool either
    const nTables = v.getUint16(o + 2);
    let sub = o + 4;
    for (let t = 0; t < nTables; t++) {
      const length = v.getUint16(sub + 2);
      const coverage = v.getUint16(sub + 4);
      const format = coverage >> 8;
      const horizontal = coverage & 1;
      if (format === 0 && horizontal) {
        const nPairs = v.getUint16(sub + 6);
        let p = sub + 14;
        for (let i = 0; i < nPairs; i++, p += 6) {
          const key = v.getUint16(p) + "," + v.getUint16(p + 2);
          raw.set(key, (raw.get(key) || 0) + v.getInt16(p + 4));
        }
      }
      sub += Math.max(length, 6);
    }
    return raw;
  }

  /* ── OpenType layout common structures ────────────────────── */

  _coverageGlyphs(off) {
    const v = this.view;
    const format = v.getUint16(off);
    const glyphs = [];
    if (format === 1) {
      const count = v.getUint16(off + 2);
      for (let i = 0; i < count; i++) glyphs.push(v.getUint16(off + 4 + i * 2));
    } else if (format === 2) {
      const count = v.getUint16(off + 2);
      for (let i = 0; i < count; i++) {
        const rec = off + 4 + i * 6;
        const start = v.getUint16(rec), end = v.getUint16(rec + 2);
        for (let g = start; g <= end; g++) glyphs.push(g);
      }
    }
    return glyphs;
  }

  _classDef(off) {
    const v = this.view;
    const map = new Map(); // gid → class (missing = 0)
    if (off === 0) return map;
    const format = v.getUint16(off);
    if (format === 1) {
      const startGlyph = v.getUint16(off + 2);
      const count = v.getUint16(off + 4);
      for (let i = 0; i < count; i++) {
        const cls = v.getUint16(off + 6 + i * 2);
        if (cls !== 0) map.set(startGlyph + i, cls);
      }
    } else if (format === 2) {
      const count = v.getUint16(off + 2);
      for (let i = 0; i < count; i++) {
        const rec = off + 4 + i * 6;
        const start = v.getUint16(rec), end = v.getUint16(rec + 2);
        const cls = v.getUint16(rec + 4);
        if (cls !== 0) for (let g = start; g <= end; g++) map.set(g, cls);
      }
    }
    return map;
  }

  /* Lookup indices referenced by any FeatureRecord with one of `tags`. */
  _featureLookupIndices(tableOff, tags) {
    const v = this.view;
    const featureListOff = tableOff + v.getUint16(tableOff + 6);
    const indices = new Set();
    const count = v.getUint16(featureListOff);
    for (let i = 0; i < count; i++) {
      const rec = featureListOff + 2 + i * 6;
      const tag = this._tag(rec);
      if (!tags.includes(tag)) continue;
      const featOff = featureListOff + v.getUint16(rec + 4);
      const lookupCount = v.getUint16(featOff + 2);
      for (let j = 0; j < lookupCount; j++) {
        indices.add(v.getUint16(featOff + 4 + j * 2));
      }
    }
    return indices;
  }

  _lookups(tableOff) {
    const v = this.view;
    const lookupListOff = tableOff + v.getUint16(tableOff + 8);
    const count = v.getUint16(lookupListOff);
    const lookups = [];
    for (let i = 0; i < count; i++) {
      const off = lookupListOff + v.getUint16(lookupListOff + 2 + i * 2);
      const type = v.getUint16(off);
      const subCount = v.getUint16(off + 4);
      const subs = [];
      for (let j = 0; j < subCount; j++) subs.push(off + v.getUint16(off + 6 + j * 2));
      lookups.push({ type, subs });
    }
    return lookups;
  }

  /* ── GPOS 'kern' feature → pair kerning ───────────────────── */

  /* Value record: return XAdvance (only from value1, like the Python tool)
   * and the byte size of a record with this valueFormat. */
  static _valueSize(vf) {
    let n = 0;
    for (let bit = 0; bit < 8; bit++) if (vf & (1 << bit)) n++;
    return n * 2;
  }

  _readXAdvance(off, vf) {
    if (!(vf & 0x0004)) return 0;
    let pos = off;
    if (vf & 0x0001) pos += 2; // XPlacement
    if (vf & 0x0002) pos += 2; // YPlacement
    return this.view.getInt16(pos);
  }

  /* Accumulate GPOS kern-feature pair adjustments into `raw`
   * (Map "leftGid,rightGid" → design units). `gidSet` limits extraction to
   * glyphs of interest, mirroring the Python extractor. */
  gposKernPairs(gidSet) {
    const raw = new Map();
    if (!this.tables.has("GPOS")) return raw;
    const v = this.view;
    const gpos = this.tables.get("GPOS").offset;
    const indices = this._featureLookupIndices(gpos, ["kern"]);
    const lookups = this._lookups(gpos);

    for (const li of indices) {
      const lookup = lookups[li];
      if (!lookup) continue;
      for (let subOff of lookup.subs) {
        let effectiveType = lookup.type;
        if (lookup.type === 9) { // Extension positioning
          effectiveType = v.getUint16(subOff + 2);
          subOff = subOff + v.getUint32(subOff + 4);
        }
        if (effectiveType !== 2) continue; // only PairPos, like the Python tool
        const format = v.getUint16(subOff);
        const coverage = this._coverageGlyphs(subOff + v.getUint16(subOff + 2));
        const vf1 = v.getUint16(subOff + 4);
        const vf2 = v.getUint16(subOff + 6);
        const size1 = SfntFont._valueSize(vf1);
        const size2 = SfntFont._valueSize(vf2);

        if (format === 1) {
          const pairSetCount = v.getUint16(subOff + 8);
          for (let i = 0; i < Math.min(pairSetCount, coverage.length); i++) {
            const first = coverage[i];
            if (!gidSet.has(first)) continue;
            const psOff = subOff + v.getUint16(subOff + 10 + i * 2);
            const pairCount = v.getUint16(psOff);
            let rec = psOff + 2;
            for (let k = 0; k < pairCount; k++, rec += 2 + size1 + size2) {
              const second = v.getUint16(rec);
              if (!gidSet.has(second)) continue;
              const xa = this._readXAdvance(rec + 2, vf1);
              if (xa !== 0) {
                const key = first + "," + second;
                raw.set(key, (raw.get(key) || 0) + xa);
              }
            }
          }
        } else if (format === 2) {
          const classDef1 = this._classDef(v.getUint16(subOff + 8) ? subOff + v.getUint16(subOff + 8) : 0);
          const classDef2 = this._classDef(v.getUint16(subOff + 10) ? subOff + v.getUint16(subOff + 10) : 0);
          const class1Count = v.getUint16(subOff + 12);
          const class2Count = v.getUint16(subOff + 14);
          const coverageSet = new Set(coverage);

          // gid lists per class, limited to glyphs of interest.
          const leftByClass = new Map();
          const rightByClass = new Map();
          for (const g of gidSet) {
            if (coverageSet.has(g)) {
              const c1 = classDef1.get(g) || 0;
              if (!leftByClass.has(c1)) leftByClass.set(c1, []);
              leftByClass.get(c1).push(g);
            }
            const c2 = classDef2.get(g) || 0;
            if (!rightByClass.has(c2)) rightByClass.set(c2, []);
            rightByClass.get(c2).push(g);
          }

          const recSize = size1 + size2;
          for (let c1 = 0; c1 < class1Count; c1++) {
            if (!leftByClass.has(c1)) continue;
            for (let c2 = 0; c2 < class2Count; c2++) {
              const rec = subOff + 16 + (c1 * class2Count + c2) * recSize;
              const xa = this._readXAdvance(rec, vf1);
              if (xa === 0) continue;
              if (!rightByClass.has(c2)) continue;
              for (const lg of leftByClass.get(c1)) {
                for (const rg of rightByClass.get(c2)) {
                  const key = lg + "," + rg;
                  raw.set(key, (raw.get(key) || 0) + xa);
                }
              }
            }
          }
        }
      }
    }
    return raw;
  }

  /* ── GSUB 'liga'/'rlig' → ligature rules ──────────────────── */

  /* Returns [{sequence: [gid, ...], ligGlyph: gid}]. */
  gsubLigatures() {
    const rules = [];
    if (!this.tables.has("GSUB")) return rules;
    const v = this.view;
    const gsub = this.tables.get("GSUB").offset;
    const indices = this._featureLookupIndices(gsub, ["liga", "rlig"]);
    const lookups = this._lookups(gsub);

    for (const li of indices) {
      const lookup = lookups[li];
      if (!lookup) continue;
      for (let subOff of lookup.subs) {
        let effectiveType = lookup.type;
        if (lookup.type === 7) { // Extension substitution
          effectiveType = v.getUint16(subOff + 2);
          subOff = subOff + v.getUint32(subOff + 4);
        }
        if (effectiveType !== 4) continue; // LigatureSubst
        if (v.getUint16(subOff) !== 1) continue;
        const coverage = this._coverageGlyphs(subOff + v.getUint16(subOff + 2));
        const ligSetCount = v.getUint16(subOff + 4);
        for (let i = 0; i < Math.min(ligSetCount, coverage.length); i++) {
          const first = coverage[i];
          const lsOff = subOff + v.getUint16(subOff + 6 + i * 2);
          const ligCount = v.getUint16(lsOff);
          for (let j = 0; j < ligCount; j++) {
            const ligOff = lsOff + v.getUint16(lsOff + 2 + j * 2);
            const ligGlyph = v.getUint16(ligOff);
            const compCount = v.getUint16(ligOff + 2);
            const seq = [first];
            for (let c = 0; c < compCount - 1; c++) {
              seq.push(v.getUint16(ligOff + 4 + c * 2));
            }
            rules.push({ sequence: seq, ligGlyph });
          }
        }
      }
    }
    return rules;
  }
}

if (typeof module !== "undefined") {
  module.exports = { SfntFont };
}
