/* Dictionary converter: JMdict-simplified JSON / Yomitan zip → CrossPoint
 * binary dictionary (.idx/.dat) plus the .spx sparse-index sidecar.
 *
 * This is a line-faithful port of matcha-reader's
 * tools/dict_convert/convert_jmdict.py and scripts/gen_dict_spx.py: the
 * .idx/.dat/.spx bytes produced here match the Python tool's output for the
 * same input. The Chinese formats (CC-CEDICT, MoE, TSV, word lists) live in
 * dict-zh.js; MDict in mdx.js.
 */
"use strict";

const HEADWORD_SIZE = 32;
const RECORD_SIZE = 40;   // headword(32) + offset(4) + length(2) + priority(1) + posFlags(1)

/* Part-of-speech flag bits packed into the record's final byte — must mirror
 * DictIndexRecord::POS_* in matcha-reader's lib/Dict/DictIndex.h. 0 means "no
 * POS data" and the firmware then accepts every deinflection candidate, so
 * leaving flags unset is always safe (fail open). */
const POS_V1 = 0x01;      // ichidan verb
const POS_V5 = 0x02;      // godan verb
const POS_VS = 0x04;      // suru verb
const POS_VK = 0x08;      // kuru verb
const POS_ADJ_I = 0x10;   // i-adjective
const POS_OTHER = 0x20;   // tagged, but none of the above (noun, particle, na-adjective, ...)
const POS_READING = 0x40; // kana READING record of an entry that has kanji headwords (not a kana lemma)
const POS_ANY_VERB = POS_V1 | POS_V5 | POS_VS | POS_VK;

/* Map JMdict partOfSpeech tags / Yomitan rules to POS flag bits. Prefix-matches
 * the verb classes so subtags stay covered (v5k-s, v5aru, v1-s, vs-i, adj-ix); a
 * verb-ish tag with an unrecognized class fails OPEN (all verb bits) rather than
 * closed; transitivity tags (vt/vi) say nothing about conjugation and are
 * ignored. Faithful port of pos_flags_from_tags in convert_jmdict.py. */
function posFlagsFromTags(tags) {
  let flags = 0;
  for (const t of tags) {
    if (!t) continue;
    if (t === "vt" || t === "vi" || t === "aux" || t === "aux-adj" || t === "exp") continue;
    if (t.startsWith("v1")) flags |= POS_V1;
    else if (t.startsWith("v5") || t.startsWith("v4") || t.startsWith("iv")) flags |= POS_V5;
    else if (t.startsWith("vs")) flags |= POS_VS;
    else if (t.startsWith("vk")) flags |= POS_VK;
    else if (t.startsWith("adj-i")) flags |= POS_ADJ_I;
    else if (t.startsWith("v") || t === "aux-v") flags |= POS_ANY_VERB;
    else flags |= POS_OTHER;
  }
  return flags;
}

function posFlagsJmdict(entry) {
  const tags = [];
  for (const sense of entry.sense || []) {
    for (const p of sense.partOfSpeech || []) tags.push(p);
  }
  return posFlagsFromTags(tags);
}

const SPX_STRIDE = 48;
const SPX_VERSION = 1;
const SPX_HEADER_SIZE = 32;

const dictEncoder = new TextEncoder();

/* ── Shared output writer ─────────────────────────────────────── */

/* records: array of {hw: Uint8Array, def: Uint8Array, priority: int,
 * posFlags?: int}. posFlags defaults to 0 (fail-open / no POS data), matching
 * the MDict path and any pre-flags caller. Returns {idx, dat}. */
function dictWriteBinary(records) {
  // Stable sort by headword bytes (Python: records.sort(key=lambda r: r[0])).
  records = records.map((r, i) => ({ r, i }));
  records.sort((a, b) => compareBytes(a.r.hw, b.r.hw) || a.i - b.i);
  records = records.map((x) => x.r);

  const dat = new ByteWriter(1 << 20);
  const idx = new ByteWriter(records.length * RECORD_SIZE + 16);

  let datOffset = 0;
  // One copy per distinct definition, wherever its records sort (Python: a dict keyed by the
  // definition bytes): a Chinese entry is indexed under its traditional and simplified form,
  // which sort far apart, and a Japanese one under kanji and kana.
  const stored = new Map();
  const keyDecoder = new TextDecoder("latin1");  // a byte-for-byte string key
  const entries = [];

  for (const rec of records) {
    let defBytes = rec.def;
    if (defBytes.length > 0xffff) defBytes = defBytes.subarray(0, 0xffff);
    const key = keyDecoder.decode(defBytes);
    let hit = stored.get(key);
    if (hit === undefined) {
      hit = { offset: datOffset, length: defBytes.length };
      dat.bytes(defBytes);
      datOffset += defBytes.length;
      stored.set(key, hit);
    }
    entries.push({ hw: rec.hw, offset: hit.offset, length: hit.length, priority: rec.priority, posFlags: rec.posFlags || 0 });
  }

  for (const e of entries) {
    idx.bytes(e.hw);
    idx.zeros(HEADWORD_SIZE - e.hw.length);
    idx.u32(e.offset);
    idx.u16(e.length);
    idx.u8(e.priority);
    idx.u8(e.posFlags & 0xff);
  }

  return { idx: idx.toUint8Array(), dat: dat.toUint8Array(), recordCount: entries.length };
}

/* .spx sparse-index sidecar: one 32-byte headword checkpoint per SPX_STRIDE
 * records of the .idx (port of scripts/gen_dict_spx.py). */
function dictGenSpx(idxBytes) {
  if (idxBytes.length % RECORD_SIZE !== 0) {
    throw new Error(`idx size ${idxBytes.length} not a multiple of ${RECORD_SIZE}`);
  }
  const count = idxBytes.length / RECORD_SIZE;
  const fineCount = Math.ceil(count / SPX_STRIDE);
  const out = new ByteWriter(SPX_HEADER_SIZE + fineCount * HEADWORD_SIZE);
  out.bytes(dictEncoder.encode("CPSPX1"));
  out.zeros(2); // magic is "CPSPX1\0\0"
  out.u32(SPX_VERSION);
  out.u32(SPX_STRIDE);
  out.u32(count);
  out.u32(fineCount);
  out.u32(0);
  out.zeros(SPX_HEADER_SIZE - out.length);
  for (let rec = 0; rec < count; rec += SPX_STRIDE) {
    out.bytes(idxBytes.subarray(rec * RECORD_SIZE, rec * RECORD_SIZE + HEADWORD_SIZE));
  }
  return out.toUint8Array();
}

