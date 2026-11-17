/* Anki deck package (.apkg) -> flashcard deck folders for the reader.
 *
 * A browser port of tools/anki_import/apkg_to_flashcards.py in the matcha-reader repo: it reads
 * the package's collection, renders each card the way Anki does, cleans the HTML for the reader
 * and lays out the files the reader's Anki sync writes, under the card's system folder:
 *
 *   anki/<deck id>.json, <deck id>.cards.bin, <deck id>.css, and an empty anki/<deck id>/
 *   anki-cards/<deck id>/<NN>/<card id>q.xhtml, <card id>a.xhtml   (NN: card id % 64)
 *   anki-cards/<deck id>/media/   the images
 *
 * Needs sql.js (initSqlJs) and fzstd, passed in by the caller; the zip comes from zip.js.
 */
"use strict";

const ANKI_MAX_CARDS = 2000;            // as many as the reader keeps progress for (X4)
const ANKI_MAX_SIDE_BYTES = 40 * 1024;  // one side, as stored (the sync's limit)
const ANKI_MAX_CSS = 32 * 1024;
const ANKI_TOO_LARGE = 1;               // cards.bin flag: shown as "too large" on the reader
const ANKI_DRAWABLE = [".jpg", ".jpeg", ".png", ".gif", ".bmp"];
// Sides go in this many small folders: one folder of thousands of files is slow to search on the
// reader's FAT card (as ankideck::SIDE_FOLDERS).
const ANKI_SIDE_FOLDERS = 64n;

/* ------------------------------------------------------------------ package */

/* Smallest protobuf reader: the fields of one message, as {fieldNumber: [values]}. Length-delimited
 * values are Uint8Array; varints are Numbers (safe for the small values read here). */
function protoFields(bytes) {
  const out = {};
  let i = 0;
  const varint = () => {
    let v = 0, mul = 1, b;
    do {
      b = bytes[i++];
      v += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return v;
  };
  while (i < bytes.length) {
    const key = varint();
    const field = Math.floor(key / 8), wire = key & 7;
    let value;
    if (wire === 0) value = varint();
    else if (wire === 2) { const len = varint(); value = bytes.subarray(i, i + len); i += len; }
    else if (wire === 1) { value = bytes.subarray(i, i + 8); i += 8; }
    else if (wire === 5) { value = bytes.subarray(i, i + 4); i += 4; }
    else throw new Error(`Unsupported protobuf wire type ${wire}`);
    (out[field] = out[field] || []).push(value);
  }
  return out;
}

const UTF8 = new TextDecoder("utf-8");
const protoString = (fields, n) => (fields[n] ? UTF8.decode(fields[n][0]) : "");

/* Opens an .apkg: { db, media: Map(name -> zip entry name), compressedMedia }.
 * deps: { SQL (from initSqlJs), fzstd }. */
async function openApkg(bytes, deps) {
  const zip = new ZipReader(bytes);
  const has = (name) => zip.findEntry(name) !== null;
  let dbBytes, modern = false;
  if (has("collection.anki21b")) {
    dbBytes = deps.fzstd.decompress(await zip.readEntryByName("collection.anki21b"));
    modern = true;
  } else if (has("collection.anki21")) {
    dbBytes = await zip.readEntryByName("collection.anki21");
  } else if (has("collection.anki2")) {
    dbBytes = await zip.readEntryByName("collection.anki2");
  } else {
    throw new Error("Not an Anki package: no collection inside");
  }
  // Anki's own "unicase" collation is unknown to SQLite; queries on tables declaring it fail.
  // Rewriting the stored schema text leaves the data as it is.
  let db = new deps.SQL.Database(dbBytes);
  const unicase = db.exec("SELECT count() FROM sqlite_master WHERE sql LIKE '%COLLATE unicase%'")[0].values[0][0];
  if (unicase > 0) {
    db.exec("PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql=replace(sql,' COLLATE unicase','') " +
            "WHERE sql LIKE '%COLLATE unicase%'; PRAGMA writable_schema=OFF;");
    const patched = db.export();
    db.close();
    db = new deps.SQL.Database(patched);
  }

  const media = new Map();
  if (has("media")) {
    let raw = await zip.readEntryByName("media");
    if (modern) {
      // MediaEntries { repeated MediaEntry entries = 1 }, MediaEntry { name = 1; size = 2; sha1 = 3;
      // legacy_zip_filename = 255 }: the entry's file is its index in the zip unless renamed.
      raw = deps.fzstd.decompress(raw);
      (protoFields(raw)[1] || []).forEach((entry, index) => {
        const f = protoFields(entry);
        const zipName = f[255] ? String(f[255][0]) : String(index);
        media.set(protoString(f, 1), zipName);
      });
    } else {
      const map = JSON.parse(UTF8.decode(raw) || "{}");
      for (const [zipName, name] of Object.entries(map)) media.set(name, zipName);
    }
  }
  const readMedia = async (name) => {
    const zipName = media.get(name);
    if (zipName === undefined || !has(zipName)) return null;
    const data = await zip.readEntryByName(zipName);
    // The modern format compresses each file; zstd frames start with 28 B5 2F FD.
    if (modern && data.length >= 4 && data[0] === 0x28 && data[1] === 0xb5 && data[2] === 0x2f && data[3] === 0xfd) {
      return deps.fzstd.decompress(data);
    }
    return data;
  };
  return { db, readMedia, mediaNames: [...media.keys()] };
}

function rows(db, sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.get());
  stmt.free();
  return out;
}

