/* What the ruby annotators share: walking an EPUB's text, and asking Gemini about it.
 * A port of matcha-reader's tools/ruby_common/ruby_epub.py. pinyin-ruby.js and
 * furigana-ruby.js both put <ruby> over a book's text in the browser, because the device
 * renders ruby but does not work readings out itself. Python indexes strings by code point;
 * every function here works on code-point arrays for the same reason. */
"use strict";

const RUBY_GEMINI_MODEL = "gemini-3.8-flash";

// Text that must not be touched: tags, existing ruby, scripts/styles, and the <head>.
const RUBY_SKIP_BLOCK = /(<(ruby|rt|rp|script|style|head|title)\b[\s\S]*?<\/\2\s*>)/i;
const RUBY_SKIP_NAMES = new Set(["ruby", "rt", "rp", "script", "style", "head", "title"]);
// A tag ends at the first ">" outside a quoted attribute value: title="甲 > 乙" is one tag.
const RUBY_TAG_OR_TEXT = /(<(?:[^>"']|"[^"]*"|'[^']*')*>)/;
const RUBY_SENTENCE_END = "。！？!?…\n";
const RUBY_SENTENCE_CLOSE = RUBY_SENTENCE_END + "」』”’）)";

/* [piece, isText] over a document, in order; only isText pieces may be annotated. */
function* textPieces(doc) {
  for (const block of doc.split(RUBY_SKIP_BLOCK)) {
    if (block === undefined || RUBY_SKIP_NAMES.has(block.toLowerCase())) continue;
    const whole = RUBY_SKIP_BLOCK.exec(block);
    if (whole && whole.index === 0 && whole[0].length === block.length) {
      yield [block, false];
      continue;
    }
    for (const piece of block.split(RUBY_TAG_OR_TEXT)) {
      yield [piece, !!piece && !piece.startsWith("<")];
    }
  }
}

/* [start, sentence] over text (a code-point array), cut after sentence punctuation (and the
 * quotes that close it), or at maxChars where a passage has none. start is a code-point index;
 * sentence is a string. */
function splitSentences(chars, maxChars = 200) {
  const out = [];
  let start = 0;
  let i = 0;
  const n = chars.length;
  while (i < n) {
    let end = i + 1;
    if (RUBY_SENTENCE_END.includes(chars[i])) {
      while (end < n && RUBY_SENTENCE_CLOSE.includes(chars[end])) end++;
    } else if (end - start < maxChars) {
      i++;
      continue;
    }
    out.push([start, chars.slice(start, end).join("")]);
    start = i = end;
  }
  if (start < n) out.push([start, chars.slice(start).join("")]);
  return out;
}

/* Consecutive groups of items whose weights sum to at most limit (one item may exceed it). */
function rubyBatches(items, weight, limit) {
  const out = [];
  let group = [];
  let size = 0;
  for (const item of items) {
    const w = weight(item);
    if (group.length && size + w > limit) {
      out.push(group);
      group = [];
      size = 0;
    }
    group.push(item);
    size += w;
  }
  if (group.length) out.push(group);
  return out;
}

function numberedPassages(passages) {
  return passages.map((p, i) => `${i + 1}. ${p}`).join("\n");
}

/* The model's JSON answer to prompt, parsed, or null after the retries. */
async function geminiJson(prompt, apiKey, model = RUBY_GEMINI_MODEL, retries = 3, onWarn = null) {
  // No temperature: Gemini 3.8 drops the sampling parameters, and a reading is checked against
  // the word anyway, so a varied answer cannot put a wrong one into the book.
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" },
  };
  for (let attempt = 0; attempt < retries; attempt++) {
    let response;
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(payload) });
      response = await resp.json();
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;  // network failure or a malformed body
    }
    if (response.error) {
      if (onWarn) onWarn(`Gemini: ${String(response.error.message || response.error.status || "").substring(0, 160)}`);
      const status = response.error.status || "";
      if (["UNAUTHENTICATED", "PERMISSION_DENIED", "INVALID_ARGUMENT", "NOT_FOUND"].includes(status)) return null;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    try {
      return JSON.parse(response.candidates[0].content.parts[0].text);
    } catch (e) {
      continue;
    }
  }
  return null;
}

/* One answer per passage, in order, or null when the model did not give exactly that. */
async function askPerPassage(passages, prompt, apiKey, model, onWarn) {
  const answer = await geminiJson(prompt + numberedPassages(passages), apiKey, model, 3, onWarn);
  if (Array.isArray(answer) && answer.length === passages.length && answer.every((a) => Array.isArray(a))) return answer;
  return null;
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

/* The text pieces of a document, unescaped: what the AI paths ask about. */
function documentPassages(doc) {
  const out = [];
  for (const [piece, isText] of textPieces(doc)) if (isText) out.push(htmlUnescape(piece));
  return out;
}

/* Copy an EPUB, passing every UTF-8 XHTML document through `await annotate(name, doc)`.
 * Returns {blob, changed}. */
async function rewriteEpub(epubBytes, annotate, onProgress) {
  const zin = new ZipReader(epubBytes);
  const zout = new ZipWriter();
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const docs = zin.entries.filter((e) => /\.(xhtml|html|htm)$/i.test(e.name)).length;
  let changed = 0;
  let done = 0;
  for (const item of zin.entries) {
    if (item.name.endsWith("/")) continue;
    let data = await zin.readEntry(item);
    if (/\.(xhtml|html|htm)$/i.test(item.name)) {
      let doc = null;
      try { doc = utf8.decode(data); } catch (e) { doc = null; }
      if (doc !== null) {
        const next = await annotate(item.name, doc);
        if (next !== doc) changed++;
        data = new TextEncoder().encode(next);
      }
      done++;
      if (onProgress) onProgress(done, docs, item.name);
    }
    zout.addFile(item.name, data);
  }
  return { blob: zout.toBlob(), changed };
}

if (typeof module !== "undefined") {
  module.exports = {
    RUBY_GEMINI_MODEL, textPieces, splitSentences, rubyBatches, numberedPassages, geminiJson, askPerPassage,
    htmlEscape, htmlUnescape, documentPassages, rewriteEpub,
  };
}