/* ── JMdict (jmdict-simplified JSON) ──────────────────────────── */

function computePriorityJmdict(entry) {
  let isCommon = false;
  for (const kanji of entry.kanji || []) {
    if (kanji.common) { isCommon = true; break; }
  }
  if (!isCommon) {
    for (const kana of entry.kana || []) {
      if (kana.common) { isCommon = true; break; }
    }
  }
  return isCommon ? 200 : 100;
}

function formatDefinitionJmdict(entry) {
  const parts = [];
  const readings = (entry.kana || []).map((k) => k.text);
  if (readings.length) parts.push("【" + readings.slice(0, 3).join("、") + "】");

  const senses = entry.sense || [];
  const shown = senses.slice(0, 3);
  for (let i = 0; i < shown.length; i++) {
    const glosses = (shown[i].gloss || []).map((g) => g.text);
    if (glosses.length) {
      const prefix = senses.length > 1 ? `${i + 1}. ` : "";
      parts.push(prefix + glosses.slice(0, 4).join("; "));
    }
  }
  return parts.join("\n");
}

/* data: parsed jmdict-simplified JSON object. Returns records for dictWriteBinary. */
function convertJmdictRecords(data, onProgress) {
  const words = data.words || [];
  const records = [];
  for (let wi = 0; wi < words.length; wi++) {
    const entry = words[wi];
    const definition = formatDefinitionJmdict(entry);
    const defBytes = dictEncoder.encode(definition);
    const priority = computePriorityJmdict(entry);
    const posFlags = posFlagsJmdict(entry);

    const seen = new Set();
    for (const kanji of entry.kanji || []) {
      const hwBytes = dictEncoder.encode(kanji.text);
      const key = kanji.text;
      if (hwBytes.length >= HEADWORD_SIZE || seen.has(key)) continue;
      seen.add(key);
      records.push({ hw: hwBytes, def: defBytes, priority, posFlags });
    }
    // Kana records of an entry that also has kanji headwords are READING records:
    // text matching them is usually conjugation morphology, not the word itself.
    // Kana-only lemmas (no kanji form) stay unflagged. Empty kanji list is
    // falsy in Python, so guard on length to match (POS_READING only when set).
    const kanaFlags = posFlags | (entry.kanji && entry.kanji.length ? POS_READING : 0);
    for (const kana of entry.kana || []) {
      const hwBytes = dictEncoder.encode(kana.text);
      const key = kana.text;
      if (hwBytes.length >= HEADWORD_SIZE || seen.has(key)) continue;
      seen.add(key);
      records.push({ hw: hwBytes, def: defBytes, priority, posFlags: kanaFlags });
    }
    if (onProgress && wi % 20000 === 0) onProgress(wi, words.length);
  }
  return records;
}

/* ── Yomitan / Yomichan (.zip) ────────────────────────────────── */

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/* Python's whitespace (str.isspace, the \s of re) as a character-class body. It includes
 * \x1c-\x1f, which the flattener uses as markers. */
const PY_WS = "\\t-\\r\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_WS_RE = new RegExp(`[${PY_WS}]+`, "u");
/* Python's \w for str patterns: letters, digits and numbers of any script, and "_". */
const WORD_RE = /[\p{L}\p{N}_]/u;

function cpLen(s) { let n = 0; for (const _ of s) n++; return n; }
function isAscii(s) { return /^[\x00-\x7f]*$/.test(s); }
function pySplit(s) { const t = pyStrip(s); return t ? t.split(new RegExp(`[${PY_WS}]+`, "u")) : []; }
function rstripChars(s, chars) {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1])) end--;
  return s.slice(0, end);
}
function lstripChars(s, chars) {
  let start = 0;
  while (start < s.length && chars.includes(s[start])) start++;
  return s.slice(start);
}

/* UTF-8 without the lone surrogates some dictionaries' JSON escapes carry (TheKanjiMap), as
 * Python's encode("utf-8", "ignore"). TextEncoder would write U+FFFD for them. */
function utf8Bytes(text) {
  return dictEncoder.encode(text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, ""));
}

const IMAGE_MARKER = "";  // a definition line "<w>x<h> <file>" is a picture (private use)
const SOURCE_MARKER = "";  // first line of an entry from a merged file: its dictionary's name

/* A list whose data attributes name it as example sentences (surasura "examples", CantoDict
 * "sentences"): its items print as plain lines, the device's example layout. */
function isExampleList(node) {
  if (!isPlainObject(node.data)) return false;
  return Object.values(node.data).some((v) => typeof v === "string"
    && (v.toLowerCase().includes("example") || v.toLowerCase().includes("sentence")));
}

function listStyleNone(node) {
  return isPlainObject(node) && isPlainObject(node.style) && node.style.listStyleType === "none";
}

/* A ul/ol: "• " per item, plain lines for example lists and unmarked items, and no line at all
 * for an item left empty (a dropped web link). */
function flattenList(node) {
  const plain = isExampleList(node);
  let items = node.content ?? "";
  items = Array.isArray(items) ? items : [items];
  // Onomatoproject wraps each li in its own array: [[li], [li], ...].
  items = items.flatMap((it) => (Array.isArray(it) && it.every((y) => isPlainObject(y) && y.tag === "li") ? it : [it]));
  const marker = isGlossList(node, items) ? "• " : "・";
  let lines = [];
  for (const item of items) {
    if (isPlainObject(item) && item.tag === "li") {
      const text = pyStrip(flattenStructuredContent(item.content ?? ""));
      if (!text) continue;
      lines.push(plain || listStyleNone(item) ? text : marker + text);
    } else {
      const text = pyStrip(flattenStructuredContent(item));
      if (text) lines.push(text);
    }
  }
  const unmarked = lines.map((l) => (l.startsWith(marker) ? l.slice(marker.length) : l));
  if (!plain && alternatesWithTranslation(unmarked)) lines = unmarked;
  return lines.length ? "\n" + lines.join("\n") + "\n" : "";
}

/* A list of glosses, which the device joins into one numbered sense: Jitendex marks it
 * data-content "glossary"; a list of foreign-language glosses has no Japanese in it. Other lists
 * (類語例解's usage notes) keep their own lines. */
