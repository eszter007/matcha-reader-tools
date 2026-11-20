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

// Particles whose own entry lists a full-tone reading first (着 zhāo, 得 dé), but which in running
// text, standing alone, are almost always read in the neutral tone.
const NEUTRAL_PARTICLES = {
  "了": "le5", "着": "zhe5", "著": "zhe5", "得": "de5", "的": "de5", "么": "me5", "麼": "me5",
  "们": "men5", "們": "men5", "吗": "ma5", "嗎": "ma5", "呢": "ne5", "吧": "ba5",
};

/* Map(headword -> [syllable, ...]) for both scripts; the everyday reading of a word wins over a
 * surname's or a place's (長 cháng, not Zhǎng), and among everyday readings the one with more
 * senses (東西 dōngxi "thing"). charReadings, when given (a Map), collects every
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
    const senses = m[5].split("/").length;
    for (const hw of [trad, simp]) {
      const held = words.get(hw);
      if (held === undefined || (!proper && (held.proper || senses > held.senses))) words.set(hw, { syllables, proper, senses });
    }
  }
  for (const [ch, syl] of Object.entries(NEUTRAL_PARTICLES)) {
    if (words.has(ch)) words.set(ch, { syllables: [syl] });
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
  const out = new Map();
  await askBySentence(passages, (t) => PINYIN_HAN.test(t), (t) => (t.match(PINYIN_HAN_G) || []).length,
    PINYIN_AI_BATCH_HANZI, ask, onBatch, (text, syllables, places) => {
      const sentence = Array.from(text);
      const positions = [];
      sentence.forEach((ch, i) => { if (PINYIN_HAN.test(ch)) positions.push(i); });
      if (syllables.length !== positions.length) return;
      positions.forEach((pos, k) => {
        const syl = normalizeSyllable(String(syllables[k]));
        const known = charReadings.get(sentence[pos]);
        if (known && known.has(syl)) {
          for (const [passage, start] of places) {
            if (!out.has(passage)) out.set(passage, new Map());
            out.get(passage).set(start + pos, syl);
          }
        }
      });
    });
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

function sylTone(syl) { return syl && /\d/.test(syl[syl.length - 1]) ? parseInt(syl[syl.length - 1], 10) : 5; }

const SANDHI_NUMERALS = new Set(Array.from("〇零一二三四五六七八九十百千万萬亿億两兩第"));

/* readings: one syllable or null per character of chars. 一 and 不 take the tone they are spoken
 * with before the next syllable: 4th -> 2nd for both, else 一 -> 4th. 一 keeps its 1st tone as a
 * number (第一, 十一, 一月, 一 alone or last, before another numeral) and inside a word it does not
 * begin (统一, 星期一). wordStart: true where a dictionary word begins. */
function spokenTones(chars, readings, wordStart = null) {
  const out = readings.slice();
  for (let i = 0; i < readings.length; i++) {
    const syl = readings[i];
    if (syl === null || i + 1 >= chars.length || readings[i + 1] === null) continue;
    const ch = chars[i], after = readings[i + 1];
    if (ch === "不" && syl.toLowerCase() === "bu4" && sylTone(after) === 4) {
      out[i] = "bu2";
    } else if (ch === "一" && syl.toLowerCase() === "yi1" && (wordStart === null || wordStart[i])
               && !SANDHI_NUMERALS.has(chars[i + 1]) && !"月号號日".includes(chars[i + 1])
               && (i === 0 || !SANDHI_NUMERALS.has(chars[i - 1]))) {
      out[i] = sylTone(after) === 4 ? "yi2" : "yi4";
    }
  }
  return out;
}

function rubyFor(chunk, syllables, zhuyin) {
  const chars = Array.from(chunk);
  const groups = [];  // [characters, reading]
  for (let i = 0; i < Math.min(chars.length, syllables.length); i++) {
    const syl = syllables[i].toLowerCase();  // CC-CEDICT capitalises proper nouns; ruby does not
    const reading = zhuyin ? pinyinSyllableToZhuyin(syl) : pinyinSyllableToMarks(syl);
    if (syl === "r5" && (chars[i] === "儿" || chars[i] === "兒") && groups.length && !zhuyin) {
      groups[groups.length - 1][0] += chars[i];  // erhua: 哪儿 under one nǎr
      groups[groups.length - 1][1] += "r";
      continue;
    }
    groups.push([chars[i], reading]);
  }
  return groups.map(([c, r]) => rubyMarkup(c, r)).join("");
}

