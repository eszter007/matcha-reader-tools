/* Manga converter: browser pipeline and page wiring.
 * Pure conversion logic lives in manga-core.js; this file handles file
 * input, image decoding, Gemini OCR calls, and the output zip. */
"use strict";

const GEMINI_DEFAULT_MODEL = "gemini-3.6-flash";

/* Exact prompt from tools/manga_convert/convert_manga.py. */
const PANEL_OCR_PROMPT = `This image is a single panel cropped from a Japanese manga page.
List every piece of text/dialogue visible in this panel, in the order a
reader would read them (top-to-bottom, right-to-left for manga). Then give
a single natural English translation of all of it combined, in the same
reading order, as it would read in an English localization of this manga.

Return ONLY a JSON object, no other text:
{"blocks": [{"text": "<the Japanese text, line breaks as \\n>",
             "bbox_2d": [ymin, xmin, ymax, xmax]}, ...],
 "translation": "<natural English translation of all the panel's text combined, in reading order>"}

bbox_2d is each text region's bounding box normalized to a 0-1000 scale
(0,0 = top-left of the panel image, 1000,1000 = bottom-right). If you
cannot determine a precise box, omit bbox_2d for that entry.
If there is no text in the panel, return {"blocks": [], "translation": ""}.`;

/* ── Image helpers ────────────────────────────────────────────── */

const EXT_MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".bmp": "image/bmp",
};

async function decodeImage(bytes, ext) {
  const blob = new Blob([bytes], { type: EXT_MIME[ext] || "" });
  try {
    // 'none' matches PIL, which does not apply EXIF rotation on open.
    return await createImageBitmap(blob, { imageOrientation: "none" });
  } catch (e) {
    return await createImageBitmap(blob);
  }
}

async function canvasToJpegBytes(canvas, quality) {
  let blob;
  if (canvas.convertToBlob) {
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  } else {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  }
  return new Uint8Array(await blob.arrayBuffer());
}

async function canvasToPngBytes(canvas) {
  let blob;
  if (canvas.convertToBlob) {
    blob = await canvas.convertToBlob({ type: "image/png" });
  } else {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }
  return new Uint8Array(await blob.arrayBuffer());
}

/* Rotate a canvas 90° clockwise into a new (height×width) canvas. */
function rotateCanvas90CW(src) {
  const dst = makeCanvas(src.height, src.width);
  const c = dst.getContext("2d");
  c.translate(src.height, 0);
  c.rotate(Math.PI / 2);
  c.drawImage(src, 0, 0);
  return dst;
}

function bytesToBase64(bytes) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes]));
  });
}

/* ── Gemini OCR ───────────────────────────────────────────────── */

async function geminiOcrOnce(jpegBytes, apiKey, model) {
  const imageB64 = await bytesToBase64(jpegBytes);
  const payload = {
    contents: [{
      parts: [
        { text: PANEL_OCR_PROMPT },
        { inline_data: { mime_type: "image/jpeg", data: imageB64 } },
      ],
    }],
    generationConfig: { responseMimeType: "application/json" },
  };

  let resp;
  try {
    resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(payload),
      });
  } catch (e) {
    return null; // network-level failure — retry
  }

  let response;
  try {
    response = await resp.json();
  } catch (e) {
    return null; // malformed response — retry
  }

  if (response.error) {
    const status = response.error.status || "";
    if (["UNAVAILABLE", "RESOURCE_EXHAUSTED", "DEADLINE_EXCEEDED", "INTERNAL"].includes(status)) {
      return null; // transient API error — retry
    }
    logLine(`  Warning: Gemini error: ${String(response.error.message || status).substring(0, 200)}`, "warn");
    return { blocks: [], translation: "" }; // non-transient — give up on this panel
  }

  try {
    const textOut = response.candidates[0].content.parts[0].text;
    const parsed = JSON.parse(textOut);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { blocks: [], translation: "" };
    }
    let blocks = parsed.blocks;
    if (!Array.isArray(blocks)) blocks = [];
    blocks = blocks.filter((b) => b !== null && typeof b === "object" && !Array.isArray(b) && "text" in b);
    let translation = parsed.translation;
    if (typeof translation !== "string") translation = "";
    return { blocks, translation };
  } catch (e) {
    logLine(`  Warning: could not parse Gemini response (${e.message})`, "warn");
    return { blocks: [], translation: "" };
  }
}

async function geminiOcrPanel(jpegBytes, apiKey, model, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const result = await geminiOcrOnce(jpegBytes, apiKey, model);
    if (result !== null) return result;
    if (attempt < retries - 1) await sleep(Math.pow(2, attempt) * 1000);
  }
  return { blocks: [], translation: "" };
}

/* ── Page collection ──────────────────────────────────────────── */

/* files: FileList/array from the picker. Returns
 * {pages: [{name, read}], meta: {title, author}, tocEntries, sourceLabel}. */
/* ── PDF input (lazy-loaded pdf.js) ───────────────────────────── */

const PDFJS_DIR = "js/vendor/pdfjs/";
let pdfjsLoadPromise = null; // resolves to the pdf.js module