/* Note types and decks, from either schema: { notetypes: Map(id -> {...}), decks: Map(id -> name) }.
 * Ids are kept as strings: they pass 2^53. */
function loadCollection(db) {
  const notetypes = new Map(), decks = new Map();
  const tables = new Set(rows(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r[0]));
  const modern = tables.has("notetypes") && rows(db, "SELECT count() FROM notetypes")[0][0] > 0;
  if (modern) {
    for (const [id, name, config] of rows(db, "SELECT CAST(id AS TEXT), name, config FROM notetypes")) {
      const f = protoFields(config);
      notetypes.set(id, { name, kind: f[1] ? f[1][0] : 0, css: protoString(f, 3), fields: [], templates: [] });
    }
    for (const [ntid, ord, name] of rows(db, "SELECT CAST(ntid AS TEXT), ord, name FROM fields ORDER BY ntid, ord")) {
      if (notetypes.has(ntid)) notetypes.get(ntid).fields[ord] = name;
    }
    for (const [ntid, ord, name, config] of
         rows(db, "SELECT CAST(ntid AS TEXT), ord, name, config FROM templates ORDER BY ntid, ord")) {
      const f = protoFields(config);
      if (notetypes.has(ntid)) notetypes.get(ntid).templates[ord] = { name, qfmt: protoString(f, 1), afmt: protoString(f, 2) };
    }
    for (const [id, name] of rows(db, "SELECT CAST(id AS TEXT), name FROM decks")) decks.set(id, name.split("\x1f").join("::"));
  } else {
    const [models, deckJson] = rows(db, "SELECT models, decks FROM col")[0];
    // Ids as JSON numbers lose precision past 2^53: quote them before parsing.
    const quoteIds = (text) => text.replace(/("(?:id|did|mid)"\s*:\s*)(-?\d+)/g, '$1"$2"');
    for (const [id, m] of Object.entries(JSON.parse(quoteIds(models)))) {
      const fields = [], templates = [];
      for (const fl of m.flds || []) fields[fl.ord] = fl.name;
      for (const t of m.tmpls || []) templates[t.ord] = { name: t.name, qfmt: t.qfmt || "", afmt: t.afmt || "" };
      notetypes.set(id, { name: m.name, kind: m.type || 0, css: m.css || "", fields, templates });
    }
    for (const [id, d] of Object.entries(JSON.parse(quoteIds(deckJson)))) decks.set(id, d.name);
  }
  return { notetypes, decks };
}

/* ------------------------------------------------------------------ rendering (Anki's template.rs) */