function isGlossList(node, items) {
  if (isPlainObject(node.data) && node.data.content === "glossary") return true;
  return !/[぀-ヿ㐀-鿿]/.test(flattenStructuredContent(items));
}

/* Items that pair a Japanese sentence with its Latin-script translation (斎藤's 犬がほえる /
 * A dog barks.) are examples, whatever the list is called. */
function alternatesWithTranslation(lines) {
  if (lines.length < 2 || lines.length % 2) return false;
  const jp = /^[぀-ヿ㐀-鿿々〜～（「]/;
  const latin = /^["'“‘(\[]?[A-Za-zÀ-ӿ]/;
  for (let i = 0; i < lines.length; i += 2) {
    if (!jp.test(lines[i]) || !latin.test(lines[i + 1])) return false;
  }
  return true;
}

// Style suffixes in label-icon file names: 名-rect.svg, 季-default.svg, ショ-rect-red.svg.
const IMAGE_STYLE_SUFFIXES = ["rect", "fill", "default", "red", "redfill", "round", "circle", "box", "black", "white"];
const FILLED_DIGITS = new Map();
for (const digits of ["１２３４５６７８９", "一二三四五六七八九"]) {
  [...digits].forEach((c, i) => FILLED_DIGITS.set(c, String.fromCodePoint(0x2460 + i)));
}

function rpartition(s, sep) {
  const i = s.lastIndexOf(sep);
  return i < 0 ? ["", "", s] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

/* Text for a structured-content image. Label icons are named after their label (名-rect.svg,
 * 文法-red.svg, １-fill.svg, red_（.svg) and become that label; other images keep their alt or
 * title text. Pictures are dropped: the page does not convert them (the Python tool's --images). */
function imageText(node) {
  const path = typeof node.path === "string" ? node.path : "";
  const [folder, , fname] = rpartition(path, "/");
  const [stem, dot, ext] = rpartition(fname, ".");
  if (dot && ["jpg", "jpeg", "webp", "gif", "bmp"].includes(ext.toLowerCase())) return "";
  const data = isPlainObject(node.data) ? node.data : {};
  for (const value of [node.alt, node.title, data.alt]) {
    if (typeof value === "string" && pyStrip(value) && !value.includes("://")) {
      // 明鏡 describes its accent marks in words ("3分の2"); in "gaiji" they are noise.
      return data.class === "gaiji" && folder === "gaiji" ? "" : pyStrip(value);
    }
  }
  if (folder === "gaiji" && /^[A-Za-z]{1,3}[^A-Za-z]/.test(stem)) return "";  // a gaiji code with a kanji suffix (bs一)
  if (!dot) return "";
  if (folder.includes("accent")) return "";  // accent glyphs; pitch comes from the pitch dictionaries
  if (stem.startsWith("red_")) return stem.slice(4);
  const parts = stem.split("-");
  while (parts.length > 1 && IMAGE_STYLE_SUFFIXES.includes(parts[parts.length - 1].toLowerCase())) parts.pop();
  const label = parts.join("-");
  if (!label || isAscii(label)) return "";  // gaiji codes (B92D, AC6E, b327) have no text; a PNG is a drawing
  if (stem.split("-").slice(1).includes("fill") && FILLED_DIGITS.has(label)) return FILLED_DIGITS.get(label);
  if (cpLen(label) <= 6) return `〔${label}〕`;
  return label;
}

/* Recursively extract display text from Yomitan structured content, using
 * the semantic data-content attributes from Jitendex. */
function flattenStructuredContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(flattenStructuredContent).join("");
  if (isPlainObject(content)) {
    const ctype = content.type || "";
    if (ctype === "text") return content.text || "";
    if (ctype === "image" || content.tag === "img") return imageText(content);
    if (ctype === "structured-content") return flattenStructuredContent(content.content ?? "");

    const inner = content.content ?? "";
    const tag = content.tag || "";
    const data = isPlainObject(content.data) ? content.data : {};
    const dc = data.content || "";
    const cls = data.class || "";
    const text = flattenStructuredContent(inner);

    if (tag === "br") return "\n";
    // A web link cannot be followed on the device (Pixiv's 続きを読む, Nico/Pixiv's site names).
    const href = content.href ?? "";
    if (tag === "a" && typeof href === "string" && (href.startsWith("http://") || href.startsWith("https://"))) return "";
    // Monolingual dictionaries (大辞林) label parts with data.name. Map them to the layout the
    // device formats: "• " gloss lines, "[pos]" tag lines, and plain lines for examples. 見出部 and
    // 語義Gnum repeat what the panel already shows; ━ stands for the headword and draws badly.
    const dn = typeof data.name === "string" ? data.name : "";
    if (dn === "見出部" || dn === "語義Gnum") return "";
    if (dn === "品詞G") return "\n[" + pyStrip(text.replace(/[（）()]/g, "")) + "]\n";
    if (dn === "語釈") return "\n• " + text + "\n";
    if (dn === "見出相当部") return text.replace(/━/g, "〜");
    if (dn && tag === "div") {
      // A short label line (㋐) joins the gloss after it: "• ㋐ すっかり。".
      const body = text.replace(/\n+/g, "\n").replace(/^\n/, "").replace(/\n$/, "")
        .replace(/^([^\n•[\x1f]{1,3})\n• /u, "• $1 ");
      // A 語義G holds one numbered sense (①, ②): a blank line keeps it apart from the next.
      // \x1f survives the outer divs' newline collapsing; cleanMarkup makes it a blank line.
      return (dn === "語義G" ? "\n\x1f\n" : "\n") + body + "\n";
    }
    if (tag === "rt") return "";
    // Tables (類句 lists, conjugation grids): one row per line, cells apart.
    if (tag === "summary") return "";  // a "show 5 examples" toggle; the details print in full
    // A bordered badge ("Definitions", "Examples") heads what follows it.
    const style = isPlainObject(content.style) ? content.style : {};
    if (tag === "span" && style.borderStyle && pyStrip(text) && cpLen(pyStrip(text)) <= 20) {
      return "\n■ " + pyStrip(text) + "\n";
    }
    if (tag === "table") return "\n" + text;
    if (tag === "tr") {
      // \x1e marks a header cell: "label：value" beside data, "a · b" in a header row.
      const hasData = text.includes("　");
      const row = pyStrip(rstripChars(pyStrip(text), "\x1e　")).split("\x1e").join(hasData ? "：" : " · ");
      return row.split("　").join(" · ") + "\n";
    }
    if (tag === "td" || tag === "th") return pyStrip(text) + (tag === "th" ? "\x1e" : "　");
    // A section header block (Pixiv's related-tags-header "関連記事"): a heading line.
    if (tag === "div" && isPlainObject(content.data) && Object.values(content.data).some(
      (v) => typeof v === "string" && v.endsWith("header") && v !== "nav-header")) {
      const heading = pyStrip(text).replace(new RegExp(`^[•${PY_WS}]+`, "u"), "");
      return heading ? "\n■ " + heading + "\n" : "";
    }
    if (tag === "ruby") return text;

    if (cls === "tag" && ["part-of-speech-info", "field-info", "misc-info",
      "dialect-info", "language-info"].includes(dc)) {
      return "[" + text + "] ";
    }
    if (cls === "tag" && dc === "forms-label") return "";

    if (dc === "glossary" && tag === "ul") return "\n" + text;
    if (tag === "li" && !dc) return "• " + pyStrip(text) + "\n";

    if (dc === "sense-group" && (tag === "li" || tag === "div")) return text + "\n";
    if (dc === "sense" && tag === "li") return text;

    if (dc === "sense-note-label") return text + ": ";
    if (dc === "sense-note-content") return text + "\n";
    if (dc === "sense-note" && cls === "extra-box") return "  → " + text;

    if (dc === "example-sentence-a") return text + "\n";
    if (dc === "example-sentence-b") return text + "\n";
    if (dc === "example-sentence" && cls === "extra-box") return "  " + text;
    if (dc === "example-keyword") return text;

    if (dc === "xref" && cls === "extra-box") return "";
    if (dc === "reference-label") return text + " ";

    if (dc === "forms") return "";
    if (dc === "attribution-footnote") return "";

    if (["div", "p", "blockquote", "section"].includes(tag)) {
      if (dc === "extra-info") return text;
      return pyStrip(text) ? "\n" + text + "\n" : "";
    }
    if (tag === "ol" || tag === "ul") return flattenList(content);

    return text;
  }
  return pyStr(content);
}

/* Python's str() of a JSON scalar. */
function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/* Section headings ("■ 関連記事") joined to the list under them as one labelled line, which the
 * device sets as a wrapped block: "関連記事: 高校生・…". A lone heading is a "→ " note. Pixiv's
 * category path ("⋯⋯学ぶ ＞ 学校") goes last as "分類: …": a "→ " line opening an entry would be
 * read as another headword. */
function headingsAsNotes(text) {
  const out = [];
  let path = "";
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = pyStrip(lines[i]);
    if (line.startsWith("■ ")) {
      let j = i + 1;
      while (j < lines.length && !pyStrip(lines[j])) j++;
      const nxt = j < lines.length ? pyStrip(lines[j]) : "";
      if (nxt && !nxt.startsWith("■ ") && !nxt.startsWith("• ") && !nxt.startsWith("・")) {
        out.push(line.slice(2) + ": " + nxt);
        i = j + 1;
        continue;
      }
      out.push("→ " + line.slice(2));
    } else if (line.startsWith("⋯⋯")) {
      path = pyStrip(line.slice(2));
    } else {
      out.push(lines[i]);
    }
    i++;
  }
  if (path) out.push("分類: " + path);
  return out.join("\n");
}

/* Pixiv's related-article lines list dozens of titles; keep the first twelve. */
function shortenRelated(text) {
  return text.replace(/^(・?(?:関連記事|子記事|親記事|兄弟記事): ?)(.+)$/gm, (_, head, list) => {
    const items = list.split("・");
    return head + items.slice(0, 12).join("・") + (items.length > 12 ? ` …（他${items.length - 12}件）` : "");
  });
}

const HTML_TAG_RE = /<\/?(ruby|rb|rp|span|font|b|i|u|em|strong|sup|sub|small|big|p|div|br|a)(\s[^<>]*)?\/?>/gi;
const RT_RE = /<rt>[\s\S]*?<\/rt>|<rp>[\s\S]*?<\/rp>/gi;

/* Removes markup some dictionaries leave inside their text: HTML tags (ruby keeps its base
 * text), placeholders for characters the source could not encode, and web junk lines. */
function cleanMarkup(text) {
  if (text.includes("<")) {
    text = text.replace(RT_RE, "").replace(/<br\s*\/?>/gi, "\n").replace(HTML_TAG_RE, "");
    text = text.split("<unencoded>").join("〓");
  }
  text = text.replace(/\{\{w_\p{Nd}+\}\}/gu, "〓");
  text = text.replace(/\n?\x1f\n?/g, "\n\n");
  // CC-CEDICT in Yomitan form: "【衬衫】 【襯衫】 [3304] shirt/blouse". The forms repeat the
  // headword and the rank is noise; each gloss gets its own line. A "gloss" that only lists
  // the forms again ("(襯衫,衬衫)", 漢語大詞典) is dropped.
  text = text.replace(/^[【〖]([^】〗]+)[】〗] [【〖]([^】〗]+)[】〗](?: \[\p{Nd}+\])? (.+)$/gmu, (m, a, b, g) => {
    const glosses = pyStrip(g);
    if (/^[(（][^)）a-zA-Z]*[)）]$/.test(glosses)) return "";
    return glosses.split("/").map(pyStrip).filter((x) => x).map((x) => "• " + x).join("\n");
  });
  // A heading glued to its text by a list bullet ("・違い• 「猫に小判」と…"): the text starts a line.
  text = text.replace(new RegExp(`(?<=[^${PY_WS}•])• ?`, "gu"), "\n");
  text = text.replace(/^(\[[^\]\n]*\]|→ [^\n]*)\n\n(?=• )/gm, "$1\n");  // a tag line stays on its sense
  text = text.replace(/｛([0-9０-９]+)｝/g, "（$1）");  // a source's year: 〔特殊語百科辞典｛１９３１｝〕
  text = shortenRelated(text);
  text = text.split("┏").join("");  // 研究社 marks the scope of a following [variant] with ┏
  // ► is missing from Japanese fonts (▶ is a JIS symbol); ━ stands for the headword.
  text = text.split("►").join("▶").split("━").join("〜");
  // 大辞林 opens each part of an entry with a kanji numeral and its pitch ("一[2]"). The part's
  // own tag line ([接頭]) already marks the break, and a leading "→ " would name the page.
  text = text.replace(/^[一二三四五六七八九十]{1,2}(?:\[\p{Nd}+\])?[ \t]*$/gmu, "");
  // Dingbat circled digits (❶, ➀) are missing too; ① to ⑩ are in every Japanese font.
  text = text.replace(/[❶-➓]/g, (c) => String.fromCharCode(0x2460 + (c.charCodeAt(0) - 0x2776) % 10));
  // Emoji have no glyph on the device: one leading a heading ("📚使い方") becomes ■.
  text = text.replace(new RegExp(`^[\\u{1F000}-\\u{1FAFF}]\\ufe0f?[${PY_WS}]*`, "gmu"), "■ ");
  text = text.replace(/[\u{1F000}-\u{1FAFF}]️?/gu, "");
  text = text.replace(/^.*(adsbygoogle|google\.com\/search\?).*$\n?/gm, "");
  // A line that is only a web address (scheme dropped with its link) cannot be followed.
  text = text.replace(/^[ \t]*(https?:\/\/)?[\p{L}\p{N}_-]+(\.[\p{L}\p{N}_-]+)+\/\S*[ \t]*$\n?/gmu, "");
  // Wiktionary maintenance notes ("…並移除{{rfdef}}模板。").
  text = text.replace(/[^\n。]*\{\{[\p{L}\p{N}_-]+\}\}[^\n。]*。?/gu, "");
  if (text.includes("{")) {
    // Wadoku cross-references carry an entry number: {百均（ひゃっきん）:81491}.
    text = text.replace(/\{([^{}:\n]+):\p{Nd}+\}/gu, "$1");
    // 斎藤 marks a reading in braces after the kanji: 莫連{ばくれん}.
    text = text.replace(/(?<=[㐀-鿿々])\{([ぁ-ゟー]+)\}/g, "（$1）");
  }
  return text;
}

