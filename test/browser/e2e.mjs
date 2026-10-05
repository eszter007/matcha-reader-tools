#!/usr/bin/env node
/* End-to-end tests: drive the real pages in Chromium via Playwright.
 *
 *   - fonts.html: convert DejaVuSans.ttf at 14pt/latin-ext, then compare the
 *     .cpfont structurally against the Python reference (test/font_compare.py).
 *   - manga.html: convert a CBZ of the synthetic pages with OCR skipped and
 *     byte-compare panels.idx/panels.dat against the Python reference.
 *
 *   - dictionary.html (Chinese, Cantonese) and ruby.html (furigana, pinyin; Gemini stubbed):
 *     byte-compare against the firmware tools' output for the same inputs and model answers.
 *
 * Prereqs: `python3 test/gen_references.py` has been run, and the reference
 * .cpfont exists (see test/README.md).
 */
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const OUT = path.join(FIXTURES, "e2e_out");
const FONT_PATH = process.env.TEST_FONT || "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
               ".css": "text/css", ".wasm": "application/wasm" };

function serve(rootDir) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(rootDir, p);
    if (!file.startsWith(rootDir) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); failures++; }
}

async function downloadFromPage(page, action) {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 300000 }), action()]);
  const target = path.join(OUT, download.suggestedFilename());
  await download.saveAs(target);
  return target;
}

function unzipTo(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync("python3", ["-c", `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z: z.extractall(sys.argv[2])
`, zipFile, destDir]);
}

/* The manga page remembers the last run's format, resolution and panels-only choice in
 * localStorage and restores them on load, so one test's settings would otherwise carry
 * into the next (a leftover "xtc" plus a "full" resolution is a validation error, and the
 * run never starts). Every manga test therefore states the whole form, not just the parts
 * it cares about. Formats and resolution start unpicked on a fresh profile anyway -- the
 * page rejects an empty choice rather than guessing one. */
const MANGA_FORMATS = ["matcha", "epub", "xtc", "xtch"];

/* manga.html with every collapsible section open. The detection and output options sit in
 * <details> blocks that start closed, and Playwright will not operate a control it cannot see. */
async function gotoManga(page, base) {
  await page.goto(`${base}/manga.html`);
  await page.$$eval("details", (ds) => ds.forEach((d) => { d.open = true; }));
}

/* bookType: the page refuses to run until one is picked. "manga" (right to left) is what the
 * references are generated with -- convert_manga.py's default order. */
async function setMangaForm(page, { formats = ["matcha"], res = "full", panelsOnly = false, bookType = "manga" }) {
  await page.selectOption("#manga-booktype", bookType);
  for (const f of MANGA_FORMATS) {
    const sel = `#manga-format .fmt[value="${f}"]`;
    if (formats.includes(f)) await page.check(sel); else await page.uncheck(sel);
  }
  if (panelsOnly) await page.check("#manga-panels-only"); else await page.uncheck("#manga-panels-only");
  await page.selectOption("#manga-res", res);
}

/* Page count from an XTC/XTCH container header (u16 at offset 6). */
function xtcPageCount(file) {
  return fs.readFileSync(file).readUInt16LE(6);
}

function filesEqual(a, b) {
  const ba = fs.readFileSync(a), bb = fs.readFileSync(b);
  return ba.length === bb.length && ba.equals(bb);
}

async function testDictMdx(page, base) {
  console.log("dictionary.html end-to-end (MDict .mdx):");
  if (!fs.existsSync(path.join(FIXTURES, "dict.mdx"))) {
    console.log("  skip (no MDX fixtures — rerun gen_references.py with readmdict + python-lzo installed)");
    return;
  }
  await page.goto(`${base}/dictionary.html`);
  await page.setInputFiles("#dict-file", path.join(FIXTURES, "dict.mdx"));
  const zipFile = await downloadFromPage(page, () => page.click("#dict-run"));
  const dest = path.join(OUT, "dict_mdx");
  unzipTo(zipFile, dest);
  for (const ext of ["idx", "dat", "spx"]) {
    const ref = path.join(FIXTURES, "ref_dict_mdx", `vocab.${ext}`);
    const got = path.join(dest, "dict", `vocab.${ext}`);
    check(`vocab.${ext} matches Python reference`, fs.existsSync(got) && filesEqual(ref, got));
  }

  // Registration-encrypted variant, with the passcode entered in the UI.
  await page.goto(`${base}/dictionary.html`);
  await page.setInputFiles("#dict-file", path.join(FIXTURES, "dict_reg.mdx"));
  await page.evaluate(() => { document.getElementById("dict-regcode").closest("details").open = true; });
  await page.fill("#dict-regcode", "000102030405060708090a0b0c0d0e0f");
  await page.fill("#dict-userid", "test@example.com");
  const zipFile2 = await downloadFromPage(page, () => page.click("#dict-run"));
  const dest2 = path.join(OUT, "dict_mdx_reg");
  unzipTo(zipFile2, dest2);
  for (const ext of ["idx", "dat", "spx"]) {
    const ref = path.join(FIXTURES, "ref_dict_mdx", `vocab.${ext}`);
    const got = path.join(dest2, "dict", `vocab.${ext}`);
    check(`encrypted .mdx with passcode: vocab.${ext} matches`, fs.existsSync(got) && filesEqual(ref, got));
  }
}

