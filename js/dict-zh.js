/* Chinese and Cantonese dictionary conversion: CC-CEDICT / CC-Canto text, the MoE 重編國語辭典
 * (g0v dict-revised.json), plain TSV, plus the word lists that rank, tag and illustrate the
 * entries (jieba / HSK / TOCFL files, cccedict-canto-readings, Tatoeba sentence pairs).
 *
 * A line-faithful port of the --lang zh / --lang yue paths of matcha-reader's
 * tools/dict_convert/convert_jmdict.py: the records handed to dictWriteBinary() are the same
 * bytes the Python tool writes, and test/node/run.cjs compares them. Where Python counts
 * characters (code points), this file does too, never UTF-16 units.
 */
"use strict";

/* ── Pinyin and zhuyin ────────────────────────────────────────── */

const TONE_MARKS = {
  a: "āáǎà", e: "ēéěè", i: "īíǐì", o: "ōóǒò", u: "ūúǔù", "ü": "ǖǘǚǜ",
  A: "ĀÁǍÀ", E: "ĒÉĚÈ", I: "ĪÍǏÌ", O: "ŌÓǑÒ", U: "ŪÚǓÙ", "Ü": "ǕǗǙǛ",
};
const SYLLABLE_RE = /^([A-Za-zü:]+?)([1-5])$/;

/* 'ni3' -> 'nǐ', 'lu:4' -> 'lǜ', 'ma5' -> 'ma'. Anything else is returned unchanged. */
function pinyinSyllableToMarks(syllable) {
  const m = SYLLABLE_RE.exec(syllable);
  if (!m) return syllable;
  const base = m[1].split("u:").join("ü").split("U:").join("Ü");
  const tone = parseInt(m[2], 10);
  if (tone === 5) return base;
  const lower = base.toLowerCase();
  let idx;
  if (lower.includes("a")) idx = lower.indexOf("a");
  else if (lower.includes("e")) idx = lower.indexOf("e");
  else if (lower.includes("ou")) idx = lower.indexOf("ou");
  else {
    idx = -1;
    for (let i = 0; i < lower.length; i++) {
      if ("aeiouü".includes(lower[i])) idx = i;  // the LAST vowel takes the mark (iu -> iù, ui -> uì)
    }
    if (idx < 0) return base;  // m2, ng2, hm5: no vowel to mark
  }
  const marked = TONE_MARKS[base[idx]][tone - 1];
  return base.slice(0, idx) + marked + base.slice(idx + 1);
}

/* Space-separated numbered-tone string ('ni3 hao3') to diacritics. */
function pinyinToMarks(numbered) {
  return numbered.split(" ").map(pinyinSyllableToMarks).join(" ");
}

const ZHUYIN_INITIALS = [
  ["zh", "ㄓ"], ["ch", "ㄔ"], ["sh", "ㄕ"], ["b", "ㄅ"], ["p", "ㄆ"], ["m", "ㄇ"], ["f", "ㄈ"],
  ["d", "ㄉ"], ["t", "ㄊ"], ["n", "ㄋ"], ["l", "ㄌ"], ["g", "ㄍ"], ["k", "ㄎ"], ["h", "ㄏ"],
  ["j", "ㄐ"], ["q", "ㄑ"], ["x", "ㄒ"], ["r", "ㄖ"], ["z", "ㄗ"], ["c", "ㄘ"], ["s", "ㄙ"],
];
const ZHUYIN_FINALS = {
  a: "ㄚ", o: "ㄛ", e: "ㄜ", "ê": "ㄝ", ai: "ㄞ", ei: "ㄟ", ao: "ㄠ", ou: "ㄡ",
  an: "ㄢ", en: "ㄣ", ang: "ㄤ", eng: "ㄥ", er: "ㄦ", i: "ㄧ", ia: "ㄧㄚ",
  io: "ㄧㄛ", ie: "ㄧㄝ", iai: "ㄧㄞ", iao: "ㄧㄠ", iu: "ㄧㄡ", ian: "ㄧㄢ",
  in: "ㄧㄣ", iang: "ㄧㄤ", ing: "ㄧㄥ", iong: "ㄩㄥ", u: "ㄨ", ua: "ㄨㄚ",
  uo: "ㄨㄛ", uai: "ㄨㄞ", ui: "ㄨㄟ", uan: "ㄨㄢ", un: "ㄨㄣ", uang: "ㄨㄤ",
  ueng: "ㄨㄥ", ong: "ㄨㄥ", "ü": "ㄩ", "üe": "ㄩㄝ", "üan": "ㄩㄢ", "ün": "ㄩㄣ",
};
// Syllables written with y/w carry the medial in the spelling, not in a separate initial.
const ZHUYIN_WHOLE = {
  zhi: "ㄓ", chi: "ㄔ", shi: "ㄕ", ri: "ㄖ", zi: "ㄗ", ci: "ㄘ", si: "ㄙ",
  yi: "ㄧ", ya: "ㄧㄚ", yo: "ㄧㄛ", ye: "ㄧㄝ", yai: "ㄧㄞ", yao: "ㄧㄠ", you: "ㄧㄡ",
  yan: "ㄧㄢ", yin: "ㄧㄣ", yang: "ㄧㄤ", ying: "ㄧㄥ", yong: "ㄩㄥ",
  wu: "ㄨ", wa: "ㄨㄚ", wo: "ㄨㄛ", wai: "ㄨㄞ", wei: "ㄨㄟ", wan: "ㄨㄢ", wen: "ㄨㄣ",
  wang: "ㄨㄤ", weng: "ㄨㄥ",
  yu: "ㄩ", yue: "ㄩㄝ", yuan: "ㄩㄢ", yun: "ㄩㄣ",
  r: "ㄦ", m: "ㄇ", n: "ㄋ", ng: "ㄫ", hm: "ㄏㄇ", hng: "ㄏㄫ",
};
const ZHUYIN_TONES = { 1: "", 2: "ˊ", 3: "ˇ", 4: "ˋ" };