function loadPdfJs() {
  if (!pdfjsLoadPromise) {
    pdfjsLoadPromise = (async () => {
      const base = new URL(PDFJS_DIR, location.href).href;
      const pdfjs = await import(base + "pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.mjs";
      return pdfjs;
    })().catch((e) => { pdfjsLoadPromise = null; throw e; });
  }
  return pdfjsLoadPromise;
}

/* Mirror of convert_manga.py:_extract_pdf_pages: rasterize each page in
 * document order at 2x zoom (manga PDFs usually embed pages at 72–150 DPI,
 * so 2x lands near e-ink screen resolution) and name them pdfpage_NNNN.png.
 * Pages render lazily, one at a time, inside read() — a whole volume is
 * never held as pixels at once. */
async function collectFromPdf(bytes, name) {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    wasmUrl: new URL(PDFJS_DIR + "wasm/", location.href).href,
    isEvalSupported: false,
  });
  const doc = await loadingTask.promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    pages.push({
      name: `pdfpage_${String(i - 1).padStart(4, "0")}.png`,
      read: async () => {
        const pdfPage = await doc.getPage(i);
        const viewport = pdfPage.getViewport({ scale: 2 });
        const canvas = makeCanvas(Math.round(viewport.width), Math.round(viewport.height));
        await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        pdfPage.cleanup();
        return canvasToPngBytes(canvas);
      },
    });
  }

  // Same source as the desktop tool: the PDF's Title/Author metadata.
  let title = "", author = "";
  try {
    const md = await doc.getMetadata();
    title = ((md.info && md.info.Title) || "").trim();
    author = ((md.info && md.info.Author) || "").trim();
  } catch (e) { /* metadata is best-effort */ }

  return {
    // A PDF carries no language field, so it stays empty here -- set it in the form.
    pages,
    meta: { title, author, language: "" },
    tocEntries: [],
    sourceLabel: baseName(name),
    cleanup: () => { loadingTask.destroy().catch(() => {}); },
  };
}

async function collectPagesFromInput(files) {
  if (files.length === 1 && !isImageName(files[0].name)) {
    const ext = mangaFileExt(files[0].name);
    const bytes = await readFileBytes(files[0]);
    if (ext === ".cbz" || ext === ".zip") return collectFromCbz(bytes, files[0].name);
    if (ext === ".epub") return collectFromEpub(bytes, files[0].name);
    if (ext === ".pdf") return collectFromPdf(bytes, files[0].name);
    throw new Error(`Unsupported input: ${files[0].name} (use .cbz, .zip, .epub, .pdf, or image files)`);
  }
  // Image list / folder selection.
  const images = [...files].filter((f) => isImageName(f.name));
  if (!images.length) throw new Error("No image files found in the selection");
  const byName = new Map(images.map((f) => [f.name, f]));
  const ordered = naturalSortPaths([...byName.keys()]);
  return {
    pages: ordered.map((name) => ({ name, read: () => readFileBytes(byName.get(name)) })),
    meta: { title: "", author: "", language: "" },
    tocEntries: [],
    sourceLabel: `${ordered.length} image files`,
  };
}

async function collectFromCbz(bytes, fileName) {
  const zip = new ZipReader(bytes);
  // Flatten by basename; later entries overwrite (matches the Python tool).
  const byBase = new Map();
  for (const e of zip.entries) {
    if (e.isDir || !isImageName(e.name)) continue;
    byBase.set(baseName(e.name), e);
  }
  if (!byBase.size) throw new Error("No image files found in the archive");
  const ordered = naturalSortPaths([...byBase.keys()]);

  let meta = { title: "", author: "", language: "" };
  const infoEntry = zip.entries.find((e) => baseName(e.name).toLowerCase() === "comicinfo.xml");
  if (infoEntry) {
    try {
      meta = cbzMetadataFromComicInfo(new TextDecoder().decode(await zip.readEntry(infoEntry)));
    } catch (e) { /* best-effort, like the Python tool */ }
  }

  return {
    pages: ordered.map((name) => ({ name, read: () => zip.readEntry(byBase.get(name)) })),
    meta,
    tocEntries: [],
    sourceLabel: fileName,
  };
}

async function collectFromEpub(bytes, fileName) {
  const zip = new ZipReader(bytes);
  const decoder = new TextDecoder();
  const container = decoder.decode(await zip.readEntryByName("META-INF/container.xml"));
  const opfPath = epubOpfPath(container);
  if (!opfPath) throw new Error("Could not find OPF in EPUB container.xml");
  const opfDir = pathDirname(opfPath);
  const opf = decoder.decode(await zip.readEntryByName(opfPath));

  const { manifest, spineIds } = epubParseOpf(opf);
  const pages = [];
  const spineMap = new Map(); // extracted basename → spine item href

  for (let idx = 0; idx < spineIds.length; idx++) {
    const href = manifest.get(spineIds[idx]);
    if (!href) continue;
    const fullHref = opfDir ? pathJoinNorm(opfDir, href) : pathNorm(href);
    let srcInZip;
    if (isImageName(fullHref)) {
      srcInZip = fullHref;
    } else {
      // Spine item is an XHTML wrapper page — find the embedded image. Take the
      // first src-like attribute that is an IMAGE and resolves to a real ZIP
      // member: Kobo-processed EPUBs inject <script src=".../kobo.js"> (and style
      // links) BEFORE the <img>, so grabbing the first src outright would pick
      // kobo.js and the conversion would die on an unidentifiable image. hrefs
      // may also carry a #fragment/?query that must be stripped before the check.
      const entry = zip.findEntry(fullHref);
      if (!entry) continue;
      const xhtml = decoder.decode(await zip.readEntry(entry));
      const xhtmlDir = pathDirname(fullHref);
      srcInZip = null;
      for (const m of xhtml.matchAll(/(?:src|xlink:href)="([^"]+)"/g)) {
        const candidate = m[1].split("#", 1)[0].split("?", 1)[0];
        if (!candidate || !isImageName(candidate)) continue;
        const resolved = pathJoinNorm(xhtmlDir, candidate);
        if (zip.findEntry(resolved)) { srcInZip = resolved; break; }
      }
      if (!srcInZip) continue;
    }
    const imgEntry = zip.findEntry(srcInZip);
    if (!imgEntry) {
      logLine(`Warning: image not found in EPUB: ${srcInZip}`, "warn");
      continue;
    }
    const targetBasename = `spine_${String(idx).padStart(4, "0")}_${baseName(srcInZip)}`;
    spineMap.set(fullHref, targetBasename);
    pages.push({ name: targetBasename, read: () => zip.readEntry(imgEntry) });
  }

  // Native EPUB table of contents → final page indices.
  let tocEntries = [];
  try {
    tocEntries = await epubNativeToc(zip, opf, opfDir, spineMap, pages);
  } catch (e) { /* fall back to no TOC */ }

  return { pages, meta: epubMetadataFromOpf(opf), tocEntries, sourceLabel: fileName };
}