async function testFonts(page, base) {
  console.log("fonts.html end-to-end:");
  await page.goto(`${base}/fonts.html`);
  await page.setInputFiles("#font-regular", FONT_PATH);
  for (const size of [12, 16, 18]) await page.uncheck(`#font-size-${size}`);
  // latin-ext is checked by default — matches the Python reference run.
  const zipFile = await downloadFromPage(page, () => page.click("#font-run"));
  const dest = path.join(OUT, "font");
  unzipTo(zipFile, dest);
  // <Family>/<Family>_14.cpfont, with the family the tool read from the font -- DejaVuSans in
  // CI, whatever TEST_FONT points at elsewhere.
  const families = fs.existsSync(path.join(dest, ".fonts")) ? fs.readdirSync(path.join(dest, ".fonts")) : [];
  const family = families.length === 1 ? families[0] : "";
  const cpfont = path.join(dest, ".fonts", family, `${family}_14.cpfont`);
  check("cpfont produced at expected path", family !== "" && fs.existsSync(cpfont), `families: ${families}`);
  if (process.platform === "darwin") {
    // The page rasterises with the browser's font engine: CoreText on macOS, not the FreeType
    // fontconvert_sdcard.py uses, so bitmaps land a pixel past the tolerance for reasons that
    // say nothing about this code. Compared on Linux only.
    console.log("  skip cpfont structural comparison (macOS: CoreText rasteriser, not FreeType)");
  } else if (fs.existsSync(cpfont)) {
    let result;
    try {
      result = execFileSync("python3", [
        path.join(ROOT, "test", "font_compare.py"),
        path.join(FIXTURES, "ref_font", "DejaVuSans_14.cpfont"), cpfont,
      ], { encoding: "utf-8" });
    } catch (e) {
      result = (e.stdout || "") + (e.stderr || "");
    }
    process.stdout.write(result.split("\n").map((l) => "    " + l).join("\n") + "\n");
    check("cpfont structural comparison", result.includes("STRUCTURAL MATCH"));
  }
}

async function testManga(page, base) {
  console.log("manga.html end-to-end (CBZ, no OCR, grid detection):");
  await gotoManga(page, base);
  await page.setInputFiles("#manga-file", path.join(FIXTURES, "manga.cbz"));
  await page.check("#manga-no-ocr");
  await page.uncheck("#manga-yolo"); // byte-exact references use the grid path
  // References are generated with no device downscaling, so "full" is the matching pick.
  await setMangaForm(page, { formats: ["matcha"], res: "full" });
  await page.fill("#manga-title", "Test Manga");
  await page.fill("#manga-author", "Test Author");
  const zipFile = await downloadFromPage(page, () => page.click("#manga-run"));
  const dest = path.join(OUT, "manga");
  unzipTo(zipFile, dest);
  const dir = path.join(dest, "Test Manga");
  for (const f of ["panels.idx", "panels.dat", "meta.bin"]) {
    const ref = path.join(FIXTURES, "ref_manga", f);
    const got = path.join(dir, f);
    check(`${f} matches Python reference`, fs.existsSync(got) && filesEqual(ref, got));
  }
  for (let i = 0; i < 3; i++) {
    const name = `page_${String(i).padStart(4, "0")}.png`;
    check(`${name} copied`, fs.existsSync(path.join(dir, name)));
  }
}

/* Panel rectangles per page, via parsePanelsDat below. */
function parsePanelBoxes(dir) {
  return parsePanelsDat(dir).map((pg) => pg.panels.map((p) => p.box));
}

async function testMangaYolo(page, base) {
  console.log("manga.html end-to-end (CBZ, no OCR, AI panel detection):");
  const refPath = path.join(FIXTURES, "ref_yolo", "boxes.json");
  if (!fs.existsSync(refPath)) {
    console.log("  skip (no ref_yolo fixtures — rerun gen_references.py with numpy + onnxruntime installed)");
    return;
  }
  const ref = JSON.parse(fs.readFileSync(refPath, "utf-8"));
  await gotoManga(page, base);
  await page.setInputFiles("#manga-file", path.join(FIXTURES, "manga.cbz"));
  await page.check("#manga-no-ocr");
  await page.check("#manga-yolo");
  await setMangaForm(page, { formats: ["matcha"], res: "full" });
  await page.fill("#manga-title", "Yolo Manga");
  const zipFile = await downloadFromPage(page, () => page.click("#manga-run"));
  const dest = path.join(OUT, "manga_yolo");
  unzipTo(zipFile, dest);
  const pages = parsePanelBoxes(path.join(dest, "Yolo Manga"));
  const names = Object.keys(ref).sort();
  check("page count", pages.length === names.length, `got ${pages.length}`);
  // Same tolerance rationale as the Node test: inference backends round
  // floats differently, so ±2 px rather than byte-exact.
  const TOL = 2;
  for (let p = 0; p < names.length && p < pages.length; p++) {
    const expected = ref[names[p]];
    const got = pages[p];
    const ok = got.length === expected.length &&
               got.every((b, i) => b.every((v, j) => Math.abs(v - expected[i][j]) <= TOL));
    check(`${names[p]} ${expected.length} panel(s) within ±${TOL}px`, ok,
          ok ? "" : `got ${JSON.stringify(got)}, reference ${JSON.stringify(expected)}`);
  }
}