/* 'ni3' -> 'ㄋㄧˇ', 'lu:4' -> 'ㄌㄩˋ', 'ma5' -> '˙ㄇㄚ'. Unknown syllables come back unchanged. */
function pinyinSyllableToZhuyin(syllable) {
  const m = SYLLABLE_RE.exec(syllable);
  if (!m) return syllable;
  const base = m[1].toLowerCase().split("u:").join("ü").split("v").join("ü");
  const tone = parseInt(m[2], 10);
  let body = Object.prototype.hasOwnProperty.call(ZHUYIN_WHOLE, base) ? ZHUYIN_WHOLE[base] : undefined;
  if (body === undefined) {
    let initial = "";
    let rest = base;
    for (const [latin, bopomofo] of ZHUYIN_INITIALS) {
      if (base.startsWith(latin)) {
        initial = bopomofo;
        rest = base.slice(latin.length);
        break;
      }
    }
    // After j/q/x (and y, handled above) a written u is ü.
    if ((initial === "ㄐ" || initial === "ㄑ" || initial === "ㄒ") && rest.startsWith("u")) rest = "ü" + rest.slice(1);
    const final = Object.prototype.hasOwnProperty.call(ZHUYIN_FINALS, rest) ? ZHUYIN_FINALS[rest] : undefined;
    if (final === undefined || (!initial && rest !== base)) return syllable;
    body = initial + final;
  }
  if (tone === 5) return "˙" + body;
  return body + ZHUYIN_TONES[tone];
}

function pinyinToZhuyin(numbered) {
  return numbered.split(" ").map(pinyinSyllableToZhuyin).join(" ");
}

const BRACKETED_PINYIN_RE = /\[([A-Za-z0-9:üÜ ,]+)\]/g;
// A word given in both scripts inside a gloss: 個|个, 237號房間|237号房间, 對…|对…. Not every bar:
// only one that touches a CJK character.
const SCRIPT_PAIR_BAR_RE = /(?<=[\u3400-\u9fff\uf900-\ufaff])\||\|(?=[\u3400-\u9fff\uf900-\ufaff])/g;
const CLASSIFIER_RE = /(?<![\p{L}\p{N}_])CL:(?=\S)/gu;

/* CEDICT glosses carry their own markup for cross-references: both scripts joined by a bar and
 * numbered pinyin in brackets (CL:個|个[ge4], see 你好[ni3 hao3]). Written out for a reader:
 * "CL: 個/个 (gè)", "see 你好 (nǐ hǎo)". */
function prettifyCedictGloss(gloss) {
  gloss = gloss.replace(BRACKETED_PINYIN_RE, (_, inner) => " (" + pinyinToMarks(inner) + ")");
  gloss = gloss.replace(SCRIPT_PAIR_BAR_RE, "/");
  return gloss.replace(CLASSIFIER_RE, "CL: ");
}

/* ── Frequency ranking ────────────────────────────────────────── */

const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u{20000}-\u{3134f}]/u;
// A graded list's level: 1-9, or a band such as 7-9.
const LEVEL_RE = /^[1-9](?:-[1-9])?$/;
const UNRANKED_PRIORITY = 60;  // entries absent from the frequency list
const POS_OTHER_ZH = 0x20;     // DictIndexRecord::POS_OTHER, the flag every Chinese record carries
const ZH_HEADWORD_SIZE = 32;   // HEADWORD_SIZE in dict.js, which may not be loaded first