function escapeAttr(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* Anki's "is this field empty" for {{#Field}}: only whitespace, <br> and <div> tags. */
function fieldIsEmpty(text) {
  return /^(?:\s|<\/?(?:br|div)\s*\/?>)*$/i.test(text);
}

function htmlToTextLine(html) {
  return decodeEntities(html.replace(/<br\s*\/?>|<\/?div[^>]*>/gi, " ").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ").trim();
}

const FURIGANA_RE = / ?([^ >]+?)\[(.+?)\]/g;
function furigana(text, mode) {
  return text.replace(/&nbsp;/g, " ").replace(FURIGANA_RE, (m, base, reading) => {
    if (reading.startsWith("sound:")) return m;
    if (mode === "kana") return reading;
    if (mode === "kanji") return base;
    return `<ruby><rb>${base}</rb><rt>${reading}</rt></ruby>`;
  });
}

/* {{c1::text::hint}}, nested clozes included. `ord` is the card's cloze number (1-based). */
function renderCloze(text, ord, answer) {
  let out = "", i = 0;
  const parse = (stopAtClose) => {
    let buf = "";
    while (i < text.length) {
      if (text.startsWith("{{c", i)) {
        const m = /^\{\{c(\d+)::/.exec(text.slice(i, i + 12));
        if (m) {
          i += m[0].length;
          const n = Number(m[1]);
          const inner = parse(true);
          if (inner !== null) buf += clozeSpan(n, inner, ord, answer);
          continue;
        }
      }
      if (stopAtClose && text.startsWith("}}", i)) { i += 2; return buf; }
      buf += text[i++];
    }
    return stopAtClose ? null : buf;  // an unclosed cloze is left out, as Anki does
  };
  out = parse(false);
  return out;
}

function clozeSpan(n, inner, ord, answer) {
  // inner is "text" or "text::hint" (the hint after the last top-level "::").
  const split = inner.indexOf("::");
  const content = split >= 0 ? inner.slice(0, split) : inner;
  const hint = split >= 0 ? inner.slice(split + 2) : "";
  if (n !== ord) return `<span class="cloze-inactive" data-ordinal="${n}">${content}</span>`;
  if (answer) return `<span class="cloze" data-ordinal="${n}">${content}</span>`;
  return `<span class="cloze" data-cloze="${escapeAttr(content)}" data-ordinal="${n}">[${hint || "..."}]</span>`;
}

function clozeNumbers(text) {
  const out = new Set();
  for (const m of text.matchAll(/\{\{c(\d+)::/g)) out.add(Number(m[1]));
  return out;
}

function applyFilter(name, value, fieldName, ctx) {
  switch (name) {
    case "text": return htmlToTextLine(value);
    case "furigana": return furigana(value, "ruby");
    case "kana": return furigana(value, "kana");
    case "kanji": return furigana(value, "kanji");
    case "cloze": return renderCloze(value, ctx.clozeOrd, ctx.answer);
    case "cloze-only": {
      // Only the card's own clozes, their text joined.
      const parts = [];
      const re = new RegExp(`\\{\\{c${ctx.clozeOrd}::(.*?)(?:::.*?)?\\}\\}`, "g");
      for (const m of value.matchAll(re)) parts.push(m[1]);
      return parts.join(", ");
    }
    case "hint": {
      if (fieldIsEmpty(value)) return "";
      const id = `hint${ctx.hintCount++}`;
      return `\n<a class=hint href="#"\nonclick="this.style.display='none';\n` +
             `document.getElementById('${id}').style.display='block';\nreturn false;" draggable=false>\n` +
             `${fieldName}</a>\n<div id="${id}" class=hint style="display: none">${value}</div>\n`;
    }
    default:
      if (name.startsWith("tts")) return "";
      return value;  // an add-on's filter: the field as it is
  }
}

/* One side of a card. ctx: { fields: Map(name -> html), special, clozeOrd, answer, frontSide }. */
function renderTemplate(template, ctx) {
  const tokens = [];
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{{", i);
    if (open < 0) { tokens.push({ text: template.slice(i) }); break; }
    const close = template.indexOf("}}", open + 2);
    if (close < 0) { tokens.push({ text: template.slice(i) }); break; }
    if (open > i) tokens.push({ text: template.slice(i, open) });
    tokens.push({ tag: template.slice(open + 2, close).trim() });
    i = close + 2;
  }
  let pos = 0;
  const lookup = (name) => {
    if (ctx.fields.has(name)) return ctx.fields.get(name);
    if (name in ctx.special) return ctx.special[name];
    return null;
  };
  const renderUntil = (endName) => {
    let out = "";
    while (pos < tokens.length) {
      const t = tokens[pos++];
      if (t.text !== undefined) { out += t.text; continue; }
      const tag = t.tag;
      if (tag.startsWith("/")) {
        if (tag.slice(1).trim() === endName) return out;
        continue;
      }
      if (tag.startsWith("#") || tag.startsWith("^")) {
        const name = tag.slice(1).trim();
        const value = lookup(name);
        const shown = value !== null && !fieldIsEmpty(value);
        const inner = renderUntil(name);
        if (shown === tag.startsWith("#")) out += inner;
        continue;
      }
      if (tag === "FrontSide") { out += ctx.answer ? ctx.frontSide : ""; continue; }
      const parts = tag.split(":");
      const fieldName = parts.pop().trim();
      const filters = parts.map((p) => p.trim());
      if (filters.includes("type")) {
        out += `[[type:${filters.filter((f) => f !== "type").map((f) => f + ":").join("")}${fieldName}]]`;
        continue;
      }
      let value = lookup(fieldName);
      if (value === null) continue;  // unknown field
      for (let k = filters.length - 1; k >= 0; k--) value = applyFilter(filters[k], value, fieldName, ctx);
      out += value;
    }
    return out;
  };
  return renderUntil(null);
}

/* Question and answer HTML for one card, as Anki renders them (without the <style> Anki prepends). */
function renderCard(card, note, nt, deckName) {
  const template = nt.kind === 1 ? nt.templates[0] : nt.templates[card.ord];
  if (!template) return null;
  const fields = new Map();
  nt.fields.forEach((name, k) => fields.set(name, note.fields[k] || ""));
  const tags = note.tags.trim().split(/\s+/).filter(Boolean).join(" ");
  const special = {
    Tags: tags, Type: nt.name, Deck: deckName, Subdeck: deckName.split("::").pop(),
    Card: template.name, CardFlag: card.flags & 7 ? `flag${card.flags & 7}` : "",
  };
  const base = { fields, special, clozeOrd: card.ord + 1, hintCount: 0 };
  if (nt.kind === 1 && ![...fields.values()].some((v) => clozeNumbers(v).has(card.ord + 1))) {
    const notice = `<div>No cloze \u2068${card.ord + 1}\u2069 found on card.\nPlease either add a cloze deletion, or ` +
      "use the Empty Cards tool.<br><a href='https://docs.ankiweb.net/templates/errors.html#no-cloze-filter-on-" +
      "cloze-note-type'>More information</a></div>";
    return { question: notice, answer: notice };
  }
  const question = renderTemplate(template.qfmt, { ...base, answer: false });
  const answer = renderTemplate(template.afmt, { ...base, answer: true, frontSide: question });
  return { question, answer };
}

const TYPE_IN_RE = /\[\[type:([^\]]*)\]\]/g;
/* The reader has no typing box: the front leaves it out, the back shows the expected answer. */
function typeIn(html, fields, answer) {
  return html.replace(TYPE_IN_RE, (m, name) => {
    name = name.trim();
    return answer && !name.includes(":") && fields.has(name) ? `<code id="typeans">${fields.get(name)}</code>` : "";
  });
}

/* ------------------------------------------------------------------ HTML -> XHTML (lxml's behaviour) */

const VOID = new Set(["area", "base", "basefont", "br", "col", "embed", "frame", "hr", "img", "input", "isindex",
                      "keygen", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp"]);
const BOOLEAN_ATTRS = new Set(["checked", "compact", "declare", "defer", "disabled", "ismap", "multiple", "nohref",
                               "noresize", "noshade", "nowrap", "readonly", "selected"]);
// Start tags that close an open <p> (HTML's "close p" rule, as libxml2 applies it).
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "center", "dd", "details", "dialog", "dir",
                          "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2",
                          "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "main", "menu", "nav", "ol", "p",
                          "pre", "section", "table", "ul"]);
const DROP_TAGS = new Set(["script", "noscript", "audio", "video", "iframe", "object", "embed", "template", "svg",
                           "style", "canvas", "math", "button", "input", "select", "textarea", "label", "dialog"]);
const ICON_CLASSES = new Set(["material-icons", "material-icons-outlined", "material-symbols-outlined", "fa", "fas",
                              "far", "glyphicon"]);
const HIDDEN_RE = /display\s*:\s*none|visibility\s*:\s*hidden/i;

// The HTML 4 entities, as lxml's parser (libxml2) knows them.
const ENTITIES = {
  AElig: "\u00c6", Aacute: "\u00c1", Acirc: "\u00c2", Agrave: "\u00c0", Alpha: "\u0391", Aring: "\u00c5",
  Atilde: "\u00c3", Auml: "\u00c4", Beta: "\u0392", Ccedil: "\u00c7", Chi: "\u03a7", Dagger: "\u2021",
  Delta: "\u0394", ETH: "\u00d0", Eacute: "\u00c9", Ecirc: "\u00ca", Egrave: "\u00c8", Epsilon: "\u0395",
  Eta: "\u0397", Euml: "\u00cb", Gamma: "\u0393", Iacute: "\u00cd", Icirc: "\u00ce", Igrave: "\u00cc",
  Iota: "\u0399", Iuml: "\u00cf", Kappa: "\u039a", Lambda: "\u039b", Mu: "\u039c", Ntilde: "\u00d1", Nu: "\u039d",
  OElig: "\u0152", Oacute: "\u00d3", Ocirc: "\u00d4", Ograve: "\u00d2", Omega: "\u03a9", Omicron: "\u039f",
  Oslash: "\u00d8", Otilde: "\u00d5", Ouml: "\u00d6", Phi: "\u03a6", Pi: "\u03a0", Prime: "\u2033", Psi: "\u03a8",
  Rho: "\u03a1", Scaron: "\u0160", Sigma: "\u03a3", THORN: "\u00de", Tau: "\u03a4", Theta: "\u0398",
  Uacute: "\u00da", Ucirc: "\u00db", Ugrave: "\u00d9", Upsilon: "\u03a5", Uuml: "\u00dc", Xi: "\u039e",
  Yacute: "\u00dd", Yuml: "\u0178", Zeta: "\u0396", aacute: "\u00e1", acirc: "\u00e2", acute: "\u00b4",
  aelig: "\u00e6", agrave: "\u00e0", alefsym: "\u2135", alpha: "\u03b1", amp: "\u0026", and: "\u2227",
  ang: "\u2220", aring: "\u00e5", asymp: "\u2248", atilde: "\u00e3", auml: "\u00e4", bdquo: "\u201e",
  beta: "\u03b2", brvbar: "\u00a6", bull: "\u2022", cap: "\u2229", ccedil: "\u00e7", cedil: "\u00b8",
  cent: "\u00a2", chi: "\u03c7", circ: "\u02c6", clubs: "\u2663", cong: "\u2245", copy: "\u00a9", crarr: "\u21b5",
  cup: "\u222a", curren: "\u00a4", dArr: "\u21d3", dagger: "\u2020", darr: "\u2193", deg: "\u00b0",
  delta: "\u03b4", diams: "\u2666", divide: "\u00f7", eacute: "\u00e9", ecirc: "\u00ea", egrave: "\u00e8",
  empty: "\u2205", emsp: "\u2003", ensp: "\u2002", epsilon: "\u03b5", equiv: "\u2261", eta: "\u03b7",
  eth: "\u00f0", euml: "\u00eb", euro: "\u20ac", exist: "\u2203", fnof: "\u0192", forall: "\u2200",
  frac12: "\u00bd", frac14: "\u00bc", frac34: "\u00be", frasl: "\u2044", gamma: "\u03b3", ge: "\u2265",
  gt: "\u003e", hArr: "\u21d4", harr: "\u2194", hearts: "\u2665", hellip: "\u2026", iacute: "\u00ed",
  icirc: "\u00ee", iexcl: "\u00a1", igrave: "\u00ec", image: "\u2111", infin: "\u221e", int: "\u222b",
  iota: "\u03b9", iquest: "\u00bf", isin: "\u2208", iuml: "\u00ef", kappa: "\u03ba", lArr: "\u21d0",
  lambda: "\u03bb", lang: "\u2329", laquo: "\u00ab", larr: "\u2190", lceil: "\u2308", ldquo: "\u201c",
  le: "\u2264", lfloor: "\u230a", lowast: "\u2217", loz: "\u25ca", lrm: "\u200e", lsaquo: "\u2039",
  lsquo: "\u2018", lt: "\u003c", macr: "\u00af", mdash: "\u2014", micro: "\u00b5", middot: "\u00b7",
  minus: "\u2212", mu: "\u03bc", nabla: "\u2207", nbsp: "\u00a0", ndash: "\u2013", ne: "\u2260", ni: "\u220b",
  not: "\u00ac", notin: "\u2209", nsub: "\u2284", ntilde: "\u00f1", nu: "\u03bd", oacute: "\u00f3",
  ocirc: "\u00f4", oelig: "\u0153", ograve: "\u00f2", oline: "\u203e", omega: "\u03c9", omicron: "\u03bf",
  oplus: "\u2295", or: "\u2228", ordf: "\u00aa", ordm: "\u00ba", oslash: "\u00f8", otilde: "\u00f5",
  otimes: "\u2297", ouml: "\u00f6", para: "\u00b6", part: "\u2202", permil: "\u2030", perp: "\u22a5",
  phi: "\u03c6", pi: "\u03c0", piv: "\u03d6", plusmn: "\u00b1", pound: "\u00a3", prime: "\u2032", prod: "\u220f",
  prop: "\u221d", psi: "\u03c8", quot: "\u0022", rArr: "\u21d2", radic: "\u221a", rang: "\u232a", raquo: "\u00bb",
  rarr: "\u2192", rceil: "\u2309", rdquo: "\u201d", real: "\u211c", reg: "\u00ae", rfloor: "\u230b", rho: "\u03c1",
  rlm: "\u200f", rsaquo: "\u203a", rsquo: "\u2019", sbquo: "\u201a", scaron: "\u0161", sdot: "\u22c5",
  sect: "\u00a7", shy: "\u00ad", sigma: "\u03c3", sigmaf: "\u03c2", sim: "\u223c", spades: "\u2660", sub: "\u2282",
  sube: "\u2286", sum: "\u2211", sup: "\u2283", sup1: "\u00b9", sup2: "\u00b2", sup3: "\u00b3", supe: "\u2287",
  szlig: "\u00df", tau: "\u03c4", there4: "\u2234", theta: "\u03b8", thetasym: "\u03d1", thinsp: "\u2009",
  thorn: "\u00fe", tilde: "\u02dc", times: "\u00d7", trade: "\u2122", uArr: "\u21d1", uacute: "\u00fa",
  uarr: "\u2191", ucirc: "\u00fb", ugrave: "\u00f9", uml: "\u00a8", upsih: "\u03d2", upsilon: "\u03c5",
  uuml: "\u00fc", weierp: "\u2118", xi: "\u03be", yacute: "\u00fd", yen: "\u00a5", yuml: "\u00ff", zeta: "\u03b6",
  zwj: "\u200d", zwnj: "\u200c"
};

function decodeEntities(text) {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (m, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
  });
}

/* A tolerant HTML parser into a small tree: { tag, attrs: [[name, value]], children } and
 * text strings. Mirrors what lxml's HTML parser does for the markup Anki cards contain. */
function parseHtmlFragment(html) {
  const root = { tag: "div", attrs: [], children: [] };
  let current = root;
  const stack = [root];
  const open = (node) => { current.children.push(node); };
  const closeTo = (index) => { stack.length = index; current = stack[stack.length - 1]; };
  const findOpen = (name, stopAt) => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (stack[k].tag === name) return k;
      if (stopAt && stopAt.has(stack[k].tag)) return -1;
    }
    return -1;
  };
  const LIST_SCOPE = new Set(["ul", "ol", "table"]);
  let i = 0;
  const text = (t) => { if (t) open(decodeEntities(t)); };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { text(html.slice(i)); break; }
    if (lt > i) text(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {  // doctype, processing instruction
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const endTag = /^<\/([A-Za-z][A-Za-z0-9:-]*)[^>]*>/.exec(html.slice(lt, lt + 200));
    if (endTag) {
      const name = endTag[1].toLowerCase();
      const k = findOpen(name);
      if (k > 0) closeTo(k);
      i = lt + endTag[0].length;
      continue;
    }
    const startTag = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(html.slice(lt, lt + 100));
    if (!startTag) { text("<"); i = lt + 1; continue; }
    const name = startTag[1].toLowerCase();
    // Attributes up to the closing ">", honouring quotes.
    let j = lt + startTag[0].length;
    const attrs = [];
    const seen = new Set();
    let selfClosing = false;
    while (j < html.length) {
      while (j < html.length && /\s/.test(html[j])) j++;
      if (html[j] === ">") { j++; break; }
      if (html[j] === "/" && html[j + 1] === ">") { selfClosing = true; j += 2; break; }
      if (html[j] === "/") { j++; continue; }
      const an = /^[^\s/>=]+/.exec(html.slice(j));
      if (!an) { j++; continue; }
      const attrName = an[0].toLowerCase();
      j += an[0].length;
      while (j < html.length && /\s/.test(html[j])) j++;
      let value = null;
      if (html[j] === "=") {
        j++;
        while (j < html.length && /\s/.test(html[j])) j++;
        if (html[j] === '"' || html[j] === "'") {
          const q = html[j];
          const end = html.indexOf(q, j + 1);
          value = html.slice(j + 1, end < 0 ? html.length : end);
          j = end < 0 ? html.length : end + 1;
        } else {
          const v = /^[^\s>]*/.exec(html.slice(j))[0];
          value = v;
          j += v.length;
        }
        value = decodeEntities(value);
      }
      if (!seen.has(attrName)) {
        seen.add(attrName);
        attrs.push([attrName, value === null ? (BOOLEAN_ATTRS.has(attrName) ? attrName : "") : value]);
      }
    }
    i = j;
    // Implied end tags.
    if (CLOSES_P.has(name)) { const k = findOpen("p", LIST_SCOPE); if (k > 0) closeTo(k); }
    if (name === "li") { const k = findOpen("li", LIST_SCOPE); if (k > 0) closeTo(k); }
    if (name === "dt" || name === "dd") {
      const k = Math.max(findOpen("dt", new Set(["dl"])), findOpen("dd", new Set(["dl"])));
      if (k > 0) closeTo(k);
    }
    if (name === "option") { const k = findOpen("option", new Set(["select"])); if (k > 0) closeTo(k); }
    if (name === "tr") { const k = findOpen("tr", new Set(["table"])); if (k > 0) closeTo(k); }
    if (name === "td" || name === "th") {
      const k = Math.max(findOpen("td", new Set(["tr", "table"])), findOpen("th", new Set(["tr", "table"])));
      if (k > 0) closeTo(k);
    }
    const node = { tag: name, attrs, children: [] };
    open(node);
    if (VOID.has(name) || selfClosing) continue;
    if (RAW_TEXT.has(name)) {
      const end = html.toLowerCase().indexOf(`</${name}`, i);
      const body = html.slice(i, end < 0 ? html.length : end);
      if (body) node.children.push(name === "script" || name === "style" ? body : decodeEntities(body));
      const close = end < 0 ? html.length : html.indexOf(">", end);
      i = close < 0 ? html.length : close + 1;
      continue;
    }
    stack.push(node);
    current = node;
  }
  return root;
}

function attr(node, name) {
  const a = node.attrs.find((x) => x[0] === name);
  return a ? a[1] : null;
}

function isDropped(node) {
  if (DROP_TAGS.has(node.tag) || attr(node, "hidden") !== null || HIDDEN_RE.test(attr(node, "style") || "")) return true;
  const cls = attr(node, "class") || "";
  if (cls.split(/\s+/).some((c) => ICON_CLASSES.has(c)) || cls.includes("material-symbols")) return true;
  // A link with no target only runs a script (Anki's hint link, template menus).
  return node.tag === "a" && (attr(node, "href") || "#").trim() === "#" && attr(node, "onclick") !== null;
}

/* Removes dropped elements (their following text stays), event handlers and namespaced attributes;
 * WebP images are pointed at a PNG copy. */
const XML_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;

function cleanTree(node) {
  const kept = [];
  for (const child of node.children) {
    if (typeof child === "string") { kept.push(child); continue; }
    if (isDropped(child)) continue;
    if (!XML_NAME.test(child.tag)) {
      // Word's <o:p> and the like: not well-formed without a namespace; their content stays.
      cleanTree(child);
      kept.push(...child.children);
      continue;
    }
    child.attrs = child.attrs.filter(([n]) => !n.startsWith("on") && !n.includes(":") && XML_NAME.test(n));
    if (child.tag === "img") {
      const src = attr(child, "src");
      if (src && src.toLowerCase().endsWith(".webp")) child.attrs.find((a) => a[0] === "src")[1] = src + ".png";
    }
    cleanTree(child);
    kept.push(child);
  }
  node.children = kept;
}

// XML 1.0 has no place for C0 controls other than tab, newline and carriage return.
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;
const escText = (t) => t.replace(XML_INVALID, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (t) => escText(t).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;")
  .replace(/\t/g, "&#9;");

function serialize(node) {
  const attrs = node.attrs.map(([n, v]) => ` ${n}="${escAttr(v)}"`).join("");
  if (node.children.length === 0) return `<${node.tag}${attrs}/>`;
  let inner = "";
  for (const child of node.children) inner += typeof child === "string" ? escText(child) : serialize(child);
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

/* Anki's HTML as an XHTML fragment the reader's parser accepts. */
function cleanSide(html) {
  html = html.replace(/\[anki:play:[qa]:\d+\]|\[sound:[^\]]*\]/g, "");
  const root = parseHtmlFragment(html);
  cleanTree(root);
  // Adjacent text pieces print the same either way.
  const out = serialize(root);
  return out.startsWith("<div>") ? out.slice(5, -6) : out;
}

function cardDocument(fragment) {
  return '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title/>' +
         '</head><body><div class="card">' + fragment + "</div></body></html>";
}

function stylesIn(html) {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
}

/* ------------------------------------------------------------------ decks */

/* Decks with their card counts, subdecks included: [{ id, name, cards }], sorted by name. */
function listDecks(db, collection) {
  const counts = new Map();
  for (const [did, odid, n] of rows(db, "SELECT CAST(did AS TEXT), CAST(odid AS TEXT), count() FROM cards GROUP BY did, odid")) {
    const home = odid !== "0" ? odid : did;
    counts.set(home, (counts.get(home) || 0) + n);
  }
  // A package may list only the decks that hold cards; Anki makes their parents on import. Those
  // get a stable id from their name (64-bit FNV-1a), far from Anki's timestamp-sized ids.
  const known = new Set(collection.decks.values());
  for (const name of [...known]) {
    const parts = name.split("::");
    for (let k = 1; k < parts.length; k++) {
      const parent = parts.slice(0, k).join("::");
      if (known.has(parent)) continue;
      known.add(parent);
      let h = 0xcbf29ce484222325n;
      for (const b of new TextEncoder().encode(parent)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
      collection.decks.set(h.toString(), parent);
    }
  }
  const out = [];
  for (const [id, name] of collection.decks) {
    let cards = 0;
    for (const [did, n] of counts) {
      const dname = collection.decks.get(did);
      if (dname === name || (dname && dname.startsWith(name + "::"))) cards += n;
    }
    if (cards > 0) out.push({ id, name, cards });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/* The top-level decks, as the Python tool picks them without --deck. */
function defaultDecks(decks) {
  return decks.filter((d) => !d.name.includes("::"));
}

/* Files for one deck: Map(path inside the deck folder -> Uint8Array | string), plus counts.
 * convertWebp(bytes) -> Promise<Uint8Array|null> makes the grayscale PNG copy; without it WebP
 * images are left out. */
async function exportDeck(apkg, collection, deck, convertWebp, onProgress) {
  const db = apkg.db;
  const names = collection.decks;
  const inDeck = (did) => {
    const n = names.get(did);
    return n === deck.name || (n !== undefined && n.startsWith(deck.name + "::"));
  };
  const all = rows(db, "SELECT CAST(id AS TEXT), CAST(nid AS TEXT), CAST(did AS TEXT), CAST(odid AS TEXT), ord, flags FROM cards");
  let cards = all.filter((r) => inDeck(r[2]) || (r[3] !== "0" && inDeck(r[3])));
  cards.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1));
  let cut = 0;
  if (cards.length > ANKI_MAX_CARDS) { cut = cards.length - ANKI_MAX_CARDS; cards = cards.slice(0, ANKI_MAX_CARDS); }

  const cardsDir = `anki-cards/${deck.id}`;
  const noteStmt = db.prepare("SELECT CAST(id AS TEXT), CAST(mid AS TEXT), mod, tags, flds FROM notes WHERE id = ?");
  const files = new Map();
  const cssParts = [];
  const records = new Uint8Array(cards.length * 24);
  const view = new DataView(records.buffer);
  const wanted = new Set();
  let tooLarge = 0;
  const enc = new TextEncoder();
  for (let k = 0; k < cards.length; k++) {
    const [cardId, noteId, did, odid, ord, cardFlags] = cards[k];
    noteStmt.bind([noteId]);
    const found = noteStmt.step();
    const [, mid, mod = 0, tags = "", flds = ""] = found ? noteStmt.get() : [];
    noteStmt.reset();
    const nt = found ? collection.notetypes.get(mid) : null;  // a card without its note: too large
    let flags = 0;
    let sides = null;
    if (nt) {
      if (nt.css && !cssParts.includes(nt.css)) cssParts.push(nt.css);
      const note = { fields: flds.split("\x1f"), tags };
      const home = odid !== "0" ? odid : did;  // a card in a filtered deck belongs to its home deck
      const rendered = renderCard({ ord, flags: cardFlags }, note, nt, names.get(home) || deck.name);
      if (rendered) {
        const fieldMap = new Map();
        nt.fields.forEach((name, f) => fieldMap.set(name, note.fields[f] || ""));
        sides = [rendered.question, rendered.answer].map((html, side) => {
          for (const style of stylesIn(html)) if (!cssParts.includes(style)) cssParts.push(style);
          return cardDocument(cleanSide(typeIn(html, fieldMap, side === 1)));
        });
      }
    }
    if (!sides || sides.some((s) => enc.encode(s).length > ANKI_MAX_SIDE_BYTES)) {
      flags |= ANKI_TOO_LARGE;
      tooLarge++;
    } else {
      const sideDir = `${cardsDir}/${String(BigInt(cardId) % ANKI_SIDE_FOLDERS).padStart(2, "0")}`;
      files.set(`${sideDir}/${cardId}q.xhtml`, sides[0]);
      files.set(`${sideDir}/${cardId}a.xhtml`, sides[1]);
      for (const side of sides) {
        for (const m of side.matchAll(/src="([^"]+)"/g)) wanted.add(decodeEntities(m[1]));
      }
    }
    const at = k * 24;
    view.setBigUint64(at, BigInt(cardId), true);
    view.setBigUint64(at + 8, BigInt(noteId), true);
    view.setUint32(at + 16, Number(mod) >>> 0, true);
    view.setUint32(at + 20, flags, true);
    if (onProgress && k % 50 === 0) onProgress(k, cards.length, "cards");
  }
  noteStmt.free();

  let images = 0, imagesMissing = 0, seen = 0;
  for (const name of wanted) {
    if (onProgress && seen++ % 20 === 0) onProgress(seen, wanted.size, "images");
    if (name.includes("/") || name.includes("\\") || name.includes("..") || name.startsWith(".")) continue;
    const webp = name.toLowerCase().endsWith(".webp.png");
    const original = webp ? name.slice(0, -4) : name;
    if (!webp && !ANKI_DRAWABLE.some((ext) => name.toLowerCase().endsWith(ext))) continue;
    const data = await apkg.readMedia(original);
    if (!data) { imagesMissing++; continue; }
    const out = webp ? (convertWebp ? await convertWebp(data) : null) : data;
    if (!out) { imagesMissing++; continue; }
    files.set(`${cardsDir}/media/${name}`, out);
    images++;
  }
  files.set(`anki/${deck.id}.cards.bin`, records);
  files.set(`anki/${deck.id}.css`, cssParts.join("\n").slice(0, ANKI_MAX_CSS));
  files.set(`anki/${deck.id}.json`, `{"name": ${pyJsonString(deck.name)}, "lastReviewId": 0, "cardsMoved": true}`);
  // The deck's folder marks it as present: the reader forgets a deck whose folder is gone.
  files.set(`anki/${deck.id}/`, new Uint8Array(0));
  return { files, cards: cards.length, cut, tooLarge, images, imagesMissing };
}

/* json.dumps(..., ensure_ascii=False) for one string. */
function pyJsonString(s) {
  return '"' + s.replace(/[\\"\u0000-\u001f]/g, (c) => {
    const map = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
    return map[c] || "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
  }) + '"';
}

if (typeof module !== "undefined") {
  module.exports = { openApkg, loadCollection, listDecks, defaultDecks, exportDeck, renderCard, cleanSide,
                     renderCloze, furigana, fieldIsEmpty, protoFields, ANKI_MAX_CARDS };
}