async function epubNativeToc(zip, opf, opfDir, spineMap, pages) {
  const decoder = new TextDecoder();
  let raw = []; // [(href_with_optional_anchor, title)]
  const navHref = epubNavHref(opf);
  if (navHref) {
    const navPath = pathJoinNorm(opfDir, navHref);
    const navXhtml = decoder.decode(await zip.readEntryByName(navPath));
    raw = epubTocFromNav(navXhtml, navPath);
  } else {
    const ncxHref = epubNcxHref(opf);
    if (ncxHref) {
      const ncxPath = pathJoinNorm(opfDir, ncxHref);
      const ncx = decoder.decode(await zip.readEntryByName(ncxPath));
      raw = epubTocFromNcx(ncx, ncxPath);
    }
  }
  if (!raw.length) return [];

  const basenameToIndex = new Map(pages.map((p, i) => [p.name, i]));
  const resolved = [];
  for (const [href, title] of raw) {
    const hrefNoAnchor = href.split("#", 1)[0];
    const extractedBasename = spineMap.get(hrefNoAnchor);
    if (extractedBasename !== undefined && basenameToIndex.has(extractedBasename)) {
      resolved.push([basenameToIndex.get(extractedBasename), title]);
    }
  }
  return resolved;
}

/* ── AI panel detection (lazy-loaded ONNX Runtime + YOLO26 model) ── */

const YOLO_MODEL_URL = "models/manga_panel_detector_yolo26n.onnx";
const ORT_DIR = "js/vendor/ort/";
let yoloLoadPromise = null; // resolves to {ort, session}; reset to null on failure

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("failed to load " + src));
    document.head.appendChild(s);
  });
}

function loadYoloDetector() {
  if (!yoloLoadPromise) {
    yoloLoadPromise = (async () => {
      if (typeof ort === "undefined") await loadScriptOnce(ORT_DIR + "ort.wasm.min.js");
      // Must be absolute: ort dynamic-import()s its .mjs loader, and bare
      // relative specifiers are invalid module specifiers.
      ort.env.wasm.wasmPaths = new URL(ORT_DIR, location.href).href;
      const resp = await fetch(YOLO_MODEL_URL);
      if (!resp.ok) throw new Error(`model download failed (HTTP ${resp.status})`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
      return { ort, session };
    })().catch((e) => { yoloLoadPromise = null; throw e; });
  }
  return yoloLoadPromise;
}

/* ── Conversion pipeline ──────────────────────────────────────── */

/* Clamp a resolution choice to a real MANGA_DEVICE_TARGETS key (own-property
 * only, so "__proto__" etc. can't slip through) or "" for original. Guards both
 * the persisted <select> value and the conversion path against junk in
 * localStorage. */
function validResChoice(v) {
  return Object.prototype.hasOwnProperty.call(MANGA_DEVICE_TARGETS, v) ? v : "";
}

const mangaState = { running: false, cancelled: false };

/* Assemble the collected page/panel images into a fixed-layout EPUB 3 (a zip
 * with the mandatory STORE-first mimetype). epubPages is [{pageIdx, images:
 * [{bytes, mime, w, h}]}] in reading order; the pure XML lives in manga-epub.js.
 * tocEntries ([[pageIndex, title]]) is carried into the EPUB's table of
 * contents, each chapter resolved to that page's first spine page. */
async function buildMangaEpub({ title, author, epubPages, tocEntries }) {
  const spine = [];
  const pageFirstHref = new Map();  // pageIdx → xhtmlHref of that page's first image
  for (const pg of epubPages) {
    pg.images.forEach((im, ii) => {
      const base = `p${String(pg.pageIdx).padStart(4, "0")}_${ii}`;
      const xhtmlHref = `text/${base}.xhtml`;
      if (ii === 0) pageFirstHref.set(pg.pageIdx, xhtmlHref);
      spine.push({
        xhtmlId: `x_${base}`, xhtmlHref,
        imgId: `img_${base}`, imgHref: `images/${base}.${epubImageExt(im.mime)}`,
        mime: im.mime, w: im.w, h: im.h,
        isCover: spine.length === 0,
        bytes: im.bytes,
      });
    });
  }

  let chapters = tocEntries
    .slice()
    .sort((a, b) => a[0] - b[0])
    .map(([pageIndex, chTitle]) => ({ href: pageFirstHref.get(pageIndex), title: chTitle }))
    .filter((c) => c.href);
  if (!chapters.length && spine.length) chapters = [{ href: spine[0].xhtmlHref, title: title || "Start" }];

  const identifier = epubIdentifier(title, author, spine.length);
  const files = buildEpubTextFiles({ identifier, title, author, language: "ja", spine, chapters });

  const zw = new ZipWriter();
  const enc = new TextEncoder();
  zw.addFile("mimetype", enc.encode(EPUB_MIMETYPE));  // must be first + STORE (OCF)
  for (const f of files) zw.addFile(f.path, enc.encode(f.text));
  for (const s of spine) zw.addFile("OEBPS/" + s.imgHref, s.bytes);
  return new Uint8Array(await zw.toBlob().arrayBuffer());
}

/* Encode one image as an XTC (1-bit) and/or XTCH (2-bit) page, laid out for the device screen.
 *
 * Every page in a book is rendered onto the SAME canvas size, because the reader allocates one
 * page buffer for the whole session and cannot grow it -- a later, larger page just fails to load
 * ("Buffer too small: need N, have M"). Panels are all different shapes, so each is scaled to fit
 * and centred on white, and a landscape one is rotated to portrait first so it fills the screen
 * rather than sitting in a thin band (the same thing the EPUB export does).
 *
 * The 1-bit page is dithered (Floyd-Steinberg) rather than hard-thresholded: a plain threshold
 * turns screentone into flat black. XTH additionally needs a height that is a multiple of 8, which
 * every device target already satisfies (800 and 792 both divide by 8). */
function encodeXtcVariants(src, wantXtc, wantXtch, target) {
  const [w, h] = target;
  const page = makeCanvas(w, h);
  const ctx = page.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);

  let img = src;
  if (src.width > src.height && w < h) img = rotateCanvas90CW(src);
  const scale = Math.min(w / img.width, h / img.height);
  const dw = Math.max(1, Math.round(img.width * scale));
  const dh = Math.max(1, Math.round(img.height * scale));
  ctx.drawImage(img, Math.round((w - dw) / 2), Math.round((h - dh) / 2), dw, dh);

  const gray = grayFromRGBA(ctx.getImageData(0, 0, w, h).data, w, h);
  const out = {};
  if (wantXtc) {
    const dithered = floydSteinbergMono(gray, w, h);   // 0/1 per pixel, 1 = white
    const bw = new Uint8Array(w * h);
    for (let i = 0; i < bw.length; i++) bw[i] = dithered[i] ? 255 : 0;
    out.xtc = { bytes: encodeXtgPage(bw, w, h), w, h };
  }
  if (wantXtch) out.xtch = { bytes: encodeXthPage(gray, w, h), w, h };
  return out;
}