const zhEncoder = new TextEncoder();
const zhDecoder = new TextDecoder("utf-8");

function codePoints(s) { return Array.from(s); }
function cpLength(s) { return codePoints(s).length; }

/* Python's str.strip(): whitespace, which JS trim() also takes as Unicode White_Space. */
function pyStrip(s) { return s.trim(); }
function stripQuotes(s) { return s.replace(/^"+/, "").replace(/"+$/, ""); }
/* Python float(): the number formats a count column can hold. */
function pyFloat(s) {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return null;
  return parseFloat(s);
}
/* Python's text-mode line iteration: universal newlines, no trailing empty line. */
function textLines(text) {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/* The Han words in one list cell: HSK and TOCFL write variants as 爸爸|爸 and 你/妳. */
function splitVariants(cell) {
  return cell.split(/[/|｜、]/).filter((w) => HAN_RE.test(w));
}

/* 1 -> 255, 10 -> 227, 1000 -> 171, 100000 -> 115: log-scaled so the common words spread. */
function rankToPriority(rank) {
  return Math.max(UNRANKED_PRIORITY + 1, Math.min(255, 255 - Math.round(28 * Math.log10(rank))));
}

/* Read a word list into Map(word -> priority). Accepts jieba dict.txt ("word count pos"),
 * BCC/SUBTLEX exports ("word<TAB>count"), and graded lists such as HSK or TOCFL CSVs where the
 * order of the rows IS the ranking. kind: "auto" ranks by count when most rows carry one, else
 * by row order; "count" / "rank" force either. Returns {priorities, rankedBy}. */
function loadFrequency(text, kind = "auto") {
  const rows = [];
  let graded = false;  // a level band (7-9) seen: the numbers in this file are levels, not counts
  for (let line of textLines(text)) {
    line = pyStrip(line).replace(/^\ufeff+/, "");
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/[\t,]|\s+/).filter((x) => pyStrip(x)).map((x) => stripQuotes(pyStrip(x)));
    const wordAt = fields.findIndex((x) => HAN_RE.test(x));
    if (wordAt < 0) continue;
    let count = null;
    for (const x of fields.slice(wordAt + 1)) {
      if (/^[1-9]-[1-9]$/.test(x)) {
        graded = true;  // HSK's 7-9 band: this column is a level, not a count
        break;
      }
      const f = pyFloat(x);  // a plain small number may still be a count (jieba: 說 3)
      if (f !== null) {
        count = f;
        break;
      }
    }
    // 你/妳, 爸爸|爸: every variant in the cell is the same word.
    for (const word of splitVariants(fields[wordAt])) rows.push({ word, count });
  }
  if (!rows.length) return { priorities: new Map(), rankedBy: "nothing" };
  const withCount = rows.filter((r) => r.count !== null).length;
  // A graded list's level column is numeric too (HSK 1-9, TOCFL 1-7), but it is not a count:
  // auto treats small numbers as levels and keeps the file's own order.
  let largest = 0;
  for (const r of rows) if (r.count !== null && r.count > largest) largest = r.count;
  const useCount = kind === "count" || (kind === "auto" && !graded && withCount >= 0.8 * rows.length && largest > 100);
  if (useCount) rows.sort((a, b) => (b.count || 0) - (a.count || 0));  // stable, like Python's
  const priorities = new Map();
  rows.forEach((r, i) => {
    const p = rankToPriority(i + 1);
    if (p > (priorities.get(r.word) || 0)) priorities.set(r.word, p);
  });
  return { priorities, rankedBy: useCount ? "count" : "row order" };
}

/* Replace each record's priority with its frequency rank, taken from either script's form of
 * the word (twins, from CC-CEDICT): the lists are written in one script, and the device
 * segments a traditional book with the traditional records. */
function applyFrequency(records, priorities, twins) {
  if (!priorities || !priorities.size) return records;
  twins = twins || new Map();
  return records.map((r) => {
    const word = r.word !== undefined ? r.word : zhDecoder.decode(r.hw);
    // The larger of the two forms' ranks: jieba's list is simplified but carries a few stray
    // traditional characters with tiny counts (說 3, 這 7), which must not outrank 说 and 这.
    const p = Math.max(priorities.get(word) || 0, priorities.get(twins.get(word) || "") || 0) || UNRANKED_PRIORITY;
    return { ...r, priority: p };
  });
}

/* ── CC-CEDICT (.u8 / .txt) ───────────────────────────────────── */

