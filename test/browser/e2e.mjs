#!/usr/bin/env node
/* End-to-end tests: drive the real pages in Chromium via Playwright.
 *
 *   - fonts.html: convert DejaVuSans.ttf at 14pt/latin-ext, then compare the
 *     .cpfont structurally against the Python reference (test/font_compare.py).
 *   - manga.html: convert a CBZ of the synthetic pages with OCR skipped and
 *     byte-compare panels.idx/panels.dat against the Python reference.
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

async function setMangaForm(page, { formats = ["matcha"], res = "full", panelsOnly = false }) {
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
  const cpfont = path.join(dest, ".fonts", "DejaVuSans", "DejaVuSans_14.cpfont");
  check("cpfont produced at expected path", fs.existsSync(cpfont));
  if (fs.existsSync(cpfont)) {
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
  await page.goto(`${base}/manga.html`);
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

/* Parse the panel rectangles back out of panels.idx/panels.dat (no-OCR
 * layout: per page u8 count, u8 pad, then 12-byte panel records). */
function parsePanelBoxes(dir) {
  const idx = fs.readFileSync(path.join(dir, "panels.idx"));
  const dat = fs.readFileSync(path.join(dir, "panels.dat"));
  const pageCount = idx.readUInt32LE(4);
  const pages = [];
  for (let p = 0; p < pageCount; p++) {
    let off = idx.readUInt32LE(8 + p * 12);
    const count = dat.readUInt8(off);
    off += 2;
    const boxes = [];
    for (let i = 0; i < count; i++) {
      const x = dat.readUInt16LE(off), y = dat.readUInt16LE(off + 2);
      const w = dat.readUInt16LE(off + 4), h = dat.readUInt16LE(off + 6);
      boxes.push([x, y, x + w, y + h]);
      off += 12;
    }
    pages.push(boxes);
  }
  return pages;
}

async function testMangaYolo(page, base) {
  console.log("manga.html end-to-end (CBZ, no OCR, AI panel detection):");
  const refPath = path.join(FIXTURES, "ref_yolo", "boxes.json");
  if (!fs.existsSync(refPath)) {
    console.log("  skip (no ref_yolo fixtures — rerun gen_references.py with numpy + onnxruntime installed)");
    return;
  }
  const ref = JSON.parse(fs.readFileSync(refPath, "utf-8"));
  await page.goto(`${base}/manga.html`);
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
  await page.goto(`${base}/manga.html`);
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
  await page.goto(`${base}/manga.html`);
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
  const pages = [];
  for (let p = 0; p < idx.readUInt32LE(4); p++) {
    let off = idx.readUInt32LE(8 + p * 12);
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
      const texts = [];
      for (let t = 0; t < textCount; t++) {
        // Text-block boxes are raw corners (x1,y1,x2,y2), unlike the panel's x,y,w,h --
        // the Python tool writes them that way and this port matches it byte-for-byte.
        const box = [dat.readUInt16LE(off), dat.readUInt16LE(off + 2),
                     dat.readUInt16LE(off + 4), dat.readUInt16LE(off + 6)];
        const len = dat.readUInt16LE(off + 8);
        off += 10;
        texts.push({ box, text: dat.subarray(off, off + len).toString("utf-8") });
        off += len;
      }
      panels.push({ box: [x, y, x + pw, y + ph], translation, texts });
    }
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
        blocks: [{ text: JP, bbox_2d: [0, 0, 1000, 1000] }], translation: TRANSLATION,
      }) }] } }] }),
    });
  });
  try {
    await page.goto(`${base}/manga.html`);
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
          r.url.endsWith("/v1beta/models/gemini-3.6-flash:generateContent"), r.url);
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
    // A panel covering essentially the whole page is deliberately never sent to Gemini --
    // the page image already shows it, and OCRing both would double the calls. So the two
    // kinds of panel are checked against opposite expectations.
    const isFullPage = (b, w, h) =>
      (b[2] - b[0]) / w >= 0.95 && (b[3] - b[1]) / h >= 0.95;
    let ocred = 0, fullPage = 0, badBox = 0, badText = 0, outside = 0, leaked = 0;
    for (const pg of pages) {
      for (const panel of pg.panels) {
        const [x1, y1, x2, y2] = panel.box;
        if (isFullPage(panel.box, pg.w, pg.h)) {
          fullPage++;
          if (panel.translation !== "" || panel.texts.length) leaked++;
          continue;
        }
        ocred++;
        if (panel.translation !== TRANSLATION) badText++;
        // The crop handed to the model, in page space.
        const want = [Math.max(0, x1 - MARGIN), Math.max(0, y1 - MARGIN),
                      Math.min(pg.w, x2 + MARGIN), Math.min(pg.h, y2 + MARGIN)];
        if (panel.texts.length !== 1) badText++;
        for (const t of panel.texts) {
          if (t.text !== JP) badText++;
          if (t.box.some((v, i) => v !== want[i])) badBox++;
          if (t.box[2] > pg.w || t.box[3] > pg.h) outside++;
        }
      }
    }
    check("every OCRed panel got its translation and text", ocred > 0 && badText === 0,
          `${ocred} panels, ${badText} wrong`);
    check("text boxes land on the crop the model was shown", badBox === 0, `${badBox} misplaced`);
    check("no text box runs past the page edge", outside === 0, `${outside} outside`);
    check("one Gemini call per OCRed panel", requests.length === ocred,
          `${requests.length} calls, ${ocred} panels`);
    check("full-page panels are not sent to Gemini", fullPage > 0 && leaked === 0,
          `${fullPage} full-page, ${leaked} with text`);
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
  await page.goto(`${base}/manga.html`);
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
    await pg.goto(`${base}/manga.html`);
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

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve(ROOT);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  page.on("pageerror", (e) => { console.error("  page error:", e.message); failures++; });

  try {
    await testManga(page, base);
    await testMangaYolo(page, base);
    await testMangaEpub(page, base);
    await testMangaPdf(page, base);
    await testMangaPanelsOnly(page, base);
    await testMangaGeminiOcr(page, base);
    await testMangaNoOffscreenCanvas(browser, base);
    await testDict(page, base);
    await testDictMdx(page, base);
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