async function testMangaEpub(page, base) {
  console.log("manga.html end-to-end (EPUB with nav TOC, no OCR):");
  await gotoManga(page, base);
  await page.setInputFiles("#manga-file", path.join(FIXTURES, "manga.epub"));
  await page.check("#manga-no-ocr");
  await page.uncheck("#manga-yolo");
  await setMangaForm(page, { formats: ["matcha"], res: "full" });
  const zipFile = await downloadFromPage(page, () => page.click("#manga-run"));
  const dest = path.join(OUT, "manga_epub");
  unzipTo(zipFile, dest);
  const dir = path.join(dest, "Epub Test Manga"); // title from dc:title
  for (const f of ["panels.idx", "panels.dat", "meta.bin", "toc.idx"]) {
    const ref = path.join(FIXTURES, "ref_manga_epub", f);
    const got = path.join(dir, f);
    check(`${f} matches Python reference`, fs.existsSync(got) && filesEqual(ref, got));
  }
}

async function testMangaPdf(page, base) {
  console.log("manga.html end-to-end (PDF, no OCR, grid detection):");
  const refDir = path.join(FIXTURES, "ref_manga_pdf");
  if (!fs.existsSync(refDir)) {
    console.log("  skip (no ref_manga_pdf fixtures — rerun gen_references.py with pymupdf installed)");
    return;
  }
  await gotoManga(page, base);
  await page.setInputFiles("#manga-file", path.join(FIXTURES, "manga.pdf"));
  await page.check("#manga-no-ocr");
  await page.uncheck("#manga-yolo");
  await setMangaForm(page, { formats: ["matcha"], res: "full" });
  const zipFile = await downloadFromPage(page, () => page.click("#manga-run"));
  const dest = path.join(OUT, "manga_pdf");
  unzipTo(zipFile, dest);
  const dir = path.join(dest, "Pdf Test Manga"); // title from PDF metadata
  check("output folder named from PDF Title", fs.existsSync(dir));
  if (!fs.existsSync(dir)) return;

  // Metadata flows through byte-identically; the rasterized pixels do not
  // (PyMuPDF and PDF.js decode the embedded JPEGs slightly differently), so
  // panel boxes are compared with a small tolerance instead of byte-compare.
  check("meta.bin matches Python reference",
        filesEqual(path.join(refDir, "meta.bin"), path.join(dir, "meta.bin")));
  const got = parsePanelBoxes(dir);
  const ref = parsePanelBoxes(refDir);
  check("page count", got.length === ref.length, `got ${got.length}, reference ${ref.length}`);
  const TOL = 2;
  for (let p = 0; p < Math.min(got.length, ref.length); p++) {
    const ok = got[p].length === ref[p].length &&
               got[p].every((b, i) => b.every((v, j) => Math.abs(v - ref[p][i][j]) <= TOL));
    check(`pdf page ${p}: ${ref[p].length} panel(s) within ±${TOL}px`, ok,
          ok ? "" : `got ${JSON.stringify(got[p])}, reference ${JSON.stringify(ref[p])}`);
  }
  for (let i = 0; i < got.length; i++) {
    const name = `page_${String(i).padStart(4, "0")}.png`;
    check(`${name} present`, fs.existsSync(path.join(dir, name)));
  }
}

/* Panels-only on borderless pages: every page is a single full-page panel, which is
 * the one shape with no full page behind it to fall back on. That combination used to
 * throw "drawImage ... value is not of type ..." -- the full-resolution source canvas
 * was allocated only for pages with a non-full-page panel, but panels-only cropped
 * from it anyway -- and, once merely guarded, silently dropped those pages from the
 * pre-rendered exports. So the check is that every source page reaches the XTC. */
/* Full panels.idx/panels.dat reader, including the v2 per-panel translation and the
 * text blocks (parsePanelBoxes above only walks the no-OCR layout). Returns
 * [{w, h, panels: [{box, translation, texts: [{box, text}]}]}]. */
function parsePanelsDat(dir) {
  const idx = fs.readFileSync(path.join(dir, "panels.idx"));
  const dat = fs.readFileSync(path.join(dir, "panels.dat"));
  const version = idx.readUInt32LE(0);
  const pages = [];
  for (let p = 0; p < idx.readUInt32LE(4); p++) {
    let off = idx.readUInt32LE(8 + p * 12);
    const end = off + idx.readUInt32LE(8 + p * 12 + 4);
    const w = idx.readUInt16LE(8 + p * 12 + 8), h = idx.readUInt16LE(8 + p * 12 + 10);
    const count = dat.readUInt8(off);
    off += 2;
    const panels = [];
    for (let i = 0; i < count; i++) {
      const x = dat.readUInt16LE(off), y = dat.readUInt16LE(off + 2);
      const pw = dat.readUInt16LE(off + 4), ph = dat.readUInt16LE(off + 6);
      const textCount = dat.readUInt8(off + 8);
      const trLen = dat.readUInt16LE(off + 10);
      off += 12;
      const translation = dat.subarray(off, off + trLen).toString("utf-8");
      off += trLen;
      let crop = null;
      if (version >= 3) {  // the page region the panel's crop image shows
        const cx = dat.readUInt16LE(off), cy = dat.readUInt16LE(off + 2);
        crop = [cx, cy, cx + dat.readUInt16LE(off + 4), cy + dat.readUInt16LE(off + 6)];
        off += 8;
      }
      const texts = [];
      for (let t = 0; t < textCount; t++) {
        // Stored as x, y, w, h since v3 (raw corners before); returned as corners.
        const bx = dat.readUInt16LE(off), by = dat.readUInt16LE(off + 2);
        const box = [bx, by, bx + dat.readUInt16LE(off + 4), by + dat.readUInt16LE(off + 6)];
        const len = dat.readUInt16LE(off + 8);
        off += 10;
        const text = dat.subarray(off, off + len).toString("utf-8");
        off += len;
        const lines = [];
        let vertical = false;
        if (version >= 3) {
          const lineCount = dat.readUInt8(off);
          vertical = (dat.readUInt8(off + 1) & 1) !== 0;
          off += 2;
          for (let l = 0; l < lineCount; l++) {
            const lx = dat.readUInt16LE(off), ly = dat.readUInt16LE(off + 2);
            lines.push([lx, ly, lx + dat.readUInt16LE(off + 4), ly + dat.readUInt16LE(off + 6)]);
            off += 8;
          }
        }
        texts.push({ box, text, lines, vertical });
      }
      panels.push({ box: [x, y, x + pw, y + ph], crop, translation, texts });
    }
    if (off !== end) throw new Error(`panels.dat page ${p}: ${end - off} byte(s) not consumed`);
    pages.push({ w, h, panels });
  }
  return pages;
}