// CC-CEDICT, and CC-Canto's extension of it with a {jyutping} field after the pinyin.
const CEDICT_LINE_RE = /^(\S+)\s+(\S+)\s+\[([^\]]*)\](?:\s+\{([^}]*)\})?\s+\/(.*)\/\s*$/;
// cccedict-canto-readings: "繁 简 [pin1 yin1] {jyut6 ping3}" with no glosses.
const CANTO_READING_RE = /^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\{([^}]*)\}/;

function formatDefinitionCedict(trad, simp, pinyin, glosses, zhuyin, jyutping = "", level = "", examples = null) {
  let reading = pinyinToMarks(pinyin);
  if (zhuyin) reading += " " + pinyinToZhuyin(pinyin);
  if (jyutping) reading += " · " + jyutping;
  // The device's entry renderer speaks Jitendex's layout: "• gloss" bullets, one sense per
  // blank-line-separated group, "→ note" lines, and any other line an example sentence. An
  // entry without bullets is taken for a names dictionary and gets every line numbered.
  const parts = ["【" + reading + "】"];
  if (level) parts.push(`[${level}]`);  // a tag line: the device shows it on the entry's grammar line
  if (trad !== simp) parts.push(`→ ${trad} / ${simp}`);
  const shown = glosses.filter((g) => g).map(prettifyCedictGloss).slice(0, 12);
  for (const g of shown) parts.push(`• ${g}\n`);
  // Example sentences, each with its translation on the next line.
  for (const [sentence, translation] of (examples || [])) {
    parts.push(sentence);
    if (translation) parts.push(translation);
  }
  return parts.join("\n");
}

/* ── Example sentences (Tatoeba) ──────────────────────────────── */

const EXAMPLES_PER_ENTRY = 2;
const EXAMPLE_MAX_CHARS = 40;

// The commonest characters that exist in only one script, in matching pairs (mirrors the
// firmware's content sniff). Tatoeba mixes both; a simplified pack should show simplified
// sentences, and the other way round.
const SIMPLIFIED_ONLY = new Set(codePoints("这说们个么时国来对会发为还没过样开学现后点见问东门车书长几应两认让经关实话听从头尔业爱图电机体试写读马鸟龙叶万与"));
const TRADITIONAL_ONLY = new Set(codePoints("這說們個麼時國來對會發為還沒過樣開學現後點見問東門車書長幾應兩認讓經關實話聽從頭爾業愛圖電機體試寫讀馬鳥龍葉萬與"));

/* 'simplified', 'traditional', or 'any' when nothing in the sentence tells them apart. */
function sentenceScript(sentence) {
  let simp = 0, trad = 0;
  for (const ch of sentence) {
    if (SIMPLIFIED_ONLY.has(ch)) simp++;
    if (TRADITIONAL_ONLY.has(ch)) trad++;
  }
  if (simp > trad) return "simplified";
  if (trad > simp) return "traditional";
  return "any";
}

const UNRENDERABLE_EXAMPLE_RE = /Tatoeba|JMdict|JMnedict|【|^\d+\. /;

/* Tatoeba 'sentence pairs' export (id, sentence, id, translation) or a plain two-column
 * sentence<TAB>translation file. Returns [[sentence, translation]] with long sentences dropped.
 * script keeps only sentences written in that script (or in neither distinguishably). */
function loadSentencePairs(text, script = "any") {
  const pairs = [];
  for (const line of textLines(text)) {
    const fields = line.split("\t");
    let sentence, translation;
    if (fields.length >= 4) { sentence = pyStrip(fields[1]); translation = pyStrip(fields[3]); }
    else if (fields.length >= 2) { sentence = pyStrip(fields[0]); translation = pyStrip(fields[1]); }
    else continue;
    if (!sentence || cpLength(sentence) > EXAMPLE_MAX_CHARS || !HAN_RE.test(sentence)) continue;
    if (script !== "any") {
      const s = sentenceScript(sentence);
      if (s !== "any" && s !== script) continue;
    }
    // The device's entry renderer treats a line that mentions a source, holds a 【, or starts
    // like "3. " as chrome or a sense number, so such a pair would come out mangled.
    if (UNRENDERABLE_EXAMPLE_RE.test(sentence) || UNRENDERABLE_EXAMPLE_RE.test(translation)) continue;
    pairs.push([sentence, translation]);
  }
  pairs.sort((a, b) => cpLength(a[0]) - cpLength(b[0]));  // shortest first, so the cap keeps the clearest ones
  return pairs;
}

/* Segment every sentence against the dictionary's headwords (longest match, like the device
 * does) and hand it to the entries of the words it contains, up to EXAMPLES_PER_ENTRY each.
 * forms maps each headword form to its entry index. Single-character words get none. */