const ECHO_RE = new RegExp(`^([\\u3041-\\u30ff・‐\\-ー\\p{Nd}０-９${PY_WS}]+)〖([^〗]+)〗(.*)$`, "u");

/* Monolingual dictionaries open with their own heading, "いぬ〖犬・狗〗", under the reading the
 * panel already shows. Drop it when it says nothing more; keep only the spellings otherwise. */
function dropHeadwordEcho(text, headword) {
  const m = /^【([^】]*)】[^\n]*\n+/.exec(text);
  if (!m) return text;
  const kana = (s) => s.replace(/[^ぁ-ヿ]/g, "");
  const reading = kana(m[1]);
  const end = m[0].length;
  const rest = text.slice(end);
  const cut = rest.indexOf("\n");
  const line = cut < 0 ? rest : rest.slice(0, cut);
  const nl = cut < 0 ? "" : "\n";
  const after = cut < 0 ? "" : rest.slice(cut + 1);
  const e = ECHO_RE.exec(pyStrip(line));
  if (!e || kana(e[1]) !== reading) return text;
  const spellings = e[2], tail = pyStrip(e[3]);
  if (spellings === headword && !tail) return text.slice(0, end) + lstripChars(after, "\n");
  return text.slice(0, end) + "〖" + spellings + "〗" + (tail ? " " + tail : "") + nl + after;
}