// Tags that stay inside a phrase: the tone of 不 in 不<em>是</em> depends on the next word all the same.
const INLINE_TAGS = new Set(["a", "abbr", "b", "bdi", "bdo", "big", "cite", "code", "dfn", "em", "font", "i", "kbd",
  "mark", "q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "tt", "u", "var"]);
const TAG_NAME_RE = /^<\s*\/?\s*([A-Za-z][\w:.-]*)/;

function isInlineTag(piece) {
  const m = TAG_NAME_RE.exec(piece);
  return !!m && INLINE_TAGS.has(m[1].toLowerCase().split(":").pop());
}

/* Annotate one XHTML document. skip: Set of words to leave bare. contextual: the Map from
 * contextualReadings(), overriding the dictionary's reading character by character. citation
 * keeps dictionary tones (no 一/不 sandhi). Readings are decided over a phrase: text joined across
 * inline tags, up to a block tag or existing ruby. */
function annotateXhtml(doc, words, skip, zhuyin, contextual = null, citation = false) {
  const pieces = [...textPieces(doc)];
  const plans = new Map();  // piece index -> {chars, chunks, readings, starts, lengths}
  let run = [];
  const finishRun = () => {
    if (!run.length) return;
    const chars = run.flatMap((k) => plans.get(k).chars);
    let readings = run.flatMap((k) => plans.get(k).readings);
    const starts = run.flatMap((k) => plans.get(k).starts);
    const lengths = run.flatMap((k) => plans.get(k).lengths);
    // 地 standing alone after a doubled adjective is the adverb marker: 慢慢地 mànmàn de, not dì.
    for (let i = 2; i < chars.length; i++) {
      if (chars[i] === "地" && lengths[i] === 1 && chars[i - 1] === chars[i - 2] && PINYIN_HAN.test(chars[i - 1])
          && readings[i] === "di4") {
        readings[i] = "de5";
      }
    }
    if (!citation) readings = spokenTones(chars, readings, starts);
    let offset = 0;
    for (const k of run) {
      const plan = plans.get(k);
      plan.readings = readings.slice(offset, offset + plan.chars.length);
      offset += plan.chars.length;
    }
    run = [];
  };
  pieces.forEach(([piece, isText], k) => {
    if (!isText) {
      if (!isInlineTag(piece)) finishRun();
      return;
    }
    const text = htmlUnescape(piece);
    const override = (contextual && contextual.get(text)) || new Map();
    const chars = Array.from(text);
    const chunks = [...segmentForRuby(chars, words)];
    const readings = [], starts = [], lengths = [];
    for (const [chunk, syllables] of chunks) {
      const len = Array.from(chunk).length;
      for (let c = 0; c < len; c++) {
        const pos = readings.length;
        readings.push(override.has(pos) ? override.get(pos) : (syllables ? syllables[c] : null));
        starts.push(c === 0);
        lengths.push(len);
      }
    }
    plans.set(k, { chars, chunks, readings, starts, lengths });
    run.push(k);
  });
  finishRun();

  const out = [];
  pieces.forEach(([piece, isText], k) => {
    if (!isText || !PINYIN_HAN.test(plans.get(k).chars.join(""))) {
      out.push(piece);
      return;
    }
    const { chunks, readings } = plans.get(k);
    const built = [];
    let offset = 0;
    for (const [chunk] of chunks) {
      const len = Array.from(chunk).length;
      const mine = readings.slice(offset, offset + len);
      if (skip.has(chunk) || mine.some((r) => r === null)) {
        built.push(htmlEscape(chunk, false));
      } else {
        built.push(rubyFor(chunk, mine, zhuyin));
      }
      offset += len;
    }
    out.push(built.join(""));
  });
  return out.join("");
}

/* The N commonest words of a frequency list, to leave unannotated. */
function topWords(priorities, n) {
  const ranked = [...priorities.entries()].sort((a, b) => b[1] - a[1]);  // stable, like Python's sorted
  return new Set(ranked.slice(0, n).map(([w]) => w));
}

if (typeof module !== "undefined") {
  module.exports = {
    PINYIN_AI_PROMPT, normalizeSyllable, loadCedictReadings, contextualReadings, segmentForRuby, spokenTones,
    rubyFor, annotateXhtml, topWords,
  };
}
