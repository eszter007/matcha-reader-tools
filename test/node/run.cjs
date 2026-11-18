#!/usr/bin/env node
/* Byte-compares the JS converters' output against reference files produced
 * by the matcha-reader firmware's Python tools (see ../gen_references.py). */
"use strict";

const fs = require("fs");
const path = require("path");

const FIXTURES = path.join(__dirname, "..", "fixtures");

// The site's scripts are classic <script> files sharing globals; recreate
// that environment for Node.
const binary = require("../../js/binary.js");
global.ByteWriter = binary.ByteWriter;
global.compareBytes = binary.compareBytes;
global.bytesEqual = binary.bytesEqual;
const zip = require("../../js/zip.js");
const dict = require("../../js/dict.js");
const zh = require("../../js/dict-zh.js");
// pinyin-ruby.js uses dict-zh.js's globals the way the page does.
global.CEDICT_LINE_RE = zh.CEDICT_LINE_RE;
global.isProperNounPinyin = zh.isProperNounPinyin;
global.pinyinSyllableToMarks = zh.pinyinSyllableToMarks;
global.pinyinSyllableToZhuyin = zh.pinyinSyllableToZhuyin;
global.ZipReader = zip.ZipReader;
global.ZipWriter = zip.ZipWriter;
const rubyCommon = require("../../js/ruby-common.js");
Object.assign(global, rubyCommon);
const ruby = require("../../js/pinyin-ruby.js");
const furigana = require("../../js/furigana-ruby.js");
const manga = require("../../js/manga-core.js");
const ppocr = require("../../js/ppocr.js");
const epub = require("../../js/manga-epub.js");

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
    failures++;
  }
}

function compareFile(name, actual, refPath) {
  const ref = new Uint8Array(fs.readFileSync(refPath));
  if (ref.length !== actual.length) {
    check(name, false, `size ${actual.length} != reference ${ref.length}`);
    return;
  }
  for (let i = 0; i < ref.length; i++) {
    if (ref[i] !== actual[i]) {
      check(name, false, `first difference at byte ${i} (0x${actual[i].toString(16)} != 0x${ref[i].toString(16)})`);
      return;
    }
  }
  check(name, true);
}

/* ── Manga: v3 line boxes (convert_manga.py:block_lines_from_ocr + encode_page) ── */

function testMangaLineBoxes() {
  console.log("manga v3 line boxes:");
  const L = manga.blockLinesFromOcr;
  // A vertical speech bubble from a real Gemini response (the Animal Crossing test cover), panel
  // origin (0,0), panel 920x1380: two columns, right to left.
  const bubble = {
    text: "重要なのは\n実用性だね。", vertical: true,
    lines: [
      { text: "重要なのは", bbox_2d: [38, 856, 196, 912] },
      { text: "実用性だね。", bbox_2d: [37, 781, 200, 840] },
    ],
  };
  const r = L(bubble, 0, 0, 920, 1380);
  check("vertical flag from the model", r.vertical === true);
  check("text rebuilt from the lines", r.text === "重要なのは\n実用性だね。");
  check("line boxes in page pixels", JSON.stringify(r.lines) === JSON.stringify([[787, 52, 839, 270], [718, 51, 772, 276]]),
        JSON.stringify(r.lines));
  check("offset by the margin-crop origin",
        JSON.stringify(L(bubble, 10, 20, 920, 1380).lines[0]) === JSON.stringify([797, 72, 849, 290]));

  // A partial set would put later lines on the wrong text segment: all or nothing.
  const partial = { text: "a\nb", lines: [{ text: "a", bbox_2d: [0, 0, 10, 10] }, { text: "b" }] };
  check("line without a box drops them all", L(partial, 0, 0, 100, 100).lines.length === 0);
  check("empty line text drops them all",
        L({ lines: [{ text: " ", bbox_2d: [0, 0, 10, 10] }] }, 0, 0, 100, 100).lines.length === 0);
  check("inverted box drops them all",
        L({ lines: [{ text: "x", bbox_2d: [10, 0, 5, 10] }] }, 0, 0, 100, 100).lines.length === 0);
  check("no lines keeps the block text", L({ text: "x" }, 0, 0, 100, 100).text === null);

  // No flag from the model: the shape of the lines decides, as in Python.
  const tall = { lines: [{ text: "縦", bbox_2d: [0, 0, 500, 50] }] };
  const wide = { lines: [{ text: "横", bbox_2d: [0, 0, 50, 500] }] };
  check("tall lines infer vertical", L(tall, 0, 0, 100, 100).vertical === true);
  check("wide lines infer horizontal", L(wide, 0, 0, 100, 100).vertical === false);

  // Encoder: block size (not its second corner), the line record, and the panel crop rect.
  const page = manga.encodePage([{
    box: [0, 0, 920, 1380], crop: [0, 0, 920, 1380], translation: "",
    textBlocks: [{ box: [718, 51, 841, 280], text: r.text, lines: r.lines, vertical: true }],
  }]);
  const dv = new DataView(page.buffer, page.byteOffset, page.byteLength);
  // panelCount u8 + pad u8, panel box 12, translation 0, crop 8 -> block at 22.
  check("crop rect after the panel header", dv.getUint16(14, true) === 0 && dv.getUint16(18, true) === 920);
  check("block stores width and height", dv.getUint16(26, true) === 123 && dv.getUint16(28, true) === 229,
        `${dv.getUint16(26, true)}x${dv.getUint16(28, true)}`);
  const textLen = dv.getUint16(30, true);
  const lineHdr = 32 + textLen;
  check("line count and vertical flag", page[lineHdr] === 2 && page[lineHdr + 1] === 1);
  check("first line as x, y, w, h", dv.getUint16(lineHdr + 2, true) === 787 && dv.getUint16(lineHdr + 6, true) === 52);
  check("record ends after its lines", page.length === lineHdr + 2 + 2 * 8, `${page.length} vs ${lineHdr + 18}`);
}

/* ── Manga: grid detection + binary output vs convert_manga.py ── */

function testManga() {
  console.log("manga converter (vs convert_manga.py --no-ocr):");
  const pagesDir = path.join(FIXTURES, "manga_pages");
  const refDir = path.join(FIXTURES, "ref_manga");
  const dims = JSON.parse(fs.readFileSync(path.join(pagesDir, "dims.json"), "utf-8"));

  const names = manga.naturalSortPaths(Object.keys(dims));
  const idxRecords = [];
  const datChunks = [];
  let datOffset = 0;

  for (const name of names) {
    const [w, h] = dims[name];
    const gray = new Uint8Array(fs.readFileSync(path.join(pagesDir, name.replace(".png", ".gray"))));
    let boxes = manga.detectPanelsGrid(gray, w, h);
    boxes = manga.sortPanelsReadingOrder(boxes);
    // v3 stores each panel's crop rect: the panel plus convert_manga.py's default 10px margin,
    // clamped to the page -- the same rect the converter crops and OCRs.
    const panelsWithText = boxes.map((box) => ({
      box,
      crop: [Math.max(0, box[0] - 10), Math.max(0, box[1] - 10), Math.min(w, box[2] + 10), Math.min(h, box[3] + 10)],
      textBlocks: [],
      translation: "",
    }));
    const pageData = manga.encodePage(panelsWithText);
    idxRecords.push({ offset: datOffset, length: pageData.length, w: Math.min(w, 0xffff), h: Math.min(h, 0xffff) });
    datChunks.push(pageData);
    datOffset += pageData.length;
  }

  compareFile("panels.idx", manga.writePanelsIdx(idxRecords), path.join(refDir, "panels.idx"));
  const dat = new Uint8Array(datOffset);
  let off = 0;
  for (const c of datChunks) { dat.set(c, off); off += c.length; }
  compareFile("panels.dat", dat, path.join(refDir, "panels.dat"));
  compareFile("meta.bin", manga.writeMetaBin("Test Manga", "Test Author"), path.join(refDir, "meta.bin"));

  // meta.bin's optional language trailer. The EPUB fixture declares
  // <dc:language>ja</dc:language>, so convert_manga.py's reference for it carries the
  // trailer while the reference above (no declared language) must not -- the two
  // comparisons together pin both halves of the format.
  const epubRefMeta = path.join(FIXTURES, "ref_manga_epub", "meta.bin");
  if (fs.existsSync(epubRefMeta)) {
    compareFile("meta.bin language trailer",
      manga.writeMetaBin("Epub Test Manga", "Epub Author", "ja"), epubRefMeta);
  } else {
    console.log("  skip (no ref_manga_epub fixture — rerun gen_references.py)");
  }

  // Language normalisation, mirroring convert_manga.py:normalize_language.
  const langCases = [["jp", "ja"], ["JP", "ja"], ["cn", "zh"], ["kr", "ko"], ["ja", "ja"],
                     ["ja-JP", "ja-JP"], ["ja_JP", "ja-JP"], ["zh-Hant", "zh-Hant"], ["", ""]];
  for (const [input, want] of langCases) {
    const got = manga.normalizeLanguage(input);
    check(`normalizeLanguage(${JSON.stringify(input)}) == ${JSON.stringify(want)}`, got === want, `got ${JSON.stringify(got)}`);
  }
  check("no language writes no trailer",
    manga.writeMetaBin("T", "A", "").length === 8 + 1 + 1);

  // The reference run should have produced renamed page copies too.
  for (let i = 0; i < names.length; i++) {
    const pageName = `page_${String(i).padStart(4, "0")}.png`;
    check(`reference has ${pageName}`, fs.existsSync(path.join(refDir, pageName)));
  }

  // Reading-order sort: one tall right panel beside two stacked left panels
  // (the mixed-size layout simple row-clustering gets wrong). The tall right
  // panel reads first, then top-left, then bottom-left.
  const tall = [420, 40, 760, 1160], topLeft = [40, 40, 380, 580], bottomLeft = [40, 640, 380, 1160];
  const order = manga.sortPanelsReadingOrder([bottomLeft, tall, topLeft]);
  check("reading order tall-right first", order[0] === tall && order[1] === topLeft && order[2] === bottomLeft);
  // Plain 2x2 grid reads right-to-left, top-to-bottom.
  const tl = [0, 0, 100, 100], tr = [110, 0, 210, 100], bl = [0, 110, 100, 210], br = [110, 110, 210, 210];
  const grid = manga.sortPanelsReadingOrder([tl, tr, bl, br]);
  check("2x2 grid order", grid[0] === tr && grid[1] === tl && grid[2] === br && grid[3] === bl);
}

/* ── Manga: book type — reading order, trim, webtoon ──────────── */

/* A webtoon row profile from [artHeight, gutterHeight] pairs. */
function webtoonStrip(blocks) {
  const rows = [];
  for (const [art, gutter] of blocks) {
    for (let i = 0; i < art; i++) rows.push(false);
    for (let i = 0; i < gutter; i++) rows.push(true);
  }
  return rows;
}

function testMangaBookType() {
  console.log("\n== manga book type ==");

  // Left-to-right (western) order on a plain 2x2 grid is the mirror of manga order.
  const tl = [0, 0, 100, 100], tr = [110, 0, 210, 100], bl = [0, 110, 100, 210], br = [110, 110, 210, 210];
  const ltr = manga.sortPanelsReadingOrder([br, tl, bl, tr], false);
  check("2x2 grid LTR order", ltr[0] === tl && ltr[1] === tr && ltr[2] === bl && ltr[3] === br);
  // Tiers still run top-to-bottom in both conventions.
  const tall = [420, 40, 760, 1160], topLeft = [40, 40, 380, 580], bottomLeft = [40, 640, 380, 1160];
  const ltrMixed = manga.sortPanelsReadingOrder([bottomLeft, tall, topLeft], false);
  check("LTR tall-right last", ltrMixed[0] === topLeft && ltrMixed[1] === bottomLeft && ltrMixed[2] === tall);

  // Yonkoma: two columns of four, read down the right column then down the left.
  {
    const named = {};
    for (let col = 0; col < 2; col++) {
      for (let row = 0; row < 4; row++) {
        named[`c${col}r${row}`] = [col * 450 + 60, row * 330 + 60, col * 450 + 420, row * 330 + 300];
      }
    }
    const byBox = new Map(Object.entries(named).map(([n, b]) => [b.join(), n]));
    const names = (boxes) => boxes.map((b) => byBox.get(b.join()));
    const panels = Object.values(named).reverse();
    check("4-koma reads down the right column, then the left",
      names(manga.sortPanelsReadingOrder(panels, true, true)).join() ===
      "c1r0,c1r1,c1r2,c1r3,c0r0,c0r1,c0r2,c0r3");
    check("4-koma LTR reads the columns the other way, still downwards",
      names(manga.sortPanelsReadingOrder(panels, false, true)).join() ===
      "c0r0,c0r1,c0r2,c0r3,c1r0,c1r1,c1r2,c1r3");
    // Pins the default: the same page row-major interleaves the two strips.
    check("without the flag the same page interleaves the strips",
      names(manga.sortPanelsReadingOrder(panels, true, false)).join() ===
      "c1r0,c0r0,c1r1,c0r1,c1r2,c0r2,c1r3,c0r3");
  }

  // A 4-koma title page: a full-height illustration beside a strip of four. The
  // illustration is a column of its own and reads last.
  {
    const art = [30, 90, 500, 1500];
    const strip = [[520, 90, 1000, 430], [520, 440, 1000, 780], [520, 790, 1000, 1140], [520, 1150, 1000, 1500]];
    const out = manga.sortPanelsReadingOrder([art, strip[2], strip[0], strip[3], strip[1]], true, true);
    check("4-koma title page: strip first, full-height art last",
      out[0] === strip[0] && out[1] === strip[1] && out[2] === strip[2] && out[3] === strip[3] && out[4] === art);
  }

  // Margin trim: a 200x200 page with a 40px white border around a dark block.
  {
    const w = 200, h = 200;
    const gray = new Uint8Array(w * h).fill(255);
    for (let y = 40; y < 160; y++) for (let x = 40; x < 160; x++) gray[y * w + x] = 10;
    const box = manga.trimMarginsBox(gray, w, h);
    check("trim finds the artwork box", box && box[0] === 38 && box[1] === 38 && box[2] === 162 && box[3] === 162,
      JSON.stringify(box));
    check("trim returns null on a blank page", manga.trimMarginsBox(new Uint8Array(w * h).fill(255), w, h) === null);
    const full = new Uint8Array(w * h).fill(10);
    check("trim returns null when there is no margin", manga.trimMarginsBox(full, w, h) === null);
  }

  // Webtoon cuts: panels a bit shorter than a screen should all break in a gutter.
  {
    const rows = webtoonStrip(Array.from({ length: 8 }, () => [700, 40]));
    const cuts = manga.webtoonCutPoints(rows, 800);
    check("webtoon cuts land in gutters", cuts.slice(1, -1).every((c) => rows[c]));
  }
  // Art taller than the screen has no gutter to find, but the page must still fit.
  {
    const cuts = manga.webtoonCutPoints(webtoonStrip([[5000, 30], [900, 30]]), 800);
    const heights = cuts.slice(1).map((c, i) => c - cuts[i]);
    check("webtoon page never exceeds the screen", Math.max(...heights) <= 800, String(Math.max(...heights)));
  }
  // Every row is covered exactly once, in order.
  {
    const rows = webtoonStrip([[613, 25], [1500, 40], [222, 60], [990, 15]]);
    const cuts = manga.webtoonCutPoints(rows, 800);
    check("webtoon covers the whole strip", cuts[0] === 0 && cuts[cuts.length - 1] === rows.length);
    check("webtoon cuts strictly increase", cuts.every((c, i) => i === 0 || c > cuts[i - 1]));
  }
  // Two gutters in reach: taking the earlier one would waste half a screen.
  // Gutters at 400-419 and 750-769; their midpoints are 410 and 760.
  {
    const cuts = manga.webtoonCutPoints(webtoonStrip([[400, 20], [330, 20], [900, 0]]), 800);
    check("webtoon prefers the latest usable gutter", cuts[1] === 760, String(cuts[1]));
  }
  {
    check("webtoon short strip is one page",
      JSON.stringify(manga.webtoonCutPoints(webtoonStrip([[300, 0]]), 800)) === "[0,300]");
  }

  // Webtoon panels: the art blocks between the gutters, top to bottom.
  {
    const w = 40, h = 300;
    const gray = new Uint8Array(w * h).fill(255);
    const paint = (y1, y2) => { for (let y = y1; y < y2; y++) for (let x = 0; x < w; x++) gray[y * w + x] = 10; };
    paint(0, 100); paint(140, 300);
    const boxes = manga.detectWebtoonPanels(gray, w, h);
    check("webtoon panels split at the gutter", boxes.length === 2, JSON.stringify(boxes));
    check("webtoon panels span the full width and stack",
      boxes[0][0] === 0 && boxes[0][2] === w && boxes[0][1] === 0 && boxes[0][3] === 100 &&
      boxes[1][1] === 140 && boxes[1][3] === 300, JSON.stringify(boxes));
    const blank = manga.detectWebtoonPanels(new Uint8Array(w * h).fill(255), w, h);
    check("blank webtoon page is one whole-page panel",
      blank.length === 1 && blank[0][3] === h, JSON.stringify(blank));
  }
}