/* The Gemini OCR path, with the API stubbed so it runs without a key or a network call.
 * Covers the request the tool actually sends, and what comes back reaching panels.dat.
 *
 * The stub answers with bbox_2d covering the whole crop, so each decoded text box must
 * land exactly on the region that was sent -- the MARGINED panel rect. That pins the bug
 * where the box was mapped from the panel's own corner while being scaled by the margined
 * size, sliding every text box down-right by the crop margin. */
/* Chapter-foldered CBZ: one folder per chapter, page numbering restarting inside each,
 * so ch01/001.png and ch03/001.png share a basename. Pages used to be keyed on that
 * basename, so each chapter's page 1 overwrote the last -- a nine-page archive converted
 * to three, silently, and the survivors read as jumbled chapters. Reported against the
 * XTCH export by a reader whose source was exactly this layout.
 *
 * The fixture gives each chapter a distinct page WIDTH, so panels.idx records the reading
 * order unambiguously: 600,600,600,620,620,620,640,640,640 is ch01,ch02,ch03 in order. */
async function testMangaFolderedCbz(page, base) {
  console.log("manga.html end-to-end (chapter-foldered CBZ, page order):");
  const cbz = path.join(FIXTURES, "manga_foldered.cbz");
  if (!fs.existsSync(cbz)) {
    console.log("  skip (no manga_foldered.cbz — rerun gen_references.py)");
    return;
  }
  await gotoManga(page, base);
  await page.setInputFiles("#manga-file", cbz);
  await page.check("#manga-no-ocr");
  await page.uncheck("#manga-yolo");
  await setMangaForm(page, { formats: ["matcha"], res: "full" });
  await page.fill("#manga-title", "Foldered");
  const zipFile = await downloadFromPage(page, () => page.click("#manga-run"));
  const dest = path.join(OUT, "manga_foldered");
  unzipTo(zipFile, dest);
  const dir = path.join(dest, "Foldered");

  const pages = parsePanelsDat(dir);
  check("every page of every chapter survives", pages.length === 9, `got ${pages.length}`);
  const widths = pages.map((p) => p.w);
  check("pages in chapter order (widths identify the chapter)",
        JSON.stringify(widths) === JSON.stringify([600, 600, 600, 620, 620, 620, 640, 640, 640]),
        JSON.stringify(widths));
  const written = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((n) => /^page_\d+\./.test(n)).sort() : [];
  check("one page image per source page", written.length === 9, `got ${written.length}`);
}