function attachExamples(pairs, forms, entryCount) {
  const examples = [];
  for (let i = 0; i < entryCount; i++) examples.push([]);
  if (!pairs.length || !forms.size) return examples;
  let maxLen = 0;
  for (const w of forms.keys()) maxLen = Math.max(maxLen, cpLength(w));
  for (const [sentence, translation] of pairs) {
    const chars = codePoints(sentence);
    const n = chars.length;
    const seen = new Set();
    let i = 0;
    while (i < n) {
      let matched = 0;
      for (let length = Math.min(maxLen, n - i); length > 1; length--) {
        const idx = forms.get(chars.slice(i, i + length).join(""));
        if (idx !== undefined) {
          matched = length;
          if (!seen.has(idx) && examples[idx].length < EXAMPLES_PER_ENTRY) {
            examples[idx].push([sentence, translation]);
            seen.add(idx);
          }
          break;
        }
      }
      i += matched || 1;
    }
  }
  return examples;
}

// Capitalised in CC-CEDICT but everyday vocabulary, not names: languages, nationalities, days,
// festivals, religions and institutions a learner meets in any text.
// Python's \b and \w are Unicode-aware; JS's are ASCII-only, so they are spelled out here
// (Cristóbal must not end in "ist").
const ZH_WORD_CHAR = "[\\p{L}\\p{N}_]";
const COMMON_NOUN_GLOSS_RE = new RegExp(
  `(?<!${ZH_WORD_CHAR})(language|people|person|ethnic|nationality|citizen|day|${ZH_WORD_CHAR}+day|week|month|festival|holiday|new year|`
  + "religion|church|bible|god|party|army|navy|games|cup|era|calendar|zodiac|internet|christianity|"
  + "january|february|march|april|may|june|july|august|september|october|november|december|"
  + "american|british|chinese|japanese|korean|english|french|german|russian|spanish|italian|indian|"
  + `asian|european|african|western)(?!${ZH_WORD_CHAR})|ism(?!${ZH_WORD_CHAR})|ist(?!${ZH_WORD_CHAR})`, "iu");

function isAlpha(ch) { return /\p{L}/u.test(ch); }
function isUpper(ch) { return ch !== ch.toLowerCase() && ch === ch.toUpperCase(); }

/* CC-CEDICT capitalises the pinyin of proper nouns (Zhong1 guo2, Bei3 jing1). Entries whose
 * glosses read like common nouns (汉语, 中国人, 星期天, 春节) stay in the vocabulary. */