/* ── Manga: dither brightness (issue #9) ──────────────────────── */

function testMangaDither() {
  console.log("\n== manga dither brightness ==");
  const ramp = new Uint8Array([0, 32, 64, 96, 128, 160, 192, 224, 255]);

  // Normal must be a true no-op, or the default output stops matching the Python tool.
  check("normal returns the same buffer", manga.applyGrayGamma(ramp, "normal") === ramp);
  check("unknown name falls back to normal", manga.applyGrayGamma(ramp, "nonsense") === ramp);
  check("gamma 1 is normal", manga.validDitherGamma(1) === 1 && manga.validDitherGamma("normal") === 1);
  check("a bad gamma is rejected, not applied",
    manga.validDitherGamma(0) === 1 && manga.validDitherGamma(-2) === 1 && manga.validDitherGamma(NaN) === 1);

  // Endpoints stay pinned: line art keeps its blacks and paper stays paper.
  for (const name of ["lightest", "lighter", "darker"]) {
    const out = manga.applyGrayGamma(ramp, name);
    check(`${name} pins 0 and 255`, out[0] === 0 && out[out.length - 1] === 255, `${out[0]}..${out[out.length-1]}`);
    check(`${name} is monotonic`, out.every((v, i) => i === 0 || v >= out[i - 1]), [...out].join(","));
  }

  // Direction: lighter raises midtones, darker lowers them.
  const mid = 4;  // the 128 entry
  const lightest = manga.applyGrayGamma(ramp, "lightest");
  const lighter = manga.applyGrayGamma(ramp, "lighter");
  const darker = manga.applyGrayGamma(ramp, "darker");
  check("lightest > lighter > normal > darker at the midpoint",
    lightest[mid] > lighter[mid] && lighter[mid] > ramp[mid] && ramp[mid] > darker[mid],
    `${lightest[mid]} ${lighter[mid]} ${ramp[mid]} ${darker[mid]}`);

  // End to end: a mid-grey field dithers to less black when lightened. A flat 120 sits just
  // under the 128 threshold, which is exactly the case issue #9 describes.
  const W = 64, H = 64;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i*4] = rgba[i*4+1] = rgba[i*4+2] = 120; rgba[i*4+3] = 255; }
  const blackCount = (name) => {
    const gray = manga.applyGrayGamma(manga.grayFromRGBA(rgba, W, H), name);
    return manga.floydSteinbergMono(gray, W, H).reduce((n, v) => n + (v ? 0 : 1), 0);
  };
  const nb = blackCount("normal"), lb = blackCount("lightest"), db = blackCount("darker");
  check("lightening a mid-grey field reduces black", lb < nb, `${lb} vs ${nb}`);
  check("darkening it increases black", db > nb, `${db} vs ${nb}`);

  // The BMP encoder's default must stay byte-for-byte what it was before the option existed.
  const a = manga.encodeMonoBmpFromRGBA(rgba, W, H);
  const b = manga.encodeMonoBmpFromRGBA(rgba, W, H, 1);
  check("mono BMP default is unchanged", a.length === b.length && a.every((v, i) => v === b[i]));
  const c = manga.encodeMonoBmpFromRGBA(rgba, W, H, "lightest");
  check("mono BMP actually changes when lightened", c.length === a.length && !c.every((v, i) => v === a[i]));
}

/* ── Manga: language-aware OCR prompt ─────────────────────────── */

function testMangaOcrPrompt() {
  console.log("\n== manga OCR prompt ==");
  const ja = manga.buildPanelOcrPrompt("ja", "en", true);
  check("ja prompt names the language", ja.includes("Japanese manga page") && ja.includes("the Japanese text"));
  check("ja prompt reads right-to-left", ja.includes("right-to-left"));

  const de = manga.buildPanelOcrPrompt("de", "en", false);
  check("de prompt names German", de.includes("comic page in German") && de.includes("the German text"));
  check("de prompt reads left-to-right", de.includes("left-to-right"));
  check("de prompt never says Japanese or manga", !de.includes("Japanese") && !de.includes("manga"));

  // Source language equal to the target: transcription only, no paraphrase.
  const enEn = manga.buildPanelOcrPrompt("en", "en", false);
  check("en->en asks for no translation",
    enEn.includes("no translation is needed") && enEn.includes('"translation": ""'));

  // A non-English target is what the browser tool adds over the Python one.
  const jaDe = manga.buildPanelOcrPrompt("ja", "de", true);
  check("ja->de translates into German", jaDe.includes("natural German translation") && !jaDe.includes("English"));

  // Region subtags and case must not defeat the lookup; manhua/manhwa are not manga.
  for (const tag of ["JA", "ja-JP", "ja_JP"]) {
    check(`${tag} resolves to Japanese`, manga.buildPanelOcrPrompt(tag, "en", true).includes("Japanese manga page"));
  }
  for (const [tag, name] of [["zh-Hant", "Chinese"], ["ko", "Korean"]]) {
    const p = manga.buildPanelOcrPrompt(tag, "en", true);
    check(`${tag} is a ${name} comic, not manga`, p.includes(`comic page in ${name}`) && !p.includes("manga"));
  }
  // An unknown or absent tag still yields a usable prompt.
  for (const tag of ["", "xx", "tlh-Piqd"]) {
    const p = manga.buildPanelOcrPrompt(tag, "en", false);
    check(`${tag || "(empty)"} still builds a prompt`,
      p.includes("bbox_2d") && !p.includes("undefined") && !p.includes("null"));
  }
}

/* ── Manga: 1-bit Floyd-Steinberg BMP output (--mono) ─────────── */

/* Decode the structural fields and unpack the bits of a 1-bit BMP the way the
 * device's Bitmap reader does (MSB-first, bottom-up, 4-byte row stride). */
function decodeBmp1bit(bmp) {
  const dv = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
  const offBits = dv.getUint32(10, true);
  const width = dv.getInt32(18, true);
  const height = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true);
  const comp = dv.getUint32(30, true);
  const colorsUsed = dv.getUint32(46, true);
  const rowBytes = ((width + 31) >> 5) << 2;
  const mono = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const srcRow = offBits + (height - 1 - y) * rowBytes; // bottom-up
    for (let x = 0; x < width; x++) {
      const bit = bmp[srcRow + (x >> 3)] & (0x80 >> (x & 7));
      mono[y * width + x] = bit ? 1 : 0;
    }
  }
  return { magic: bmp[0] === 0x42 && bmp[1] === 0x4d, offBits, width, height, bpp, comp, colorsUsed, rowBytes, mono };
}

/* Chapter lists come from a textarea, so the page index is whatever was typed.
 * toc.idx stores it as u32: a negative one used to wrap (-5 -> 4294967291) and point
 * the device at a page that cannot exist, where the Python tool's struct.pack refuses
 * the value outright. Rejected at both the parse and the encode step now. */
/* Paths a V8 coverage sweep of the browser tool showed were reached by real user input
 * but exercised by no test: source metadata, the EPUB2 chapter list, and the ink-coverage
 * math that decides whether a panels-only page keeps its full page. */
/* Metadata and chapter titles are lifted out of XML with regexes, so whatever the file
 * escaped arrives still escaped unless it is decoded here. The set is deliberately the
 * five predefined XML entities plus numeric references -- exactly what
 * convert_manga.py:xml_unescape decodes, since the two tools must agree byte for byte. */
/* Chapter-foldered archives: each chapter restarts page numbering, so basenames repeat
 * across folders. Keying or sorting on the basename alone collapsed ch01/001 and ch08/001
 * into one page -- most of a volume silently lost, and the survivors interleaved into
 * something that reads as jumbled chapters. */
/* XTCH pages: four grays, dithered, with paper and ink kept exact so no stray dots appear. */
function testXtchDither() {
  console.log("XTCH 4-level dithering:");
  const w = 64, h = 64;
  const out = manga.floydSteinbergLevels(new Uint8Array(w * h).fill(200), w, h, 4);
  check("only the four XTH grays come out", out.every((v) => v === 0 || v === 85 || v === 170 || v === 255));
  const mean = out.reduce((a, v) => a + v, 0) / out.length;
  check("a flat mid gray keeps its average tone", Math.abs(mean - 200) < 4, `mean ${mean.toFixed(1)}`);
  const page = new Uint8Array(w * h).fill(255);
  for (let i = 0; i < w * 8; i++) page[i] = 100;  // a gray band above white paper
  const dithered = manga.floydSteinbergLevels(page, w, h, 4);
  check("error never leaks into white paper", dithered.slice(w * 8).every((v) => v === 255));
  check("paper and ink are stretched to pure white and black",
        JSON.stringify([...manga.stretchPaperAndInk(Uint8Array.from([8, 16, 128, 240, 248]))]) ===
        JSON.stringify([0, 0, 128, 255, 255]));
  const flat = new Uint8Array(w * h).fill(180);
  check("sharpening leaves flat areas alone", manga.unsharpMask(flat, w, h).every((v) => v === 180));
  const edge = new Uint8Array(w * h).map((_, i) => (i % w < w / 2 ? 60 : 200));
  const sharp = manga.unsharpMask(edge, w, h);
  check("sharpening steepens an edge", sharp[w / 2 - 1] < 60 && sharp[w / 2] > 200,
        `${sharp[w / 2 - 1]} ${sharp[w / 2]}`);
}

/* XTC/XTCH and EPUB chapters for a CBZ: one per chapter folder, or the ones ComicInfo.xml marks. */
function testMangaArchiveChapters() {
  console.log("manga chapters from an archive's layout:");
  const order = manga.naturalSortPaths([
    "Vol 1/ch02/001.png", "Vol 1/cover.jpg", "Vol 1/ch01/002.png", "Vol 1/ch01/001.png", "Vol 1/ch02/002.png"]);
  check("one chapter per folder below the shared wrapper folder",
        JSON.stringify(manga.chaptersFromFolders(order)) === JSON.stringify([[1, "ch01"], [3, "ch02"]]),
        JSON.stringify(manga.chaptersFromFolders(order)));
  check("a flat archive has no chapters", manga.chaptersFromFolders(["001.png", "002.png"]).length === 0);
  check("a single folder is not a chapter list",
        manga.chaptersFromFolders(["ch01/001.png", "ch01/002.png"]).length === 0);
  const xml = '<ComicInfo><Pages><Page Image="0" Type="FrontCover"/>' +
    '<Page Image="5" Bookmark="Chapter 2 &amp; more"/><Page Image="1" Bookmark="Chapter 1"/>' +
    '<Page Image="99" Bookmark="Past the end"/></Pages></ComicInfo>';
  check("ComicInfo bookmarks, sorted, unescaped, past-the-end dropped",
        JSON.stringify(manga.comicInfoBookmarks(xml, 10)) ===
        JSON.stringify([[1, "Chapter 1"], [5, "Chapter 2 & more"]]),
        JSON.stringify(manga.comicInfoBookmarks(xml, 10)));
}