async function testMangaGeminiOcr(page, base) {
  console.log("manga.html end-to-end (Gemini OCR + translations, API stubbed):");
  const MARGIN = 10;                        // the page's default panel crop margin
  const KEY = "stub-key-not-a-real-credential";
  const JP = "テスト";
  const TRANSLATION = "Hello — こんにちは! 🍵";  // multi-byte, to pin the u16 BYTE-length prefix
  const GEMINI = "https://generativelanguage.googleapis.com/**";
  const requests = [];
  await page.route(GEMINI, async (route) => {
    const req = route.request();
    requests.push({ url: req.url(), headers: req.headers(), body: JSON.parse(req.postData() || "{}") });
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        blocks: [{ text: JP, bbox_2d: [0, 0, 1000, 1000], vertical: true,
                   lines: [{ text: JP, bbox_2d: [0, 500, 1000, 1000] }] }],
        translation: TRANSLATION,
      }) }] } }] }),
    });
  });
  try {
    await gotoManga(page, base);
    await page.setInputFiles("#manga-file", path.join(FIXTURES, "manga.cbz"));
    await page.uncheck("#manga-no-ocr");
    await page.uncheck("#manga-yolo");
    await setMangaForm(page, { formats: ["matcha"], res: "full" });
    await page.fill("#manga-key", KEY);
    await page.fill("#manga-title", "Ocr Manga");
    const zipFile = await downloadFromPage(page, () => page.click("#manga-run"));
    const dest = path.join(OUT, "manga_ocr");
    unzipTo(zipFile, dest);

    // What went out on the wire.
    check("Gemini was called", requests.length > 0, `got ${requests.length}`);
    const r = requests[0] || { url: "", headers: {}, body: {} };
    check("calls generateContent for the chosen model",
          r.url.endsWith("/v1beta/models/gemini-3.8-flash:generateContent"), r.url);
    check("sends the key as the x-goog-api-key header (not in the URL)",
          r.headers["x-goog-api-key"] === KEY && !r.url.includes(KEY));
    check("asks for a JSON response",
          r.body.generationConfig?.responseMimeType === "application/json");
    const parts = r.body.contents?.[0]?.parts || [];
    const inline = parts[1]?.inline_data || {};
    const jpeg = Buffer.from(inline.data || "", "base64");
    check("sends prompt + inline JPEG",
          typeof parts[0]?.text === "string" && inline.mime_type === "image/jpeg" &&
          jpeg[0] === 0xff && jpeg[1] === 0xd8);

    // What came back, as written to disk.
    const pages = parsePanelsDat(path.join(dest, "Ocr Manga"));
    // Every panel is read, a full-page one included (from a crop of the page that is not kept):
    // a cover or an unsplittable page would otherwise get no text and so no word lookup.
    const isFullPage = (b, w, h) =>
      (b[2] - b[0]) / w >= 0.95 && (b[3] - b[1]) / h >= 0.95;
    let ocred = 0, fullPage = 0, badBox = 0, badText = 0, outside = 0, badCrop = 0, badLine = 0;
    for (const pg of pages) {
      for (const panel of pg.panels) {
        const [x1, y1, x2, y2] = panel.box;
        if (isFullPage(panel.box, pg.w, pg.h)) fullPage++;
        ocred++;
        if (panel.translation !== TRANSLATION) badText++;
        // The crop handed to the model, in page space -- also what v3 records as the panel's crop.
        const want = [Math.max(0, x1 - MARGIN), Math.max(0, y1 - MARGIN),
                      Math.min(pg.w, x2 + MARGIN), Math.min(pg.h, y2 + MARGIN)];
        if (!panel.crop || panel.crop.some((v, i) => v !== want[i])) badCrop++;
        if (panel.texts.length !== 1) badText++;
        for (const t of panel.texts) {
          if (t.text !== JP) badText++;
          if (t.box.some((v, i) => v !== want[i])) badBox++;
          if (t.box[2] > pg.w || t.box[3] > pg.h) outside++;
          // One vertical line: the right half of that crop, as the stub answered.
          const cw = want[2] - want[0];
          const line = [want[0] + Math.trunc(0.5 * cw), want[1], want[2], want[3]];
          if (!t.vertical || t.lines.length !== 1 || t.lines[0].some((v, i) => v !== line[i])) badLine++;
        }
      }
    }
    check("every panel got its translation and text", ocred > 0 && badText === 0,
          `${ocred} panels, ${badText} wrong`);
    check("text boxes land on the crop the model was shown", badBox === 0, `${badBox} misplaced`);
    check("no text box runs past the page edge", outside === 0, `${outside} outside`);
    check("v3 records each panel's crop rect", badCrop === 0, `${badCrop} wrong`);
    check("v3 line boxes and vertical flag reach panels.dat", badLine === 0, `${badLine} wrong`);
    check("one Gemini call per panel", requests.length === ocred,
          `${requests.length} calls, ${ocred} panels`);
    check("full-page panels are read too", fullPage > 0, `${fullPage} full-page panels in the fixture`);
  } finally {
    await page.unroute(GEMINI);
  }
}

async function testMangaPanelsOnly(page, base) {
  console.log("manga.html end-to-end (panels-only, borderless pages, XTC + EPUB):");
  const cbz = path.join(FIXTURES, "manga_fullbleed.cbz");
  if (!fs.existsSync(cbz)) {
    console.log("  skip (no manga_fullbleed.cbz — rerun gen_references.py)");
    return;
  }
  const pageCount = 3;  // full01..full03, one full-page panel each
  await gotoManga(page, base);
  await page.setInputFiles("#manga-file", cbz);
  await page.check("#manga-no-ocr");
  await page.uncheck("#manga-yolo");
  // XTC needs a fixed page size, hence a device resolution rather than "full".
  await setMangaForm(page, { formats: ["matcha", "epub", "xtc"], res: "x4", panelsOnly: true });
  await page.fill("#manga-title", "Full Bleed");
  const zipFile = await downloadFromPage(page, () => page.click("#manga-run"));
  const dest = path.join(OUT, "manga_panels_only");
  unzipTo(zipFile, dest);

  const xtc = path.join(dest, "Full Bleed.xtc");
  check("XTC produced", fs.existsSync(xtc));
  if (fs.existsSync(xtc)) {
    const got = xtcPageCount(xtc);
    check(`XTC keeps all ${pageCount} pages`, got === pageCount, `got ${got}`);
  }

  const epubFile = path.join(dest, "Full Bleed.epub");
  check("EPUB produced", fs.existsSync(epubFile));
  if (fs.existsSync(epubFile)) {
    const epubDir = path.join(dest, "epub_unzipped");
    unzipTo(epubFile, epubDir);
    const imgDir = path.join(epubDir, "OEBPS", "images");
    const images = fs.existsSync(imgDir) ? fs.readdirSync(imgDir) : [];
    check(`EPUB keeps all ${pageCount} pages`, images.length === pageCount, `got ${images.length}`);
  }

  // The device folder is unaffected by the bug, but its crops are what the XTC pages
  // are built from -- if they are missing, the counts above pass for the wrong reason.
  const crops = path.join(dest, "Full Bleed", "panels");
  const cropFiles = fs.existsSync(crops) ? fs.readdirSync(crops) : [];
  check(`${pageCount} panel crops written`, cropFiles.length === pageCount, `got ${cropFiles.length}`);
}