/* ── Format selection & conditional UI ────────────────────────── */

function formatBoxes() { return [...document.querySelectorAll("#manga-format .fmt")]; }

/* Nothing is preselected -- the user picks what they want, and an empty selection is rejected at
 * Convert rather than guessed at. */
function selectedFormats() {
  return new Set(formatBoxes().filter((cb) => cb.checked).map((cb) => cb.value));
}

/* Hide what the chosen formats can't use, so the page only asks for what it will act on.
 *  - OCR text and translations are stored in panels.dat, which only the device folder has.
 *  - Title/author/chapters are embedded in meta.bin AND in the EPUB, so they stay for both;
 *    XTC/XTCH carry them in their own metadata block, written from the same fields.
 *  - 1-bit BMP only affects the pages written into the device folder; the EPUB needs a core
 *    media type and XTC/XTCH have their own bit depths. */
function applyFormatVisibility() {
  const f = selectedFormats();
  // Before anything is picked, show everything: the steps only start disappearing once the user
  // has said what they want, so an untouched page never looks like it is missing parts.
  const nothingPicked = f.size === 0;
  const matcha = nothingPicked || f.has("matcha");
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.hidden = !on; };
  show("card-ocr", matcha);
  show("notice-ocr", matcha);
  show("card-install", matcha);
  show("card-book", matcha || nothingPicked || f.has("epub") || f.has("xtc") || f.has("xtch"));
  show("manga-mono-row", matcha);
  renumberSteps();
}

/* The step headings are numbered in the markup; hiding a card would leave a gap ("1, 2, 3, 5"),
 * so the visible ones are renumbered in place. The original text minus its number is kept on the
 * element the first time round. */
function renumberSteps() {
  let n = 0;
  for (const card of document.querySelectorAll("main .card")) {
    const h = card.querySelector("h3");
    if (!h) continue;
    if (h.dataset.base === undefined) {
      const m = h.innerHTML.match(/^\s*\d+\.\s*([\s\S]*)$/);
      if (!m) continue;               // unnumbered card (e.g. "Install on the device")
      h.dataset.base = m[1];
    }
    if (card.hidden) continue;
    h.innerHTML = `${++n}. ${h.dataset.base}`;
  }
}

/* Validation warnings ("pick a format", "choose a file") describe a state the user can fix right
 * there, so they are tagged and cleared as soon as the input they complain about changes --
 * a stale complaint next to a now-valid form reads as a failure that already happened. */
function logValidation(text) {
  logLine(text, "warn validation");
}

function clearValidationWarnings() {
  const log = $("log");
  if (!log) return;
  for (const el of log.querySelectorAll(".validation")) el.remove();
  if (!log.children.length) log.hidden = true;
}