function formatDefinitionYomitan(headword, reading, definitions) {
  const parts = [];
  if (reading && reading !== headword) parts.push(`【${reading}】`);

  function flattenListDefn(d) {
    if (typeof d === "string") {
      if (d.startsWith("redirected from")) return "";
      return d;
    }
    if (isPlainObject(d)) return flattenStructuredContent(d);
    if (Array.isArray(d)) {
      const pieces = d.map(flattenListDefn);
      return pieces.filter((p) => p).join(" ");
    }
    return "";
  }

  // Plain-string glosses of one entry are one sense (JMdict's older Yomitan build lists
  // "friendship", "friendly relations", ... separately): one line, not a numbered list.
  // A multi-line string is a sense or paragraph of its own (MoE builds); those stay apart.
  if (Array.isArray(definitions) && definitions.length > 1
      && definitions.every((d) => typeof d === "string" && !pyStrip(d).includes("\n"))) {
    definitions = [[...new Set(definitions.slice(0, 6).map(pyStrip).filter((d) => d))].join("; ")];
  }

  if (Array.isArray(definitions)) {
    let nonEmpty = [];
    for (const defn of definitions.slice(0, 6)) {
      let text;
      if (typeof defn === "string") text = defn;
      else if (isPlainObject(defn)) text = flattenStructuredContent(defn);
      else if (Array.isArray(defn)) text = flattenListDefn(defn);
      else text = pyStr(defn);
      // The device reads a line holding 【】 as the reading and drops it, which in monolingual
      // dictionaries (あい【愛】…) deletes the definition. Only the reading line above keeps them.
      text = pyStrip(cleanMarkup(text)).replace(/【/g, "〖").replace(/】/g, "〗");
      // A line of only a symbol (the Mongolian dictionary's ◇ before its examples) is a break,
      // and the reader fonts lack most of these symbols.
      text = pyStrip(text.replace(new RegExp(`^[${PY_WS}◇◆□■○●☆★※]+$`, "gmu"), ""));
      text = headingsAsNotes(text);
      // Separators left behind by dropped web links ("|") are not a definition.
      if (WORD_RE.test(text)) nonEmpty.push(text);
    }
    const deduped = [];
    for (const t of nonEmpty) if (!deduped.includes(t)) deduped.push(t);
    nonEmpty = deduped;
    if (!nonEmpty.length) return "";  // a reading alone is no entry

    // A picture-only definition is no sense: it stays unnumbered so the reader sees its marker.
    const senses = nonEmpty.filter((t) => !t.startsWith(IMAGE_MARKER));
    let number = 0;
    for (const text of nonEmpty) {
      if (senses.length > 1 && !text.startsWith(IMAGE_MARKER)) parts.push(`\n${++number}. ${text}`);
      else parts.push(`\n${text}`);
    }
  }

  let result = parts.join("\n");
  result = result.replace(/[ \t]+/g, " ");
  result = result.replace(/\n{3,}/g, "\n\n");
  result = result.split("• • ").join("• ");
  return pyStrip(result);
}