/* The whole pipeline on a browser WITHOUT OffscreenCanvas -- the branch makeCanvas takes
 * for older Safari/WebKit, where every page and panel is encoded through
 * HTMLCanvasElement.toBlob instead of convertToBlob. Nothing exercised it before, so a
 * break there would have reached those users first. Needs its own context: the global has
 * to be gone before any page script runs, and it must not leak into the other tests.
 *
 * The check is equality, not just "it produced something": the same book converted with
 * and without OffscreenCanvas must come out byte for byte identical. */
async function testMangaNoOffscreenCanvas(browser, base) {
  console.log("manga.html end-to-end (no OffscreenCanvas — the older-Safari path):");
  const setup = async (pg) => {
    await gotoManga(pg, base);
    await pg.setInputFiles("#manga-file", path.join(FIXTURES, "manga.cbz"));
    await pg.check("#manga-no-ocr");
    await pg.uncheck("#manga-yolo");
    await setMangaForm(pg, { formats: ["matcha", "epub", "xtc"], res: "x4" });
    await pg.fill("#manga-title", "NoOffscreen");
  };
  const runIn = async (ctx, dest) => {
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => { console.error("  page error:", e.message); failures++; });
    await setup(pg);
    const zipFile = await downloadFromPage(pg, () => pg.click("#manga-run"));
    unzipTo(zipFile, dest);
    await pg.close();
  };

  const plainCtx = await browser.newContext({ acceptDownloads: true });
  const fallbackCtx = await browser.newContext({ acceptDownloads: true });
  // A browser without it simply lacks the global, so `typeof OffscreenCanvas` is
  // "undefined" -- deleting it is the faithful simulation.
  await fallbackCtx.addInitScript(() => { delete window.OffscreenCanvas; });
  try {
    const withOsc = path.join(OUT, "no_osc_with");
    const without = path.join(OUT, "no_osc_without");
    await runIn(plainCtx, withOsc);
    const probe = await fallbackCtx.newPage();
    await probe.goto(`${base}/manga.html`);
    const seen = await probe.evaluate(() => typeof OffscreenCanvas);
    await probe.close();
    check("OffscreenCanvas really is absent for this run", seen === "undefined", seen);
    await runIn(fallbackCtx, without);

    const walk = (root) => {
      const out = [];
      const rec = (d, pre) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) rec(p, pre + e.name + "/"); else out.push([pre + e.name, p]);
        }
      };
      rec(root, "");
      return out;
    };
    const a = walk(withOsc), b = walk(without);
    check("same set of output files", a.length === b.length && a.every((x, i) => x[0] === b[i][0]),
          `${a.length} vs ${b.length}`);
    const differing = a.filter(([name, p], i) => b[i] && !filesEqual(p, b[i][1])).map(([n]) => n);
    check("every file byte-identical to the OffscreenCanvas run", a.length > 0 && differing.length === 0,
          differing.join(", "));
  } finally {
    await plainCtx.close();
    await fallbackCtx.close();
  }
}

async function testDict(page, base) {
  console.log("dictionary.html end-to-end (Yomitan zip):");
  await page.goto(`${base}/dictionary.html`);
  await page.setInputFiles("#dict-file", path.join(FIXTURES, "yomitan.zip"));
  const zipFile = await downloadFromPage(page, () => page.click("#dict-run"));
  const dest = path.join(OUT, "dict");
  unzipTo(zipFile, dest);
  for (const ext of ["idx", "dat", "spx"]) {
    const ref = path.join(FIXTURES, "ref_dict_yomitan", `vocab.${ext}`);
    const got = path.join(dest, "dict", `vocab.${ext}`);
    check(`vocab.${ext} matches Python reference`, fs.existsSync(got) && filesEqual(ref, got));
  }
}

function zipMember(zipFile, member) {
  return execFileSync("python3", ["-c", `
import sys, zipfile
sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))
`, zipFile, member]).toString("utf-8");
}