function testMangaFolderedSort() {
  console.log("manga page order in chapter-foldered archives:");
  const foldered = ["ch02/002.png", "ch01/002.png", "ch02/001.png", "ch01/001.png", "ch10/001.png"];
  check("directories order before the page number inside them",
        JSON.stringify(manga.naturalSortPaths(foldered)) ===
        JSON.stringify(["ch01/001.png", "ch01/002.png", "ch02/001.png", "ch02/002.png", "ch10/001.png"]),
        JSON.stringify(manga.naturalSortPaths(foldered)));
  check("repeated basenames stay distinct entries",
        new Set(foldered.map((p) => manga.baseName(p))).size === 2 &&
        manga.naturalSortPaths(foldered).length === 5);
  // ch10 must follow ch02, not sort between ch01 and ch02 as a string compare would.
  check("chapter numbers compare numerically, not as text",
        manga.naturalSortPaths(["ch10/001.png", "ch2/001.png"])[0] === "ch2/001.png");

  // A flat archive has no directory component, so nothing about it changes -- this is what
  // keeps the byte-comparison against convert_manga.py valid.
  const flat = ["010.png", "9.png", "002.png", "cover.jpg", "copyright.png"];
  check("flat archive order unchanged (cover, copyright, then natural)",
        JSON.stringify(manga.naturalSortPaths(flat)) ===
        JSON.stringify(["cover.jpg", "copyright.png", "002.png", "9.png", "010.png"]),
        JSON.stringify(manga.naturalSortPaths(flat)));
  check("cover/copyright pinned by basename even inside a folder",
        manga.naturalSortPaths(["ch01/001.png", "front/cover.jpg"])[0] === "front/cover.jpg");
}

function testXmlUnescape() {
  console.log("XML entity decoding (shared with convert_manga.py):");
  const u = manga.xmlUnescape;
  check("the five predefined entities",
        u("&amp; &lt; &gt; &quot; &apos;") === "& < > \" '", JSON.stringify(u("&amp; &lt; &gt; &quot; &apos;")));
  check("decimal character reference", u("&#65;&#66;") === "AB", u("&#65;&#66;"));
  check("hex character reference", u("&#x41;&#X42;") === "AB", u("&#x41;&#X42;"));
  check("astral character reference", u("&#x1F375;") === "\u{1F375}", u("&#x1F375;"));
  // One pass, so an escaped escape survives as text rather than decoding twice.
  check("single pass: &amp;lt; stays &lt;", u("&amp;lt;") === "&lt;", u("&amp;lt;"));
  // html.unescape would turn this into a space; we must not, or the tools diverge.
  check("HTML5-only named entities are left alone", u("&nbsp;") === "&nbsp;", u("&nbsp;"));
  check("unknown and unterminated entities are left alone",
        u("&unknown; &amp") === "&unknown; &amp", u("&unknown; &amp"));
  check("out-of-range character reference left alone",
        u("&#999999999;") === "&#999999999;", u("&#999999999;"));
  check("text with no entities is unchanged", u("plain 日本語 text") === "plain 日本語 text");

  const nav = '<nav epub:type="toc"><ol><li><a href="p1.xhtml">Tom &amp; Jerry</a></li></ol></nav>';
  check("EPUB3 nav chapter titles decode",
        manga.epubTocFromNav(nav, "OEBPS/nav.xhtml")[0][1] === "Tom & Jerry",
        JSON.stringify(manga.epubTocFromNav(nav, "OEBPS/nav.xhtml")));
  const ncx = '<ncx><navMap><navPoint><navLabel><text>R &amp; D</text></navLabel>' +
              '<content src="p1.xhtml"/></navPoint></navMap></ncx>';
  check("EPUB2 ncx chapter titles decode",
        manga.epubTocFromNcx(ncx, "OEBPS/toc.ncx")[0][1] === "R & D",
        JSON.stringify(manga.epubTocFromNcx(ncx, "OEBPS/toc.ncx")));
  check("OPF metadata decodes",
        manga.epubMetadataFromOpf("<dc:title>A &amp; B</dc:title>").title === "A & B");
}

function testMangaSourceMetadata() {
  console.log("manga source metadata + EPUB2 chapters (previously untested):");
  const ci = manga.cbzMetadataFromComicInfo(
    "<ComicInfo><Title>Tom &amp; Jerry</Title><Writer>Ada Lovelace</Writer>" +
    "<LanguageISO>jp</LanguageISO></ComicInfo>");
  check("ComicInfo title decodes XML entities",
        ci.title === "Tom & Jerry", JSON.stringify(ci.title));
  check("ComicInfo writer", ci.author === "Ada Lovelace", JSON.stringify(ci.author));
  check("ComicInfo language", ci.language === "jp", JSON.stringify(ci.language));
  check("ComicInfo language normalises to ja", manga.normalizeLanguage(ci.language) === "ja");
  const none = manga.cbzMetadataFromComicInfo("<ComicInfo/>");
  check("ComicInfo with no fields yields empties",
        none.title === "" && none.author === "" && none.language === "");

  const opf = '<package><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' +
              '</manifest><spine toc="ncx"><itemref idref="x1"/></spine></package>';
  check("EPUB2 ncx href resolved from the spine's toc attribute",
        manga.epubNcxHref(opf) === "toc.ncx", String(manga.epubNcxHref(opf)));
  check("no ncx attribute yields null", manga.epubNcxHref("<package><spine/></package>") === null);
  const ncx = '<ncx><navMap>' +
    '<navPoint><navLabel><text>First Chapter</text></navLabel><content src="text/p1.xhtml"/></navPoint>' +
    '<navPoint><navLabel><text>Second Chapter</text></navLabel><content src="text/p2.xhtml"/></navPoint>' +
    '<navPoint><navLabel><text>  </text></navLabel><content src="text/p3.xhtml"/></navPoint>' +
    '</navMap></ncx>';
  const entries = manga.epubTocFromNcx(ncx, "OEBPS/toc.ncx");
  check("EPUB2 chapters resolved against the ncx's own directory",
        entries.length === 2 && entries[0][0] === "OEBPS/text/p1.xhtml" && entries[0][1] === "First Chapter",
        JSON.stringify(entries));
  check("blank-titled navPoint dropped", entries.every(([, t]) => t.trim() !== ""));
}

function testMangaInkCoverage() {
  console.log("manga panels-only ink coverage (previously untested):");
  const w = 100, h = 100;
  const page = (px) => { const g = new Uint8Array(w * h).fill(255); for (const [x, y] of px) g[y * w + x] = 0; return g; };
  const inside = [], outside = [];
  for (let i = 0; i < 100; i++) inside.push([10 + (i % 10), 10 + Math.floor(i / 10)]);
  for (let i = 0; i < 10; i++) outside.push([90, 90 + (i % 10)]);
  const rect = [[10, 10, 20, 20]];
  const mixed = manga.panelInkCoverage(page(inside.concat(outside)), w, h, rect);
  check("ink split 100 inside / 10 outside", Math.abs(mixed - 100 / 110) < 1e-9, String(mixed));
  check("all ink inside → 1", manga.panelInkCoverage(page(inside), w, h, rect) === 1);
  check("a blank page counts as fully covered",
        manga.panelInkCoverage(new Uint8Array(w * h).fill(255), w, h, rect) === 1);
  check("no panels → 0", manga.panelInkCoverage(page(inside), w, h, []) === 0);
  check("a rect past the page edge is clamped, not out of bounds",
        manga.panelInkCoverage(page(inside), w, h, [[-50, -50, 500, 500]]) === 1);
  check("gaps narrower than the minimum are merged",
        JSON.stringify(manga.mergeSmallGaps([0, 10, 12, 100], 5)) === "[0,10,100]",
        JSON.stringify(manga.mergeSmallGaps([0, 10, 12, 100], 5)));
  check("wide gaps are kept",
        JSON.stringify(manga.mergeSmallGaps([0, 50, 100], 5)) === "[0,50,100]");
}

function testMangaToc() {
  console.log("manga chapter list (toc.idx page indices):");
  const parsed = manga.parseTocText("-5|Bad\n0|Start\n2|Two\nnope\nx|Nan");
  check("negative page index dropped",
        parsed.entries.length === 2 && parsed.entries[0][0] === 0 && parsed.entries[1][0] === 2,
        JSON.stringify(parsed.entries));
  check("negative page index warns",
        parsed.warnings.some((w) => /negative page index/.test(w)), JSON.stringify(parsed.warnings));
  check("malformed and non-integer lines still warn", parsed.warnings.length === 3,
        JSON.stringify(parsed.warnings));

  const out = manga.writeTocIdx([[-5, "Bad"], [0, "Start"], [2, "Two"]]);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const count = dv.getUint32(4, true);
  const indices = [];
  let o = 8;
  for (let i = 0; i < count; i++) {
    indices.push(dv.getUint32(o, true));
    o += 6 + dv.getUint16(o + 4, true);
  }
  check("writeTocIdx drops a negative index rather than wrapping it",
        indices.every((v) => v < 0x80000000) && count === 2, JSON.stringify(indices));

  // A cover entry is still prepended when the first real chapter is not page 0.
  const withCover = manga.writeTocIdx([[3, "Three"]]);
  const dv2 = new DataView(withCover.buffer, withCover.byteOffset, withCover.byteLength);
  check("cover entry still prepended", dv2.getUint32(4, true) === 2 && dv2.getUint32(8, true) === 0);
}

function testMangaMono() {
  console.log("manga 1-bit BMP output (--mono / Floyd-Steinberg):");

  // Solid inputs must dither to a uniform field regardless of size.
  const w = 13, h = 7;                       // width forces row padding (13 → 4-byte stride)
  const white = new Uint8Array(w * h).fill(255);
  const black = new Uint8Array(w * h).fill(0);
  check("solid white → all 1s", manga.floydSteinbergMono(white, w, h).every((v) => v === 1));
  check("solid black → all 0s", manga.floydSteinbergMono(black, w, h).every((v) => v === 0));

  // BMP structure the device relies on: BI_RGB, 1 bpp, 2-colour palette, and a
  // 4-byte-aligned row stride (13px → 4 bytes, not 2).
  const mono = manga.floydSteinbergMono(white, w, h);
  const bmp = manga.encodeBmp1bit(mono, w, h);
  const d = decodeBmp1bit(bmp);
  check("BMP magic 'BM'", d.magic);
  check("BMP is 1 bpp", d.bpp === 1, `got ${d.bpp}`);
  check("BMP is BI_RGB", d.comp === 0, `got ${d.comp}`);
  check("BMP width/height", d.width === w && d.height === h, `got ${d.width}x${d.height}`);
  check("BMP palette 2 colours", d.colorsUsed === 2, `got ${d.colorsUsed}`);
  check("BMP row stride padded to 4", d.rowBytes === 4, `got ${d.rowBytes}`);
  check("BMP total size", bmp.length === 62 + d.rowBytes * h, `got ${bmp.length}`);

  // Bits round-trip through the device's unpacking exactly.
  const monoBack = decodeBmp1bit(manga.encodeBmp1bit(mono, w, h)).mono;
  check("mono bits round-trip", monoBack.every((v, i) => v === mono[i]));

  // A vertical split (left black, right white) survives dithering and packing:
  // the left half stays black, the right half stays white.
  const split = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) split[y * w + x] = x < w >> 1 ? 0 : 255;
  const splitBack = decodeBmp1bit(manga.encodeBmp1bit(manga.floydSteinbergMono(split, w, h), w, h)).mono;
  let leftBlack = true, rightWhite = true;
  for (let y = 0; y < h; y++) {
    if (splitBack[y * w + 0] !== 0) leftBlack = false;
    if (splitBack[y * w + (w - 1)] !== 1) rightWhite = false;
  }
  check("split page: left edge black", leftBlack);
  check("split page: right edge white", rightWhite);

  // RGBA convenience path packs the same bytes as gray → dither → encode.
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255; }
  const viaRgba = manga.encodeMonoBmpFromRGBA(rgba, w, h);
  const viaGray = manga.encodeBmp1bit(manga.floydSteinbergMono(manga.grayFromRGBA(rgba, w, h), w, h), w, h);
  check("encodeMonoBmpFromRGBA matches manual path", binary.bytesEqual(viaRgba, viaGray));
}

/* ── Manga: portable EPUB export ──────────────────────────────── */

/* Build a small EPUB the way manga-ui.js does (mimetype first + STORE), then
 * read it back with our own ZipReader and check the structure. */