function isProperNounPinyin(pinyin, glosses = null) {
  const syllables = pinyin.split(" ").filter((p) => p && isAlpha(p[0]));
  if (!syllables.length || !isUpper(syllables[0][0])) return false;
  // "People's Republic of China" in a place's gloss is not the common noun "people".
  const first = (glosses && glosses.length ? glosses[0] : "").replace(/people['\u2019]s/gi, "");
  return !COMMON_NOUN_GLOSS_RE.test(first);
}

/* Split an entry's "/gloss/gloss/" body into glosses. A slash inside parentheses belongs to the
 * gloss: CC-Canto writes "(phrase / adverb / noun) no, not." as one. */
function splitCedictGlosses(body) {
  const glosses = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    if (ch === "/" && depth === 0) {
      glosses.push(pyStrip(current));
      current = "";
    } else {
      current += ch;
    }
  }
  glosses.push(pyStrip(current));
  return glosses;
}

function cantoKey(trad, simp, pinyin) { return `${trad}\t${simp}\t${pinyin}`; }

/* Map((trad, simp, pinyin) -> jyutping) from a cccedict-canto-readings file. */
function loadCantoReadings(text) {
  const out = new Map();
  for (const line of textLines(text)) {
    if (!line || line.startsWith("#")) continue;
    const m = CANTO_READING_RE.exec(line);
    if (m) out.set(cantoKey(m[1], m[2], m[3]), pyStrip(m[4]));
  }
  return out;
}

/* Convert a raw CC-CEDICT (or CC-Canto) file to index records, one per traditional and
 * simplified form. Returns {records, names, entryCount, skipped, examplesDropped,
 * examplesAttached}; names is empty unless splitNames routes proper nouns into the names slot.
 * twins (a Map), when given, is filled with each form's other-script form for applyFrequency. */
function convertCedict(text, opts = {}) {
  const zhuyin = !!opts.zhuyin;
  const splitNames = !!opts.splitNames;
  const levels = opts.levels || new Map();
  const jyutping = opts.jyutping || new Map();
  let sentencePairs = opts.sentencePairs || null;
  const twins = opts.twins || null;
  const examplesScript = opts.examplesScript || "any";

  const parsed = [];  // {trad, simp, pinyin, canto, glosses}
  const forms = new Map();
  let skipped = 0;
  for (const line of textLines(text)) {
    if (!line || line.startsWith("#")) continue;
    const m = CEDICT_LINE_RE.exec(line);
    if (!m) { skipped++; continue; }
    const [, trad, simp, pinyin, canto, body] = m;
    const idx = parsed.length;
    const glosses = splitCedictGlosses(body);
    parsed.push({ trad, simp, pinyin, canto: canto || "", glosses });
    // Examples go to the everyday entry of a form: 周 the week over the surname, and among
    // lowercase readings the one with more senses (東西 "thing" over "east and west").
    const proper = isProperNounPinyin(pinyin, glosses);
    for (const form of [trad, simp]) {
      const held = forms.get(form);
      if (held === undefined) { forms.set(form, idx); continue; }
      const heldProper = isProperNounPinyin(parsed[held].pinyin, parsed[held].glosses);
      if (!proper && (heldProper || glosses.length > parsed[held].glosses.length)) forms.set(form, idx);
    }
    if (twins && trad !== simp) {
      if (!twins.has(trad)) twins.set(trad, simp);
      if (!twins.has(simp)) twins.set(simp, trad);
    }
  }
  let examplesDropped = 0;
  if (sentencePairs && sentencePairs.length && (examplesScript === "simplified" || examplesScript === "traditional")) {
    // The characters CC-CEDICT itself uses in only one script decide a sentence's script far
    // more reliably than the short list the firmware's book sniff uses: a 10-character
    // sentence often holds none of those, and a fifth of Tatoeba is the other script.
    const tradChars = new Set(), simpChars = new Set();
    for (const e of parsed) {
      if (e.trad === e.simp) continue;
      for (const ch of e.trad) tradChars.add(ch);
      for (const ch of e.simp) simpChars.add(ch);
    }
    const foreign = new Set();
    const [from, minus] = examplesScript === "simplified" ? [tradChars, simpChars] : [simpChars, tradChars];
    for (const ch of from) if (!minus.has(ch)) foreign.add(ch);
    const before = sentencePairs.length;
    sentencePairs = sentencePairs.filter((pair) => !codePoints(pair[0]).some((ch) => foreign.has(ch)));
    examplesDropped = before - sentencePairs.length;
  }
  const examples = sentencePairs && sentencePairs.length ? attachExamples(sentencePairs, forms, parsed.length) : null;

  const records = [];
  const names = [];
  parsed.forEach((e, idx) => {
    const level = levels.get(e.simp) || levels.get(e.trad) || "";
    const readingCanto = e.canto || jyutping.get(cantoKey(e.trad, e.simp, e.pinyin)) || "";
    const definition = formatDefinitionCedict(e.trad, e.simp, e.pinyin, e.glosses, zhuyin, readingCanto, level,
                                              examples ? examples[idx] : null);
    const def = zhEncoder.encode(definition);
    const target = splitNames && isProperNounPinyin(e.pinyin, e.glosses) ? names : records;
    const hws = e.trad === e.simp ? [e.trad] : [e.trad, e.simp];  // both forms, once each
    for (const hw of hws) {
      const hwBytes = zhEncoder.encode(hw);
      if (hwBytes.length >= ZH_HEADWORD_SIZE) { skipped++; continue; }
      target.push({ hw: hwBytes, def, priority: 100, posFlags: POS_OTHER_ZH, word: hw });
    }
  });
  const examplesAttached = examples ? examples.filter((e) => e.length).length : 0;
  return { records, names, entryCount: parsed.length, skipped, examplesDropped, examplesAttached };
}

/* ── Level lists (HSK, TOCFL, TBCL) ───────────────────────────── */

/* Map(word -> "HSK 3") from a graded CSV/TSV: every Han field in a row is a form of the word,
 * and the level is the first field after it that is a small number or a band such as "7-9". */
function loadLevels(text, name) {
  const out = new Map();
  for (let line of textLines(text)) {
    line = pyStrip(line).replace(/^\ufeff+/, "");
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/[\t,]/).map((x) => stripQuotes(pyStrip(x)));
    const words = [];
    for (const x of fields) for (const w of splitVariants(x)) words.push(w);
    if (!words.length) continue;
    // Columns before the word hold ids (a bare row number would read as a level).
    const firstWord = fields.findIndex((x) => HAN_RE.test(x));
    let level = fields.slice(firstWord + 1).find((x) => LEVEL_RE.test(x));
    if (level === undefined) {
      // The ivankra CSVs carry the level in the row id: L3-0123 (HSK), L0-1001 (TOCFL, where
      // L0 is the pre-A1 novice band).
      const m = fields.length ? /^L(\d)-\d+/.exec(fields[0]) : null;
      if (m) level = m[1];
    }
    if (level === undefined) continue;
    // TOCFL's band 0 is the pre-A1 "Novice" list; a zero would read like a mistake.
    if (level === "0") level = "Novice";
    for (const w of words) if (!out.has(w)) out.set(w, `${name} ${level}`);
  }
  return out;
}

