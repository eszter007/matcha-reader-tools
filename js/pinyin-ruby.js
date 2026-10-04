/* Pinyin ruby: annotate a Chinese EPUB so the reader shows pinyin (or zhuyin) above the text.
 * A line-faithful port of matcha-reader's tools/pinyin_ruby/add_pinyin_ruby.py: every run of
 * hanzi is segmented against CC-CEDICT by longest match and each character gets its syllable as
 * <rt>. With AI, each passage is read in context by Gemini to pick the reading of a character
 * that has several (石 shí or dàn); a reading the model gives is used only when CC-CEDICT lists
 * it for that character. Needs dict-zh.js and ruby-common.js. */
"use strict";

const PINYIN_HAN = /[㐀-䶿一-鿿\u{20000}-\u{3134f}]/u;
const PINYIN_HAN_G = /[㐀-䶿一-鿿\u{20000}-\u{3134f}]/gu;
const PINYIN_MAX_WORD = 8;
const PINYIN_AI_BATCH_HANZI = 600;  // per request
const PINYIN_AI_PROMPT =
  "For each numbered passage of Chinese below, give the Hanyu Pinyin of every Chinese character "
  + "as it is read in this context, in order. Write each syllable with a tone number 1-5 after it "
  + "(5 for the neutral tone) and u: for ü, for example ni3 hao3, lu:4. One syllable per Chinese "
  + "character; skip punctuation, digits and Latin letters. Answer with a JSON array holding one "
  + "array of syllables per passage, in the order given, and nothing else.\n\n";

/* One spelling per reading: lowercase, ü as "u:" (CC-CEDICT's), neutral tone as 5. */
function normalizeSyllable(syl) {
  syl = syl.trim().toLowerCase().split("ü").join("u:").split("v").join("u:");
  if (syl && !/\d/.test(syl[syl.length - 1])) syl += "5";
  return syl;
}

/* Map(headword -> [syllable, ...]) for both scripts; the everyday reading of a word wins over a
 * surname's or a place's (長 cháng, not Zhǎng). charReadings, when given (a Map), collects every
 * reading CC-CEDICT has for each character, in any word: char -> Set("shi2", "dan4"). It is what
 * a model's answer is checked against. */
function loadCedictReadings(text, charReadings = null) {
  const words = new Map();  // headword -> {syllables, proper}
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.startsWith("#")) continue;
    const m = CEDICT_LINE_RE.exec(line);
    if (!m) continue;
    const [, trad, simp, pinyin] = m;
    const syllables = pinyin.split(" ").filter((p) => p);
    if (syllables.length !== Array.from(trad).length) continue;  // 儿化 and odd entries: one syllable per character is what ruby needs
    const proper = isProperNounPinyin(pinyin);
    if (charReadings) {
      for (const hw of [trad, simp]) {
        const chars = Array.from(hw);
        for (let k = 0; k < Math.min(chars.length, syllables.length); k++) {
          if (!charReadings.has(chars[k])) charReadings.set(chars[k], new Set());
          charReadings.get(chars[k]).add(normalizeSyllable(syllables[k]));
        }
      }
    }
    for (const hw of [trad, simp]) {
      const held = words.get(hw);
      if (held === undefined || (!proper && held.proper)) words.set(hw, { syllables, proper });
    }
  }
  const out = new Map();
  for (const [hw, held] of words) out.set(hw, held.syllables);
  return out;
}

/* Map(passage -> Map(index of a hanzi in it -> syllable)) for the readings a model gave AND the
 * dictionary knows for that character. ask(sentences) -> Promise of a list of syllable lists, or
 * null. A sentence whose answer has the wrong number of syllables is dropped whole: once the
 * count is off there is no telling which syllable belongs to which character. */