async function testDictChinese(page, base) {
  console.log("dictionary.html end-to-end (Chinese and Cantonese):");
  const zh = (n) => path.join(FIXTURES, "zh", n);
  if (!fs.existsSync(zh("cedict.u8")) || !fs.existsSync(path.join(FIXTURES, "ref_dict_zh"))) {
    console.log("  skip (no zh fixtures — run test/gen_references.py)");
    return;
  }
  // Every option at once, as the reference was built: CC-CEDICT + MoE merged, frequency, HSK,
  // simplified examples, names split off, zhuyin.
  await page.goto(`${base}/dictionary.html`);
  await page.selectOption("#dict-lang", "zh");
  check("Chinese starts on a built-in edition, without the file steps",
        await page.isChecked('input[name="dict-edition"][value="simplified"]')
        && !(await page.isVisible("#dict-file-card")) && !(await page.isVisible("#dict-zh-options")));
  await page.check('input[name="dict-edition"][value="own"]');
  await page.setInputFiles("#dict-file", [zh("cedict.u8"), zh("moe.json")]);
  await page.setInputFiles("#dict-frequency", zh("freq.txt"));
  await page.setInputFiles("#dict-levels", zh("hsk.csv"));
  await page.fill("#dict-level-name", "HSK");
  await page.setInputFiles("#dict-examples", zh("pairs.tsv"));
  await page.selectOption("#dict-examples-script", "simplified");
  await page.check("#dict-zhuyin");
  await page.check("#dict-split-names");
  let zipFile = await downloadFromPage(page, () => page.click("#dict-run"));
  let dest = path.join(OUT, "dict_zh");
  unzipTo(zipFile, dest);
  for (const name of ["vocab", "names"]) {
    for (const ext of ["idx", "dat", "spx", "title"]) {
      const got = path.join(dest, "dictionaries", "zh", `${name}.${ext}`);
      check(`zh ${name}.${ext} matches Python reference`,
            fs.existsSync(got) && filesEqual(path.join(FIXTURES, "ref_dict_zh", `${name}.${ext}`), got));
    }
  }
  // The built-in editions: nothing to choose but the edition.
  for (const [lang, edition] of [["zh", "simplified"], ["zh", "traditional"], ["yue", "cantonese"]]) {
    const ref = path.join(FIXTURES, `ref_dict_${lang}_${edition}`);
    if (!fs.existsSync(ref)) { console.log(`  skip ${edition} edition (no reference)`); continue; }
    await page.goto(`${base}/dictionary.html`);
    await page.selectOption("#dict-lang", lang);
    await page.check(`input[name="dict-edition"][value="${edition}"]`);
    zipFile = await downloadFromPage(page, () => page.click("#dict-run"));
    dest = path.join(OUT, `dict_${lang}_${edition}`);
    unzipTo(zipFile, dest);
    let same = true;
    for (const name of ["vocab", "names"]) {
      for (const ext of ["idx", "dat", "spx", "title"]) {
        const got = path.join(dest, "dictionaries", lang, `${name}.${ext}`);
        same &&= fs.existsSync(got) && filesEqual(path.join(ref, `${name}.${ext}`), got);
      }
    }
    check(`built-in ${edition} edition matches convert_jmdict.py on the same sources`, same);
    check(`${edition} download named for its edition`, path.basename(zipFile) === `${lang}-${edition}-dict.zip`, path.basename(zipFile));
  }

  // Cantonese: CC-Canto + CC-CEDICT with the readings file, into dictionaries/yue.
  await page.goto(`${base}/dictionary.html`);
  await page.selectOption("#dict-lang", "yue");
  check("Cantonese starts on its built-in edition",
        await page.isChecked('input[name="dict-edition"][value="cantonese"]') && !(await page.isVisible("#dict-file-card"))
        && !(await page.isVisible('input[name="dict-edition"][value="simplified"]')));
  await page.check('input[name="dict-edition"][value="own"]');
  await page.setInputFiles("#dict-file", [zh("canto.u8"), zh("cedict.u8")]);
  await page.setInputFiles("#dict-jyutping", zh("canto-readings.txt"));
  await page.uncheck("#dict-split-names");
  await page.uncheck("#dict-zhuyin");
  zipFile = await downloadFromPage(page, () => page.click("#dict-run"));
  dest = path.join(OUT, "dict_yue");
  unzipTo(zipFile, dest);
  for (const ext of ["idx", "dat", "spx", "title"]) {
    const got = path.join(dest, "dictionaries", "yue", `vocab.${ext}`);
    check(`yue vocab.${ext} matches Python reference`,
          fs.existsSync(got) && filesEqual(path.join(FIXTURES, "ref_dict_yue", `vocab.${ext}`), got));
  }
}