/* ── Plain TSV (pattern <TAB> definition) ─────────────────────── */

/* Headword<TAB>definition per line, for grammar patterns or name lists from any source. A
 * definition may use \n for a line break; further tab-separated fields are appended as lines. */
function convertTsv(text) {
  const records = [];
  let skipped = 0;
  for (const line of textLines(text)) {
    if (!line || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length < 2 || !pyStrip(fields[0])) { skipped++; continue; }
    const hw = pyStrip(fields[0]);
    const hwBytes = zhEncoder.encode(hw);
    if (hwBytes.length >= ZH_HEADWORD_SIZE) { skipped++; continue; }
    const definition = fields.slice(1).filter((x) => pyStrip(x)).map((x) => pyStrip(x).split("\\n").join("\n")).join("\n");
    records.push({ hw: hwBytes, def: zhEncoder.encode(definition), priority: 100, posFlags: POS_OTHER_ZH, word: hw });
  }
  return { records, skipped };
}

/* ── MoE 重編國語辭典 (g0v moedict JSON) ──────────────────────── */

/* Strip HTML tags and decode common entities to plain text (convert_jmdict.py strip_html). */
function stripHtml(html) {
  let text = html.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.split("&amp;").join("&");
  text = text.split("&lt;").join("<");
  text = text.split("&gt;").join(">");
  text = text.split("&quot;").join('"');
  text = text.split("&nbsp;").join(" ");
  text = text.split("&#x27;").join("'");
  text = text.split("&#39;").join("'");
  return text.split("\n").map(pyStrip).filter((l) => l).join("\n");
}

// {[8e4f]} text references and raw Plane-15 private-use codepoints: glyphs no font carries.
const MOE_GLYPH_REF_RE = /\{\[[0-9a-fA-F]+\]\}|[\u{F0000}-\u{FFFFD}]/gu;

function moeText(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(moeText).join(" ");
  const text = stripHtml(String(value));
  return pyStrip(text.replace(MOE_GLYPH_REF_RE, "□"));
}

/* One definition text per heteronym (reading): the device shows one 【reading】 per record, so
 * 好 hǎo and 好 hào become two records rather than one whose second reading would vanish. */
function formatDefinitionsMoedict(entry) {
  const out = [];
  for (const heteronym of (entry.heteronyms || []).slice(0, 3)) {
    const parts = [];
    // Pinyin first, then zhuyin: the order a CC-CEDICT entry built with zhuyin uses.
    const reading = [moeText(heteronym.pinyin), moeText(heteronym.bopomofo)].filter((x) => x).join(" ");
    if (reading) parts.push("【" + reading + "】");
    for (const d of (heteronym.definitions || []).slice(0, 6)) {
      // One bullet per sense (the device numbers them), the part of speech inside it.
      let line = "• ";
      const kind = moeText(d.type);
      if (kind) line += `[${kind}] `;
      line += moeText(d.def) + "\n";
      parts.push(line);
      // One modern example per sense; the classical quotations are left out.
      for (const example of (d.example || []).slice(0, 1)) parts.push(moeText(example));
    }
    const text = parts.filter((p) => pyStrip(p)).join("\n");
    if (text.includes("•")) out.push(text);
  }
  return out;
}

/* Convert the parsed g0v dict-revised.json (an array of entries) to index records. */
function convertMoedict(data) {
  const records = [];
  let skipped = 0;
  for (const entry of data) {
    const title = moeText(entry.title !== undefined ? entry.title : "");
    // Only headwords the page scan can match: a run of hanzi. Phrases with punctuation
    // (一不做，二不休) and missing glyphs are skipped.
    if (!title || !codePoints(title).every((ch) => HAN_RE.test(ch) || ch === "〇")) { skipped++; continue; }
    const definitions = formatDefinitionsMoedict(entry);
    const hwBytes = zhEncoder.encode(title);
    if (!definitions.length || hwBytes.length >= ZH_HEADWORD_SIZE) { skipped++; continue; }
    // Below CC-CEDICT's default so a merged file shows the bilingual entry first.
    for (const definition of definitions) {
      records.push({ hw: hwBytes, def: zhEncoder.encode(definition), priority: 90, posFlags: POS_OTHER_ZH, word: title });
    }
  }
  return { records, skipped };
}