/* If a Yomitan entry is purely a redirect, return the target headword. */
function findRedirectTarget(definitions) {
  function search(node) {
    if (isPlainObject(node)) {
      const data = node.data;
      if (isPlainObject(data) && data.content === "redirect-glossary") {
        return pyStrip(flattenStructuredContent(node).split("⟶").join(""));
      }
      return search(node.content);
    }
    if (Array.isArray(node)) {
      for (const x of node) {
        const r = search(x);
        if (r) return r;
      }
    }
    return "";
  }
  return search(definitions);
}

function yomitanPriority(score) {
  if (typeof score === "number" && !Number.isNaN(score)) {
    return Math.max(0, Math.min(255, Math.trunc(score) + 128));
  }
  return 100;
}

/* termBanks: array of parsed term_bank JSON arrays, in lexicographic
 * filename order. Returns {records, entryCount}. readingRecords=false skips the extra record
 * per reading: Chinese dictionaries carry pinyin there, which no page text ever matches. */
/* Converts Yomitan term banks one at a time: addBank() formats each entry while its bank is
 * loaded and keeps only the strings, so a bank's parsed JSON can be dropped before the next
 * is read. finish() resolves redirects, which can point into any bank, and emits records. */
function createYomitanConverter(readingRecords = true) {
  // [headword, reading, priority, definition, redirect, rules, readingDefinition]
  const allEntries = [];
  const canonicalDefs = new Map(); // headword → [definition, priority], for redirects
  return {
    addBank(entries) {
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length < 6) continue;
        const headword = entry[0];
        if (!headword || typeof headword !== "string") continue;
        let reading = entry.length > 1 ? entry[1] : "";
        // Some Pixiv builds glue the headword in front of the kana reading.
        if (typeof reading === "string" && reading !== headword && reading.startsWith(headword)
            && /^[\u3040-\u30ffー]+$/.test(reading.slice(headword.length))) {
          reading = reading.slice(headword.length);
        }
        const rules = (entry.length > 3 && typeof entry[3] === "string") ? entry[3] : "";
        const score = entry.length > 4 ? entry[4] : 0;
        const definitions = entry.length > 5 ? entry[5] : [];
        const redirect = findRedirectTarget(definitions);
        const priority = yomitanPriority(score);
        let definition = "", readingDefinition = "";
        if (!redirect) {
          definition = formatDefinitionYomitan(headword, reading, definitions);
          if (definition) {
            const prev = canonicalDefs.get(headword);
            if (prev === undefined || priority > prev[1]) canonicalDefs.set(headword, [definition, priority]);
            if (readingRecords && reading && reading !== headword) {
              readingDefinition = formatDefinitionYomitan(reading, reading, definitions);
            }
          }
        }
        allEntries.push([headword, reading, priority, definition, redirect, rules, readingDefinition]);
      }
    },

    finish(onProgress) {
      const records = [];
      let entryCount = 0;
      for (let ei = 0; ei < allEntries.length; ei++) {
        const [headword, reading, ownPriority, ownDefinition, redirect, rules, readingDefinition] = allEntries[ei];
        allEntries[ei] = null;   // its strings are no longer needed once its records exist
        let definition, priority;
        if (redirect) {
          const target = canonicalDefs.get(redirect);
          if (!target) continue; // dangling redirect
          definition = `= ${redirect}\n${target[0]}`;
          priority = target[1];
        } else {
          if (!ownDefinition) continue;
          definition = ownDefinition;
          priority = ownPriority;
        }

        const defBytes = utf8Bytes(definition);
        // Yomitan spec: empty rules = "word is not inflected" — that IS positive POS
        // data (a non-conjugating word), so stamp POS_OTHER rather than fail-open 0.
        const posFlags = rules.trim() ? posFlagsFromTags(rules.trim().split(/\s+/)) : POS_OTHER;
        const seen = new Set();
        const hwBytes = utf8Bytes(headword);
        if (hwBytes.length && hwBytes.length < HEADWORD_SIZE) {
          seen.add(headword);
          records.push({ hw: hwBytes, def: defBytes, priority, posFlags, word: headword });
        }

        if (readingDefinition) {
          const rBytes = dictEncoder.encode(reading);
          if (rBytes.length < HEADWORD_SIZE && !seen.has(reading)) {
            // reading != headword: kana reading of a kanji headword → flag it.
            records.push({ hw: rBytes, def: dictEncoder.encode(readingDefinition), priority, posFlags: posFlags | POS_READING, word: reading });
          }
        }
        entryCount++;
        if (onProgress && ei % 20000 === 0) onProgress(ei, allEntries.length);
      }
      allEntries.length = 0;
      canonicalDefs.clear();
      return { records, entryCount };
    },
  };
}

function convertYomitanRecords(termBanks, onProgress, readingRecords = true) {
  const converter = createYomitanConverter(readingRecords);
  for (const entries of termBanks) converter.addBank(entries);
  return converter.finish(onProgress);
}

/* ── Steps run over a whole input's records ───────────────────── */

const dictDecoder = new TextDecoder("utf-8");

/* Japanese Yomitan input in the vocab slot: drops a monolingual dictionary's echo of its own
 * headword and shortens Pixiv's related-article lists. */
function cleanJapaneseVocab(records) {
  return records.map((r) => {
    const text = dictDecoder.decode(r.def);
    const clean = shortenRelated(dropHeadwordEcho(text, dictDecoder.decode(r.hw)));
    return clean === text ? r : { ...r, def: dictEncoder.encode(clean) };
  });
}

/* The device reads the first 39 bytes of a title. Keep whole characters, and drop a bracket the
 * cut left open: "違いがわかる事典 (chigai.sit" becomes "違いがわかる事典". */
function shortDictTitle(title) {
  const full = pyStrip(title || "");
  let bytes = dictEncoder.encode(full).subarray(0, 39);
  // Drop a trailing UTF-8 sequence the cut left incomplete (Python's errors="ignore").
  let end = bytes.length;
  let start = end;
  while (start > 0 && (bytes[start - 1] & 0xC0) === 0x80) start--;
  if (start > 0) {
    const lead = bytes[start - 1];
    const need = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
    if (end - (start - 1) < need) end = start - 1;
  }
  let short = pyStrip(dictDecoder.decode(bytes.subarray(0, end)));
  if (short !== full) {
    for (const [open, close] of [["(", ")"], ["（", "）"], ["[", "]"], ["【", "】"]]) {
      const cut = short.lastIndexOf(open);
      if (cut > 0 && !short.slice(cut).includes(close)) short = pyStrip(short.slice(0, cut));
    }
  }
  return short;
}

