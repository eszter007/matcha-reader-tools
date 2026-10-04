/* Furigana: annotate a Japanese EPUB that ships without it. A line-faithful port of
 * matcha-reader's tools/furigana_ruby/add_furigana_ruby.py. A kanji's reading depends on the
 * word and the sentence it is in (今日 is きょう or こんにち, 行った is いった or おこなった), so
 * readings come from Gemini, sentence by sentence; there is no dictionary mode. Furigana the
 * book already has is kept, and a reading is used only when it is kana and fits the word as
 * written: 食べる read たべる puts た over 食 and leaves べる alone. Needs ruby-common.js. */
"use strict";

const FURIGANA_KANJI = /[㐀-䶿一-鿿々〆ヶ\u{20000}-\u{3134f}]/u;
const FURIGANA_HIRAGANA = /^[ぁ-ゖー]+$/u;
const MAX_KANA_PER_KANJI = 6;  // 承る is うけたまわ: five for one kanji; more than this is not a reading
const FURIGANA_AI_BATCH_CHARS = 500;  // per request
const FURIGANA_AI_PROMPT =
  "For each numbered Japanese sentence below, list every word that contains kanji, in the order "
  + "the words appear, with its reading in this context. Give each as a pair [word, reading]: the "
  + "word exactly as written in the sentence, okurigana included, and the reading of that whole "
  + "word in hiragana. Leave out words written only in kana, digits or Latin letters. Answer with "
  + "a JSON array holding one array of pairs per sentence, in the order given, and nothing else.\n\n";

function toHiragana(text) {
  return Array.from(text).map((c) => (c >= "ァ" && c <= "ヶ" ? String.fromCodePoint(c.codePointAt(0) - 0x60) : c)).join("");
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"); }

/* [[start, end, kana]] for each kanji run of word (code-point indices), or null when reading
 * does not fit it. The kana written in the word must appear in the reading where they stand:
 * 取り引き read とりひき gives と over 取 and ひ over 引. */
function alignReading(word, reading) {
  reading = toHiragana(reading.trim());
  if (!FURIGANA_HIRAGANA.test(reading)) return null;
  const chars = Array.from(word);
  const runs = [];  // [start, end] in code points
  for (let i = 0; i < chars.length;) {
    if (!FURIGANA_KANJI.test(chars[i])) { i++; continue; }
    let j = i;
    while (j < chars.length && FURIGANA_KANJI.test(chars[j])) j++;
    runs.push([i, j]);
    i = j;
  }
  if (!runs.length) return null;
  let pattern = "";
  let pos = 0;
  for (const [s, e] of runs) {
    pattern += escapeRegExp(toHiragana(chars.slice(pos, s).join(""))) + "(.+?)";
    pos = e;
  }
  pattern += escapeRegExp(toHiragana(chars.slice(pos).join("")));
  const fitted = new RegExp("^" + pattern + "$", "u").exec(reading);
  if (!fitted) return null;
  const out = [];
  for (let k = 0; k < runs.length; k++) {
    const [s, e] = runs[k];
    const kana = fitted[k + 1];
    if (Array.from(kana).length > MAX_KANA_PER_KANJI * (e - s)) return null;
    out.push([s, e, kana]);
  }
  return out;
}

/* First code-point index of needle in hay at or after from, or -1 (Python str.find). */
function findCodePoints(hay, needle, from) {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

/* Map(passage -> [[start, end, kana], ...] in order), from a model's [word, reading] pairs.
 * ask(sentences) -> Promise of one list of pairs per sentence, or null. A pair is used only
 * when its word is found in the sentence after the previous one and its reading fits. */
async function contextualFurigana(passages, ask, onBatch) {
  const sentences = new Map();  // sentence -> [[passage, start], ...]
  for (const passage of new Set(passages)) {
    for (const [start, sentence] of splitSentences(Array.from(passage))) {
      if (FURIGANA_KANJI.test(sentence)) {
        if (!sentences.has(sentence)) sentences.set(sentence, []);
        sentences.get(sentence).push([passage, start]);
      }
    }
  }
  const out = new Map();
  const groups = rubyBatches([...sentences.keys()], (t) => Array.from(t).length, FURIGANA_AI_BATCH_CHARS);
  for (let g = 0; g < groups.length; g++) {
    const batch = groups[g];
    const answer = await ask(batch);
    if (onBatch) onBatch(g + 1, groups.length, answer !== null);
    if (answer === null) continue;
    for (let b = 0; b < Math.min(batch.length, answer.length); b++) {
      const sentence = Array.from(batch[b]);
      let cursor = 0;
      const spans = [];
      for (const pair of answer[b]) {
        if (!(Array.isArray(pair) && pair.length === 2 && pair.every((x) => typeof x === "string"))) continue;
        const [word, reading] = pair;
        const at = word ? findCodePoints(sentence, Array.from(word), cursor) : -1;
        const fitted = at >= 0 ? alignReading(word, reading) : null;
        if (!fitted) continue;
        for (const [s, e, kana] of fitted) spans.push([at + s, at + e, kana]);
        cursor = at + Array.from(word).length;
      }
      for (const [passage, start] of sentences.get(batch[b])) {
        if (!out.has(passage)) out.set(passage, []);
        for (const [s, e, kana] of spans) out.get(passage).push([start + s, start + e, kana]);
      }
    }
  }
  for (const spans of out.values()) {
    spans.sort((x, y) => x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0));
  }
  return out;
}

function annotateFurigana(doc, furigana) {
  const out = [];
  for (const [piece, isText] of textPieces(doc)) {
    const text = isText ? htmlUnescape(piece) : "";
    const spans = isText ? furigana.get(text) : null;
    if (!spans || !spans.length) {
      out.push(piece);
      continue;
    }
    const chars = Array.from(text);
    const built = [];
    let pos = 0;
    for (const [start, end, kana] of spans) {
      if (start < pos) continue;  // overlaps the previous span: keep the first
      built.push(htmlEscape(chars.slice(pos, start).join(""), false));
      built.push(`<ruby>${htmlEscape(chars.slice(start, end).join(""))}<rt>${htmlEscape(kana)}</rt></ruby>`);
      pos = end;
    }
    built.push(htmlEscape(chars.slice(pos).join(""), false));
    out.push(built.join(""));
  }
  return out.join("");
}

if (typeof module !== "undefined") {
  module.exports = { FURIGANA_AI_PROMPT, toHiragana, alignReading, contextualFurigana, annotateFurigana };
}