async function testMangaEpub() {
  console.log("manga EPUB export:");

  // Two pages: page 0 = full page + a wide panel (rotated → portrait) + a tall
  // panel; page 1 = full page only. Chapter list points at both pages.
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); // stand-in image bytes
  const epubPages = [
    { pageIdx: 0, images: [
      { bytes: jpg, mime: "image/jpeg", w: 800, h: 1200 }, // full page
      { bytes: jpg, mime: "image/jpeg", w: 500, h: 900 },  // wide panel, already rotated to portrait by the UI (w/h swapped)
      { bytes: jpg, mime: "image/jpeg", w: 400, h: 700 },  // tall panel
    ] },
    { pageIdx: 1, images: [{ bytes: jpg, mime: "image/jpeg", w: 800, h: 1200 }] },
  ];
  const totalImages = epubPages.reduce((n, p) => n + p.images.length, 0); // 4
  const tocEntries = [[1, "Chapter 2"], [0, "Chapter 1"]]; // deliberately unsorted

  // Mirror manga-ui.js buildMangaEpub assembly (kept in the test so the pure
  // module can be exercised without a browser).
  const spine = [];
  const pageFirstHref = new Map();
  for (const pg of epubPages) {
    pg.images.forEach((im, ii) => {
      const base = `p${String(pg.pageIdx).padStart(4, "0")}_${ii}`;
      const xhtmlHref = `text/${base}.xhtml`;
      if (ii === 0) pageFirstHref.set(pg.pageIdx, xhtmlHref);
      spine.push({
        xhtmlId: `x_${base}`, xhtmlHref,
        imgId: `img_${base}`, imgHref: `images/${base}.${epub.epubImageExt(im.mime)}`,
        mime: im.mime, w: im.w, h: im.h, isCover: spine.length === 0, bytes: im.bytes,
      });
    });
  }
  const chapters = tocEntries.slice().sort((a, b) => a[0] - b[0])
    .map(([pi, t]) => ({ href: pageFirstHref.get(pi), title: t })).filter((c) => c.href);
  const identifier = epub.epubIdentifier("Test Manga", "Test Author", spine.length);
  const files = epub.buildEpubTextFiles({ identifier, title: "Test Manga", author: "Test Author", language: "ja", spine, chapters });

  const zw = new zip.ZipWriter();
  const enc = new TextEncoder();
  zw.addFile("mimetype", enc.encode(epub.EPUB_MIMETYPE));
  for (const f of files) zw.addFile(f.path, enc.encode(f.text));
  for (const s of spine) zw.addFile("OEBPS/" + s.imgHref, s.bytes);
  const bytes = new Uint8Array(await zw.toBlob().arrayBuffer());

  // OCF requires the mimetype file first, STORE-compressed, with an 8-byte name
  // and NO extra field — which is exactly what puts its name at byte 30 and its
  // content at byte 38, the fixed offsets readers use to sniff an EPUB without
  // unzipping. Assert those local-header fields explicitly (rather than trusting
  // the offsets blind) so 30/38 is self-documenting and a stray extra field or
  // rename is caught as the OCF violation it is, not a silent pass.
  const lh = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  check("first local header signature", lh.getUint32(0, true) === 0x04034b50);
  check("mimetype entry is STORE", lh.getUint16(8, true) === 0);
  check("mimetype name len 8, no extra field", lh.getUint16(26, true) === 8 && lh.getUint16(28, true) === 0);
  // Given those fields, the name lives at 30 and content at 30 + nameLen (= 38).
  const nameOff = 30, contentOff = 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  check("mimetype name at offset 30", new TextDecoder().decode(bytes.subarray(nameOff, nameOff + 8)) === "mimetype");
  check("epub mimetype content at offset 38",
    contentOff === 38 && new TextDecoder().decode(bytes.subarray(contentOff, contentOff + epub.EPUB_MIMETYPE.length)) === epub.EPUB_MIMETYPE);

  const zr = new zip.ZipReader(bytes);
  check("mimetype is the first entry, STORE", zr.entries[0].name === "mimetype" && zr.entries[0].method === 0);

  const dec = new TextDecoder();
  const container = dec.decode(await zr.readEntryByName("META-INF/container.xml"));
  check("container points at content.opf", container.includes(`full-path="OEBPS/content.opf"`));

  const opf = dec.decode(await zr.readEntryByName("OEBPS/content.opf"));
  check("opf fixed-layout", opf.includes("pre-paginated"));
  check("opf right-to-left spine", opf.includes(`page-progression-direction="rtl"`));
  check("opf cover-image on first image", opf.includes(`id="img_p0000_0"`) && /id="img_p0000_0"[^>]*properties="cover-image"/.test(opf));
  check("opf itemref count == images", (opf.match(/<itemref\b/g) || []).length === totalImages, `${(opf.match(/<itemref\b/g) || []).length} != ${totalImages}`);
  check("opf image items == images", (opf.match(/media-type="image\/jpeg"/g) || []).length === totalImages);

  const nav = dec.decode(await zr.readEntryByName("OEBPS/nav.xhtml"));
  check("nav lists both chapters in page order",
    nav.indexOf("Chapter 1") >= 0 && nav.indexOf("Chapter 1") < nav.indexOf("Chapter 2"));
  check("nav links resolve to page xhtml", nav.includes(`href="text/p0000_0.xhtml"`) && nav.includes(`href="text/p0001_0.xhtml"`));

  const ncx = dec.decode(await zr.readEntryByName("OEBPS/toc.ncx"));
  check("ncx has both navPoints", (ncx.match(/<navPoint\b/g) || []).length === 2);

  // Every spine page renders one image at its declared viewport size.
  const wide = dec.decode(await zr.readEntryByName("OEBPS/text/p0000_1.xhtml"));
  check("page viewport matches image dims", wide.includes(`content="width=500, height=900"`));
  check("page references its image one dir up", wide.includes(`src="../images/p0000_1.jpg"`));
  check("all page xhtml present", files.filter((f) => f.path.startsWith("OEBPS/text/")).length === totalImages);

  // Identifier is deterministic and content-derived.
  check("identifier deterministic",
    epub.epubIdentifier("Test Manga", "Test Author", spine.length) === identifier && /^urn:matcha-reader:[0-9a-f]{16}$/.test(identifier));
  check("identifier varies with title", epub.epubIdentifier("Other", "Test Author", spine.length) !== identifier);
}

/* ── Manga: detection-retry gate (vs convert_manga.py) ────── */

function testMangaCoverGate() {
  console.log("manga detection-retry coverage gate:");
  const { yoloPanelCoverFrac: cover, YOLO_RETRY_COVER_FRAC: gate } = require("../../js/yolo.js");

  // One banner-sized box on a whole page: what a failed detection pass looks like.
  check("a sparse page falls under the gate", cover([[0, 0, 600, 100]], 1200, 1700) < gate);
  // A genuine single-panel splash covers the page, so it must not be retried.
  check("a full-page splash stays above the gate", cover([[0, 0, 1200, 1700]], 1200, 1700) >= gate);
  check("a panelled page stays above the gate",
        cover([0, 420, 840, 1260].map(y => [0, y, 1200, y + 400]), 1200, 1700) >= gate);
  check("no boxes cover nothing", cover([], 1200, 1700) === 0);
}

/* ── Manga: bubble-aware panel crops (vs convert_manga.py) ────── */

function testMangaBubbleCrops() {
  console.log("manga bubble-aware panel crops:");
  const yolo = require("../../js/yolo.js");
  const { yoloExpandPanelsOverText: expand, yoloSplitFramesOverSubpanels: split,
          yoloTextPadPx: padPx } = yolo;
  const pad = padPx(800, 800);

  // A caption drawn above the frame border must not be sliced off, and the crop
  // edge must clear its outline rather than land on it.
  check("overhanging caption grows the crop",
        JSON.stringify(expand([[100, 100, 500, 500]], [[120, 60, 300, 140]], 800, 800)) ===
        JSON.stringify([[100, 60 - pad, 500, 500]]));

  // Padding is breathing room for a breached border, not a blanket inset.
  check("a bubble inside the panel never moves the crop",
        JSON.stringify(expand([[100, 100, 500, 500]], [[104, 104, 300, 180]], 800, 800)) ===
        JSON.stringify([[100, 100, 500, 500]]));

  // A bubble straddling two panels belongs to one of them, not both.
  check("gutter bubble goes to the panel holding most of it",
        JSON.stringify(expand([[0, 100, 300, 500], [320, 100, 620, 500]],
                              [[250, 200, 420, 260]], 800, 800)) ===
        JSON.stringify([[0, 100, 300, 500], [250 - pad, 100, 620, 500]]));

  // A page number in the margin must not stretch the nearest panel to it.
  check("text outside every panel is ignored",
        JSON.stringify(expand([[100, 100, 500, 500]], [[470, 700, 520, 740]], 800, 800)) ===
        JSON.stringify([[100, 100, 500, 500]]));

  check("growth never leaves the page",
        JSON.stringify(expand([[10, 100, 500, 500]], [[-40, 60, 300, 200]], 800, 800)) ===
        JSON.stringify([[0, 60 - pad, 500, 500]]));

  check("pad scales with the page",
        padPx(290, 420) < padPx(1024, 1449) && padPx(1024, 1449) < padPx(1364, 2000));

  // A strip the model returned as one frame, but also saw three panels in.
  const frame = [0, 0, 900, 300];
  const kids = [[0, 0, 290, 300], [300, 0, 590, 300], [600, 0, 900, 300]];
  check("a merged row is split into its subpanels",
        JSON.stringify(split([frame], kids.concat([frame]))) === JSON.stringify(kids));

  check("a frame seen twice at two scales is not split",
        JSON.stringify(split([frame], [frame, [4, 3, 896, 297]])) === JSON.stringify([frame]));

  check("one stray box never splits a frame",
        JSON.stringify(split([frame], [frame, [100, 60, 300, 240]])) === JSON.stringify([frame]));

  check("subpanels must account for the frame",
        JSON.stringify(split([frame], [[0, 0, 150, 100], [160, 0, 310, 100], frame])) ===
        JSON.stringify([frame]));

  check("overlapping subpanels are rejected",
        JSON.stringify(split([frame], [[0, 0, 600, 300], [100, 0, 700, 300], frame])) ===
        JSON.stringify([frame]));
}

/* ── Manga: panel layouts, 4-koma pages, spreads (vs convert_manga.py) ── */

/* panels.idx/panels.dat as convert_manga.py --no-ocr writes them for pages detected on the grid
 * path: gutter grid, 4-koma or gutter-cut order, the default 10px crop margin. */
function gridFolder(pages, { rtl = true, columnMajor = false, yonkomaDetect = true } = {}) {
  const idxRecords = [];
  const chunks = [];
  let offset = 0;
  for (const { gray, w, h } of pages) {
    const frames = manga.detectPanelsGrid(gray, w, h);
    const boxes = manga.orderPanels(frames, w, rtl, columnMajor, yonkomaDetect);
    const data = manga.encodePage(boxes.map((box) => ({
      box,
      crop: [Math.max(0, box[0] - 10), Math.max(0, box[1] - 10), Math.min(w, box[2] + 10), Math.min(h, box[3] + 10)],
      textBlocks: [],
      translation: "",
    })));
    idxRecords.push({ offset, length: data.length, w, h });
    chunks.push(data);
    offset += data.length;
  }
  const dat = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) { dat.set(c, at); at += c.length; }
  return { idx: manga.writePanelsIdx(idxRecords), dat };
}

function cropGray(gray, w, [x1, y1, x2, y2]) {
  const out = new Uint8Array((x2 - x1) * (y2 - y1));
  for (let y = y1; y < y2; y++) out.set(gray.subarray(y * w + x1, y * w + x2), (y - y1) * (x2 - x1));
  return { gray: out, w: x2 - x1, h: y2 - y1 };
}

function testMangaLayouts() {
  console.log("manga layouts: gutter cuts, dark gutters, 4-koma pages, spreads (vs convert_manga.py):");
  const dir = path.join(FIXTURES, "manga_layouts");
  if (!fs.existsSync(path.join(FIXTURES, "ref_layouts", "panels.dat"))) {
    console.log("  skip (no ref_layouts — rerun gen_references.py against a convert_manga.py with --split-spreads)");
    return;
  }
  const dims = JSON.parse(fs.readFileSync(path.join(dir, "dims.json"), "utf-8"));
  const pages = Object.keys(dims).sort().map((name) => {
    const [w, h] = dims[name];
    return { gray: new Uint8Array(fs.readFileSync(path.join(dir, name.replace(".png", ".gray")))), w, h };
  });
  const split = (rtl) => pages.flatMap((p) => {
    const halves = manga.spreadHalves(p.w, p.h, rtl);
    return halves ? halves.map((r) => cropGray(p.gray, p.w, r)) : [p];
  });
  const trimmed = (list) => list.map((p) => {
    const box = manga.trimMarginsBox(p.gray, p.w, p.h);
    return box ? cropGray(p.gray, p.w, box) : p;
  });
  const runs = [
    ["ref_layouts", pages, {}],
    ["ref_layouts_noyonkoma", pages, { yonkomaDetect: false }],
    ["ref_layouts_split", split(true), {}],
    ["ref_layouts_split_ltr", trimmed(split(false)), { rtl: false }],
  ];
  for (const [ref, list, opts] of runs) {
    const { idx, dat } = gridFolder(list, opts);
    compareFile(`${ref} panels.idx`, idx, path.join(FIXTURES, ref, "panels.idx"));
    compareFile(`${ref} panels.dat`, dat, path.join(FIXTURES, ref, "panels.dat"));
  }
  // The 4-koma page must actually differ with detection off, or the comparison above proves nothing.
  const lay01 = pages[0];
  const cells = manga.detectPanelsGrid(lay01.gray, lay01.w, lay01.h);
  check("4-koma page: 8 cells, read strip by strip only with detection on",
    cells.length === 8 && manga.orderPanels(cells, lay01.w, true, false, true).map((b) => b.join()).join() !==
      manga.orderPanels(cells, lay01.w, true, false, false).map((b) => b.join()).join());
  const lay02 = pages[1];
  check("black gutters cut the page", manga.detectPanelsGrid(lay02.gray, lay02.w, lay02.h).length === 3);
}