async function contextualReadings(passages, charReadings, ask, onBatch) {
  const sentences = new Map();  // sentence -> [[passage, start], ...]
  for (const passage of new Set(passages)) {
    for (const [start, sentence] of splitSentences(Array.from(passage))) {
      if (PINYIN_HAN.test(sentence)) {
        if (!sentences.has(sentence)) sentences.set(sentence, []);
        sentences.get(sentence).push([passage, start]);
      }
    }
  }
  const out = new Map();
  const groups = rubyBatches([...sentences.keys()], (t) => (t.match(PINYIN_HAN_G) || []).length, PINYIN_AI_BATCH_HANZI);
  for (let g = 0; g < groups.length; g++) {
    const batch = groups[g];
    const answer = await ask(batch);
    if (onBatch) onBatch(g + 1, groups.length, answer !== null);
    if (answer === null) continue;
    for (let b = 0; b < Math.min(batch.length, answer.length); b++) {
      const sentence = Array.from(batch[b]);
      const syllables = answer[b];
      const positions = [];
      sentence.forEach((ch, i) => { if (PINYIN_HAN.test(ch)) positions.push(i); });
      if (syllables.length !== positions.length) continue;
      positions.forEach((pos, k) => {
        const syl = normalizeSyllable(String(syllables[k]));
        const known = charReadings.get(sentence[pos]);
        if (known && known.has(syl)) {
          for (const [passage, start] of sentences.get(batch[b])) {
            if (!out.has(passage)) out.set(passage, new Map());
            out.get(passage).set(start + pos, syl);
          }
        }
      });
    }
  }
  return out;
}

/* [chunk, syllables or null] over text (a code-point array), longest dictionary match first. */
function* segmentForRuby(chars, words) {
  const n = chars.length;
  let i = 0;
  while (i < n) {
    if (!PINYIN_HAN.test(chars[i])) {
      let j = i;
      while (j < n && !PINYIN_HAN.test(chars[j])) j++;
      yield [chars.slice(i, j).join(""), null];
      i = j;
      continue;
    }
    let best = 0;
    for (let length = Math.min(PINYIN_MAX_WORD, n - i); length > 0; length--) {
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

/* Annotate one XHTML document. skip: Set of words to leave bare. contextual: the Map from
 * contextualReadings(), overriding the dictionary's reading character by character. */
function annotateXhtml(doc, words, skip, zhuyin, contextual = null) {
  const out = [];
  for (const [piece, isText] of textPieces(doc)) {
    if (!isText) {
      out.push(piece);
      continue;
    }
    const text = htmlUnescape(piece);
    if (!PINYIN_HAN.test(text)) {
      out.push(piece);
      continue;
    }
    const override = (contextual && contextual.get(text)) || new Map();
    const built = [];
    let offset = 0;
    for (const [chunk, syllables] of segmentForRuby(Array.from(text), words)) {
      const len = Array.from(chunk).length;
      let overridden = false;
      for (let k = 0; k < len; k++) if (override.has(offset + k)) { overridden = true; break; }
      if (skip.has(chunk) || (syllables === null && !overridden)) {
        built.push(htmlEscape(chunk, false));
      } else if (syllables === null) {
        // A character the dictionary has no word for here, which the model read.
        built.push(rubyFor(chunk, [override.get(offset)], zhuyin));
      } else {
        built.push(rubyFor(chunk, syllables.map((syl, k) => (override.has(offset + k) ? override.get(offset + k) : syl)), zhuyin));
      }
      offset += len;
    }
    out.push(built.join(""));
  }
  return out.join("");
}

/* The N commonest words of a frequency list, to leave unannotated. */
function topWords(priorities, n) {
  const ranked = [...priorities.entries()].sort((a, b) => b[1] - a[1]);  // stable, like Python's sorted
  return new Set(ranked.slice(0, n).map(([w]) => w));
}

if (typeof module !== "undefined") {
  module.exports = {
    PINYIN_AI_PROMPT, normalizeSyllable, loadCedictReadings, contextualReadings, segmentForRuby, rubyFor,
    annotateXhtml, topWords,
  };
}