/* When several inputs merge, each entry opens with a line naming its dictionary. */
function labelDictSource(records, title) {
  const label = dictEncoder.encode(SOURCE_MARKER + shortDictTitle(title) + "\n");
  return records.map((r) => {
    const def = new Uint8Array(label.length + r.def.length);
    def.set(label);
    def.set(r.def, label.length);
    return { ...r, def };
  });
}

/* ── Kanji, hanzi and hanja slot (Yomitan kanji banks) ────────── */

// Stats worth a reader's glance; KANJIDIC carries some 40 textbook index numbers besides these.
const KANJI_STATS = [["strokes", "Strokes"], ["grade", "Grade"], ["jlpt", "JLPT"], ["freq", "Freq"],
  ["総画", "総画"], ["画数", "画数"], ["部首", "部首"], ["旧字体", "旧字体"], ["漢字検定", "漢字検定"]];
// Wiktionary section rules: ＝＝＝発音＝＝＝, ーーー字源ーーー.
const KANJI_HEADING_RE = new RegExp(`^[＝=ー\\-]{2,}[${PY_WS}]*(.*?)[${PY_WS}]*[＝=ー\\-]{2,}$`, "u");

/* Lines that say nothing on the device: the character alone, a bare rule, a web address, or
 * Wiktionary's "見：附录:…" pointer to another wiki page. */
function kanjiNoise(line, character) {
  const bare = pyStrip(line);
  return bare === character || /^[＝=ー-]+$/.test(bare) || bare.startsWith("http://") || bare.startsWith("https://")
    || new RegExp(`^見[：:][${PY_WS}]*附[录錄]`, "u").test(bare);
}

function headingLevel(line) {
  return line.startsWith("■■ ") ? 2 : line.startsWith("■ ") ? 1 : 0;
}

/* A heading with no text under it before the next heading of its level or higher (Wiktionary's
 * empty 詞源1). "■■ " is a language heading, "■ " a section heading. The kept ones lose a level. */
function dropEmptyHeadings(lines) {
  const out = [];
  lines.forEach((line, i) => {
    const level = headingLevel(line);
    if (level) {
      let hasText = false;
      for (const x of lines.slice(i + 1)) {
        if (!x) continue;
        const other = headingLevel(x);
        if (other >= level) break;
        if (!other) { hasText = true; break; }
      }
      if (!hasText) return;
      if (level === 2) line = "■ " + line.slice(3);
    }
    out.push(line);
  });
  return out;
}

/* Three or more short word lines in a row (JPDB's example words) share one line: 学校、学園、大学. */
function joinWordRuns(lines) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) out.push(run.join("、"));
    else out.push(...run);
    run = [];
  };
  const breaks = new RegExp(`[${PY_WS}:：、。,（(]`, "u");
  for (const line of lines) {
    if (line && cpLen(line) <= 6 && !breaks.test(line)) run.push(line);
    else { flush(); out.push(line); }
  }
  flush();
  return out;
}

/* A short label line (Wiktionary's 衍生字, 組詞) joins the line after it: 衍生字：敩, 𢽾. */
function joinLabels(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const nxt = i + 1 < lines.length ? lines[i + 1] : "";
    if (line && !line.startsWith("■ ") && cpLen(line) <= 4 && !/[^\p{L}\p{N}_]/u.test(line) && nxt
        && !nxt.startsWith("■ ")) {
      out.push(line + "：" + nxt);
      i += 2;
      continue;
    }
    out.push(line);
    i++;
  }
  return out;
}

/* One kanji_bank entry as the device shows it: reading lines, the meanings, and a short line of
 * stats. Short glosses (KANJIDIC's "study", "learning") share one line; longer meaning lines
 * (Wiktionary, TheKanjiMap) keep theirs, and their section rules become "→ heading" lines. */
function formatKanjiEntry(onyomi, kunyomi, tags, meanings, stats, character = "") {
  const lines = [];
  // On-readings, then kun-readings with KANJIDIC's okurigana dot as parentheses (たか.い -> たか(い)),
  // space-separated so a long list wraps between readings.
  const kun = pySplit(kunyomi).map((k) => k.replace(/\.(.+)$/, "($1)"));
  const readings = [pySplit(onyomi).join(" "), kun.join(" ")].filter((r) => r);
  if (readings.length) lines.push("【" + readings.join("　") + "】");
  let items = [];
  if (meanings) {
    const list = typeof meanings === "string" ? [...meanings] : Array.isArray(meanings) ? meanings : Object.keys(meanings);
    items = list.map((m) => (typeof m === "string" ? m : flattenStructuredContent(m)));
  }
  items = items.map((m) => pyStrip(m).replace(/【/g, "〖").replace(/】/g, "〗"));
  items = items.filter((m) => !(m && kanjiNoise(m, character)));
  const shown = items.filter((m) => m);
  if (shown.length && shown.every((m) => cpLen(m) <= 30 && !m.includes("\n") && !KANJI_HEADING_RE.test(m))
      && shown.every(isAscii)) {
    lines.push("• " + shown.join("; "));
  } else {
    const body = [];
    // Empty meanings split groups whose first line names them (mozc: 旧字体, 俗字).
    const grouped = items.includes("");
    let groupStart = grouped;
    items.forEach((m, i) => {
      const heading = KANJI_HEADING_RE.exec(m);
      if (grouped && !m) { groupStart = true; return; }
      const after = i + 1 < items.length ? items[i + 1] : "";
      if (groupStart && m && cpLen(m) <= 8 && cpLen(after) > 8) {
        body.push("■ " + m);
        groupStart = false;
        return;
      }
      groupStart = false;
      if (heading) {
        // ＝ rules head a language, ー rules a section within it.
        const lead = m.replace(new RegExp(`^[${PY_WS}]+`, "u"), "");
        body.push((lead.startsWith("＝") || lead.startsWith("=") ? "■■ " : "■ ") + heading[1]);
      } else if (m && body.length && new RegExp(`[:：][${PY_WS}]*$`, "u").test(body[body.length - 1])
                 && !body[body.length - 1].startsWith("■ ")) {
        // A label line ("漢字分解:") takes the line after it.
        body[body.length - 1] = body[body.length - 1].replace(new RegExp(`[${PY_WS}]+$`, "u"), "") + " " + m;
      } else if (m) {
        body.push(m);
      }
    });
    for (const line of joinLabels(joinWordRuns(dropEmptyHeadings(body)))) {
      if (line.startsWith("■ ") && lines.length && lines[lines.length - 1].startsWith("→ ")) {
        lines[lines.length - 1] += " · " + line.slice(2);  // a language heading and its first section
        continue;
      }
      if (line.startsWith("■ ")) {
        lines.push("");
        lines.push("→ " + line.slice(2));
      } else {
        lines.push(line);
      }
    }
  }
  const extra = [];
  if (isPlainObject(stats)) {
    for (const [key, label] of KANJI_STATS) {
      const value = stats[key];
      if (value !== undefined && value !== null && value !== "") extra.push(`${label} ${pyStr(value)}`);
    }
  }
  extra.push(...pySplit(tags));
  if (extra.length) {
    lines.push("");
    lines.push(extra.join(" · "));
  }
  return pyStrip(lines.join("\n").replace(/\n{3,}/g, "\n\n"));
}