/* Coordinate-only cases from convert_manga.py's own test_panel_order.py. */
function testMangaPanelOrderCases() {
  console.log("manga reading order, 4-koma detection, spreads (cases from test_panel_order.py):");
  const names = (named, boxes) => {
    const byBox = new Map(Object.entries(named).map(([n, b]) => [b.join(), n]));
    return boxes.map((b) => byBox.get(b.join())).join();
  };
  {
    const named = {
      strip: [27, 413, 695, 656],
      right_top: [483, 673, 762, 892], right_bottom: [484, 911, 763, 1111],
      tall: [352, 668, 474, 1198],
      left_top: [26, 674, 347, 878], left_bottom: [26, 894, 347, 1110],
    };
    check("tall panel between two columns",
      names(named, manga.sortPanelsReadingOrder(Object.values(named))) ===
      "strip,right_top,right_bottom,tall,left_top,left_bottom");
  }
  {
    const named = {
      right_1: [476, 713, 764, 831], right_2: [488, 849, 764, 980], right_3: [503, 997, 763, 1110],
      middle: [254, 713, 527, 1199],
      left_1: [26, 714, 301, 884], left_2: [25, 901, 288, 1200],
    };
    check("slanted middle panel overlapping both columns",
      names(named, manga.sortPanelsReadingOrder(Object.values(named))) ===
      "right_1,right_2,right_3,middle,left_1,left_2");
  }
  {
    const named = {};
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 3; col++) named[`r${row}c${col}`] = [col * 280, row * 300, col * 280 + 270, row * 300 + 260];
    }
    const panels = Object.values(named).reverse();
    const want = (cols) => [0, 1, 2, 3].flatMap((r) => cols.map((c) => `r${r}c${c}`)).join();
    check("strip page LTR", names(named, manga.sortPanelsReadingOrder(panels, false)) === want([0, 1, 2]));
    check("strip page RTL", names(named, manga.sortPanelsReadingOrder(panels, true)) === want([2, 1, 0]));
  }
  {
    // A cycle in the pairwise rules reads the rest by position instead of keeping the input order.
    const a = [0, 0, 100, 100], b = [90, 50, 190, 150], c = [40, 95, 140, 195];
    const out = manga.sortPanelsGraph([c, b, a]);
    check("graph order keeps every panel", out.length === 3 && new Set(out).size === 3);
  }

  const R = [0, 1, 2, 3].map((i) => [420, 170 + 235 * i, 710, 390 + 235 * i]);
  const L = [0, 1, 2, 3].map((i) => [100, 170 + 235 * i, 390, 390 + 235 * i]);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const shuffled = R.flatMap((r, i) => [r, L[i]]);
  check("4-koma page read down each strip", same(manga.yonkomaReadingOrder(shuffled, 760), R.concat(L)));
  check("4-koma page LTR", same(manga.yonkomaReadingOrder(shuffled, 760, false), L.concat(R)));
  const cut = [[L[2][0], L[2][1], 240, L[2][3]], [200, L[2][1], L[2][2], L[2][3]]];
  check("a cut strip panel merges back",
    same(manga.yonkomaReadingOrder(R.concat(L.slice(0, 2), cut, L.slice(3)), 760), R.concat(L)));
  {
    const title = [720, 170, 760, 1090];
    const nr = R.map((b) => [400, b[1], 690, b[3]]), nl = L.map((b) => [60, b[1], 350, b[3]]);
    check("a title panel beside the strips reads first",
      same(manga.yonkomaReadingOrder(nl.concat([title], nr), 760), [title].concat(nr, nl)));
  }
  {
    const rows = [[0, 100], [110, 500], [510, 600]];
    const grid = rows.flatMap(([y1, y2]) => [[0, 370], [390, 760]].map(([x1, x2]) => [x1, y1, x2, y2]));
    check("rows of differing heights are not 4-koma", manga.yonkomaReadingOrder(grid, 760) === null);
    check("a full-width panel across both strips is not 4-koma",
      manga.yonkomaReadingOrder(R.concat(L, [[0, 1100, 760, 1200]]), 760) === null);
    check("two loose panels beside the strips are not 4-koma",
      manga.yonkomaReadingOrder(R.concat(L, [[0, 100, 60, 500], [0, 600, 60, 1000]]), 760) === null);
    check("full-width rows are not 4-koma",
      manga.yonkomaReadingOrder([0, 250, 500, 750].map((y) => [0, y, 760, y + 200]), 760) === null);
  }

  check("scalePanelBoxes maps and clamps",
    same(manga.scalePanelBoxes([[0, 0, 2000, 3000], [1000, 1500, 1500, 2250]], [2000, 3000], [480, 720]),
      [[0, 0, 480, 720], [240, 360, 360, 540]]));
  check("scalePanelBoxes rounds halves to even, as Python does",
    same(manga.scalePanelBoxes([[5, 5, 15, 15]], [100, 100], [50, 50]), [[2, 2, 8, 8]]));
  check("spread halves: right page first in manga",
    same(manga.spreadHalves(2000, 1400, true), [[1000, 0, 2000, 1400], [0, 0, 1000, 1400]]));
  check("spread halves: left page first left to right",
    same(manga.spreadHalves(2001, 1400, false), [[0, 0, 1000, 1400], [1000, 0, 2001, 1400]]));
  check("a portrait page is not a spread", manga.spreadHalves(1000, 1400) === null);
  check("chapters move with the split pages",
    same(manga.remapTocAfterSplit([[0, "a"], [2, "b"], [5, "gone"]], [0, 1, 3]), [[0, "a"], [3, "b"]]));
}

/* ── Manga: Pillow's BOX resize, which the ink grid is built on ── */

function testPilBoxResize() {
  console.log("Pillow BOX resize (vs Image.resize):");
  const dir = path.join(FIXTURES, "pil_box");
  if (!fs.existsSync(path.join(dir, "cases.json"))) {
    console.log("  skip (no pil_box fixtures — rerun gen_references.py)");
    return;
  }
  const { pillow, cases } = JSON.parse(fs.readFileSync(path.join(dir, "cases.json"), "utf-8"));
  let bad = 0;
  cases.forEach(([w, h, ow, oh], i) => {
    const stem = `c${String(i).padStart(2, "0")}`;
    const got = manga.pilResizeBox(new Uint8Array(fs.readFileSync(path.join(dir, `${stem}.in`))), w, h, ow, oh);
    const ref = fs.readFileSync(path.join(dir, `${stem}.out`));
    if (got.length !== ref.length || !got.every((v, k) => v === ref[k])) bad++;
  });
  // Pillow before 13.0 always resized horizontally first, which rounds some cells differently.
  check(`${cases.length} images match Pillow ${pillow} byte for byte`, bad === 0, `${bad} differ`);
}

/* ── Manga: YOLO post-processing on fixed detections vs convert_manga.py, exactly ── */

async function testMangaYoloPost() {
  console.log("manga AI detection post-processing (vs convert_manga.py on fixed detections):");
  const dir = path.join(FIXTURES, "yolo_post");
  const casesPath = path.join(dir, "cases.json");
  if (!fs.existsSync(casesPath)) {
    console.log("  skip (no yolo_post fixtures — rerun gen_references.py with numpy installed)");
    return;
  }
  const yolo = require("../../js/yolo.js");
  const cases = JSON.parse(fs.readFileSync(casesPath, "utf-8"));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const stem = `case${String(i).padStart(2, "0")}`;
    const [fw, fh] = c.full, [pw, ph] = c.page;
    const full = { gray: new Uint8Array(fs.readFileSync(path.join(dir, `${stem}_full.gray`))), w: fw, h: fh };
    const page = c.stored
      ? { gray: new Uint8Array(fs.readFileSync(path.join(dir, `${stem}_page.gray`))), w: pw, h: ph }
      : full;
    const runPass = (size) => {
      const decoded = (c.detections[String(size)] || [])
        .filter((d) => d[4] >= yolo.YOLO_WEAK_CONF)
        .map((d) => [d.slice(0, 4), d[4], d[5]]);
      return yolo.yoloPassFromDecoded(decoded, fw, fh, yolo.YOLO_CONF_THRESHOLD);
    };
    const detected = await yolo.detectPanelsYoloWith(runPass, full.gray, fw, fh);
    const found = yolo.detectPanels(detected, full, page);
    const frames = found.frames.length ? found.frames : [[0, 0, pw, ph]];
    const boxes = yolo.yoloExpandPanelsOverText(manga.orderPanels(frames, pw, c.rtl, false, true), found.texts, pw, ph);
    check(`${c.name}: frames`, same(found.frames, c.frames) && same(found.texts, c.texts),
      `got ${JSON.stringify(found)}, reference ${JSON.stringify({ frames: c.frames, texts: c.texts })}`);
    check(`${c.name}: crops in reading order`, same(boxes, c.boxes),
      `got ${JSON.stringify(boxes)}, reference ${JSON.stringify(c.boxes)}`);
  }
}

/* ── Manga: YOLO panel detection vs Python reference ──────────── */

async function testMangaYolo() {
  console.log("manga YOLO panel detection (vs ref_yolo/boxes.json):");
  const refPath = path.join(FIXTURES, "ref_yolo", "boxes.json");
  if (!fs.existsSync(refPath)) {
    console.log("  skip (no ref_yolo fixtures — rerun gen_references.py with numpy + onnxruntime installed)");
    return;
  }
  let ort;
  try {
    ort = require("onnxruntime-web");
  } catch {
    console.log("  skip (npm install onnxruntime-web)");
    return;
  }
  const yolo = require("../../js/yolo.js");
  const model = new Uint8Array(fs.readFileSync(path.join(__dirname, "..", "..", "models", "manga_panel_detector_yolo26n.onnx")));
  const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });

  // Inference backends round floats differently, so unlike the byte-exact
  // grid comparisons this is tolerance-based: same panels, same reading
  // order, coordinates within ±2 px. The page is detected as manga.html does it.
  const TOL = 2;
  for (const [pagesName, refName] of [["manga_pages", "boxes.json"], ["manga_layouts", "layouts.json"]]) {
    const pagesDir = path.join(FIXTURES, pagesName);
    const refFile = path.join(FIXTURES, "ref_yolo", refName);
    if (!fs.existsSync(refFile)) {
      console.log(`  skip ${refName} (rerun gen_references.py)`);
      continue;
    }
    const dims = JSON.parse(fs.readFileSync(path.join(pagesDir, "dims.json"), "utf-8"));
    const ref = JSON.parse(fs.readFileSync(refFile, "utf-8"));
    for (const name of Object.keys(ref)) {
      const [w, h] = dims[name];
      const rgba = new Uint8Array(fs.readFileSync(path.join(pagesDir, name.replace(".png", ".rgba"))));
      const page = { gray: manga.grayFromRGBA(rgba, w, h), w, h };
      const detected = await yolo.detectPanelsYolo(session, ort, rgba, w, h, undefined, page.gray);
      const found = yolo.detectPanels(detected, page, page);
      let boxes = manga.orderPanels(found.frames.length ? found.frames : [[0, 0, w, h]], w, true, false, true);
      boxes = yolo.yoloExpandPanelsOverText(boxes, found.texts, w, h);
      const expected = ref[name];
      if (boxes.length !== expected.length) {
        check(`${name} panel count`, false, `got ${JSON.stringify(boxes)}, reference ${JSON.stringify(expected)}`);
        continue;
      }
      const ok = boxes.every((b, i) => b.every((v, j) => Math.abs(v - expected[i][j]) <= TOL));
      check(`${name} ${boxes.length} panel(s) within ±${TOL}px`, ok,
            ok ? "" : `got ${JSON.stringify(boxes)}, reference ${JSON.stringify(expected)}`);
    }
  }
}

/* ── Dictionary, Chinese: vs convert_jmdict.py --lang zh / yue ──── */

const ZH = path.join(FIXTURES, "zh");
function zhText(name) { return fs.readFileSync(path.join(ZH, name), "utf-8"); }

/* The page's Chinese pipeline, as dict-ui.js runs it, on a list of fixture inputs. */
function convertChineseFixture(inputs, opts = {}) {
  const lang = opts.lang || "zh";
  const twins = new Map();
  const zhOpts = {
    zhuyin: !!opts.zhuyin, splitNames: !!opts.splitNames, twins, tradsOf: new Map(), seen: new Map(),
    levels: opts.levels ? zh.loadLevels(zhText(opts.levels), opts.levelName || "HSK") : new Map(),
    jyutping: opts.jyutping ? zh.loadCantoReadings(zhText(opts.jyutping)) : new Map(),
    sentencePairs: opts.examples ? zh.loadSentencePairs(zhText(opts.examples), opts.examplesScript || "any") : null,
    examplesScript: opts.examplesScript || "any",
  };
  let records = [];
  let names = [];
  const titles = [];
  const bilingual = new Set();
  for (const input of inputs) {
    const fmt = zh.detectDictFormat(input, lang);
    let title = zh.DEFAULT_DICT_TITLES[fmt] || "";
    if (fmt === "cedict") {
      const r = zh.convertCedict(zhText(input), zhOpts);
      records = records.concat(r.records);
      names = names.concat(r.names);
      for (const rec of r.records) bilingual.add(zh.headwordKey(rec.hw));
      if (input.toLowerCase().includes("canto")) title = "CC-Canto";
    } else if (fmt === "moedict") {
      records = records.concat(zh.convertMoedict(JSON.parse(zhText(input))).records);
    } else if (fmt === "tsv") {
      records = records.concat(zh.convertTsv(zhText(input)).records);
      title = input.replace(/\.[^.]+$/, "");
    } else {
      throw new Error(`fixture format ${fmt} not handled here`);
    }
    if (title) titles.push(title);
  }
  if (names.length) ({ records, names } = zh.keepNamesTogether(records, names, bilingual));
  if (opts.frequency) {
    const { priorities } = zh.loadFrequency(zhText(opts.frequency), opts.frequencyKind || "auto");
    const shares = zh.sharedSimplifiedCounts(zhOpts.tradsOf);
    records = zh.applyFrequency(records, priorities, twins, shares);
    names = zh.applyFrequency(names, priorities, twins, shares);
  }
  return { records, names, title: opts.title || zh.joinDictTitles(titles) };
}

function compareDictDir(label, refDir, name, records, title) {
  const { idx, dat } = dict.dictWriteBinary(records);
  compareFile(`${label} ${name}.idx`, idx, path.join(refDir, `${name}.idx`));
  compareFile(`${label} ${name}.dat`, dat, path.join(refDir, `${name}.dat`));
  compareFile(`${label} ${name}.spx`, dict.dictGenSpx(idx), path.join(refDir, `${name}.spx`));
  const titleBytes = zh.encodeDictTitle(title);
  const refTitle = path.join(refDir, `${name}.title`);
  if (fs.existsSync(refTitle)) {
    if (titleBytes) compareFile(`${label} ${name}.title`, titleBytes, refTitle);
    else check(`${label} ${name}.title`, false, "reference has a title, JS wrote none");
  } else {
    check(`${label} ${name}.title absent`, titleBytes === null, "JS wrote a title the reference lacks");
  }
}