async function runMangaConversion() {
  const fileInput = $("manga-file");
  const files = fileInput.files;
  if (!files || !files.length) {
    logValidation("Choose a .cbz/.zip/.epub file or a set of page images first.");
    return;
  }

  // Any combination of the device folder, a portable EPUB, and Xteink's XTC/XTCH. Nothing is
  // preselected, so an empty pick is a user error rather than a default to guess at.
  const formats = selectedFormats();
  if (!formats.size) {
    logValidation("Pick at least one export format.");
    return;
  }

  // OCR text and translations are only ever stored in panels.dat, so without the device folder
  // there is nowhere for them to go -- skip OCR implicitly rather than demanding an API key for
  // output that would be discarded. (The OCR section is hidden in that case too.)
  const noOcr = $("manga-no-ocr").checked || !formats.has("matcha");
  const mono = $("manga-mono").checked;
  const epub = formats.has("epub");
  const matchaFolder = formats.has("matcha");
  const wantXtc = formats.has("xtc");
  const wantXtch = formats.has("xtch");
  const anyXtc = wantXtc || wantXtch;
  const panelsOnly = $("manga-panels-only").checked;
  // How much of a page's ink must sit inside its panels before the full page may be dropped.
  // Not 100%: a stray speck in the gutter or a page number outside every panel is not content
  // worth keeping a whole page image for.
  const PANELS_ONLY_MIN_INK_COVERAGE = 0.98;
  let pagesKeptForCoverage = 0;
  // XTC/XTCH pages are accumulated as encoded bitmaps (one per page/panel image, same reading
  // order as the EPUB) and assembled once at the end, since the page table needs every size.
  const xtcPages = [], xtchPages = [];
  const xtcPageMap = new Map();   // source page index -> position in the exported XTC sequence
  // Target device resolution: "" (original), "x3", or "x4". Downscales pages and
  // panels before detection so the device decodes fewer pixels; never upscales.
  // Validate against own keys so a stray persisted value (e.g. "__proto__")
  // can't yield Object.prototype and NaN sizes downstream.
  const resChoice = validResChoice($("manga-res").value);
  const deviceTarget = resChoice ? MANGA_DEVICE_TARGETS[resChoice] : null;
  // XTC/XTCH are pre-rendered: every page is written at one fixed size, because the reader
  // allocates a single page buffer for the book. "Original" leaves panels at their own (varying,
  // full-resolution) sizes, which has no sensible answer here -- so a device target is required.
  if (anyXtc && !deviceTarget) {
    logValidation("Pick a target resolution (X3 or X4) for XTC/XTCH — those formats need a fixed page size.");
    return;
  }
  const apiKey = $("manga-key").value.trim();
  const model = $("manga-model").value.trim() || GEMINI_DEFAULT_MODEL;
  if (!noOcr && !apiKey) {
    logValidation("Enter a Gemini API key, or tick \"Skip OCR\" for panels-only output.");
    return;
  }
  saveSetting("gemini-key", apiKey);
  saveSetting("gemini-model", model);
  saveSetting("manga-yolo", $("manga-yolo").checked ? "1" : "0");
  saveSetting("manga-mono", mono ? "1" : "0");
  saveSetting("manga-panels-only", panelsOnly ? "1" : "0");
  saveSetting("manga-format", [...formats].join(","));
  saveSetting("manga-res", resChoice);

  const panelMargin = parseInt($("manga-margin").value, 10);
  const margin = Number.isInteger(panelMargin) ? panelMargin : 10;
  const maxPagesRaw = parseInt($("manga-max-pages").value, 10);

  mangaState.running = true;
  mangaState.cancelled = false;
  $("manga-run").disabled = true;
  $("manga-cancel").hidden = false;
  clearLog();
  const wakeLock = new WakeLock();
  await wakeLock.acquire();

  let collected = null;
  try {
    logLine("Collecting pages…");
    collected = await collectPagesFromInput(files);
    let pages = collected.pages;

    // Resolve TOC before any max-pages truncation (indices stay correct).
    let tocEntries = collected.tocEntries;
    if (tocEntries.length) logLine(`Found ${tocEntries.length} chapter(s) in the EPUB's table of contents`);
    const tocText = $("manga-toc").value;
    if (tocText.trim()) {
      const parsed = parseTocText(tocText);
      parsed.warnings.forEach((warning) => logLine("Warning: " + warning, "warn"));
      tocEntries = parsed.entries;
      logLine(`Using ${tocEntries.length} chapter(s) from the chapter list`);
    }

    if (Number.isInteger(maxPagesRaw) && maxPagesRaw > 0) pages = pages.slice(0, maxPagesRaw);
    logLine(`Found ${pages.length} pages in ${collected.sourceLabel}`);

    // Same detector hierarchy as the Python tool: YOLO when available,
    // white-gutter grid heuristic as the fallback.
    let yolo = null;
    if ($("manga-yolo").checked) {
      try {
        logLine("Loading AI panel detector (first load downloads ~21 MB, then it's cached)…");
        yolo = await loadYoloDetector();
        logLine("AI panel detector ready");
      } catch (e) {
        logLine(`Could not load the AI panel detector (${e.message}); using the grid heuristic.`, "warn");
      }
    }

    const metaTitle = $("manga-title").value.trim() || collected.meta.title;
    const metaAuthor = $("manga-author").value.trim() || collected.meta.author;
    const metaLanguage = $("manga-language").value.trim() || collected.meta.language;
    const folder = sanitizeFolderName(metaTitle || "Manga");

    const zip = new ZipWriter();
    const idxRecords = [];
    const datChunks = [];
    let datOffset = 0;
    let totalPanels = 0;
    let totalTextBlocks = 0;
    let pagesDone = 0;
    // For the optional portable EPUB: one entry per manga page, each holding the
    // full-page image followed by its (rotated) panel images. Assembled after
    // the loop; null when the EPUB export is off.
    const epubPages = epub ? [] : null;

    for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
      if (mangaState.cancelled) {
        logLine(`Cancelled after ${pagesDone} page(s); packaging what's done…`, "warn");
        break;
      }
      const page = pages[pageIdx];
      setProgress(pageIdx, pages.length, `Page ${pageIdx + 1} / ${pages.length}`);
      logLine(`[${pageIdx + 1}/${pages.length}] ${page.name}`);

      const srcBytes = await page.read();
      let ext = mangaFileExt(page.name);
      const bitmap = await decodeImage(srcBytes, ext);

      // Downscale FIRST, before panel detection, so every downstream coordinate
      // (panel boxes, crop rects, OCR text boxes, the page dims in panels.idx)
      // lives in the resized space and matches the files actually written. When
      // no device is selected fit.resized is false and this is a 1:1 draw, so the
      // default output is unchanged. (White-fill for transparent sources differs
      // per canvas — see the detection/page and full-res source canvases below.)
      const origW = bitmap.width, origH = bitmap.height;
      const fit = fitToDeviceSize(origW, origH, deviceTarget);
      const imgW = fit.w, imgH = fit.h;
      const wasResized = fit.resized;

      // Detection + page canvas (downscaled). White-fill only when actually
      // resizing, so panels.idx and the default (Original) output are unchanged.
      const canvas = makeCanvas(imgW, imgH);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (wasResized) { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, imgW, imgH); }
      ctx.drawImage(bitmap, 0, 0, origW, origH, 0, 0, imgW, imgH);
      // The source bitmap stays open until after detection: the full-resolution
      // panel-crop canvas is only built for pages that actually have a panel to
      // crop (see below), so a cover / full-page spread never allocates it.

      // Panel boxes stay in resized page space (panels.idx records the page at that
      // size); only the crop comes from the original, so map the rect back across.
      const panelScaleX = origW / imgW, panelScaleY = origH / imgH;

      const rgba = ctx.getImageData(0, 0, imgW, imgH).data;

      let boxes = null;
      if (yolo) {
        try {
          boxes = await detectPanelsYolo(yolo.session, yolo.ort, rgba, imgW, imgH);
        } catch (e) {
          logLine(`AI detection failed on this page (${e.message}); using the grid heuristic.`, "warn");
        }
      }
      if (!boxes) {
        const gray = grayFromRGBA(rgba, imgW, imgH);
        boxes = detectPanelsGrid(gray, imgW, imgH);
      }
      boxes = sortPanelsMangaOrder(boxes);

      // Panels-only must not lose anything the detector missed: with no full page behind them,
      // uncovered artwork would simply be unreachable. Measure how much of this page's ink falls
      // inside the panels (expanded by the same crop margin that will be applied) and keep the
      // full page whenever that falls short. The device already handles such mixed books -- a
      // page with no crop shows as a full page -- so the result is panels where detection is
      // good and pages where it is not, rather than silent gaps.
      let keepPageImage = true;
      if (panelsOnly && pageIdx !== 0) {
        const marginedRects = boxes.map(([x1, y1, x2, y2]) =>
          [Math.max(0, x1 - margin), Math.max(0, y1 - margin), Math.min(imgW, x2 + margin), Math.min(imgH, y2 + margin)]);
        const coverage = panelInkCoverage(grayFromRGBA(rgba, imgW, imgH), imgW, imgH, marginedRects);
        keepPageImage = coverage < PANELS_ONLY_MIN_INK_COVERAGE;
        if (keepPageImage) {
          pagesKeptForCoverage++;
          logLine(`Page ${pageIdx + 1}: panels cover ${(coverage * 100).toFixed(1)}% of the artwork — keeping the full page so nothing is lost.`, "warn");
        }
      }

      // Copy the page to a canonical, trivially-sortable filename. In mono mode
      // it becomes a 1-bit Floyd-Steinberg-dithered BMP the device paints with a
      // single fast black-and-white refresh (no 4-level gray pass). A resized
      // JPEG/PNG page is re-encoded (source bytes no longer match); otherwise the
      // source is copied byte-for-byte.
      const pageBase = `page_${String(pageIdx).padStart(4, "0")}`;
      // Panels-only drops the page image -- the device sees a page with no image and goes
      // straight to its panels -- but only where the panels actually cover the page's content
      // (see keepPageImage above). Page 0 is always kept: findCoverImage() picks it up as the
      // Library/Home cover, and without it the book has none. Missing pages do not shift the
      // rest: the device maps page index -> image by position, so index 0 resolves to the cover
      // and any index past the ones present resolves to "" (no image).
      if (!matchaFolder || !keepPageImage) {
        // nothing written for this page
      } else if (mono) {
        zip.addFile(`${folder}/${pageBase}.bmp`, encodeMonoBmpFromRGBA(rgba, imgW, imgH));
      } else if ([".jpg", ".jpeg", ".png"].includes(ext) && !wasResized) {
        zip.addFile(`${folder}/${pageBase}${ext}`, srcBytes);
      } else if (ext === ".png" && wasResized) {
        zip.addFile(`${folder}/${pageBase}.png`, await canvasToPngBytes(canvas));
      } else {
        const outExt = (ext === ".jpg" || ext === ".jpeg") ? ext : ".jpg";
        zip.addFile(`${folder}/${pageBase}${outExt}`, await canvasToJpegBytes(canvas, 0.92));
      }

      // The EPUB always uses a widely-supported core media type (JPEG/PNG); the
      // full page is never rotated (it's the overview). Reuse the source bytes
      // when they're already JPEG/PNG and unresized, otherwise re-encode from the
      // (possibly downscaled) canvas.
      const epubImages = [];
      // Panels-only leaves the full pages out of the EPUB too, so the option means the same thing
      // in both formats -- including keeping the page wherever its panels miss content.
      if (epub && keepPageImage) {
        let pageBytes, pageMime;
        if (!wasResized && (ext === ".jpg" || ext === ".jpeg")) { pageBytes = srcBytes; pageMime = "image/jpeg"; }
        else if (!wasResized && ext === ".png") { pageBytes = srcBytes; pageMime = "image/png"; }
        else if (ext === ".png") { pageBytes = await canvasToPngBytes(canvas); pageMime = "image/png"; }
        else { pageBytes = await canvasToJpegBytes(canvas, 0.92); pageMime = "image/jpeg"; }
        epubImages.push({ bytes: pageBytes, mime: pageMime, w: imgW, h: imgH });
      }
      if (anyXtc) xtcPageMap.set(pageIdx, wantXtc ? xtcPages.length : xtchPages.length);
      if (anyXtc && keepPageImage) {
        const v = encodeXtcVariants(canvas, wantXtc, wantXtch, deviceTarget);
        if (v.xtc) xtcPages.push(v.xtc);
        if (v.xtch) xtchPages.push(v.xtch);
      }

      // Full-resolution page for the panel crops. A panel is shown zoomed to fill
      // the screen, so cropping it from the already-downscaled page magnifies a
      // fraction of an already-reduced image (softness and dither dots and all);
      // cropping at full res and fitting each panel afterwards gives it the whole
      // pixel budget. Allocate this second full-res canvas only when the page
      // actually has a panel to crop — covers / full-page spreads skip it.
      // Transparent sources composite onto white (the device's alpha handling).
      let sourceCanvas = null;
      if (boxes.some((b) => !isFullPagePanel(b, imgW, imgH))) {
        sourceCanvas = makeCanvas(origW, origH);
        const sctx = sourceCanvas.getContext("2d");
        sctx.fillStyle = "#ffffff"; sctx.fillRect(0, 0, origW, origH);
        sctx.drawImage(bitmap, 0, 0);
      }
      bitmap.close();

      // Crop panels (fast, local) before dispatching OCR calls concurrently.
      const panelCrops = [];  // Uint8Array | null (null = full-page panel)
      const panelRects = [];
      for (let panelIdx = 0; panelIdx < boxes.length; panelIdx++) {
        const [x1, y1, x2, y2] = boxes[panelIdx];
        const mx1 = Math.max(0, x1 - margin);
        const my1 = Math.max(0, y1 - margin);
        const mx2 = Math.min(imgW, x2 + margin);
        const my2 = Math.min(imgH, y2 + margin);
        let cropBytes = null;  // full-colour JPEG crop for OCR (null = no crop / no OCR)
        // A full-page panel normally gets no crop: the page image is already the best
        // presentation of it. Panels-only books have no page image to fall back on, so the crop
        // must be written anyway or that page would export nothing at all.
        const fullPagePanel = isFullPagePanel(boxes[panelIdx], imgW, imgH);
        if (!fullPagePanel || panelsOnly) {
          // Map the detected rect into full-resolution page coordinates, then draw
          // that region straight into a device-fitted panel canvas (one drawImage
          // crops + scales). fitToDeviceSize fits a landscape panel against the
          // rotated box — the size the firmware zooms it to, and dithers it at.
          const fx1 = Math.max(0, Math.round(mx1 * panelScaleX));
          const fy1 = Math.max(0, Math.round(my1 * panelScaleY));
          const fx2 = Math.min(origW, Math.round(mx2 * panelScaleX));
          const fy2 = Math.min(origH, Math.round(my2 * panelScaleY));
          // Clamp to at least 1×1: real panels are tens of px, but guard a
          // degenerate rounding/tiny-box case so fitToDeviceSize can't divide by
          // zero and makeCanvas/drawImage can't throw on a 0-size crop.
          const fw = Math.max(1, fx2 - fx1), fh = Math.max(1, fy2 - fy1);
          const pf = fitToDeviceSize(fw, fh, deviceTarget);
          const pw = pf.w, ph = pf.h;
          const cropCanvas = makeCanvas(pw, ph);
          const cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true });
          cropCtx.drawImage(sourceCanvas, fx1, fy1, fw, fh, 0, 0, pw, ph);
          if (mono) {
            const cropRgba = cropCtx.getImageData(0, 0, pw, ph).data;
            if (matchaFolder) {
              zip.addFile(`${folder}/${PANEL_CROP_SUBDIR}/p${pageIdx}_${panelIdx}.bmp`, encodeMonoBmpFromRGBA(cropRgba, pw, ph));
            }
            // OCR still reads a full-colour JPEG crop: the dithered BMP would
            // only hurt text recognition (the --mono guidance to pair with
            // --no-ocr still applies, but OCR stays usable when both are on).
            if (!noOcr) cropBytes = await canvasToJpegBytes(cropCanvas, 0.90);
          } else {
            cropBytes = await canvasToJpegBytes(cropCanvas, 0.90);
            if (matchaFolder) zip.addFile(`${folder}/${PANEL_CROP_SUBDIR}/p${pageIdx}_${panelIdx}.jpg`, cropBytes);
          }
          if (epub && !fullPagePanel) {
            // Rotate wide (landscape) panels to portrait so they display as
            // large as possible on the usual portrait reading screen; the
            // fixed-layout reader then scales each to fullscreen.
            let panelCanvas = cropCanvas, epw = pw, eph = ph;
            if (pw > ph) { panelCanvas = rotateCanvas90CW(cropCanvas); epw = ph; eph = pw; }
            epubImages.push({ bytes: await canvasToJpegBytes(panelCanvas, 0.90), mime: "image/jpeg", w: epw, h: eph });
          }
          if (anyXtc && !fullPagePanel) {
            const v = encodeXtcVariants(cropCanvas, wantXtc, wantXtch, deviceTarget);
            if (v.xtc) xtcPages.push(v.xtc);
            if (v.xtch) xtchPages.push(v.xtch);
          }
        }
        // OCR semantics stay as the Python tool's: a full-page panel gets an empty result even
        // when panels-only forced its crop to be written, so enabling the option cannot silently
        // multiply Gemini calls.
        panelCrops.push(fullPagePanel ? null : cropBytes);
        panelRects.push([mx1, my1, mx2, my2]);
      }

      if (epub) epubPages.push({ pageIdx, images: epubImages });

      let ocrResults;
      if (!noOcr) {
        ocrResults = await mapLimit(panelCrops, Math.min(8, Math.max(1, panelCrops.length)),
          (crop) => crop ? geminiOcrPanel(crop, apiKey, model) : Promise.resolve({ blocks: [], translation: "" }));
      } else {
        ocrResults = panelCrops.map(() => ({ blocks: [], translation: "" }));
      }

      const panelsWithText = [];
      for (let panelIdx = 0; panelIdx < boxes.length; panelIdx++) {
        const [x1, y1, x2, y2] = boxes[panelIdx];
        const [mx1, my1, mx2, my2] = panelRects[panelIdx];
        const ocr = ocrResults[panelIdx];
        const panelW = mx2 - mx1, panelH = my2 - my1;

        const textBlocks = [];
        for (const b of ocr.blocks || []) {
          const text = String(b.text ?? "").trim();
          if (!text) continue;
          const bbox = b.bbox_2d;
          let tb;
          if (Array.isArray(bbox) && bbox.length === 4) {
            const [ymin, xmin, ymax, xmax] = bbox;
            tb = [
              x1 + Math.trunc((xmin / 1000) * panelW),
              y1 + Math.trunc((ymin / 1000) * panelH),
              x1 + Math.trunc((xmax / 1000) * panelW),
              y1 + Math.trunc((ymax / 1000) * panelH),
            ];
          } else {
            tb = [x1, y1, x2, y2];
          }
          textBlocks.push({ box: tb, text });
        }
        panelsWithText.push({ box: boxes[panelIdx], textBlocks, translation: ocr.translation || "" });
        totalPanels += 1;
        totalTextBlocks += textBlocks.length;
      }

      const pageData = encodePage(panelsWithText);
      idxRecords.push({ offset: datOffset, length: pageData.length, w: Math.min(imgW, 0xffff), h: Math.min(imgH, 0xffff) });
      datChunks.push(pageData);
      datOffset += pageData.length;
      pagesDone++;
    }

    if (!pagesDone) throw new Error("No pages were processed");

    zip.addFile(`${folder}/panels.idx`, writePanelsIdx(idxRecords));
    const dat = new Uint8Array(datOffset);
    let off = 0;
    for (const chunk of datChunks) { dat.set(chunk, off); off += chunk.length; }
    if (matchaFolder) {
      zip.addFile(`${folder}/panels.dat`, dat);
      const metaBin = writeMetaBin(metaTitle, metaAuthor, metaLanguage);
      if (metaBin) zip.addFile(`${folder}/meta.bin`, metaBin);
      if (tocEntries.length) zip.addFile(`${folder}/toc.idx`, writeTocIdx(tocEntries));
    }

    // Extra single-file outputs (EPUB / XTC / XTCH). They ride inside the zip when the device
    // folder is also being exported, otherwise they are the download themselves.
    const extras = [];
    if (epub && epubPages.length) {
      setProgress(pagesDone, pages.length, "Building EPUB…");
      const epubBytes = await buildMangaEpub({ title: metaTitle, author: metaAuthor, epubPages, tocEntries });
      extras.push({ name: `${folder}.epub`, bytes: epubBytes, type: "application/epub+zip" });
      logLine(`Built ${folder}.epub (${epubPages.reduce((n, p) => n + p.images.length, 0)} images).`);
    }
    // The chapter list indexes the EXPORTED page sequence (each page followed by its panels),
    // not the source page numbers, so a chapter starting at source page N lands on that page's
    // entry in xtcPageMap.
    const xtcToc = tocEntries
      .map(([pageIndex, chapterTitle]) => ({ title: chapterTitle, page: xtcPageMap.get(pageIndex) }))
      .filter((c) => c.page !== undefined)
      .sort((a, b) => a.page - b.page);
    const xtcMeta = { title: metaTitle, author: metaAuthor, language: metaLanguage, toc: xtcToc };
    if (wantXtc && xtcPages.length) {
      extras.push({ name: `${folder}.xtc`, bytes: buildXtcFile(xtcPages, { ...xtcMeta, isHq: false }), type: "application/octet-stream" });
      logLine(`Built ${folder}.xtc (${xtcPages.length} pages, 1-bit).`);
    }
    if (wantXtch && xtchPages.length) {
      extras.push({ name: `${folder}.xtch`, bytes: buildXtcFile(xtchPages, { ...xtcMeta, isHq: true }), type: "application/octet-stream" });
      logLine(`Built ${folder}.xtch (${xtchPages.length} pages, 2-bit grayscale).`);
    }

    setProgress(pagesDone, pages.length, "Packaging…");
    const summary = `Done: ${pagesDone} pages, ${totalPanels} panels` +
      (noOcr ? "" : `, ${totalTextBlocks} text blocks`) +
      (deviceTarget ? `, ${resChoice.toUpperCase()} resolution` : "") +
      (mono && matchaFolder ? ", 1-bit dithered BMP" : "") +
      (pagesKeptForCoverage ? `, ${pagesKeptForCoverage} full page(s) kept where panels missed content` : "");

    if (matchaFolder) {
      for (const e of extras) zip.addFile(e.name, e.bytes);
      const blob = zip.toBlob();
      logLine(`${summary}${extras.length ? `, + ${extras.map((e) => e.name.split(".").pop().toUpperCase()).join(" + ")}` : ""} — ${formatBytes(blob.size)}`);
      logLine(`Unzip onto the SD card (e.g. /manga/) or upload the "${folder}" folder via the device's web file transfer.` +
        (extras.length ? ` The ${extras.map((e) => `"${e.name}"`).join(" and ")} inside the zip ${extras.length > 1 ? "are" : "is"} for other readers.` : ""));
      downloadBlob(blob, `${folder}.zip`);
    } else if (extras.length === 1) {
      // A single file needs no zip wrapper -- nothing to unpack.
      const only = extras[0];
      const blob = new Blob([only.bytes], { type: only.type });
      logLine(`${summary} — ${formatBytes(blob.size)}`);
      logLine(`Copy "${only.name}" to your reader.`);
      downloadBlob(blob, only.name);
    } else if (extras.length) {
      const outZip = new ZipWriter();
      for (const e of extras) outZip.addFile(e.name, e.bytes);
      const blob = outZip.toBlob();
      logLine(`${summary} — ${formatBytes(blob.size)}`);
      logLine(`Unzip and copy ${extras.map((e) => `"${e.name}"`).join(" / ")} to your reader.`);
      downloadBlob(blob, `${folder}.zip`);
    } else {
      throw new Error("Nothing to export: no pages were produced");
    }
    setProgress(pagesDone, pagesDone, "Complete");
  } catch (e) {
    logLine("Error: " + e.message, "error");
    console.error(e);
  } finally {
    if (collected && collected.cleanup) collected.cleanup();
    mangaState.running = false;
    $("manga-run").disabled = false;
    $("manga-cancel").hidden = true;
    wakeLock.release();
  }
}

