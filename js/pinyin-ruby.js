/* Pinyin ruby: annotate a Chinese EPUB so the reader shows pinyin (or zhuyin) above the text
 * the way it shows furigana. A line-faithful port of matcha-reader's
 * tools/pinyin_ruby/add_pinyin_ruby.py: every run of hanzi is segmented against CC-CEDICT by
 * longest match and each character gets its syllable as <rt>. Needs dict-zh.js. */
"use strict";

const RUBY_HAN = /[㐀-䶿一-鿿\u{20000}-\u{3134f}]/u;
const RUBY_MAX_WORD = 8;

/* Map(headword -> [syllable, ...]) for both scripts; the everyday reading of a word wins over a
 * surname's or a place's (長 cháng, not Zhǎng). */
function loadCedictReadings(text) {
  const words = new Map();  // headword -> {syllables, proper}
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.startsWith("#")) continue;
    const m = CEDICT_LINE_RE.exec(line);
    if (!m) continue;
    const [, trad, simp, pinyin] = m;
    const syllables = pinyin.split(" ").filter((p) => p);
    if (syllables.length !== Array.from(trad).length) continue;  // 儿化 and odd entries: one syllable per character is what ruby needs
    const proper = isProperNounPinyin(pinyin);
    for (const hw of [trad, simp]) {
      const held = words.get(hw);
      if (held === undefined || (!proper && held.proper)) words.set(hw, { syllables, proper });
    }
  }
  const out = new Map();
  for (const [hw, held] of words) out.set(hw, held.syllables);
  return out;
}

/* [chunk, syllables or null] over text, longest dictionary match first. */
function* segmentForRuby(text, words) {
  const chars = Array.from(text);
  const n = chars.length;
  let i = 0;
  while (i < n) {
    if (!RUBY_HAN.test(chars[i])) {
      let j = i;
      while (j < n && !RUBY_HAN.test(chars[j])) j++;
      yield [chars.slice(i, j).join(""), null];
      i = j;
      continue;
    }
    let best = 0;
    for (let length = Math.min(RUBY_MAX_WORD, n - i); length > 0; length--) {
      if (words.has(chars.slice(i, i + length).join(""))) { best = length; break; }
    }
    if (best === 0) {
      yield [chars[i], null];
      i += 1;
    } else {
      const chunk = chars.slice(i, i + best).join("");
      yield [chunk, words.get(chunk)];
      i += best;
    }
  }
}

/* Python html.escape(): quote=true also escapes " and ' (as &#x27;). */
function htmlEscape(s, quote = true) {
  let out = s.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;");
  if (quote) out = out.split('"').join("&quot;").split("'").join("&#x27;");
  return out;
}

/* Python html.unescape(): every named entity in the browser; the five predefined ones plus
 * numeric references elsewhere (Node, where the test fixtures stay within that set). */
function htmlUnescape(s) {
  if (!s.includes("&")) return s;
  if (typeof document !== "undefined") {
    const ta = document.createElement("textarea");
    ta.innerHTML = s;
    return ta.value;
  }
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e];
  });
}

function rubyFor(chunk, syllables, zhuyin) {
  const chars = Array.from(chunk);
  const parts = [];
  for (let i = 0; i < Math.min(chars.length, syllables.length); i++) {
    const syl = syllables[i].toLowerCase();  // CC-CEDICT capitalises proper nouns; ruby does not
    const reading = zhuyin ? pinyinSyllableToZhuyin(syl) : pinyinSyllableToMarks(syl);
    parts.push(`<ruby>${htmlEscape(chars[i])}<rt>${htmlEscape(reading)}</rt></ruby>`);
  }
  return parts.join("");
}

// Text that must not be touched: tags, existing ruby, scripts/styles, and the <head>.
const RUBY_SKIP_BLOCK = /(<(ruby|rt|rp|script|style|head|title)\b[\s\S]*?<\/\2\s*>)/i;
const RUBY_SKIP_NAMES = new Set(["ruby", "rt", "rp", "script", "style", "head", "title"]);
const RUBY_TAG_OR_TEXT = /(<[^>]*>)/;

/* Annotate one XHTML document. skip: Set of words to leave bare. */
function annotateXhtml(doc, words, skip, zhuyin) {
  const out = [];
  for (const block of doc.split(RUBY_SKIP_BLOCK)) {
    if (block === undefined || RUBY_SKIP_NAMES.has(block.toLowerCase())) continue;
    const whole = RUBY_SKIP_BLOCK.exec(block);
    if (whole && whole[0] === block) {
      out.push(block);
      continue;
    }
    for (const piece of block.split(RUBY_TAG_OR_TEXT)) {
      if (!piece || piece.startsWith("<")) {
        out.push(piece);
        continue;
      }
      const text = htmlUnescape(piece);
      if (!RUBY_HAN.test(text)) {
        out.push(piece);
        continue;
      }
      const built = [];
      for (const [chunk, syllables] of segmentForRuby(text, words)) {
        if (syllables === null || skip.has(chunk)) built.push(htmlEscape(chunk, false));
        else built.push(rubyFor(chunk, syllables, zhuyin));
      }
      out.push(built.join(""));
    }
  }
  return out.join("");
}

/* The N commonest words of a frequency list, to leave unannotated. */
function topWords(priorities, n) {
  const ranked = [...priorities.entries()].sort((a, b) => b[1] - a[1]);  // stable, like Python's sorted
  return new Set(ranked.slice(0, n).map(([w]) => w));
}

/* Rewrite an EPUB (bytes) with ruby added to every XHTML document. Returns {blob, annotated}. */
async function annotateEpub(epubBytes, words, skip, zhuyin, onProgress) {
  const zin = new ZipReader(epubBytes);
  const zout = new ZipWriter();
  let annotated = 0;
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < zin.entries.length; i++) {
    const item = zin.entries[i];
    if (item.name.endsWith("/")) continue;
    let data = await zin.readEntry(item);
    const lower = item.name.toLowerCase();
    if (lower.endsWith(".xhtml") || lower.endsWith(".html") || lower.endsWith(".htm")) {
      let doc = null;
      try { doc = utf8.decode(data); } catch (e) { doc = null; }
      if (doc !== null) {
        const next = annotateXhtml(doc, words, skip, zhuyin);
        if (next !== doc) annotated++;
        data = new TextEncoder().encode(next);
      }
    }
    zout.addFile(item.name, data);
    if (onProgress) onProgress(i + 1, zin.entries.length);
  }
  return { blob: zout.toBlob(), annotated };
}

if (typeof module !== "undefined") {
  module.exports = { loadCedictReadings, segmentForRuby, rubyFor, annotateXhtml, topWords, annotateEpub, htmlEscape, htmlUnescape };
}