async function testDictChinese() {
  console.log("dictionary converter, Chinese and Cantonese (vs convert_jmdict.py --lang zh/yue):");
  if (!fs.existsSync(path.join(ZH, "cedict.u8")) || !fs.existsSync(path.join(FIXTURES, "ref_dict_zh"))) {
    console.log("  skip (no zh fixtures — run test/gen_references.py)");
    return;
  }
  // Everything at once: CC-CEDICT + MoE merged, ranked by a jieba-style list (with its stray
  // traditional 說 3), HSK tags, simplified-only examples, names split off, zhuyin.
  let r = convertChineseFixture(["cedict.u8", "moe.json"], {
    frequency: "freq.txt", levels: "hsk.csv", levelName: "HSK", examples: "pairs.tsv",
    examplesScript: "simplified", splitNames: true, zhuyin: true,
  });
  compareDictDir("zh", path.join(FIXTURES, "ref_dict_zh"), "vocab", r.records, r.title);
  compareDictDir("zh", path.join(FIXTURES, "ref_dict_zh"), "names", r.names, "CC-CEDICT names");

  // A graded list as the frequency source (row order, never its level column), TOCFL tags with
  // the Novice band and 你/妳 variants, traditional-only examples.
  r = convertChineseFixture(["cedict.u8"], {
    levels: "tocfl.csv", levelName: "TOCFL", frequency: "hsk.csv", examples: "pairs.tsv", examplesScript: "traditional",
  });
  compareDictDir("zh tocfl", path.join(FIXTURES, "ref_dict_zh_tocfl"), "vocab", r.records, r.title);

  // Cantonese: CC-Canto's own jyutping, plus the readings file for the CC-CEDICT part.
  r = convertChineseFixture(["canto.u8", "cedict.u8"], { lang: "yue", jyutping: "canto-readings.txt" });
  compareDictDir("yue", path.join(FIXTURES, "ref_dict_yue"), "vocab", r.records, r.title);

  // A grammar TSV into the grammar slot.
  r = convertChineseFixture(["grammar.tsv"]);
  compareDictDir("zh grammar", path.join(FIXTURES, "ref_dict_zh_grammar"), "grammar", r.records, r.title);

  // A title too long for the device's field is cut on a character boundary.
  r = convertChineseFixture(["cedict.u8"], { title: "一個非常非常非常長的詞典名字會被切短" });
  compareDictDir("zh title", path.join(FIXTURES, "ref_dict_zh_title"), "vocab", r.records, r.title);

  // A Yomitan dictionary converted as Chinese: no reading records.
  const zr = new zip.ZipReader(new Uint8Array(fs.readFileSync(path.join(FIXTURES, "yomitan.zip"))));
  const banks = [];
  for (const e of zr.entries.filter((e) => /^term_bank_\d+\.json$/.test(e.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    banks.push(JSON.parse(new TextDecoder().decode(await zr.readEntry(e))));
  }
  const yomi = dict.convertYomitanRecords(banks, null, /*readingRecords=*/false);
  const meta = JSON.parse(new TextDecoder().decode(await zr.readEntry(zr.findEntry("index.json"))));
  compareDictDir("zh yomitan", path.join(FIXTURES, "ref_dict_zh_yomitan"), "vocab", yomi.records, zh.joinDictTitles([meta.title]));

  // Pure functions the pipeline leans on.
  check("pinyin marks", zh.pinyinToMarks("ni3 hao3 lu:4 ma5 xiu1 gui4") === "nǐ hǎo lǜ ma xiū guì");
  check("zhuyin", zh.pinyinToZhuyin("ni3 hao3 lu:4 ma5 zhi1 xue2 yuan2") === "ㄋㄧˇ ㄏㄠˇ ㄌㄩˋ ˙ㄇㄚ ㄓ ㄒㄩㄝˊ ㄩㄢˊ");
  check("rank to priority", zh.rankToPriority(1) === 255 && zh.rankToPriority(10) === 227 && zh.rankToPriority(1000) === 171 && zh.rankToPriority(100000) === 115);
  check("common nouns stay vocabulary", !zh.isProperNounPinyin("Xing1 qi1 liu4", ["Saturday"]) && zh.isProperNounPinyin("Bei3 jing1", ["Beijing"]));
  check("word boundaries are Unicode, as in Python", zh.isProperNounPinyin("Ge1 lun2 bu4", ["Cristóbal Colón or Christopher Columbus (1451-1506)"])
        && !zh.isProperNounPinyin("Ji1 du1 jiao4", ["Christianity"]));
  check("script of a sentence", zh.sentenceScript("我不是中國人") === "traditional" && zh.sentenceScript("人山人海") === "any");
}

async function testPinyinRuby() {
  console.log("pinyin ruby (vs add_pinyin_ruby.py):");
  const refDir = path.join(FIXTURES, "ref_pinyin");
  if (!fs.existsSync(path.join(ZH, "book.epub")) || !fs.existsSync(refDir)) {
    console.log("  skip (no pinyin fixtures — run test/gen_references.py)");
    return;
  }
  const words = ruby.loadCedictReadings(zhText("cedict.u8"));
  const input = new zip.ZipReader(new Uint8Array(fs.readFileSync(path.join(ZH, "book.epub"))));
  const doc = new TextDecoder().decode(await input.readEntry(input.findEntry("c1.xhtml")));
  for (const [refName, skipTop, zhuyin] of [["book-pinyin.epub", 2, false], ["book-zhuyin.epub", 0, true]]) {
    const skip = skipTop ? ruby.topWords(zh.loadFrequency(zhText("freq.txt")).priorities, skipTop) : new Set();
    const got = ruby.annotateXhtml(doc, words, skip, zhuyin);
    const ref = new zip.ZipReader(new Uint8Array(fs.readFileSync(path.join(refDir, refName))));
    const want = new TextDecoder().decode(await ref.readEntry(ref.findEntry("c1.xhtml")));
    check(`${refName} c1.xhtml`, got === want, got === want ? "" : `\n    got  ${got}\n    want ${want}`);
    // The whole EPUB round-trips with every member and the mimetype first.
    const out = await rubyCommon.rewriteEpub(new Uint8Array(fs.readFileSync(path.join(ZH, "book.epub"))),
                                             async (name, d) => ruby.annotateXhtml(d, words, skip, zhuyin));
    const outZip = new zip.ZipReader(new Uint8Array(await out.blob.arrayBuffer()));
    check(`${refName} members`, outZip.entries.map((e) => e.name).join(",") === input.entries.map((e) => e.name).join(","));
    check(`${refName} annotated count`, out.changed === 1, `${out.changed}`);
  }
}

/* The AI paths, against the firmware's scripts run on the same fixed model answers. */
async function testRubyAi() {
  console.log("AI furigana and pinyin (vs add_furigana_ruby.py / add_pinyin_ruby.py, fixed answers):");
  const refDir = path.join(FIXTURES, "ref_ruby_ai");
  if (!fs.existsSync(path.join(ZH, "ai_zh.xhtml")) || !fs.existsSync(refDir)) {
    console.log("  skip (no ruby AI fixtures — run test/gen_references.py)");
    return;
  }
  const fake = (answers) => async (batch) => (batch.every((t) => t in answers) ? batch.map((t) => answers[t]) : null);
  const zhDoc = zhText("ai_zh.xhtml");
  const charReadings = new Map();
  const words = ruby.loadCedictReadings(zhText("cedict.u8"), charReadings);
  const contextual = await ruby.contextualReadings(documentPassages(zhDoc), charReadings,
                                                   fake(JSON.parse(zhText("ai_zh_answers.json"))));
  for (const [name, zhuyin] of [["zh-pinyin.xhtml", false], ["zh-zhuyin.xhtml", true]]) {
    const got = ruby.annotateXhtml(zhDoc, words, new Set(), zhuyin, contextual);
    const want = fs.readFileSync(path.join(refDir, name), "utf-8");
    check(name, got === want, got === want ? "" : `\n    got  ${got}\n    want ${want}`);
  }
  const jaDoc = zhText("ai_ja.xhtml");
  const spans = await furigana.contextualFurigana(documentPassages(jaDoc), fake(JSON.parse(zhText("ai_ja_answers.json"))));
  const got = furigana.annotateFurigana(jaDoc, spans);
  const want = fs.readFileSync(path.join(refDir, "ja.xhtml"), "utf-8");
  check("ja.xhtml", got === want, got === want ? "" : `\n    got  ${got}\n    want ${want}`);

  // A model that gives no usable answer changes nothing.
  const none = async () => null;
  // Dictionary furigana: kuromoji-style tokens, reading in katakana; "*" or none is skipped.
  const tokens = { "今日は本を読む。": [["今日", "キョウ"], ["は", "ハ"], ["本", "ホン"], ["を", "ヲ"], ["読む", "ヨム"], ["。", "。"]],
                   "取り引きを食べる。": [["取り引き", "トリヒキ"], ["を", "ヲ"], ["食べ", "タベ"], ["る", "ル"], ["。", "。"]],
                   "林さんの本。": [["林", "*"], ["さん", "サン"], ["の", "ノ"], ["本", "ホン"], ["。", "。"]] };
  const tokenize = (t) => (tokens[t] || []).map(([surface_form, reading]) => ({ surface_form, reading }));
  const dictSpans = furigana.dictionaryFurigana(Object.keys(tokens).concat(["かな。"]), tokenize);
  check("dictionary furigana", JSON.stringify([...dictSpans]) === JSON.stringify([
    ["今日は本を読む。", [[0, 2, "きょう"], [3, 4, "ほん"], [5, 6, "よ"]]],
    ["取り引きを食べる。", [[0, 1, "と"], [2, 3, "ひ"], [5, 6, "た"]]],
    ["林さんの本。", [[4, 5, "ほん"]]]]), JSON.stringify([...dictSpans]));

  check("no answer: furigana leaves the document alone",
        furigana.annotateFurigana(jaDoc, await furigana.contextualFurigana(documentPassages(jaDoc), none)) === jaDoc);
  check("no answer: pinyin falls back to the dictionary",
        ruby.annotateXhtml(zhDoc, words, new Set(), false, await ruby.contextualReadings(documentPassages(zhDoc), charReadings, none))
        === ruby.annotateXhtml(zhDoc, words, new Set(), false));
  // The firmware's own alignment cases (tools/furigana_ruby/test_add_furigana_ruby.py).
  const A = (w, r) => JSON.stringify(furigana.alignReading(w, r));
  check("align: okurigana stays bare", A("食べる", "たべる") === JSON.stringify([[0, 1, "た"]]));
  check("align: kana inside the word anchor it", A("取り引き", "とりひき") === JSON.stringify([[0, 1, "と"], [2, 3, "ひ"]]));
  check("align: katakana reading", A("東京", "トウキョウ") === JSON.stringify([[0, 2, "とうきょう"]]));
  check("align: refusals", ["のむ", "taberu"].every((r) => furigana.alignReading("食べる", r) === null)
        && furigana.alignReading("ひらがな", "ひらがな") === null && furigana.alignReading("木", "あいうえおかきくけこ") === null);
  check("sentence split", JSON.stringify(rubyCommon.splitSentences(Array.from("「はい。」と言った。次"))) ===
        JSON.stringify([[0, "「はい。」"], [5, "と言った。"], [10, "次"]]));
}

/* ── Dictionary: vs convert_jmdict.py + gen_dict_spx.py ───────── */

async function testDictYomitan() {
  console.log("dictionary converter, Yomitan (vs convert_jmdict.py):");
  const refDir = path.join(FIXTURES, "ref_dict_yomitan");
  const zipPath = path.join(FIXTURES, "yomitan.zip");
  // Guard like every other fixture-backed case: a missing fixture must skip this one test, not
  // abort the run. Without it a fresh clone -- where no fixture has been generated yet -- died
  // here on ENOENT and reported nothing at all about the cases that could have run.
  if (!fs.existsSync(zipPath) || !fs.existsSync(refDir)) {
    console.log("  skip (no yomitan fixtures — run test/gen_references.py)");
    return;
  }
  const zr = new zip.ZipReader(new Uint8Array(fs.readFileSync(zipPath)));
  const bankEntries = zr.entries
    .filter((e) => /^term_bank_\d+\.json$/.test(e.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const banks = [];
  for (const e of bankEntries) {
    banks.push(JSON.parse(new TextDecoder().decode(await zr.readEntry(e))));
  }
  const { records } = dict.convertYomitanRecords(banks);
  const { idx, dat } = dict.dictWriteBinary(records);
  compareFile("vocab.idx", idx, path.join(refDir, "vocab.idx"));
  compareFile("vocab.dat", dat, path.join(refDir, "vocab.dat"));
  compareFile("vocab.spx", dict.dictGenSpx(idx), path.join(refDir, "vocab.spx"));
}

async function testDictMdx() {
  console.log("dictionary converter, MDict .mdx (vs readmdict + convert_jmdict.py):");
  if (!fs.existsSync(path.join(FIXTURES, "dict.mdx"))) {
    console.log("  skip (no MDX fixtures — rerun gen_references.py with readmdict + python-lzo installed)");
    return;
  }
  const mdx = require("../../js/mdx.js");
  const refDir = path.join(FIXTURES, "ref_dict_mdx");
  // Three variants of the same content: plain zlib (+ one uncompressed
  // record block), Encrypted=2 key index, and LZO-compressed blocks — all
  // must produce the same bytes as the Python reference.
  for (const name of ["dict.mdx", "dict_enc.mdx", "dict_lzo.mdx"]) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
    const { records } = await mdx.convertMdictRecords(bytes);
    const { idx, dat } = dict.dictWriteBinary(records);
    compareFile(`${name} → vocab.idx`, idx, path.join(refDir, "vocab.idx"));
    compareFile(`${name} → vocab.dat`, dat, path.join(refDir, "vocab.dat"));
    compareFile(`${name} → vocab.spx`, dict.dictGenSpx(idx), path.join(refDir, "vocab.spx"));
  }

  // Registration-encrypted (Encrypted=1): the owner passcode decrypts the
  // keyword header (Salsa20/8); without it the readmdict-style key-block
  // scan recovers the same content.
  const regBytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, "dict_reg.mdx")));
  const passcode = { regcode: Uint8Array.from({ length: 16 }, (_, i) => i), userid: "test@example.com" };
  let reg = await mdx.convertMdictRecords(regBytes, null, { passcode });
  check("dict_reg.mdx decrypted via passcode", reg.keysReadVia === "passcode", `got ${reg.keysReadVia}`);
  compareFile("dict_reg.mdx (passcode) → vocab.idx", dict.dictWriteBinary(reg.records).idx, path.join(refDir, "vocab.idx"));
  reg = await mdx.convertMdictRecords(regBytes);
  check("dict_reg.mdx recovered via scan", reg.keysReadVia === "brutal", `got ${reg.keysReadVia}`);
  compareFile("dict_reg.mdx (no passcode) → vocab.idx", dict.dictWriteBinary(reg.records).idx, path.join(refDir, "vocab.idx"));
}

function testDictJmdict() {
  console.log("dictionary converter, JMdict JSON (vs convert_jmdict.py):");
  const refDir = path.join(FIXTURES, "ref_dict_jmdict");
  const data = JSON.parse(fs.readFileSync(path.join(FIXTURES, "jmdict.json"), "utf-8"));
  const records = dict.convertJmdictRecords(data);
  const { idx, dat } = dict.dictWriteBinary(records);
  compareFile("vocab.idx", idx, path.join(refDir, "vocab.idx"));
  compareFile("vocab.dat", dat, path.join(refDir, "vocab.dat"));
  compareFile("vocab.spx", dict.dictGenSpx(idx), path.join(refDir, "vocab.spx"));
}