/* ── Page wiring ──────────────────────────────────────────────── */

if (typeof document !== "undefined" && document.getElementById("manga-run")) {
  $("manga-key").value = loadSetting("gemini-key", "");
  $("manga-model").value = loadSetting("gemini-model", GEMINI_DEFAULT_MODEL);
  $("manga-yolo").checked = loadSetting("manga-yolo", "1") === "1";
  $("manga-mono").checked = loadSetting("manga-mono", "0") === "1";
  $("manga-panels-only").checked = loadSetting("manga-panels-only", "0") === "1";
  {
    const saved = new Set(loadSetting("manga-format", "").split(",").filter(Boolean));
    for (const cb of formatBoxes()) cb.checked = saved.has(cb.value);
    for (const cb of formatBoxes()) {
      cb.addEventListener("change", applyFormatVisibility);
      cb.addEventListener("change", clearValidationWarnings);
    }
    applyFormatVisibility();
  }
  $("manga-res").value = validResChoice(loadSetting("manga-res", ""));
  $("manga-run").addEventListener("click", runMangaConversion);
  $("manga-cancel").addEventListener("click", () => { mangaState.cancelled = true; });
  $("manga-file").addEventListener("change", () => {
    const files = $("manga-file").files;
    if (files.length) {
      $("manga-file-label").textContent = files.length === 1
        ? files[0].name : `${files.length} files selected`;
      clearValidationWarnings();
    }
  });
  // The API-key warning is fixed by either supplying a key or ticking Skip OCR.
  $("manga-key").addEventListener("input", clearValidationWarnings);
  $("manga-no-ocr").addEventListener("change", clearValidationWarnings);
  $("manga-res").addEventListener("change", clearValidationWarnings);
}