/* ── Format detection and titles ──────────────────────────────── */

/* Input format from the file name (and, for Chinese, its language): convert_jmdict.py detect_format. */
function detectDictFormat(fileName, lang = "ja") {
  const lower = fileName.toLowerCase().split("/").pop();
  if (lower.endsWith(".mdx")) return "mdict";
  if (lower.endsWith(".zip")) return "yomitan";
  if (lower.endsWith(".u8") || lower.endsWith(".u8.gz") || lower.includes("cedict") || lower.includes("canto")) return "cedict";
  if (lower.endsWith(".tsv")) return "tsv";
  if ((lang === "zh" || lang === "yue") && (lower.endsWith(".json") || lower.endsWith(".json.xz"))) return "moedict";
  if (lower.endsWith(".json") || lower.endsWith(".json.tgz") || lower.endsWith(".tgz")) return "jmdict";
  if (lang === "zh" || lang === "yue") return "cedict";
  return "jmdict";
}

// Latin only: the panel footer is set in the 8 pt UI font, and the CJK cuts start at 12 pt, so a
// title with hanzi in it is drawn half as large again as every other footer.
const DEFAULT_DICT_TITLES = { cedict: "CC-CEDICT", moedict: "MoE", jmdict: "", tsv: "" };

/* A byte-for-byte string key for a record's headword. */
function headwordKey(hw) {
  let s = "";
  for (let i = 0; i < hw.length; i++) s += String.fromCharCode(hw[i]);
  return s;
}

/* With proper nouns split off, CC-CEDICT's 中國 "China" goes to the names slot while the
 * monolingual entry for 中國 from a second dictionary stays in the vocabulary -- and the device
 * asks the vocabulary first, so the reader would get the Chinese definition and never the
 * English one. A headword CC-CEDICT holds only as a name takes its other entries along to the
 * names slot. bilingualHeadwords: Set of headwordKey()s CC-CEDICT left in the vocabulary.
 * Returns {records, names}. */
function keepNamesTogether(records, nameRecords, bilingualHeadwords) {
  const nameHeadwords = new Set(nameRecords.map((r) => headwordKey(r.hw)));
  const kept = [];
  const moved = nameRecords.slice();
  for (const record of records) {
    const key = headwordKey(record.hw);
    if (nameHeadwords.has(key) && !bilingualHeadwords.has(key)) moved.push(record);
    else kept.push(record);
  }
  return { records: kept, names: moved };
}

/* The footer title the Chinese converter settles on: the inputs' titles joined, or the first
 * when the join would not fit the device's 36-byte field. */
function joinDictTitles(titles) {
  const unique = [];
  for (const t of titles) if (t && !unique.includes(t)) unique.push(t);
  if (!unique.length) return "";
  const joined = unique.join(" + ");
  return zhEncoder.encode(joined).length <= 36 ? joined : unique[0];
}

/* The bytes of <name>.title: the title cut to 36 bytes on a character boundary, plus a newline.
 * Null when there is nothing to write (convert_jmdict.py write_binary). */
function encodeDictTitle(title) {
  let bytes = zhEncoder.encode(pyStrip(title || "")).subarray(0, 36);
  // Drop a trailing UTF-8 sequence the cut left incomplete (Python's errors="ignore").
  let end = bytes.length;
  let start = end;
  while (start > 0 && (bytes[start - 1] & 0xC0) === 0x80) start--;
  if (start > 0) {
    const lead = bytes[start - 1];
    const need = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
    if (end - (start - 1) < need) end = start - 1;
  }
  const text = pyStrip(zhDecoder.decode(bytes.subarray(0, end)));
  if (!text) return null;
  return zhEncoder.encode(text + "\n");
}

if (typeof module !== "undefined") {
  module.exports = {
    pinyinSyllableToMarks, pinyinToMarks, pinyinSyllableToZhuyin, pinyinToZhuyin, prettifyCedictGloss,
    HAN_RE, UNRANKED_PRIORITY, splitVariants, rankToPriority, loadFrequency, applyFrequency,
    CEDICT_LINE_RE, formatDefinitionCedict, sentenceScript, loadSentencePairs, attachExamples,
    isProperNounPinyin, loadCantoReadings, convertCedict, loadLevels, convertTsv,
    stripHtml, moeText, formatDefinitionsMoedict, convertMoedict, splitCedictGlosses,
    detectDictFormat, DEFAULT_DICT_TITLES, joinDictTitles, encodeDictTitle, headwordKey, keepNamesTogether,
  };
}