async function testRuby(page, base) {
  console.log("ruby.html end-to-end (furigana and pinyin; Gemini stubbed with the references' answers):");
  const zh = (n) => path.join(FIXTURES, "zh", n);
  if (!fs.existsSync(zh("ai_zh.epub")) || !fs.existsSync(path.join(FIXTURES, "ref_ruby_ai"))) {
    console.log("  skip (no ruby fixtures — run test/gen_references.py)");
    return;
  }
  // Chinese from the dictionary: no network at all.
  const calls = [];
  await page.route("https://generativelanguage.googleapis.com/**", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    calls.push({ url: route.request().url(), headers: route.request().headers(), body });
    const prompt = body.contents[0].parts[0].text;
    const answers = JSON.parse(fs.readFileSync(prompt.includes("Japanese") ? zh("ai_ja_answers.json") : zh("ai_zh_answers.json"), "utf-8"));
    const sentences = prompt.split("\n").map((l) => /^\d+\. (.*)$/.exec(l)).filter((m) => m).map((m) => m[1]);
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(sentences.map((t) => answers[t])) }] } }] }) });
  });
  try {
    await page.goto(`${base}/ruby.html`);
    await page.selectOption("#ruby-lang", "zh");
    await page.selectOption("#ruby-method", "dict");
    await page.setInputFiles("#ruby-epub", zh("book.epub"));
    await page.setInputFiles("#ruby-cedict", zh("cedict.u8"));
    await page.setInputFiles("#ruby-frequency", zh("freq.txt"));
    await page.fill("#ruby-skip-top", "2");
    await page.uncheck("#ruby-zhuyin");
    let out = await downloadFromPage(page, () => page.click("#ruby-run"));
    check("pinyin from the dictionary matches add_pinyin_ruby.py",
          zipMember(out, "c1.xhtml") === zipMember(path.join(FIXTURES, "ref_pinyin", "book-pinyin.epub"), "c1.xhtml"));
    check("the dictionary method calls nothing", calls.length === 0, `${calls.length} request(s)`);

    // Chinese with AI.
    await page.goto(`${base}/ruby.html`);
    await page.selectOption("#ruby-lang", "zh");
    await page.selectOption("#ruby-method", "ai");
    await page.fill("#ruby-key", "stub-key-not-a-real-credential");
    await page.setInputFiles("#ruby-epub", zh("ai_zh.epub"));
    await page.setInputFiles("#ruby-cedict", zh("cedict.u8"));
    await page.fill("#ruby-skip-top", "0");
    out = await downloadFromPage(page, () => page.click("#ruby-run"));
    check("pinyin with AI matches add_pinyin_ruby.py --ai",
          zipMember(out, "c1.xhtml") === fs.readFileSync(path.join(FIXTURES, "ref_ruby_ai", "zh-pinyin.xhtml"), "utf-8"));
    check("the key goes in the header, not the URL", calls.length > 0
          && calls.every((c) => c.headers["x-goog-api-key"] === "stub-key-not-a-real-credential" && !c.url.includes("stub-key")));
    check("no sampling parameters (Gemini 3.8 drops them)",
          calls.every((c) => !("temperature" in c.body.generationConfig) && !("topP" in c.body.generationConfig)));
    check("the default model is asked", calls.every((c) => c.url.includes("/models/gemini-3.8-flash:generateContent")));

    // A saved former default is upgraded on the next visit; a model typed in on purpose is kept.
    await page.evaluate(() => localStorage.setItem("matcha-tools/gemini-model", "gemini-3.6-flash"));
    await page.goto(`${base}/ruby.html`);
    check("a saved former default becomes the current one", (await page.inputValue("#ruby-model")) === "gemini-3.8-flash");
    await page.evaluate(() => localStorage.setItem("matcha-tools/gemini-model", "my-own-model"));
    await page.goto(`${base}/manga.html`);
    check("a model chosen on purpose is kept", (await page.inputValue("#manga-model")) === "my-own-model");
    await page.evaluate(() => localStorage.removeItem("matcha-tools/gemini-model"));

    // Chinese with no CC-CEDICT chosen: the built-in copy.
    await page.goto(`${base}/ruby.html`);
    await page.selectOption("#ruby-lang", "zh");
    await page.selectOption("#ruby-method", "dict");
    await page.setInputFiles("#ruby-epub", zh("book.epub"));
    let before = calls.length;
    out = await downloadFromPage(page, () => page.click("#ruby-run"));
    check("pinyin from the built-in CC-CEDICT", /<rt>[a-zà-ǜ]+<\/rt>/.test(zipMember(out, "c1.xhtml"))
          && (await page.textContent("#log")).includes("CC-CEDICT (built-in)"));
    check("the built-in dictionary calls nothing", calls.length === before);

    // Japanese from the built-in dictionary (kuromoji, IPADIC).
    await page.goto(`${base}/ruby.html`);
    await page.selectOption("#ruby-lang", "ja");
    await page.selectOption("#ruby-method", "dict");
    await page.setInputFiles("#ruby-epub", zh("ai_ja.epub"));
    before = calls.length;
    out = await downloadFromPage(page, () => page.click("#ruby-run"));
    const ja = zipMember(out, "c1.xhtml");
    check("furigana from the built-in dictionary", ja.includes("<ruby>今日<rt>きょう</rt></ruby>")
          && ja.includes("<ruby>食<rt>た</rt></ruby>べる") && ja.includes("<ruby>林<rt>はやし</rt></ruby>"), ja);
    check("Japanese dictionary furigana calls nothing", calls.length === before);

    // Japanese with AI.
    await page.goto(`${base}/ruby.html`);
    await page.selectOption("#ruby-lang", "ja");
    await page.selectOption("#ruby-method", "ai");
    await page.fill("#ruby-key", "stub-key-not-a-real-credential");
    await page.setInputFiles("#ruby-epub", zh("ai_ja.epub"));
    out = await downloadFromPage(page, () => page.click("#ruby-run"));
    check("furigana matches add_furigana_ruby.py --ai",
          zipMember(out, "c1.xhtml") === fs.readFileSync(path.join(FIXTURES, "ref_ruby_ai", "ja.xhtml"), "utf-8"));
    check("output named for what it carries", path.basename(out) === "ai_ja-furigana.epub", path.basename(out));
  } finally {
    await page.unroute("https://generativelanguage.googleapis.com/**");
  }
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve(ROOT);
  const base = `http://127.0.0.1:${server.address().port}`;
  // Playwright's own managed Chromium by default (npx playwright install chromium).
  // CHROMIUM_PATH overrides it for environments that ship a browser elsewhere.
  // GPU canvas off: the no-OffscreenCanvas test compares an on-screen <canvas> with an
  // OffscreenCanvas byte for byte, and on a desktop browser the first is GPU-rasterised and
  // scales images a few grey levels differently from the CPU path. Headless CI Chromium is
  // CPU-only already; this makes a local run (macOS Chrome, say) agree with it.
  const args = ["--disable-gpu", "--disable-accelerated-2d-canvas"];
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args } : { args });
  const page = await browser.newPage();
  page.on("pageerror", (e) => { console.error("  page error:", e.message); failures++; });

  try {
    await testManga(page, base);
    await testMangaYolo(page, base);
    await testMangaEpub(page, base);
    await testMangaPdf(page, base);
    await testMangaPanelsOnly(page, base);
    await testMangaFolderedCbz(page, base);
    await testMangaGeminiOcr(page, base);
    await testMangaNoOffscreenCanvas(browser, base);
    await testDict(page, base);
    await testDictMdx(page, base);
    await testDictChinese(page, base);
    await testRuby(page, base);
    await testFonts(page, base);
  } finally {
    await browser.close();
    server.close();
  }
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nall e2e tests passed");
})();