/* ── Zip writer round-trip via our own reader ─────────────────── */

function testMangaFit() {
  console.log("manga device downscaling (vs convert_manga.py fit_to_device):");
  const X4 = manga.MANGA_DEVICE_TARGETS.x4, X3 = manga.MANGA_DEVICE_TARGETS.x3;
  const eq = (r, w, h, resized) => r.w === w && r.h === h && r.resized === resized;

  // No target → unchanged.
  check("no target keeps size", eq(manga.fitToDeviceSize(2000, 3000, null), 2000, 3000, false));
  // Portrait page downscaled to fit X4 (480×800), aspect preserved.
  check("portrait → X4", eq(manga.fitToDeviceSize(2000, 3000, X4), 480, 720, true));
  // Landscape page fits the ROTATED box (the device rotates it to fill the screen).
  check("landscape → X4 rotated box", eq(manga.fitToDeviceSize(3000, 2000, X4), 720, 480, true));
  // Never upscale: already within the box.
  check("no upscale (fits exactly)", eq(manga.fitToDeviceSize(480, 800, X4), 480, 800, false));
  check("no upscale (smaller)", eq(manga.fitToDeviceSize(400, 800, X4), 400, 800, false));
  // X3 box.
  check("portrait → X3", eq(manga.fitToDeviceSize(1056, 1584, X3), 528, 792, true));
  // Output never exceeds the target box on either axis.
  const r = manga.fitToDeviceSize(1500, 1000, X4);
  check("X4 result within rotated box", r.w <= 800 && r.h <= 480 && r.resized);
}

function testDictPos() {
  console.log("dictionary POS flags (vs convert_jmdict.py pos_flags_*):");
  const V1 = 0x01, V5 = 0x02, VS = 0x04, VK = 0x08, ADJ_I = 0x10, OTHER = 0x20, READING = 0x40;
  const ANY_VERB = V1 | V5 | VS | VK;

  // pos_flags_from_tags: verb classes prefix-match; vt/vi/aux/exp ignored;
  // unknown verb subtype fails open; everything else → OTHER.
  const cases = [
    [["v1"], V1], [["v1-s"], V1],
    [["v5k-s"], V5], [["v5aru"], V5], [["v4r"], V5], [["iv"], V5],
    [["vs-i"], VS], [["vs"], VS],
    [["vk"], VK],
    [["adj-i"], ADJ_I], [["adj-ix"], ADJ_I],
    [["vt", "vi", "aux", "aux-adj", "exp"], 0], // all ignored → no flags
    [["n"], OTHER], [["adj-na"], OTHER],
    [["v-unspec"], ANY_VERB], [["aux-v"], ANY_VERB], // unknown verb / aux-v fail open
    [["v1", "n"], V1 | OTHER],
    [[""], 0], [[], 0],
  ];
  for (const [tags, want] of cases) {
    const got = dict.posFlagsFromTags(tags);
    check(`posFlagsFromTags(${JSON.stringify(tags)})=0x${want.toString(16)}`, got === want, `got 0x${got.toString(16)}`);
  }

  // pos_flags_jmdict aggregates partOfSpeech across all senses.
  check("posFlagsJmdict aggregates senses",
    dict.posFlagsJmdict({ sense: [{ partOfSpeech: ["v5r"] }, { partOfSpeech: ["n"] }] }) === (V5 | OTHER));

  // POS_READING: kana record of a kanji entry is flagged; a kana-only lemma is not.
  const data = { words: [
    { kanji: [{ text: "食べる" }], kana: [{ text: "たべる" }], sense: [{ partOfSpeech: ["v1"] }] },
    { kanji: [], kana: [{ text: "ちょっと" }], sense: [{ partOfSpeech: ["adv"] }] },
  ] };
  const idx = dict.dictWriteBinary(dict.convertJmdictRecords(data)).idx;
  const posByName = {};
  for (let i = 0; i < idx.length / 40; i++) {
    const name = new TextDecoder().decode(idx.subarray(i * 40, i * 40 + 32)).replace(/\0+$/, "");
    posByName[name] = idx[i * 40 + 39];
  }
  check("kanji headword → V1, no READING", posByName["食べる"] === V1);
  check("kana reading of kanji entry → V1|READING", posByName["たべる"] === (V1 | READING));
  check("kana-only lemma → OTHER, no READING", posByName["ちょっと"] === OTHER);
}

async function testZipRoundTrip() {
  console.log("zip writer round-trip:");
  const zw = new zip.ZipWriter();
  const payloadA = new TextEncoder().encode("hello matcha");
  const payloadB = new Uint8Array(70000).map((_, i) => i % 251);
  zw.addFile("Folder/ページ.txt", payloadA);
  zw.addFile("Folder/big.bin", payloadB);
  const blob = zw.toBlob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const zr = new zip.ZipReader(bytes);
  check("entry count", zr.entries.length === 2, `got ${zr.entries.length}`);
  check("utf-8 name", zr.findEntry("Folder/ページ.txt") !== null);
  const a = await zr.readEntryByName("Folder/ページ.txt");
  const b = await zr.readEntryByName("Folder/big.bin");
  check("payload A", binary.bytesEqual(a, payloadA));
  check("payload B", binary.bytesEqual(b, payloadB));
}


/* ── XTC / XTCH page format ──────────────────────────────────── */

/* No Python reference exists (convert_manga.py has no XTC export), so instead of a byte diff
 * these decode the encoder's output exactly the way the firmware's reader does
 * (src/activities/reader/XtcReaderActivity.cpp) and compare against the source pixels. */
function testXtc() {
  console.log("XTC / XTCH page format (vs the firmware's decode):");
  const w = 24, h = 16;
  const gray = new Uint8Array(w*h);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) gray[y*w+x] = (x*10 + y*13) % 256;

  // --- XTG: decode exactly as XtcReaderActivity.cpp:609-619 (MSB first, 0 = black)
  const xtg = manga.encodeXtgPage(gray, w, h, 128);
  {
    const rowBytes = (w+7)>>3;
    const bmp = xtg.subarray(22);
    check('XTG size', xtg.length === 22 + rowBytes*h, `${xtg.length}`);
    check('XTG magic', new DataView(xtg.buffer, xtg.byteOffset).getUint32(0, true) === 0x00475458);
    let bad = 0;
    for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
      const isBlack = !((bmp[y*rowBytes + (x>>3)] >> (7-(x&7))) & 1);
      if (isBlack !== (gray[y*w+x] < 128)) bad++;
    }
    check('XTG pixels round-trip', bad === 0, `${bad} wrong`);
  }

  // --- XTH: decode exactly as XtcReaderActivity.cpp:513-527
  const xth = manga.encodeXthPage(gray, w, h);
  {
    const planeSize = (w*h+7)>>3, colBytes = (h+7)>>3;
    const data = xth.subarray(22);
    const p1 = data.subarray(0, planeSize), p2 = data.subarray(planeSize);
    check('XTH size', xth.length === 22 + planeSize*2, `${xth.length}`);
    check('XTH magic', new DataView(xth.buffer, xth.byteOffset).getUint32(0, true) === 0x00485458);
    let bad = 0;
    for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
      const colIndex = w-1-x, off = colIndex*colBytes + (y>>3), bit = 7-(y&7);
      const v = (((p1[off]>>bit)&1) << 1) | ((p2[off]>>bit)&1);
      // Reader: 0=white, 1=dark gray, 2=light gray, 3=black (photographed on an X4).
      if (v !== [3, 1, 2, 0][gray[y*w+x] >> 6]) bad++;
    }
    check('XTH pixels round-trip', bad === 0, `${bad} wrong`);
  }
  check('XTH rejects height % 8', (()=>{ try { manga.encodeXthPage(new Uint8Array(w*9), w, 9); return false; } catch(e){ return /multiple of 8/.test(e.message); } })());

  // --- container: read back the way XtcParser::readHeader/readTitle/readAuthor/loadChapters do
  {
    const toc = [{ title: "Chapter 1", page: 0 }, { title: "Chapter 2", page: 1 }];
    const file = manga.buildXtcFile([{bytes: xtg, w, h}, {bytes: xtg, w, h}],
      { isHq: false, title: "Test Manga", author: "Test Author", language: "ja", toc });
    const dv = new DataView(file.buffer, file.byteOffset);
    const str = (off, len) => new TextDecoder().decode(file.subarray(off, off + len)).replace(/\0.*$/, "");

    check("XTC magic", dv.getUint32(0, true) === 0x00435458);
    check("version 1.0", file[4] === 1 && file[5] === 0);
    check("pageCount", dv.getUint16(6, true) === 2);
    check("hasMetadata flag", file[9] === 1);
    check("hasChapters flag", file[11] === 1);
    check("currentPage 1-based", dv.getUint32(12, true) === 1);

    // The reader hardcodes these two offsets.
    check("title at 0x38", str(0x38, 128) === "Test Manga", str(0x38, 128));
    check("author at 0xB8", str(0xb8, 64) === "Test Author", str(0xb8, 64));

    const chapterOffset = Number(dv.getBigUint64(0x30, true));
    const indexOffset = Number(dv.getBigUint64(0x18, true));
    const dataOffset = Number(dv.getBigUint64(0x20, true));
    check("metadataOffset == 56", Number(dv.getBigUint64(0x10, true)) === 56);
    check("chapters follow metadata", chapterOffset === 56 + 256);
    check("index follows chapters", indexOffset === chapterOffset + toc.length * 96);
    check("data follows index", dataOffset === indexOffset + 2 * 16);
    // chapterCount is derived from the gap, so the gap must be exactly N*96.
    check("chapter count derivable", (indexOffset - chapterOffset) / 96 === toc.length);
    check("chapter 0 name", str(chapterOffset, 80) === "Chapter 1");
    check("chapter 0 startPage", dv.getUint16(chapterOffset + 0x50, true) === 0);

    check("entry0 offset", Number(dv.getBigUint64(indexOffset, true)) === dataOffset);
    check("entry0 size", dv.getUint32(indexOffset + 8, true) === xtg.length);
    check("entry0 dims", dv.getUint16(indexOffset + 12, true) === w && dv.getUint16(indexOffset + 14, true) === h);
    check("entry1 offset", Number(dv.getBigUint64(indexOffset + 16, true)) === dataOffset + xtg.length);
    check("total size", file.length === dataOffset + xtg.length * 2, `${file.length}`);
    // Byte-identical on a re-run: nothing time- or environment-dependent leaks into the file.
    const again = manga.buildXtcFile([{bytes: xtg, w, h}, {bytes: xtg, w, h}],
      { isHq: false, title: "Test Manga", author: "Test Author", language: "ja", toc });
    check("deterministic output", binary.bytesEqual(file, again));

    // XTCH must announce itself in the CONTAINER magic -- the device takes bit depth from there.
    const hq = manga.buildXtcFile([{bytes: xth, w, h}], { isHq: true, title: "T", author: "A" });
    check("XTCH magic", new DataView(hq.buffer, hq.byteOffset).getUint32(0, true) === 0x48435458,
      "0x" + new DataView(hq.buffer, hq.byteOffset).getUint32(0, true).toString(16));
    check("XTCH without chapters has chapterOffset 0",
      Number(new DataView(hq.buffer, hq.byteOffset).getBigUint64(0x30, true)) === 0);
  }
}

function testMangaMokuro() {
  console.log("\n== manga Mokuro input ==");
  // A real block from Mokuro's own test volume (vol1.mokuro, page 001a.jpg, 827x1170).
  const block = {
    box: [688, 26, 718, 161], vertical: true, font_size: 24,
    lines_coords: [[[688.0, 26.0], [712.0, 26.0], [715.0, 161.0], [691.0, 161.0]]],
    lines: ["すごいのハッ"],
  };
  const id = (x, y) => [Math.trunc(x), Math.trunc(y)];
  const [b] = manga.mokuroTextBlocks([block], id);
  check("mokuro block keeps its text", b.text === "すごいのハッ");
  check("mokuro block box", JSON.stringify(b.box) === "[688,26,718,161]");
  check("mokuro line box is the quad's bounds", JSON.stringify(b.lines) === "[[688,26,715,161]]");
  check("mokuro vertical flag", b.vertical === true);
  const [half] = manga.mokuroTextBlocks([block], (x, y) => [Math.trunc(x / 2), Math.trunc(y / 2)]);
  check("mokuro boxes follow the page resize", JSON.stringify(half.box) === "[344,13,359,80]" &&
    JSON.stringify(half.lines) === "[[344,13,357,80]]");
  const two = { ...block, lines: ["あの", "田舎とかに"],
    lines_coords: [[[700, 10], [720, 10], [720, 60], [700, 60]], [[670, 10], [690, 10], [690, 120], [670, 120]]] };
  const [joined] = manga.mokuroTextBlocks([two], id);
  check("mokuro lines join in order", joined.text === "あの\n田舎とかに" && joined.lines.length === 2);
  const [bare] = manga.mokuroTextBlocks([{ ...two, lines_coords: [] }], id);
  check("mokuro block without quads keeps its text, no lines", bare.text === "あの田舎とかに" && bare.lines.length === 0);
  check("empty mokuro block is dropped", manga.mokuroTextBlocks([{ ...block, lines: ["  "] }], id).length === 0);

  const panels = [[0, 0, 500, 400], [0, 400, 500, 800]];
  const top = { box: [100, 100, 120, 200] }, bottom = { box: [100, 450, 120, 600] }, gutter = { box: [100, 390, 120, 405] };
  const owned = manga.assignBlocksToPanels([top, bottom, gutter], panels);
  check("blocks go to the panel holding their centre", owned[0].length === 2 && owned[0][1] === gutter && owned[1][0] === bottom);
  const stray = { box: [380, 380, 390, 390] };
  const far = manga.assignBlocksToPanels([stray], [[0, 0, 100, 100], [400, 400, 500, 500]]);
  check("a block outside every panel goes to the nearest", far[0].length === 0 && far[1][0] === stray);

  const vol = manga.parseMokuroVolume(JSON.stringify({
    title: "うちの猫", volume: "vol2", pages: [{ img_path: "001.webp", img_width: 800, img_height: 1200, blocks: [block] }, { img_width: 1 }],
  }), "Series/vol2.mokuro");
  check("mokuro volume: image folder named after the file", vol.folder === "vol2");
  const mo = manga.parseMokuroVolume(JSON.stringify({ title: "S", pages: [{ img_path: "1.jpg" }] }), "S/vol3.mo.mokuro");
  check("mokuro volume: a .mo.mokuro file also finds its images in vol3/", JSON.stringify(mo.folders) === '["vol3.mo","vol3"]'
    && mo.volume === "vol3", JSON.stringify(mo));
  check("mokuro: macOS litter in an archive is not a volume",
    manga.isMokuroMember("S/vol1.mokuro") && !manga.isMokuroMember("__MACOSX/S/._vol1.mokuro") && !manga.isMokuroMember("S/._vol1.mokuro"));
  check("mokuro volume: pages without an image are dropped", vol.pages.length === 1 && vol.pages[0].imgPath === "001.webp");
  const meta = manga.mokuroMeta(vol);
  check("mokuro meta", meta.title === "うちの猫 vol2" && meta.series === "うちの猫" && meta.seriesIndex === 2 && meta.language === "ja");
  check("webp and avif count as page images", manga.isImageName("a.webp") && manga.isImageName("a.AVIF"));
}