function isHan(ch) {
  const cp = ch.codePointAt(0);
  return (cp >= 0x3400 && cp <= 0x9FFF) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x20000 && cp <= 0x3FFFF);
}

/* A Yomitan kanji dictionary to one record per character, for the kanji slot. kanjiBanks are the
 * parsed kanji_bank_N.json files in name order; termBanks are used only when there are none (漢字源,
 * TISMKANJI: term banks keyed by one character). Returns {records} or {error}. */
function convertYomitanKanjiRecords(kanjiBanks, termBanks) {
  const merged = new Map();  // a character in several entries (KANJIDIC's variants) shows them together
  const add = (char, text) => {
    if (!text || !WORD_RE.test(text)) return;
    if (!merged.has(char)) merged.set(char, []);
    if (!merged.get(char).includes(text)) merged.get(char).push(text);
  };
  const str = (v) => (v ? pyStr(v) : "");
  if (!kanjiBanks.length) {
    for (const bank of termBanks) {
      for (const entry of bank) {
        if (!Array.isArray(entry) || entry.length < 6 || typeof entry[0] !== "string") continue;
        const char = entry[0];
        if (cpLen(char) !== 1 || !isHan(char)) continue;
        add(char, formatDefinitionYomitan(char, str(entry[1]), entry[5]));
      }
    }
  }
  for (const bank of kanjiBanks) {
    for (const entry of bank) {
      if (!Array.isArray(entry) || entry.length < 5 || typeof entry[0] !== "string") continue;
      const char = entry[0];
      const stats = entry.length > 5 ? entry[5] : {};
      add(char, formatKanjiEntry(str(entry[1]), str(entry[2]), str(entry[3]), entry[4], stats, char));
    }
  }
  const records = [];
  for (const [char, texts] of merged) {
    const hw = utf8Bytes(char);
    if (hw.length && hw.length < HEADWORD_SIZE) {
      records.push({ hw, def: utf8Bytes(texts.join("\n\n")), priority: 100, posFlags: POS_OTHER });
    }
  }
  return records;
}

/* ── Pitch accent (Yomitan term_meta_bank "pitch" rows) ───────── */

/* Adds one pitch dictionary's rows to pitch, a Map of "word\0reading" -> [downstep positions];
 * "word\0" also holds the word's positions over every reading. Keys already there from an
 * earlier dictionary keep their value, so a second dictionary is a fallback. banks are the
 * parsed term_meta_bank files in zip order. Returns the number of readings in this dictionary. */
function addPitchDictionary(pitch, banks) {
  const own = new Map();
  for (const bank of banks) {
    for (const row of bank) {
      if (!Array.isArray(row) || row.length < 3 || row[1] !== "pitch" || !isPlainObject(row[2])) continue;
      const reading = row[2].reading ?? "";
      const positions = (Array.isArray(row[2].pitches) ? row[2].pitches : [])
        .filter(isPlainObject).map((p) => p.position).filter((p) => Number.isInteger(p));
      if (!positions.length || typeof row[0] !== "string") continue;
      for (const key of [row[0] + "\0" + reading, row[0] + "\0"]) {
        if (!own.has(key)) own.set(key, []);
        const known = own.get(key);
        for (const p of positions) if (!known.includes(p)) known.push(p);
      }
    }
  }
  let readings = 0;
  for (const [key, value] of own) {
    if (!key.endsWith("\0")) readings++;
    if (!pitch.has(key)) pitch.set(key, value);
  }
  return readings;
}

/* Adds "｟n｠" after each entry's reading line, from the first matching pitch entry: the device
 * draws a line over the high morae. A kana-only headword (no reading line) gets one too.
 * Returns {records, count}. */
function applyPitch(records, pitch) {
  if (!pitch.size) return { records, count: 0 };
  let count = 0;
  const out = records.map((r) => {
    let text = dictDecoder.decode(r.def);
    const word = dictDecoder.decode(r.hw);
    let source = "";
    if (text.startsWith(SOURCE_MARKER)) {
      const cut = text.indexOf("\n") + 1;
      source = text.slice(0, cut);
      text = text.slice(cut);
    }
    const m = /^【([^】]*)】(｛[^｝]*｝)?/.exec(text);
    const reading = m ? m[1] : word;
    const positions = pitch.get(word + "\0" + reading) || (!m ? pitch.get(word + "\0") : null);
    if (positions) {
      const mark = "｟" + positions[0] + "｠";
      text = m ? text.slice(0, m[0].length) + mark + text.slice(m[0].length) : "【" + word + "】" + mark + "\n" + text;
      count++;
    }
    return { ...r, def: utf8Bytes(source + text) };
  });
  return { records: out, count };
}

if (typeof module !== "undefined") {
  module.exports = {
    dictWriteBinary, dictGenSpx,
    convertJmdictRecords, convertYomitanRecords, createYomitanConverter,
    formatDefinitionJmdict, formatDefinitionYomitan,
    flattenStructuredContent, findRedirectTarget,
    posFlagsFromTags, posFlagsJmdict,
    cleanMarkup, dropHeadwordEcho, shortenRelated, cleanJapaneseVocab, shortDictTitle, labelDictSource,
    formatKanjiEntry, convertYomitanKanjiRecords, addPitchDictionary, applyPitch, SOURCE_MARKER,
  };
}