/* PP-OCR's pre- and post-processing: sizes, DB boxes, CTC decoding and bubble grouping. */
function testPpocr() {
  check("ppocr: page fits 960 on the long side in multiples of 32",
    JSON.stringify(ppocr.ppocrDetSize(888, 1238)) === JSON.stringify({ w: 704, h: 960 }));
  const strip = ppocr.ppocrDetSize(800, 6000);
  check("ppocr: a long strip gets a 3:4 page's pixel budget", strip.w % 32 === 0 && strip.w * strip.h < 0.8 * 960 * 960);

  // A 40x40 map with one confident 4x20 vertical stroke and one faint blob.
  const mw = 40, mh = 40, pred = new Float32Array(mw * mh);
  for (let y = 10; y < 30; y++) for (let x = 18; x < 22; x++) pred[y * mw + x] = 0.9;
  for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) pred[y * mw + x] = 0.2;
  const boxes = ppocr.ppocrDbBoxes(pred, mw, mh);
  check("ppocr: one box for the stroke, the faint blob dropped", boxes.length === 1, JSON.stringify(boxes));
  const [x1, y1, x2, y2] = boxes[0];
  check("ppocr: box grown by the unclip offset", x1 < 18 && x2 > 21 && y1 < 10 && y2 > 29 && x1 > 15, JSON.stringify(boxes[0]));

  const vocab = ["", "ね", "こ", " "];
  // steps: ね ね blank こ こ → ねこ
  const logits = new Float32Array([0, 5, 0, 0, 0, 5, 0, 0, 5, 0, 0, 0, 0, 0, 5, 0, 0, 0, 5, 0]);
  check("ppocr: CTC collapses repeats and blanks", ppocr.ppocrCtcDecode(logits, 5, 4, vocab) === "ねこ");
  check("ppocr: recogniser width follows the line's shape", ppocr.ppocrRecWidth(300, 48) === 300 && ppocr.ppocrRecWidth(5, 48) === 16
    && ppocr.ppocrRecWidth(1000, 48) === 1000 && ppocr.ppocrRecWidth(1999, 48) < ppocr.ppocrRecWidth(2001, 48)
    && ppocr.ppocrRecWidth(9000, 48) === 3200);

  const blocks = ppocr.ppocrBubbles([
    { text: "それじゃあ", box: [370, 110, 390, 200], vertical: true },
    { text: "お別れだ", box: [347, 110, 367, 185], vertical: true },
    { text: "019", box: [65, 1178, 119, 1188], vertical: false },
    { text: "漢字の読み", box: [300, 300, 324, 420], vertical: true },
    { text: "かんじ", box: [326, 300, 336, 340], vertical: true },
  ]);
  check("ppocr: columns of one bubble merged right to left, page number and furigana dropped",
    blocks.length === 2 && blocks.some((b) => b.lines.join("|") === "それじゃあ|お別れだ")
    && blocks.some((b) => b.lines.join("|") === "漢字の読み"), JSON.stringify(blocks.map((b) => b.lines)));
  check("ppocr: blocks carry mokuro line quads", blocks.every((b) => b.lines_coords.length === b.lines.length));
  // A column the detector split at a mark (〝穴〟の下の, crop 01 of manga-ocr's examples) is one line.
  const joined = ppocr.ppocrBubbles([
    { text: "立川で見た", box: [131, 15, 173, 201], vertical: true },
    { text: "穴", box: [80, 19, 114, 97], vertical: true },
    { text: "の下の", box: [78, 82, 113, 197], vertical: true },
    { text: "巨大な眼は…", box: [22, 17, 64, 242], vertical: true },
  ]);
  check("ppocr: pieces of one column joined, top to bottom",
    JSON.stringify(joined.map((b) => b.lines)) === JSON.stringify([["立川で見た", "穴の下の", "巨大な眼は…"]]),
    JSON.stringify(joined.map((b) => b.lines)));
  const stacked = ppocr.ppocrBubbles([
    { text: "上の吹き出し", box: [100, 10, 120, 130], vertical: true },
    { text: "下の吹き出し", box: [100, 170, 120, 290], vertical: true },
  ]);
  check("ppocr: columns a bubble apart stay separate", stacked.length === 2);
  // Two bubbles side by side (crop 04): the right one first, the left one first with rtl off.
  const pair = [
    { text: "退治してよ!!", box: [15, 9, 31, 113], vertical: true },
    { text: "早くあいつを", box: [36, 9, 53, 112], vertical: true },
    { text: "よかったじゃ", box: [174, 10, 191, 110], vertical: true },
    { text: "ないわよ!!", box: [151, 10, 168, 96], vertical: true },
  ];
  check("ppocr: bubbles in a row read right to left",
    ppocr.ppocrBubbles(pair).map((b) => b.lines[0]).join("|") === "よかったじゃ|早くあいつを");
  check("ppocr: left to right with rtl off",
    ppocr.ppocrBubbles(pair, false).map((b) => b.lines[0]).join("|") === "早くあいつを|よかったじゃ");
  const rows = ppocr.ppocrReadingOrder([{ box: [0, 300, 50, 400] }, { box: [200, 0, 250, 100] }, { box: [0, 10, 50, 90] }]);
  check("ppocr: rows top to bottom", rows.map((b) => b.box[1]).join(",") === "0,10,300");
  // float16 round trips, as the FP16 models take and return them.
  const halves = [[0, 0x0000], [1, 0x3c00], [-2, 0xc000], [0.5, 0x3800], [65504, 0x7bff], [1e6, 0x7c00],
    [2 ** -24, 0x0001], [1 / 3, 0x3555], [-0.485 / 0.229, 0xc03c]];
  check("ppocr: float32 to float16 bits", halves.every(([v, h]) => ppocr.ppocrToHalf(v) === h),
    JSON.stringify(halves.map(([v]) => ppocr.ppocrToHalf(v).toString(16))));
  check("ppocr: float16 bits back to numbers", halves.every(([v, h]) => h === 0x7c00 || Math.abs(ppocr.ppocrFromHalf(h) - v) <= Math.abs(v) / 1024));
  const asHalf = ppocr.ppocrValues({ type: "float16", data: new Uint16Array([0x3c00, 0xc000]) });
  check("ppocr: a float16 tensor is read as numbers", asHalf[0] === 1 && asHalf[1] === -2);
  // PP-OCR's page record goes through the same mapping as a Mokuro page's, line boxes included.
  const mapped = manga.mokuroTextBlocks(blocks, (x, y) => [Math.trunc(x / 2), Math.trunc(y / 2)]);
  check("ppocr: blocks map to the page with a box per line",
    mapped.length === 2 && mapped.every((b, i) => b.lines.length === blocks[i].lines.length && b.text.includes("\n") === b.lines.length > 1),
    JSON.stringify(mapped));

  // Confidence, for the text check: the least certain character of a line.
  const probs = new Float32Array([0, 0.9, 0.1, 0, 0, 0.6, 0.4, 0, 1, 0, 0, 0, 0, 0, 0.95, 0.05, 0, 0, 0.99, 0.01]);
  const read = ppocr.ppocrCtcRead(probs, 5, 4, vocab);
  check("ppocr: a line's confidence is its least certain character", read.text === "ねこ" && Math.abs(read.conf - 0.9) < 1e-6,
    JSON.stringify(read));
  check("ppocr: an empty read has no confidence", ppocr.ppocrCtcRead(new Float32Array([1, 0, 0, 0]), 1, 4, vocab).conf === 0);
  const dots = ppocr.ppocrCtcRead(new Float32Array([0, 0.95, 0.05, 0, 0.3, 0.15, 0.15, 0.4]), 2, 4, ["", "ね", "こ", "…"]);
  check("ppocr: punctuation does not make a line unsure", dots.text === "ね…" && Math.abs(dots.conf - 0.95) < 1e-6,
    JSON.stringify(dots));
  const sure = ppocr.ppocrBubbles([
    { text: "それじゃあ", box: [370, 110, 390, 200], vertical: true, conf: 0.99 },
    { text: "お別れだ", box: [347, 110, 367, 185], vertical: true, conf: 0.4 },
  ]);
  check("ppocr: blocks carry one confidence per line, in line order",
    JSON.stringify(sure[0].lines_conf) === "[0.99,0.4]", JSON.stringify(sure));
  const split = ppocr.ppocrBubbles([
    { text: "穴", box: [80, 19, 114, 97], vertical: true, conf: 0.7 },
    { text: "の下の", box: [78, 82, 113, 197], vertical: true, conf: 1 },
  ]);
  check("ppocr: a joined column keeps its less certain piece's confidence", JSON.stringify(split[0].lines_conf) === "[0.7]",
    JSON.stringify(split));
  check("ppocr: the unsure bar sits between misread and correct lines", ppocr.PPOCR_UNSURE_CONF > 0.5 && ppocr.PPOCR_UNSURE_CONF < 0.9);

  // The text check's line edits.
  const tb = manga.mokuroTextBlocks(sure, (x, y) => [x, y])[0];
  check("text check: confidence reaches the page's text blocks", JSON.stringify(tb.conf) === "[0.99,0.4]", JSON.stringify(tb));
  check("text check: a block's lines pair text, box and confidence",
    JSON.stringify(manga.textBlockLines(tb).map((l) => [l.text, l.conf])) === '[["それじゃあ",0.99],["お別れだ",0.4]]');
  const fixedLine = manga.textBlockFromLines(tb, manga.textBlockLines(tb).map((l, i) => (i === 1 ? { ...l, text: "お別れね", conf: 1 } : l)));
  check("text check: a fixed line keeps its box and is no longer unsure",
    fixedLine.text === "それじゃあ\nお別れね" && fixedLine.lines.length === 2 && JSON.stringify(fixedLine.conf) === "[0.99,1]"
    && JSON.stringify(fixedLine.lines[1]) === JSON.stringify(tb.lines[1]), JSON.stringify(fixedLine));
  const dropped = manga.textBlockFromLines(tb, manga.textBlockLines(tb).map((l, i) => (i === 0 ? { ...l, text: "  " } : l)));
  check("text check: clearing a line removes it and its box",
    dropped.text === "お別れだ" && dropped.lines.length === 1 && JSON.stringify(dropped.lines[0]) === JSON.stringify(tb.lines[1]),
    JSON.stringify(dropped));
  check("text check: clearing every line removes the block",
    manga.textBlockFromLines(tb, manga.textBlockLines(tb).map((l) => ({ ...l, text: "" }))) === null);
  const noBoxes = { box: [0, 0, 10, 10], text: "ゴゴゴ", lines: [], vertical: true };
  check("text check: a block without line boxes is edited as one line",
    manga.textBlockLines(noBoxes).length === 1 && manga.textBlockFromLines(noBoxes, [{ text: "ゴゴ\nゴ", box: noBoxes.box, conf: 1 }]).text === "ゴゴゴ");
  const added = manga.textBlockFromBox([100, 50, 160, 250], "ここに\n\n何かが\nある ", true);
  check("text check: an added vertical bubble has one column per line, right to left",
    added.text === "ここに\n何かが\nある" && added.added === true && added.vertical
    && JSON.stringify(added.lines) === "[[140,50,160,250],[120,50,140,250],[100,50,120,250]]"
    && JSON.stringify(added.conf) === "[1,1,1]", JSON.stringify(added));
  const across = manga.textBlockFromBox([0, 0, 300, 90], "HELLO\nTHERE", false);
  check("text check: an added horizontal bubble has one row per line, top to bottom",
    JSON.stringify(across.lines) === "[[0,0,300,45],[0,45,300,90]]", JSON.stringify(across));
  check("text check: an added bubble with no text has no lines", manga.textBlockFromBox([0, 0, 10, 10], " \n ", true).text === "");
  const scaled = manga.scaleTextBlocks([tb], 400, 1200, 200, 600)[0];
  check("text check: fixed text follows the page to another size",
    JSON.stringify(scaled.box) === JSON.stringify(tb.box.map((v) => Math.round(v / 2)))
    && JSON.stringify(scaled.lines[0]) === JSON.stringify(tb.lines[0].map((v) => Math.round(v / 2))) && scaled.text === tb.text);
}


(async () => {
  testManga();
  testMangaLayouts();
  testMangaPanelOrderCases();
  testMangaBookType();
  testMangaDither();
  testMangaOcrPrompt();
  testMangaLineBoxes();
  testXtc();
  testMangaFolderedSort();
  testMangaArchiveChapters();
  testXtchDither();
  testXmlUnescape();
  testMangaSourceMetadata();
  testMangaInkCoverage();
  testMangaToc();
  testMangaMono();
  testMangaFit();
  await testMangaEpub();
  testMangaCoverGate();
  testMangaBubbleCrops();
  testPilBoxResize();
  await testMangaYoloPost();
  await testMangaYolo();
  await testDictYomitan();
  testDictJmdict();
  await testDictMdx();
  testDictPos();
  await testDictChinese();
  await testPinyinRuby();
  await testRubyAi();
  await testZipRoundTrip();
  testMangaMokuro();
  testPpocr();
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nall tests passed");
})();
