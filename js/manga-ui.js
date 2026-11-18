/* Manga converter: browser pipeline and page wiring.
 * Pure conversion logic lives in manga-core.js; this file handles file
 * input, image decoding, Gemini OCR calls, and the output zip. */
"use strict";

const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";

/* Book types, mirroring the flags convert_manga.py takes. The type decides panel
 * reading order, whether printed margins are trimmed, and whether the page is a
 * webtoon strip to be re-cut. */
const BOOK_MANGA = "manga";
const BOOK_WESTERN = "western";
const BOOK_WEBTOON = "webtoon";
const BOOK_YONKOMA = "yonkoma";
const BOOK_YONKOMA_LTR = "yonkoma-ltr";
const BOOK_TYPES = [BOOK_MANGA, BOOK_WESTERN, BOOK_WEBTOON, BOOK_YONKOMA, BOOK_YONKOMA_LTR];

function validBookType(v) { return BOOK_TYPES.includes(v) ? v : ""; }

/* ── Image helpers ────────────────────────────────────────────── */

const EXT_MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp",
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

/* Encode a page or panel canvas, whichever kind of canvas makeCanvas handed back.
 *
 * OffscreenCanvas.convertToBlob rejects when it cannot encode, but HTMLCanvasElement.toBlob
 * reports the same failure by passing the callback null -- so on the branch browsers without
 * OffscreenCanvas take, an encode failure used to surface much later as "Cannot read
 * properties of null (reading 'arrayBuffer')", naming neither the page nor the cause. Say
 * what actually failed instead; the caller turns it into a log line the user can act on. */
async function canvasBytes(canvas, type, quality) {
  const opts = quality === undefined ? { type } : { type, quality };
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob(opts)
    : await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) {
    throw new Error(`This browser could not encode a ${canvas.width}x${canvas.height} image as ${type} ` +
      "— try a smaller target resolution.");
  }
  return new Uint8Array(await blob.arrayBuffer());
}

function canvasToJpegBytes(canvas, quality) { return canvasBytes(canvas, "image/jpeg", quality); }

function canvasToPngBytes(canvas) { return canvasBytes(canvas, "image/png"); }

/* For a context that draws an image scaled: the default "low" quality is close to plain bilinear,
 * which turns screentone into moiré and thins fine lines when a page is shrunk to the screen. */
function smoothScaling(ctx) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return ctx;
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

async function geminiOcrOnce(jpegBytes, apiKey, model, prompt) {
  const imageB64 = await bytesToBase64(jpegBytes);
  const payload = {
    contents: [{
      parts: [
        { text: prompt },
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

async function geminiOcrPanel(jpegBytes, apiKey, model, prompt, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const result = await geminiOcrOnce(jpegBytes, apiKey, model, prompt);
    if (result !== null) return result;
    if (attempt < retries - 1) await sleep(Math.pow(2, attempt) * 1000);
  }
  // Every retryable failure -- a dropped connection, a gateway's HTML error page, a run of
  // UNAVAILABLE -- lands here. Say so: the panel is exported untranslated either way, and
  // without a line here an unreachable API looks exactly like a panel that has no text.
  logLine(`  Warning: no answer from Gemini after ${retries} attempts; this panel keeps no text.`, "warn");
  return { blocks: [], translation: "" };
}

/* ── Webtoon re-pagination ────────────────────────────────────── */

/* Re-cut a pre-sliced webtoon into screen-shaped pages at its own gutters.
 *
 * Takes the collected tile list and returns a replacement page list in the same
 * {name, read} shape, so everything downstream is unchanged. Tiles are scaled to the
 * most common width first, since a chapter's title banner often arrives at another size
 * and would otherwise offset every row below it. Port of assemble_webtoon_pages().
 *
 * Two passes, holding only the tiles that overlap the page being written: stitching a
 * 50,000px chapter into one canvas would be ~123MB, and browsers are a lot less
 * forgiving about that than a desktop. The row profile itself is one boolean per row. */
async function assembleWebtoonPages(pages, target, onProgress) {
  const decoded = [];  // {bitmap, w, h} after width normalisation, decoded lazily twice
  const widthCounts = new Map();
  const sizes = [];

  for (let i = 0; i < pages.length; i++) {
    const bmp = await decodeImage(await pages[i].read(), mangaFileExt(pages[i].name));
    sizes.push([bmp.width, bmp.height]);
    widthCounts.set(bmp.width, (widthCounts.get(bmp.width) || 0) + 1);
    bmp.close && bmp.close();
  }
  let width = sizes[0][0], bestCount = -1;
  for (const [w, count] of widthCounts) if (count > bestCount) { width = w; bestCount = count; }

  // Height each tile takes once scaled to the common width.
  const scaledH = sizes.map(([w, h]) => (w === width ? h : Math.max(1, Math.round(h * width / w))));

  async function tileCanvas(i) {
    const bmp = await decodeImage(await pages[i].read(), mangaFileExt(pages[i].name));
    const c = makeCanvas(width, scaledH[i]);
    const ctx = smoothScaling(c.getContext("2d", { willReadFrequently: true }));
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, scaledH[i]);
    ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, width, scaledH[i]);
    bmp.close && bmp.close();
    return c;
  }

  // Pass 1: row profile and tile offsets, one tile in memory at a time.
  const rows = [];
  const offsets = [];
  for (let i = 0; i < pages.length; i++) {
    const c = await tileCanvas(i);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const gray = grayFromRGBA(ctx.getImageData(0, 0, width, scaledH[i]).data, width, scaledH[i]);
    offsets.push([rows.length, scaledH[i]]);
    for (const blank of blankRows(gray, width, scaledH[i])) rows.push(blank);
    if (onProgress) onProgress(i, pages.length * 2);
  }

  const [tw, th] = Array.isArray(target) && target.length >= 2 ? target : MANGA_DEVICE_TARGETS.x4;
  const pageH = Math.max(1, Math.round(width * th / tw));
  const cuts = webtoonCutPoints(rows, pageH);

  // Pass 2: paint each page from the tiles it spans.
  const out = [];
  const cache = new Map();
  for (let n = 0; n < cuts.length - 1; n++) {
    let top = cuts[n];
    const bottom = cuts[n + 1];
    // Blank rows at a page's head are the tail of the gutter it was cut from; keeping
    // them would open every page with a band of empty paper.
    while (top < bottom && rows[top]) top++;
    if (top >= bottom) continue;

    const canvas = makeCanvas(width, bottom - top);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, bottom - top);
    for (let i = 0; i < offsets.length; i++) {
      const [start, height] = offsets[i];
      if (start >= bottom || start + height <= top) continue;
      if (!cache.has(i)) cache.set(i, await tileCanvas(i));
      ctx.drawImage(cache.get(i), 0, start - top);
    }
    for (const i of [...cache.keys()]) {
      if (offsets[i][0] + offsets[i][1] <= bottom) cache.delete(i);
    }
    const bytes = await canvasToPngBytes(canvas);
    const name = `webtoon_${String(out.length).padStart(4, "0")}.png`;
    out.push({ name, read: async () => bytes });
    if (onProgress) onProgress(pages.length + n, pages.length + cuts.length);
  }

  const snapped = cuts.slice(1, -1).filter((c) => rows[c - 1] || rows[Math.min(c, rows.length - 1)]).length;
  return { pages: out, stripHeight: rows.length, pageH, cuts: cuts.length - 2, snapped };
}

/* ── Two-page spreads ─────────────────────────────────────────── */

/* One half of a page, as PNG bytes: the crop on white, as convert_manga.py composites a page
 * (normalize_for_output) before cutting it. */
async function spreadHalfPng(page, [x1, y1, x2, y2]) {
  const bitmap = await decodeImage(await page.read(), mangaFileExt(page.name));
  const canvas = makeCanvas(x2 - x1, y2 - y1);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, x2 - x1, y2 - y1);
  ctx.drawImage(bitmap, x1, y1, x2 - x1, y2 - y1, 0, 0, x2 - x1, y2 - y1);
  bitmap.close && bitmap.close();
  return canvasToPngBytes(canvas);
}

/* Cut every landscape page (a scanned two-page spread) into its two halves, in reading order.
 * Halves are cut when read, so a book is never held in memory twice. Returns {pages, firstOutput}:
 * firstOutput[i] is the index of source page i's first output page, for moving chapters along.
 * Port of convert_manga.py:split_spread_pages, which names the halves the same way. */
async function splitSpreadPages(pages, rtl, onProgress) {
  const out = [], firstOutput = [];
  for (let i = 0; i < pages.length; i++) {
    if (onProgress) onProgress(i, pages.length);
    firstOutput.push(out.length);
    const page = pages[i];
    const bitmap = await decodeImage(await page.read(), mangaFileExt(page.name));
    const halves = spreadHalves(bitmap.width, bitmap.height, rtl);
    bitmap.close && bitmap.close();
    if (!halves) {
      out.push(page);
      continue;
    }
    halves.forEach((rect, part) => out.push({
      name: `page_${String(i).padStart(6, "0")}_${part}.png`,
      read: () => spreadHalfPng(page, rect),
    }));
  }
  return { pages: out, firstOutput };
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

const isMokuroName = (name) => /\.mokuro$/i.test(name);

/* A Mokuro volume picked as its .mokuro file plus the page images. From a folder pick, images are
 * matched by their path in the volume's own folder beside the .mokuro file; picked loose, by name. */
async function collectFromMokuroFiles(files) {
  const mokuroFiles = files.filter((f) => isMokuroName(f.name));
  if (mokuroFiles.length !== 1) throw new Error("Pick one .mokuro file with its page images (one volume at a time).");
  const mf = mokuroFiles[0];
  const volume = parseMokuroVolume(new TextDecoder().decode(await readFileBytes(mf)), mf.name);
  const images = files.filter((f) => isImageName(f.name));
  const byPath = new Map(images.map((f) => [pathNorm(f.webkitRelativePath || f.name), f]));
  const byName = new Map(images.map((f) => [f.name, f]));
  const here = mf.webkitRelativePath ? pathDirname(pathNorm(mf.webkitRelativePath)) : "";
  return mokuroCollected(volume, mf.name, (rel) => {
    for (const dir of volume.folders) {
      const f = here ? byPath.get(pathJoinNorm(here, `${dir}/${rel}`))
        : [...byPath.entries()].find(([p]) => p.endsWith(`${dir}/${rel}`))?.[1];
      if (f) return () => readFileBytes(f);
    }
    const f = here ? null : byName.get(baseName(rel));
    return f ? () => readFileBytes(f) : null;
  });
}

/* A Mokuro volume in a .zip/.cbz: the .mokuro file with its image folder beside it. */
async function collectFromMokuroZip(zip, mokuroEntry, fileName) {
  const volume = parseMokuroVolume(new TextDecoder().decode(await zip.readEntry(mokuroEntry)), mokuroEntry.name);
  const dir = pathDirname(pathNorm(mokuroEntry.name));
  const byPath = new Map(zip.entries.filter((e) => !e.isDir).map((e) => [pathNorm(e.name), e]));
  return mokuroCollected(volume, fileName, (rel) => {
    for (const folder of volume.folders) {
      const e = byPath.get(pathJoinNorm(dir, `${folder}/${rel}`));
      if (e) return () => zip.readEntry(e);
    }
    return null;
  });
}

/* The Mokuro volumes in an archive, in natural order of their .mokuro paths. */
function mokuroVolumesInZip(zip) {
  return zip.entries.filter((e) => !e.isDir && isMokuroMember(e.name))
    .sort((a, b) => compareNaturalKeys(naturalSortKey(a.name), naturalSortKey(b.name)));
}

function mokuroCollected(volume, label, readerFor) {
  const pages = [];
  for (const p of volume.pages) {
    const read = readerFor(p.imgPath);
    if (!read) { logLine(`Page image ${p.imgPath} not found next to the .mokuro file; skipped.`, "warn"); continue; }
    pages.push({ name: p.imgPath, read, mokuro: p });
  }
  if (!pages.length) throw new Error(`None of the pages listed in ${baseName(label)} were found. ` +
    `Its image folder (${volume.folder}/) must be included.`);
  logLine(`Mokuro volume: ${pages.length} page(s) with their text already read, so Gemini is not used.`);
  return { pages, meta: mokuroMeta(volume), tocEntries: [], sourceLabel: baseName(label), mokuro: true };
}

/* `files` is one book from splitIntoBooks(); `files.member` picks one volume of a Mokuro series archive. */
async function collectPagesFromInput(files) {
  if ([...files].some((f) => isMokuroName(f.name))) return collectFromMokuroFiles([...files]);
  if (files.length === 1 && !isImageName(files[0].name)) {
    const ext = mangaFileExt(files[0].name);
    const bytes = await readFileBytes(files[0]);
    if (ext === ".cbz" || ext === ".zip") return collectFromCbz(bytes, files[0].name, files.member);
    if (ext === ".epub") return collectFromEpub(bytes, files[0].name);
    if (ext === ".pdf") return collectFromPdf(bytes, files[0].name);
    throw new Error(`Unsupported input: ${files[0].name} (use .cbz, .zip, .epub, .pdf, or image files)`);
  }
  // Image list / folder selection. A folder pick keys pages by their path, so two chapter folders
  // that both start at 001.jpg keep both pages.
  const images = [...files].filter((f) => isImageName(f.name));
  if (!images.length) throw new Error("No image files found in the selection");
  const byName = new Map(images.map((f) => [f.webkitRelativePath || f.name, f]));
  const ordered = naturalSortPaths([...byName.keys()]);
  return {
    pages: ordered.map((name) => ({ name, read: () => readFileBytes(byName.get(name)) })),
    meta: { title: "", author: "", language: "" },
    tocEntries: [],
    sourceLabel: `${ordered.length} image files`,
  };
}

async function collectFromCbz(bytes, fileName, member) {
  const zip = new ZipReader(bytes);
  const mokuroEntries = mokuroVolumesInZip(zip);
  if (member) {
    const entry = mokuroEntries.find((e) => e.name === member);
    if (!entry) throw new Error(`${member} is no longer in ${fileName}.`);
    return collectFromMokuroZip(zip, entry, `${fileName}: ${baseName(member)}`);
  }
  if (mokuroEntries.length > 1) {
    throw new Error(`${fileName} holds ${mokuroEntries.length} Mokuro volumes. Convert makes a book of each; ` +
      "the checks work on one volume at a time.");
  }
  if (mokuroEntries.length === 1) return collectFromMokuroZip(zip, mokuroEntries[0], fileName);
  // Keyed by FULL path, not basename. Archives that give each chapter its own folder
  // restart page numbering inside it, so ch01/001.jpg and ch08/001.jpg share a basename
  // -- flattening on that silently kept only the last one, dropping most of the book and
  // interleaving the survivors. Only a genuine duplicate path collides now, and the log
  // says so rather than losing pages quietly.
  const byPath = new Map();
  let duplicates = 0;
  for (const e of zip.entries) {
    if (e.isDir || !isImageName(e.name)) continue;
    const key = pathNorm(e.name);
    if (byPath.has(key)) duplicates++;
    byPath.set(key, e);
  }
  if (!byPath.size) throw new Error("No image files found in the archive");
  if (duplicates) logLine(`${duplicates} duplicate image path(s) in the archive; keeping the last of each.`, "warn");
  const ordered = naturalSortPaths([...byPath.keys()]);

  let meta = { title: "", author: "", language: "" };
  let bookmarks = [];
  const infoEntry = zip.entries.find((e) => baseName(e.name).toLowerCase() === "comicinfo.xml");
  if (infoEntry) {
    try {
      const xml = new TextDecoder().decode(await zip.readEntry(infoEntry));
      meta = cbzMetadataFromComicInfo(xml);
      bookmarks = comicInfoBookmarks(xml, ordered.length);
    } catch (e) { /* best-effort, like the Python tool */ }
  }
  // Chapters the archive itself marks win; otherwise one per chapter folder.
  const tocEntries = bookmarks.length ? bookmarks : chaptersFromFolders(ordered);

  return {
    pages: ordered.map((name) => ({ name, read: () => zip.readEntry(byPath.get(name)) })),
    meta,
    tocEntries,
    tocSource: bookmarks.length ? "ComicInfo.xml bookmarks" : "chapter folders",
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

  return { pages, meta: epubMetadataFromOpf(opf), tocEntries, tocSource: "EPUB's table of contents", sourceLabel: fileName };
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

/* ONNX Runtime Web, shared by panel detection and PP-OCR. */
async function loadOrtRuntime() {
  if (typeof ort === "undefined") await loadScriptOnce(ORT_DIR + "ort.wasm.min.js");
  // Must be absolute: ort dynamic-import()s its .mjs loader, and bare
  // relative specifiers are invalid module specifiers.
  ort.env.wasm.wasmPaths = new URL(ORT_DIR, location.href).href;
}

function loadYoloDetector() {
  if (!yoloLoadPromise) {
    yoloLoadPromise = (async () => {
      await loadOrtRuntime();
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

/* Full resolution is a real choice with a real cost (files the Xteink firmware struggles with),
 * so the dropdown starts empty and the user picks one rather than falling into a default. */
const RES_FULL = "full";
/* A screen that isn't one of the presets: the width/height pair is typed in instead. */
const RES_CUSTOM = "custom";
/* Sanity bound on a typed size. The page header stores each dimension as a u16, and a target
 * larger than any e-ink screen only makes files the reader cannot use. */
const RES_CUSTOM_MAX = 4096;

/* Clamp a resolution choice to RES_FULL, RES_CUSTOM or a real MANGA_DEVICE_TARGETS key
 * (own-property only, so "__proto__" etc. can't slip through), or "" for "nothing picked". Guards
 * both the persisted <select> value and the conversion path against junk in localStorage. */
function validResChoice(v) {
  if (v === RES_FULL || v === RES_CUSTOM) return v;
  return Object.prototype.hasOwnProperty.call(MANGA_DEVICE_TARGETS, v) ? v : "";
}

/* The typed custom size as a [w, h] target, or null when either field is missing or out of range
 * -- the conversion refuses rather than falling back to a size the user did not ask for. */
function customResTarget() {
  const w = parseInt($("manga-res-w").value, 10);
  const h = parseInt($("manga-res-h").value, 10);
  if (!Number.isInteger(w) || !Number.isInteger(h)) return null;
  if (w < 1 || h < 1 || w > RES_CUSTOM_MAX || h > RES_CUSTOM_MAX) return null;
  return [w, h];
}

/* The hint under the dropdown describes the current choice: downscaling is the recommendation,
 * full resolution is the one that needs a warning rather than a description. */
const RES_HINT_DEFAULT = "Downscales to the device screen: smaller download, faster page turns, " +
  "no visible quality loss. Never upscales.";
const RES_HINT_FULL = "Warning: high file size — not suited to reading on " +
  "an Xteink device.";
const RES_HINT_CUSTOM = "Downscales to the entered size, for a screen that isn't listed above. " +
  "Never upscales. XTCH also needs a height that is a multiple of 8.";

/* Keep the hint and the custom width/height fields in step with the dropdown: the fields only
 * exist for the choice that uses them. */
function applyResChoiceUi() {
  const el = $("manga-res-hint");
  if (!el) return;
  const choice = validResChoice($("manga-res").value);
  const full = choice === RES_FULL;
  el.textContent = full ? RES_HINT_FULL : choice === RES_CUSTOM ? RES_HINT_CUSTOM : RES_HINT_DEFAULT;
  el.classList.toggle("warn", full);
  $("manga-res-custom").hidden = choice !== RES_CUSTOM;
}

/* Explain what the chosen book type will actually do, rather than leaving the extra
 * behaviour (margin trimming, strip re-cutting) invisible until it shows up in the log. */
const BOOK_TYPE_HINTS = {
  "": "",
  [BOOK_MANGA]: "Panels read right to left within a row, then down the page.",
  [BOOK_WESTERN]: "Panels read left to right within a row, then down the page. The paper border " +
      "and page number are cropped off, so the artwork fills the screen.",
  [BOOK_WEBTOON]: "One long vertical strip. Its tiles are reassembled and re-cut at the artwork's " +
      "gutters, so no page starts or ends mid-panel. Panels are the blocks between gutters.",
  [BOOK_YONKOMA]: "Each column is read top to bottom, then the column to its left — a 4-koma page " +
      "is two strips side by side, not rows across the page. For a book of strips: 4-koma pages " +
      "inside an ordinary manga are found without this.",
  [BOOK_YONKOMA_LTR]: "The same, for a strip page that reads the other way: each column top to " +
      "bottom, then the column to its right.",
};

const YOLO_HINT = "Finds panels more reliably, even ones without a white border. Runs in the " +
  "browser; pages are never uploaded. A one-time 21 MB download. Untick for a faster, simpler " +
  "search that looks for white or black space between panels.";
const YOLO_HINT_WEBTOON = "Not used for webtoons. Their panels are cut where the strip has white " +
  "space, and the AI only finds panels on a normal page.";

/* The panel detector is fine-tuned on Manga109, so a western page is out of its training
 * distribution and it misses panels: on a dense four-panel Moomin strip page it found 10 of
 * about 16. Say so where the choice is made rather than letting someone discover it after
 * converting a volume. Only for western comics -- a webtoon's panels are cut from the strip's
 * gutters and never go through the model at all, so the same warning there would be false. */
const BOOK_TYPE_WARNINGS = {
  [BOOK_WESTERN]: "The detector is manga-trained and misses panels on dense strip layouts. Reading " +
    "order and full pages are unaffected. For a different result, untick AI panel detection under " +
    "Advanced.",
};

/* A webtoon's panels come from its gutters, so the AI detector has nothing to find. Disable
 * it rather than leave a tickbox that does nothing, and say why in the hint itself -- a
 * greyed-out control with its reason hidden in a tooltip reads as broken, and a tooltip is
 * invisible on touch. */
function applyBookTypeUi() {
  const type = validBookType($("manga-booktype").value);
  const hint = $("manga-booktype-hint");
  if (hint) {
    hint.textContent = BOOK_TYPE_HINTS[type] || "";
    hint.hidden = !hint.textContent;
  }
  // The cards show the hidden select's value.
  for (const r of document.querySelectorAll('input[name="booktype"]')) r.checked = r.value === type;
  const warn = $("notice-booktype");
  if (warn) {
    warn.textContent = BOOK_TYPE_WARNINGS[type] || "";
    warn.hidden = !BOOK_TYPE_WARNINGS[type];
  }
  const yoloRow = $("manga-yolo-row");
  if (yoloRow) {
    const off = type === BOOK_WEBTOON;
    yoloRow.classList.toggle("disabled", off);
    $("manga-yolo").disabled = off;
    const yoloHint = yoloRow.querySelector(".hint");
    if (yoloHint) yoloHint.textContent = off ? YOLO_HINT_WEBTOON : YOLO_HINT;
  }
  applyPageOptionsUi();
}

const SPLIT_HINT = "Cuts each landscape page — a scanned two-page spread — into its two pages, " +
  "in reading order. Chapters move with their pages.";
const SPLIT_HINT_WEBTOON = "Not used for webtoons. Their pages are re-cut from the strip.";
const SPLIT_HINT_MOKURO = "Not for Mokuro volumes. Their text belongs to each page as it was scanned.";
const YONKOMA_DETECT_HINT = "A page laid out as side-by-side strips is read one strip at a time, top " +
  "to bottom, even inside an ordinary manga. Untick it if a normal page comes out in the wrong order.";
const YONKOMA_DETECT_HINT_WEBTOON = "Not used for webtoons. Their panels are read top to bottom.";

/* Options that do nothing for the chosen book are disabled, with the reason in their hint, like
 * the AI detector for webtoons. Spreads stay whole for a webtoon (its pages are re-cut) and for
 * Mokuro (its text is tied to each scanned page) -- convert_manga.py refuses --split-spreads with
 * either. */
function applyPageOptionsUi() {
  const webtoon = validBookType($("manga-booktype").value) === BOOK_WEBTOON;
  const setRow = (rowId, boxId, off, hint) => {
    const row = $(rowId);
    if (!row) return;
    row.classList.toggle("disabled", off);
    $(boxId).disabled = off;
    const h = row.querySelector(".hint");
    if (h) h.textContent = hint;
  };
  setRow("manga-split-row", "manga-split-spreads", webtoon || mangaState.mokuroInput,
    webtoon ? SPLIT_HINT_WEBTOON : mangaState.mokuroInput ? SPLIT_HINT_MOKURO : SPLIT_HINT);
  setRow("manga-yonkoma-detect-row", "manga-yonkoma-detect", webtoon,
    webtoon ? YONKOMA_DETECT_HINT_WEBTOON : YONKOMA_DETECT_HINT);
}

/* Text recognition: PP-OCR in this browser, Gemini, or none. */
const OCR_ENGINES = ["ppocr", "gemini", "none"];

function ocrEngine() {
  const v = $("manga-ocr-engine").value;
  return OCR_ENGINES.includes(v) ? v : "none";
}

/* The engine picked last, else PP-OCR, which needs no key. Someone who used Gemini before the
 * choice existed keeps it. */
function savedOcrEngine() {
  const saved = loadSetting("manga-ocr-engine", "");
  if (OCR_ENGINES.includes(saved)) return saved;
  return loadSetting("manga-no-ocr", "1") === "0" ? "gemini" : "ppocr";
}

/* The key field and the language pickers are only meaningful when Gemini will be called,
 * so they appear when it is picked rather than sitting there greyed. */
function applyOcrUi() {
  const engine = ocrEngine();
  // A Mokuro volume's text is already read: the card keeps only the text check.
  const mokuro = mangaState.mokuroInput;
  $("ocr-engine-part").hidden = mokuro;
  $("ocr-hint-mokuro").hidden = !mokuro;
  $("manga-ocr-fields").hidden = mokuro || engine !== "gemini";
  $("ocr-hint-ppocr").hidden = engine !== "ppocr";
  $("ocr-hint-none").hidden = engine !== "none";
  const h = document.querySelector("#card-ocr h3");
  if (h && h.dataset.base !== undefined) {
    h.dataset.base = mokuro ? "Text" : "Text recognition";
    renumberSteps();
  }
}

// mokuroInput: the chosen files are Mokuro volumes, which bring their own text (no Gemini).
// files: the last pick, from the file picker or the folder picker.
const mangaState = { running: false, cancelled: false, mokuroInput: false, files: null };

/* Whether the selection is Mokuro: a .mokuro file, or archives naming one. An archive's file
 * list sits at its end, so only the last 256 KB are read rather than the whole book. */
async function selectionIsMokuro(files) {
  const list = [...files];
  if (list.some((f) => isMokuroName(f.name))) return true;
  const archives = list.filter((f) => [".zip", ".cbz"].includes(mangaFileExt(f.name)));
  if (!archives.length || archives.length !== list.length) return false;
  const needle = new TextEncoder().encode(".mokuro");
  for (const f of archives) {
    const tail = new Uint8Array(await f.slice(Math.max(0, f.size - 262144)).arrayBuffer());
    let found = false;
    for (let i = 0; i + needle.length <= tail.length && !found; i++) {
      let j = 0;
      while (j < needle.length && (tail[i + j] | 0x20) === needle[j]) j++;
      found = j === needle.length;
    }
    if (!found) return false;
  }
  return true;
}

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

/* The EPUB's images as a PDF. The PDF embeds JPEG only, so PNG pages (and the odd CMYK JPEG)
 * are re-encoded; everything else goes in byte for byte. */
async function buildMangaPdf({ title, author, epubPages }) {
  const images = [];
  for (const pg of epubPages) {
    for (const im of pg.images) {
      let bytes = im.bytes;
      if (im.mime !== "image/jpeg" || ![1, 3].includes(jpegComponents(bytes))) {
        const bmp = await createImageBitmap(new Blob([bytes], { type: im.mime }));
        const c = makeCanvas(bmp.width, bmp.height);
        c.getContext("2d").drawImage(bmp, 0, 0);
        bmp.close();
        bytes = await canvasToJpegBytes(c, 0.92);
      }
      images.push({ bytes, w: im.w, h: im.h });
    }
  }
  return buildPdf({ title, author, images });
}

/* Encode one image as an XTC (1-bit) and/or XTCH (2-bit) page, laid out for the device screen.
 *
 * Every page in a book is rendered onto the SAME canvas size, because the reader allocates one
 * page buffer for the whole session and cannot grow it -- a later, larger page just fails to load
 * ("Buffer too small: need N, have M"). Panels are all different shapes, so each is scaled to fit
 * and centred on white, and a landscape one is rotated to portrait first so it fills the screen
 * rather than sitting in a thin band (the same thing the EPUB export does). rotateLandscape=false
 * keeps the image as drawn, letterboxed into the page.
 *
 * Both depths are dithered (Floyd-Steinberg) rather than rounded per pixel: a plain threshold
 * turns screentone into flat black, and plain rounding to XTH's four grays into blotches. XTH additionally needs a height that is a multiple of 8, which
 * every device target already satisfies (800 and 792 both divide by 8). */
function encodeXtcVariants(src, wantXtc, wantXtch, target, rotateLandscape = true, gamma = 1, style = "floyd") {
  const [w, h] = target;
  const page = makeCanvas(w, h);
  const ctx = smoothScaling(page.getContext("2d", { willReadFrequently: true }));
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);

  let img = src;
  if (rotateLandscape && src.width > src.height && w < h) img = rotateCanvas90CW(src);
  const scale = Math.min(w / img.width, h / img.height);
  const dw = Math.max(1, Math.round(img.width * scale));
  const dh = Math.max(1, Math.round(img.height * scale));
  ctx.drawImage(img, Math.round((w - dw) / 2), Math.round((h - dh) / 2), dw, dh);

  // Both depths read from the same corrected buffer, so a book exported as XTC and XTCH
  // gets the same tonality rather than one of the two coming out darker.
  const gray = stretchPaperAndInk(
    unsharpMask(applyGrayGamma(grayFromRGBA(ctx.getImageData(0, 0, w, h).data, w, h), gamma), w, h));
  const out = {};
  if (wantXtc) {
    const dithered = ditherMono(gray, w, h, style);   // 0/1 per pixel, 1 = white
    const bw = new Uint8Array(w * h);
    for (let i = 0; i < bw.length; i++) bw[i] = dithered[i] ? 255 : 0;
    out.xtc = { bytes: encodeXtgPage(bw, w, h), w, h };
  }
  if (wantXtch) out.xtch = { bytes: encodeXthPage(ditherLevels(gray, w, h, 4, style), w, h), w, h };
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
  const matcha = nothingPicked || f.has("matcha") || f.has("matchafile");
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.hidden = !on; };
  applyPageOptionsUi();
  // A Mokuro volume already has its text: its card only offers the text check (see applyOcrUi).
  show("card-ocr", matcha);
  show("notice-ocr", matcha && !mangaState.mokuroInput);
  show("card-install", matcha);
  show("card-book", matcha || nothingPicked || f.has("epub") || f.has("pdf") || f.has("xtc") || f.has("xtch"));
  show("manga-mono-row", matcha);
  // Dither brightness only means something when something is actually dithered: a 1-bit page
  // in the device folder, or either XTC depth. A JPEG page never goes near it.
  show("manga-dither-row",
    nothingPicked || f.has("xtc") || f.has("xtch") || (matcha && $("manga-mono").checked));
  // Panel rotation only exists in the pre-rendered exports; the device folder's crops are rotated
  // by the firmware at display time, so the option would mean nothing there.
  show("manga-xtc-split-row", f.has("xtc") || f.has("xtch"));
  show("manga-rotate-row", nothingPicked || f.has("epub") || f.has("pdf") || f.has("xtc") || f.has("xtch"));
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

/* Panels fixed by hand in the panel check, by source page name: {w, h, boxes} in the page space
 * they were drawn in. Cleared when another file is chosen. */
const panelEdits = new Map();

/* Text fixed by hand in the text check, by source page name: {w, h, trim, blocks} in the page space it
 * was read in (trim: whether the paper border was cut off first). Cleared when another file is chosen. */
const textEdits = new Map();

/* The decoded page at full resolution on white -- transparent sources composite onto white, the
 * device's alpha handling and convert_manga.py:normalize_for_output's. */
function fullResolutionCanvas(bitmap, w, h) {
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0);
  return canvas;
}

/* Boxes drawn on a w x h page, mapped onto a page of tw x th (the same page at another size). */
function scaleBoxes(boxes, w, h, tw, th) {
  if (w === tw && h === th) return boxes.map((b) => b.slice());
  const sx = tw / w, sy = th / h;
  return boxes.map(([x1, y1, x2, y2]) => [Math.round(x1 * sx), Math.round(y1 * sy), Math.round(x2 * sx), Math.round(y2 * sy)]);
}

/* Read, trim, downscale, clean up and detect one page -- shared by the conversion and the panel
 * check, so both see the same page and the same panels. `o` holds the conversion settings:
 * {trimMargins, deviceTarget, cleanup, cleanupOn, isWebtoon, yolo, rtl, columnMajor, yonkomaDetect},
 * and detect: false for the page image alone. Panel boxes are in the downscaled page's space
 * (imgW x imgH). `sourceCanvas` is the full-resolution page on white when the AI detector needed
 * it, else null. The caller closes `bitmap`. */
async function preparePage(page, o) {
  const srcBytes = await page.read();
  let ext = mangaFileExt(page.name);
  let bitmap = await decodeImage(srcBytes, ext);
  const srcW = bitmap.width, srcH = bitmap.height;
  let trimX = 0, trimY = 0;

  // Crop the blank paper border (and the page number sitting in it) before anything
  // else, so every coordinate downstream lives in the trimmed page's space. It fills
  // the screen, and it measurably improves detection: a page whose margin is gone
  // gives the detector nothing but artwork to look at.
  let wasTrimmed = false;
  if (o.trimMargins) {
    const probe = makeCanvas(bitmap.width, bitmap.height);
    const pctx = probe.getContext("2d", { willReadFrequently: true });
    pctx.drawImage(bitmap, 0, 0);
    const gray = grayFromRGBA(pctx.getImageData(0, 0, bitmap.width, bitmap.height).data,
      bitmap.width, bitmap.height);
    const box = trimMarginsBox(gray, bitmap.width, bitmap.height);
    if (box) {
      const [tx1, ty1, tx2, ty2] = box;
      trimX = tx1; trimY = ty1;
      const cropped = makeCanvas(tx2 - tx1, ty2 - ty1);
      const cctx = cropped.getContext("2d");
      cctx.fillStyle = "#ffffff";
      cctx.fillRect(0, 0, tx2 - tx1, ty2 - ty1);
      cctx.drawImage(probe, tx1, ty1, tx2 - tx1, ty2 - ty1, 0, 0, tx2 - tx1, ty2 - ty1);
      bitmap.close && bitmap.close();
      bitmap = await createImageBitmap(cropped);
      wasTrimmed = true;
    }
  }

  // Downscale FIRST, before panel detection, so every downstream coordinate
  // (panel boxes, crop rects, OCR text boxes, the page dims in panels.idx)
  // lives in the resized space and matches the files actually written. When
  // no device is selected fit.resized is false and this is a 1:1 draw, so the
  // default output is unchanged. (White-fill for transparent sources differs
  // per canvas — see the detection/page and full-res source canvases below.)
  const origW = bitmap.width, origH = bitmap.height;
  const fit = fitToDeviceSize(origW, origH, o.deviceTarget);
  const imgW = fit.w, imgH = fit.h;
  const wasResized = fit.resized;

  // Page canvas (downscaled), which the gutter grid also runs on. White-fill only when actually
  // resizing, so panels.idx and the default (Original) output are unchanged.
  const canvas = makeCanvas(imgW, imgH);
  const ctx = smoothScaling(canvas.getContext("2d", { willReadFrequently: true }));
  if (wasResized) { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, imgW, imgH); }
  ctx.drawImage(bitmap, 0, 0, origW, origH, 0, 0, imgW, imgH);
  // Image clean-up: one tone curve per page, from the page itself, reused for its crops.
  const tone = o.cleanupOn ? cleanPage(ctx, imgW, imgH, o.cleanup) : null;
  const tuned = !!tone || o.cleanup.sharpen;
  // The source bitmap stays open until after detection: the full-resolution
  // panel-crop canvas is only built for pages that actually have a panel to
  // crop (see below), so a cover / full-page spread never allocates it.

  const rgba = ctx.getImageData(0, 0, imgW, imgH).data;

  // A Mokuro page's text, in its source image's pixels: undo the trim, then scale to the page.
  let pageText = null;
  // Text fixed by hand in the text check is used as it is, not read again. It only fits the page it
  // was made on: trimming the border moves every coordinate.
  const fixed = o.detect !== false && (page.mokuro || o.ppocr) ? textEdits.get(page.name) : null;
  if (fixed && fixed.trim === !!o.trimMargins) {
    pageText = scaleTextBlocks(fixed.blocks, fixed.w, fixed.h, imgW, imgH);
  } else if (page.mokuro) {
    const kx = page.mokuro.width ? srcW / page.mokuro.width : 1;
    const ky = page.mokuro.height ? srcH / page.mokuro.height : 1;
    const sx = imgW / origW, sy = imgH / origH;
    const clamp = (v, hi) => Math.trunc(Math.min(Math.max(v, 0), hi));
    pageText = mokuroTextBlocks(page.mokuro.blocks,
      (x, y) => [clamp((x * kx - trimX) * sx, imgW), clamp((y * ky - trimY) * sy, imgH)]);
  } else if (o.ppocr && o.detect !== false) {
    // Read on the trimmed page at full resolution, then scaled to the stored page like Mokuro's.
    const record = await ppocrReadPage(o.ppocr, bitmap, origW, origH, o.rtl && !o.isWebtoon);
    const sx = imgW / origW, sy = imgH / origH;
    const clamp = (v, hi) => Math.trunc(Math.min(Math.max(v, 0), hi));
    pageText = mokuroTextBlocks(record.blocks, (x, y) => [clamp(x * sx, imgW), clamp(y * sy, imgH)]);
  }

  let boxes = null;
  let sourceCanvas = null;
  if (o.detect === false || o.panels === false) {
    // The panel editor only needs the page image, the text check only its text.
  } else if (o.isWebtoon) {
    // Already one top-to-bottom column, cut at its own gutters. The manga detector
    // looks for bordered rectangles in a grid and a webtoon has none, and reordering
    // a single column can only move boxes away from what the cut established.
    boxes = detectWebtoonPanels(grayFromRGBA(rgba, imgW, imgH), imgW, imgH);
  } else {
    // The model looks at the full-resolution page, before it is reduced to the screen, so thin
    // gutters are not lost; its boxes come back in the stored page's pixels. The gutter grid runs
    // on the stored page. As convert_manga.py:detect_panels(source_img, img).
    const stored = { gray: grayFromRGBA(rgba, imgW, imgH), w: imgW, h: imgH };
    let detected = null, full = null;
    if (o.yolo) {
      try {
        sourceCanvas = fullResolutionCanvas(bitmap, origW, origH);
        const fullRgba = sourceCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, origW, origH).data;
        full = { gray: grayFromRGBA(fullRgba, origW, origH), w: origW, h: origH };
        detected = await detectPanelsYolo(o.yolo.session, o.yolo.ort, fullRgba, origW, origH, undefined, full.gray);
      } catch (e) {
        detected = null;
        logLine(`AI detection failed on this page (${e.message}); using the grid heuristic.`, "warn");
      }
    }
    // The grid heuristic has no text detection, so nothing grows over bubbles there.
    const found = detectPanels(detected, full, stored);
    let frames = found.frames.length ? found.frames : [[0, 0, imgW, imgH]];
    // Mokuro's blocks mark the bubbles too, so panel crops grow over them.
    const textBoxes = pageText ? found.texts.concat(pageText.map((b) => b.box)) : found.texts;
    // Order on the frames as drawn -- growing a box moves its centre, which the ordering works
    // on -- then grow the crops over the bubbles. yoloExpandPanelsOverText() is index-preserving,
    // so the order survives.
    frames = orderPanels(frames, imgW, o.rtl, o.columnMajor, o.yonkomaDetect !== false);
    boxes = yoloExpandPanelsOverText(frames, textBoxes, imgW, imgH);
  }
  return { srcBytes, ext, bitmap, wasTrimmed, origW, origH, imgW, imgH, wasResized, canvas, ctx, tone, tuned, rgba, boxes, pageText, sourceCanvas };
}

/* ── Image clean-up ───────────────────────────────────────────────── */

function cleanupSettings() {
  return { levels: $("manga-levels").checked, sharpen: $("manga-sharpen").checked,
    contrast: Object.prototype.hasOwnProperty.call(CONTRAST_GAMMAS, $("manga-contrast").value) ? $("manga-contrast").value : "off" };
}

/* Clean a page canvas in place; returns its tone curve (null when levels/contrast change nothing). */
function cleanPage(ctx, w, h, cleanup) {
  const img = ctx.getImageData(0, 0, w, h);
  const tone = toneCurve(img.data, cleanup);
  if (tone) applyToneCurve(img.data, tone);
  if (cleanup.sharpen) sharpenRGBA(img.data, w, h);
  ctx.putImageData(img, 0, 0);
  return tone;
}

/* Clean a panel crop with its page's tone curve, so the two match. */
function cleanCrop(ctx, w, h, tone, sharpen) {
  const img = ctx.getImageData(0, 0, w, h);
  if (tone) applyToneCurve(img.data, tone);
  if (sharpen) sharpenRGBA(img.data, w, h);
  ctx.putImageData(img, 0, 0);
}

/* Before/after of one page at the device size, with the current clean-up settings. The pages are
 * collected once per file selection. */
let previewSource = null;
let previewPage = 1;
async function showCleanupPreview() {
  const files = chosenFiles();
  if (!files || !files.length) { logValidation("Choose a file first to preview a page."); return; }
  const btn = $("manga-preview-btn");
  btn.disabled = true;
  try {
    if (!previewSource || previewSource.files !== files) {
      previewSource = { files, collected: await collectPagesFromInput(splitIntoBooks(files)[0]) };
    }
    const pages = previewSource.collected.pages;
    previewPage = Math.min(pages.length, Math.max(1, previewPage));
    const n = previewPage;
    $("manga-preview-label").textContent = `Page ${n} of ${pages.length}`;
    $("manga-preview-prev").disabled = n === 1;
    $("manga-preview-next").disabled = n === pages.length;
    // Stepping onto the first or last page disables the button in hand: hand focus to the other.
    const held = document.activeElement;
    if (held && held.disabled && (held.id === "manga-preview-prev" || held.id === "manga-preview-next")) {
      $(held.id === "manga-preview-prev" ? "manga-preview-next" : "manga-preview-prev").focus();
    }
    const bitmap = await decodeImage(await pages[n - 1].read(), mangaFileExt(pages[n - 1].name));
    const target = MANGA_DEVICE_TARGETS[validResChoice($("manga-res").value)] || [480, 800];
    const fit = fitToDeviceSize(bitmap.width, bitmap.height, target);
    const draw = (id) => {
      const c = $(id);
      c.width = fit.w; c.height = fit.h;
      const ctx = smoothScaling(c.getContext("2d", { willReadFrequently: true }));
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, fit.w, fit.h);
      ctx.drawImage(bitmap, 0, 0, fit.w, fit.h);
      return ctx;
    };
    draw("manga-preview-before");
    cleanPage(draw("manga-preview-after"), fit.w, fit.h, cleanupSettings());
    bitmap.close && bitmap.close();
    $("manga-preview").hidden = false;
    btn.textContent = "Hide preview";
    btn.setAttribute("aria-expanded", "true");
  } catch (e) {
    logLine("Preview failed: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
}

/* The line beside Convert: what is still missing, or what the conversion will make. */
const FORMAT_NAMES = { matchafile: ".matcha", matcha: "folder", epub: "EPUB", pdf: "PDF", xtc: "XTC", xtch: "XTCH" };
function updateRunSummary() {
  const files = chosenFiles();
  const formats = [...selectedFormats()];
  const res = $("manga-res");
  const missing = [];
  if (!files || !files.length) missing.push("a manga");
  if (!formats.length) missing.push("a format");
  if (!validBookType($("manga-booktype").value)) missing.push("the book type");
  if (!validResChoice(res.value)) missing.push("a device");
  // The panel check needs a single book and its reading order; say so instead of failing on click.
  const checkBtn = $("panel-check-btn");
  if (!panelCheckRunning) {
    const bt = validBookType($("manga-booktype").value);
    const why = !files || !files.length ? "Choose a manga and how it reads first."
      : !bt ? "Choose how it reads first."
      : bt === BOOK_WEBTOON ? "Not needed for webtoons: their panels come from the strip's gutters."
      : splitIntoBooks(files).length > 1 ? "Works on one book at a time."
      : "";
    checkBtn.disabled = !!why;
    $("panel-check-hint").textContent = why || "See where they are and fix wrong ones before converting.";
  }
  const el = $("manga-run-summary");
  if (missing.length) {
    el.textContent = `Still to choose: ${missing.join(", ")}.`;
    return;
  }
  const books = splitIntoBooks(files).length;
  const folder = files[0].webkitRelativePath ? files[0].webkitRelativePath.split("/")[0] : "";
  const what = books > 1 ? `${books} books` : files.length === 1 ? files[0].name : folder || `${files.length} images`;
  const device = res.selectedOptions[0] ? res.selectedOptions[0].textContent.replace(/ — .*/, "") : "";
  el.textContent = `Ready: ${what} → ${formats.map((f) => FORMAT_NAMES[f] || f).join(" + ")}, ${device}.`;
}

/* Title/series/volume guessed from a single archive's file name; empty for a set of images. */
function fileNameMeta(files) {
  return files.length === 1 && !isImageName(files[0].name) ? metaFromFileName(files[0].name)
    : { title: "", series: "", seriesIndex: null };
}

/* Show what the file name suggests as the placeholder of each empty metadata field. */
function showFileNameMeta() {
  const files = chosenFiles();
  const m = splitIntoBooks(files).length > 1 ? { title: "", series: "", seriesIndex: null } : fileNameMeta(files);
  $("manga-title").placeholder = m.title ? `from file: ${m.title}` : "auto";
  $("manga-series").placeholder = m.series ? `from file: ${m.series}` : "auto";
  $("manga-series-index").placeholder = m.seriesIndex !== null ? `from file: ${m.seriesIndex}` : "auto";
}

/* Several archives (CBZ, ZIP, EPUB, PDF) are one book each; so is each Mokuro volume in a folder
 * pick (its .mokuro file and the images in its own folder). Anything else -- one archive, or a set
 * of page images -- is a single book. A Mokuro series archive is split into its volumes later, by
 * expandMokuroArchives(), as that needs the archive read. */
function splitIntoBooks(files) {
  const list = [...files];
  const byPath = (a, b) => compareNaturalKeys(naturalSortKey(a.webkitRelativePath || a.name), naturalSortKey(b.webkitRelativePath || b.name));
  const mokuros = list.filter((f) => isMokuroName(f.name)).sort(byPath);
  const isArchive = (f) => [".zip", ".cbz"].includes(mangaFileExt(f.name));
  const folderPick = list.some((f) => f.webkitRelativePath);
  // A Mokuro library: series folders of volumes, and series archives (split into volumes later).
  if (mokuros.length > 1 || (folderPick && mokuros.length && list.some(isArchive))) {
    const volumes = mokuros.map((mf) => {
      const here = pathDirname(pathNorm(mf.webkitRelativePath || mf.name));
      const dirs = mokuroImageDirs(baseName(mf.name).replace(/\.mokuro$/i, "")).map((d) => pathJoinNorm(here, d) + "/");
      return [mf, ...list.filter((f) => isImageName(f.name) && dirs.some((d) => pathNorm(f.webkitRelativePath || "").startsWith(d)))];
    });
    return volumes.concat(list.filter(isArchive).sort(byPath).map((f) => [f]))
      .sort((a, b) => byPath(a[0], b[0]));
  }
  if (mokuros.length === 1) return [list];
  // A folder of series archives: one book each (Mokuro ones split into volumes later).
  if (folderPick && list.filter(isArchive).length > 1) return list.filter(isArchive).sort(byPath).map((f) => [f]);
  const archives = list.filter((f) => !isImageName(f.name));
  if (list.length > 1 && archives.length === list.length) {
    return archives.sort(byPath).map((f) => [f]);
  }
  // A folder of images may hold other files too (a ComicInfo.xml, thumbnails' .db): one book.
  if (list.length > 1 && archives.length && list.some((f) => f.webkitRelativePath)) return [list.filter((f) => isImageName(f.name))];
  return [list];
}

/* One book per volume of each Mokuro series archive among the books; other books stay as they are.
 * Reads each archive that names a .mokuro file to list its volumes. */
async function expandMokuroArchives(books) {
  const out = [];
  for (const book of books) {
    const f = book[0];
    if (book.length !== 1 || ![".zip", ".cbz"].includes(mangaFileExt(f.name)) || !(await selectionIsMokuro([f]))) {
      out.push(book);
      continue;
    }
    const volumes = mokuroVolumesInZip(new ZipReader(await readFileBytes(f)));
    if (volumes.length < 2) { out.push(book); continue; }
    logLine(`${f.name} holds ${volumes.length} Mokuro volumes; each becomes its own book.`);
    for (const v of volumes) {
      const vb = [f];
      vb.member = v.name;
      out.push(vb);
    }
  }
  return out;
}

/* How a book is named in the log: its file, and the volume for one of a series archive. */
function bookLabel(book) {
  return book.member ? `${book[0].name}: ${baseName(book.member).replace(/\.mokuro$/i, "")}` : (book[0].webkitRelativePath || book[0].name);
}

/* The files of the last pick, from the file picker or the folder picker. */
function chosenFiles() {
  return mangaState.files || $("manga-file").files;
}

async function runMangaConversion() {
  const files = chosenFiles();
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
  const matchaFile = formats.has("matchafile");
  const engine = ocrEngine();
  // noOcr: Gemini is not called. PP-OCR's text, like Mokuro's, comes in with the page instead.
  const noOcr = engine !== "gemini" || !(formats.has("matcha") || matchaFile);
  const usePpocr = engine === "ppocr" && (formats.has("matcha") || matchaFile);
  const mono = $("manga-mono").checked;
  const pdf = formats.has("pdf");
  // The PDF is built from the same page/panel images as the EPUB, so either one collects them.
  const epub = formats.has("epub") || pdf;
  // matchaFolder: any device output. The legacy folder and the .matcha file hold the same entries.
  const matchaFolder = formats.has("matcha") || matchaFile;
  const wantXtc = formats.has("xtc");
  const wantXtch = formats.has("xtch");
  const anyXtc = wantXtc || wantXtch;
  const panelsOnly = $("manga-panels-only").checked;
  // A wide panel is turned upright so it fills a portrait screen instead of sitting in a thin
  // band. Only EPUB/XTC/XTCH are affected -- they embed a pre-rendered image, so the orientation
  // is baked in at conversion time; the device folder's crops keep their own shape and the
  // firmware rotates them when it zooms one to the screen.
  const rotatePanels = $("manga-rotate-panels").checked;
  // How much of a page's ink must sit inside its panels before the full page may be dropped.
  // Not 100%: a stray speck in the gutter or a page number outside every panel is not content
  // worth keeping a whole page image for.
  const PANELS_ONLY_MIN_INK_COVERAGE = 0.98;
  let pagesKeptForCoverage = 0;
  // XTC/XTCH pages are accumulated as encoded bitmaps (one per page/panel image, same reading
  // order as the EPUB) and assembled once at the end, since the page table needs every size.
  const xtcPages = [], xtchPages = [];
  const xtcPageMap = new Map();   // source page index -> position in the exported XTC sequence
  // Target resolution: RES_FULL (keep the source pixels), a device preset (a MANGA_DEVICE_TARGETS key), or
  // RES_CUSTOM with a typed width/height. Anything but full resolution downscales pages and panels
  // before detection so the device decodes fewer pixels; it never upscales. Nothing is
  // preselected, so an unanswered dropdown is a user error rather than a default to guess at.
  const resChoice = validResChoice($("manga-res").value);
  if (!resChoice) {
    logValidation("Pick a target resolution — a device, a custom size, or full resolution.");
    return;
  }
  let deviceTarget = null;
  if (resChoice === RES_CUSTOM) {
    deviceTarget = customResTarget();
    if (!deviceTarget) {
      logValidation(`Enter a custom width and height, each between 1 and ${RES_CUSTOM_MAX} px.`);
      return;
    }
    // XTCH's two bit-planes are indexed by column in 8-row groups, so a height that isn't a
    // multiple of 8 makes the firmware read past the buffer it sized. The presets all divide by 8;
    // a typed one may not, and rounding it silently would export a size nobody asked for.
    if (wantXtch && deviceTarget[1] % 8 !== 0) {
      const near = Math.max(8, Math.round(deviceTarget[1] / 8) * 8);
      logValidation(`XTCH needs a page height that is a multiple of 8 — try ${near} instead of ${deviceTarget[1]}.`);
      return;
    }
  } else if (resChoice !== RES_FULL) {
    deviceTarget = MANGA_DEVICE_TARGETS[resChoice];
  }
  // XTC/XTCH are pre-rendered: every page is written at one fixed size, because the reader
  // allocates a single page buffer for the book. Full resolution leaves panels at their own
  // (varying, full-size) dimensions, which has no sensible answer here -- so a device is required.
  if (anyXtc && !deviceTarget) {
    logValidation("Pick a target resolution (a device or a custom size) for XTC/XTCH — those formats need a fixed page size.");
    return;
  }
  // Book type drives panel reading order, margin trimming and webtoon re-cutting.
  // Like the resolution, nothing is preselected -- reading a western comic in manga
  // order is a silent, wrong-looking result, not something to guess at.
  // Dither brightness only reaches the dithered outputs (1-bit BMP, XTC, XTCH); the JPEG
  // and PNG paths are untouched by it.
  const ditherGamma = validDitherGamma($("manga-dither").value);
  const ditherStyle = validDitherStyle($("manga-dither-style").value);
  const xtcSplit = parseInt($("manga-xtc-split").value, 10) || 0;
  const cleanup = cleanupSettings();
  const cleanupOn = cleanup.levels || cleanup.contrast !== "off" || cleanup.sharpen;
  const bookType = validBookType($("manga-booktype").value);
  if (!bookType) {
    logValidation("Pick a book type — manga, western comic, or webtoon/manhwa.");
    return;
  }
  // Yonkoma is Japanese too: its columns run right to left, like manga's tiers. An English or
  // otherwise left-to-right strip page is the same layout read the other way.
  const rtl = bookType === BOOK_MANGA || bookType === BOOK_YONKOMA;
  const isWebtoon = bookType === BOOK_WEBTOON;
  const columnMajor = bookType === BOOK_YONKOMA || bookType === BOOK_YONKOMA_LTR;
  // Western print comics are scans with a paper border; trimming it is always wanted, so
  // it rides on the book type rather than being one more checkbox to find.
  const trimMargins = bookType === BOOK_WESTERN;
  // Disabled for webtoons and Mokuro volumes (see applyPageOptionsUi), whose pages must stay as
  // they are; a disabled box does nothing however it was left.
  const splitSpreads = $("manga-split-spreads").checked && !$("manga-split-spreads").disabled;
  const yonkomaDetect = $("manga-yonkoma-detect").checked;

  const apiKey = $("manga-key").value.trim();
  const model = $("manga-model").value.trim() || GEMINI_DEFAULT_MODEL;
  if (!noOcr && !apiKey && !mangaState.mokuroInput) {
    logValidation("Enter a Gemini API key, or pick another text recognition.");
    return;
  }
  saveSetting("gemini-key", apiKey);
  saveSetting("gemini-model", model);
  saveSetting("manga-yolo", $("manga-yolo").checked ? "1" : "0");
  saveSetting("manga-mono", mono ? "1" : "0");
  saveSetting("manga-panels-only", panelsOnly ? "1" : "0");
  saveSetting("manga-rotate-panels", rotatePanels ? "1" : "0");
  saveSetting("manga-split-spreads", $("manga-split-spreads").checked ? "1" : "0");
  saveSetting("manga-yonkoma-detect", yonkomaDetect ? "1" : "0");
  saveSetting("manga-format", [...formats].join(","));
  saveSetting("manga-booktype", bookType);
  saveSetting("manga-dither", $("manga-dither").value);
  saveSetting("manga-dither-style", ditherStyle);
  saveSetting("manga-xtc-split", String(xtcSplit));
  saveSetting("manga-levels", cleanup.levels ? "1" : "0");
  saveSetting("manga-sharpen", cleanup.sharpen ? "1" : "0");
  saveSetting("manga-contrast", cleanup.contrast);
  saveSetting("manga-ocr-engine", engine);
  saveSetting("manga-ocr-out", $("manga-ocr-out").value);
  saveSetting("manga-res", resChoice);
  if (resChoice === RES_CUSTOM) {
    saveSetting("manga-res-w", String(deviceTarget[0]));
    saveSetting("manga-res-h", String(deviceTarget[1]));
  }

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

  // Several archives at once are separate books, converted and downloaded one after another; so are
  // the volumes of a Mokuro library or series archive.
  let books = splitIntoBooks(files);
  try {
    books = await expandMokuroArchives(books);
  } catch (e) {
    logLine(`Could not list the volumes in ${books[0][0].name} (${e.message}); converting it as one book.`, "warn");
  }
  const batch = books.length > 1;
  // In a batch, the fields that describe one book do not apply: each book takes its own.
  const bookField = (id) => (batch ? "" : $(id).value);
  if (batch) {
    const ignored = ["manga-title", "manga-series-index", "manga-cover", "manga-toc"].filter((id) => $(id).value.trim());
    if (ignored.length) {
      logLine("Converting several books: the title, volume, cover page and chapter list fields are ignored; " +
        "each book takes its own from its file.", "warn");
    }
  }

  const convertBook = async (files) => {
    let collected = null;
    try {
      logLine("Collecting pages…");
      collected = await collectPagesFromInput(files);
      let pages = collected.pages;
      // A Mokuro volume brings its own text, so Gemini is never called for it.
      const bookNoOcr = noOcr || !!collected.mokuro;
      if (collected.mokuro && isWebtoon) {
        throw new Error("Webtoon re-cuts the pages, which would separate Mokuro's text from its page. Pick another book type.");
      }

      // Resolve TOC before any max-pages truncation (indices stay correct).
      let tocEntries = collected.tocEntries;
      if (tocEntries.length) logLine(`Found ${tocEntries.length} chapter(s) from the ${collected.tocSource}`);
      if (splitSpreads) {
        if (collected.mokuro) {
          throw new Error("Splitting spreads changes the pages, which would separate Mokuro's text from its page. " +
            "Untick \"Split two-page spreads\".");
        }
        const sourceCount = pages.length;
        const split = await splitSpreadPages(pages, rtl,
          (done, total) => setProgress(done, total, "Looking for two-page spreads…"));
        pages = split.pages;
        tocEntries = remapTocAfterSplit(tocEntries, split.firstOutput);
        logLine(`Split landscape spreads: ${sourceCount} source pages became ${pages.length} pages`);
      }
      const tocText = bookField("manga-toc");
      if (tocText.trim()) {
        const parsed = parseTocText(tocText);
        parsed.warnings.forEach((warning) => logLine("Warning: " + warning, "warn"));
        tocEntries = parsed.entries;
        logLine(`Using ${tocEntries.length} chapter(s) from the chapter list`);
      }

      if (isWebtoon) {
        // Re-cutting changes how many pages there are, so a table of contents resolved
        // above now points at the wrong ones. Dropping it beats shipping wrong chapters.
        if (tocEntries.length) {
          logLine("The source table of contents no longer matches after re-cutting the strip, so it is dropped.", "warn");
          tocEntries = [];
        }
        logLine(`Reassembling ${pages.length} webtoon tiles and re-cutting at the artwork's gutters…`);
        const cut = await assembleWebtoonPages(pages, deviceTarget,
          (done, total) => setProgress(done, total, "Re-cutting the strip…"));
        pages = cut.pages;
        logLine(`Webtoon: ${cut.stripHeight}px strip re-cut into ${pages.length} pages of up to ` +
          `${cut.pageH}px, ${cut.snapped} of ${cut.cuts} cuts landing in a gutter`);
      }

      // The device takes page 0 as the cover, so a chosen cover page moves to the front; the
      // chapters before it shift back by one.
      const coverPage = parseInt(bookField("manga-cover"), 10);
      if (Number.isInteger(coverPage) && coverPage > 1) {
        if (isWebtoon) {
          logLine("Cover page is ignored for webtoons: their pages are re-cut from the strip.", "warn");
        } else if (coverPage > pages.length) {
          logLine(`Cover page ${coverPage} is past the last page (${pages.length}); keeping the first page.`, "warn");
        } else {
          const ci = coverPage - 1;
          pages = [pages[ci], ...pages.slice(0, ci), ...pages.slice(ci + 1)];
          tocEntries = tocEntries.map(([p, t]) => [p === ci ? 0 : p < ci ? p + 1 : p, t]);
          logLine(`Using page ${coverPage} as the cover`);
        }
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
      // A Mokuro volume brings its own text, so PP-OCR does not read it again.
      let bookPpocr = null;
      if (usePpocr && !collected.mokuro) {
        logLine("Loading text recognition (first load downloads ~12 MB, then it's cached)…");
        try {
          bookPpocr = await loadPpocr(loadOrtRuntime);
        } catch (e) {
          throw new Error(`Text recognition could not load (${e.message}). Pick Skip to convert without it.`);
        }
        logLine("Text recognition ready");
      }
      const pageOpts = { trimMargins, deviceTarget, cleanup, cleanupOn, isWebtoon, yolo, rtl, columnMajor, yonkomaDetect,
        ppocr: bookPpocr };

      // What the user typed wins, then the book's own metadata, then a guess from the file name.
      const fileMeta = fileNameMeta(files);
      const metaTitle = bookField("manga-title").trim() || collected.meta.title || fileMeta.title;
      const metaAuthor = $("manga-author").value.trim() || collected.meta.author;
      const metaLanguage = $("manga-language").value.trim() || collected.meta.language;
      const metaSeries = $("manga-series").value.trim() || collected.meta.series || fileMeta.series;
      const seriesField = parseFloat(bookField("manga-series-index"));
      const metaSeriesIndex = Number.isFinite(seriesField) ? seriesField
        : (collected.meta.seriesIndex ?? fileMeta.seriesIndex);
      const folder = sanitizeFolderName(metaTitle || "Manga");

      // The book's own Language (Book details) is what tells the model which language to expect --
      // there is no second picker for it, since a book that declares one in its EPUB/ComicInfo
      // fills it in by itself and a duplicate control would only disagree with it. Webtoon
      // panels are a single top-to-bottom column with horizontal text, so the right-to-left
      // hint that suits a manga page is wrong for them however the book is tagged.
      const ocrSourceLang = metaLanguage;
      const ocrTargetLang = $("manga-ocr-out").value || "en";
      const ocrPrompt = buildPanelOcrPrompt(ocrSourceLang, ocrTargetLang, rtl && !isWebtoon);
      if (bookPpocr && ocrSourceLang && !["ja", "zh", "yue"].includes(normalizeLanguage(ocrSourceLang).split("-")[0])) {
        logLine(`Built-in text recognition reads Japanese and Chinese; this book is set to "${ocrSourceLang}", ` +
          "so its text may come out wrong. Gemini reads other languages.", "warn");
      }
      if (!bookNoOcr && !ocrSourceLang) {
        logLine("No book language set, so the model is not told which one to expect. " +
          "Filling in Language in Book details improves recognition.", "warn");
      }

      const zip = new ZipWriter();
      const matchaVolume = matchaFile ? new MatchaWriter() : null;
      const legacyFolder = formats.has("matcha");
      // One book entry, written to every device output picked.
      const addBookFile = (path, data) => {
        if (legacyFolder) zip.addFile(`${folder}/${path}`, data);
        if (matchaVolume) matchaVolume.addFile(path, data);
      };
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

        const prep = await preparePage(page, pageOpts);
        const { srcBytes, ext, wasTrimmed, origW, origH, imgW, imgH, wasResized, canvas, ctx, tone, tuned, rgba } = prep;
        const bitmap = prep.bitmap;
        // Panels fixed by hand in the panel check replace what the detector found.
        const edited = panelEdits.get(page.name);
        const boxes = edited ? scaleBoxes(edited.boxes, edited.w, edited.h, imgW, imgH) : prep.boxes;
        if (edited) logLine(`  Using ${boxes.length} panel(s) set in the panel check.`);
        const textFix = (bookPpocr || collected.mokuro) && textEdits.get(page.name);
        if (textFix && textFix.trim === trimMargins) logLine("  Using the text fixed in the text check.");
        else if (textFix) logLine("  The book type changed since the text check, so this page's text was read again.", "warn");

        // Panel boxes stay in resized page space (panels.idx records the page at that
        // size); only the crop comes from the original, so map the rect back across.
        const panelScaleX = origW / imgW, panelScaleY = origH / imgH;

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
          addBookFile(`${pageBase}.bmp`, encodeMonoBmpFromRGBA(rgba, imgW, imgH, ditherGamma, ditherStyle));
        } else if ([".jpg", ".jpeg", ".png"].includes(ext) && !wasResized && !wasTrimmed && !tuned) {
          addBookFile(`${pageBase}${ext}`, srcBytes);
        } else if (ext === ".png" && (wasResized || wasTrimmed || tuned)) {
          addBookFile(`${pageBase}.png`, await canvasToPngBytes(canvas));
        } else {
          const outExt = (ext === ".jpg" || ext === ".jpeg") ? ext : ".jpg";
          addBookFile(`${pageBase}${outExt}`, await canvasToJpegBytes(canvas, 0.92));
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
          if (!wasResized && !tuned && (ext === ".jpg" || ext === ".jpeg")) { pageBytes = srcBytes; pageMime = "image/jpeg"; }
          else if (!wasResized && !tuned && ext === ".png") { pageBytes = srcBytes; pageMime = "image/png"; }
          else if (ext === ".png") { pageBytes = await canvasToPngBytes(canvas); pageMime = "image/png"; }
          else { pageBytes = await canvasToJpegBytes(canvas, 0.92); pageMime = "image/jpeg"; }
          epubImages.push({ bytes: pageBytes, mime: pageMime, w: imgW, h: imgH });
        }
        if (anyXtc) xtcPageMap.set(pageIdx, wantXtc ? xtcPages.length : xtchPages.length);
        if (anyXtc && keepPageImage) {
          const v = encodeXtcVariants(canvas, wantXtc, wantXtch, deviceTarget, true, ditherGamma, ditherStyle);
          if (v.xtc) xtcPages.push(v.xtc);
          if (v.xtch) xtchPages.push(v.xtch);
        }

        // Which panels get cropped at all. A full-page panel normally gets no crop: the page image
        // is already the best presentation of it. Panels-only books may have dropped that page
        // image, so the crop is written anyway or the page would export nothing. The full-res
        // source canvas below is allocated from this same predicate, so the two cannot disagree --
        // they did once, and a panels-only page whose panels were *all* full-page entered the crop
        // branch with no source canvas, throwing "drawImage ... value is not of type ...".
        const needsCrop = (b) => !isFullPagePanel(b, imgW, imgH) || panelsOnly;

        // Full-resolution page for the panel crops. A panel is shown zoomed to fill
        // the screen, so cropping it from the already-downscaled page magnifies a
        // fraction of an already-reduced image (softness and dither dots and all);
        // cropping at full res and fitting each panel afterwards gives it the whole
        // pixel budget. The AI detector already drew this page for the model to look at;
        // otherwise it is allocated only when the page actually has a panel to crop —
        // covers / full-page spreads skip it.
        let sourceCanvas = prep.sourceCanvas;
        if (!sourceCanvas && boxes.some(needsCrop)) sourceCanvas = fullResolutionCanvas(bitmap, origW, origH);
        // bitmap stays open through the crop loop: a full-page panel has no sourceCanvas, and its
        // OCR crop is drawn from the decoded page directly (closed after the loop).

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
          const fullPagePanel = isFullPagePanel(boxes[panelIdx], imgW, imgH);
          // Map the detected rect (plus margin) into full-resolution page coordinates, then draw
          // that region straight into a device-fitted panel canvas (one drawImage crops + scales).
          // fitToDeviceSize fits a landscape panel against the rotated box — the size the firmware
          // zooms it to, and dithers it at.
          const drawMarginCrop = () => {
            const fx1 = Math.max(0, Math.round(mx1 * panelScaleX));
            const fy1 = Math.max(0, Math.round(my1 * panelScaleY));
            const fx2 = Math.min(origW, Math.round(mx2 * panelScaleX));
            const fy2 = Math.min(origH, Math.round(my2 * panelScaleY));
            // Clamp to at least 1×1: real panels are tens of px, but guard a
            // degenerate rounding/tiny-box case so fitToDeviceSize can't divide by
            // zero and makeCanvas/drawImage can't throw on a 0-size crop.
            const fw = Math.max(1, fx2 - fx1), fh = Math.max(1, fy2 - fy1);
            const pf = fitToDeviceSize(fw, fh, deviceTarget);
            const canvas = makeCanvas(pf.w, pf.h);
            const ctx = smoothScaling(canvas.getContext("2d", { willReadFrequently: true }));
            // White under the draw, as sourceCanvas has: the bitmap fallback may carry transparency.
            ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, pf.w, pf.h);
            ctx.drawImage(sourceCanvas || bitmap, fx1, fy1, fw, fh, 0, 0, pf.w, pf.h);
            if (tuned) cleanCrop(ctx, pf.w, pf.h, tone, cleanup.sharpen);
            return { canvas, ctx, w: pf.w, h: pf.h };
          };
          if (needsCrop(boxes[panelIdx])) {
            const { canvas: cropCanvas, ctx: cropCtx, w: pw, h: ph } = drawMarginCrop();
            if (mono) {
              const cropRgba = cropCtx.getImageData(0, 0, pw, ph).data;
              if (matchaFolder) {
                addBookFile(`${PANEL_CROP_SUBDIR}/p${pageIdx}_${panelIdx}.bmp`, encodeMonoBmpFromRGBA(cropRgba, pw, ph, ditherGamma, ditherStyle));
              }
              // OCR still reads a full-colour JPEG crop: the dithered BMP would
              // only hurt text recognition (the --mono guidance to pair with
              // --no-ocr still applies, but OCR stays usable when both are on).
              if (!bookNoOcr) cropBytes = await canvasToJpegBytes(cropCanvas, 0.90);
            } else {
              cropBytes = await canvasToJpegBytes(cropCanvas, 0.90);
              if (matchaFolder) addBookFile(`${PANEL_CROP_SUBDIR}/p${pageIdx}_${panelIdx}.jpg`, cropBytes);
            }
            // A full-page panel is normally left out of the pre-rendered books: the full page
            // image in front of it already carries the same artwork, so the crop would only
            // duplicate it. When panels-only dropped that page image, the crop is the page's only
            // copy -- without it the page is simply missing from the EPUB/XTC (the device folder
            // still gets the crop either way).
            const cropInsteadOfPage = !fullPagePanel || !keepPageImage;
            if (epub && cropInsteadOfPage) {
              // Rotate wide (landscape) panels to portrait so they display as
              // large as possible on the usual portrait reading screen; the
              // fixed-layout reader then scales each to fullscreen. Off, the
              // panel goes in as drawn and the reader letterboxes it.
              let panelCanvas = cropCanvas, epw = pw, eph = ph;
              if (rotatePanels && pw > ph) { panelCanvas = rotateCanvas90CW(cropCanvas); epw = ph; eph = pw; }
              epubImages.push({ bytes: await canvasToJpegBytes(panelCanvas, 0.90), mime: "image/jpeg", w: epw, h: eph });
            }
            if (anyXtc && cropInsteadOfPage) {
              const v = encodeXtcVariants(cropCanvas, wantXtc, wantXtch, deviceTarget, rotatePanels, ditherGamma, ditherStyle);
              if (v.xtc) xtcPages.push(v.xtc);
              if (v.xtch) xtchPages.push(v.xtch);
            }
          }
          if (!cropBytes && !bookNoOcr) {
            // A full-page panel has no crop, but its text still needs reading: a splash page, or
            // every page when detection finds no borders (the grid fallback without the AI model),
            // used to come through with no text and so no word lookup at all. OCR the same margin
            // rect a crop would have covered; the JPEG goes to Gemini only, never into the output.
            // Matches convert_manga.py, which OCRs a temp copy of that rect.
            cropBytes = await canvasToJpegBytes(drawMarginCrop().canvas, 0.90);
          }
          panelCrops.push(cropBytes);
          panelRects.push([mx1, my1, mx2, my2]);
        }
        bitmap.close();

        if (epub) epubPages.push({ pageIdx, images: epubImages });

        let ocrResults;
        if (!bookNoOcr) {
          ocrResults = await mapLimit(panelCrops, Math.min(8, Math.max(1, panelCrops.length)),
            (crop) => crop ? geminiOcrPanel(crop, apiKey, model, ocrPrompt) : Promise.resolve({ blocks: [], translation: "" }));
        } else {
          ocrResults = panelCrops.map(() => ({ blocks: [], translation: "" }));
        }

        const mokuroOwned = prep.pageText ? assignBlocksToPanels(prep.pageText, boxes) : null;
        const panelsWithText = [];
        for (let panelIdx = 0; panelIdx < boxes.length; panelIdx++) {
          const [x1, y1, x2, y2] = boxes[panelIdx];
          const [mx1, my1, mx2, my2] = panelRects[panelIdx];
          const ocr = ocrResults[panelIdx];
          const panelW = mx2 - mx1, panelH = my2 - my1;

          const textBlocks = mokuroOwned ? mokuroOwned[panelIdx].slice() : [];
          for (const b of ocr.blocks || []) {
            const text = String(b.text ?? "").trim();
            if (!text) continue;
            const bbox = b.bbox_2d;
            let tb;
            if (Array.isArray(bbox) && bbox.length === 4) {
              // bbox_2d is normalised 0-1000 over the image the model was actually shown,
              // which is the MARGINED crop -- so it maps back from that rect's corner, not
              // the panel's. Anchoring at the panel corner while scaling by the margined
              // size mixes the two frames and slides every box down-right by the margin.
              const [ymin, xmin, ymax, xmax] = bbox;
              const at = (v, span) => Math.trunc((Math.min(1000, Math.max(0, Number(v) || 0)) / 1000) * span);
              tb = [
                mx1 + at(xmin, panelW),
                my1 + at(ymin, panelH),
                mx1 + at(xmax, panelW),
                my1 + at(ymax, panelH),
              ];
            } else {
              tb = [x1, y1, x2, y2];
            }
            const lined = blockLinesFromOcr(b, mx1, my1, panelW, panelH);
            textBlocks.push({ box: tb, text: lined.text || text, lines: lined.lines, vertical: lined.vertical });
          }
          panelsWithText.push({
            box: boxes[panelIdx], crop: [mx1, my1, mx2, my2], textBlocks, translation: ocr.translation || "",
          });
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

      addBookFile(`panels.idx`, writePanelsIdx(idxRecords));
      const dat = new Uint8Array(datOffset);
      let off = 0;
      for (const chunk of datChunks) { dat.set(chunk, off); off += chunk.length; }
      if (matchaFolder) {
        addBookFile(`panels.dat`, dat);
        const metaBin = writeMetaBin(metaTitle, metaAuthor, metaLanguage, metaSeries, metaSeriesIndex);
        if (metaBin) addBookFile(`meta.bin`, metaBin);
        if (tocEntries.length) addBookFile(`toc.idx`, writeTocIdx(tocEntries));
      }

      // Extra single-file outputs (EPUB / PDF / XTC / XTCH). They ride inside the zip when the device
      // folder is also being exported, otherwise they are the download themselves.
      const extras = [];
      if (formats.has("epub") && epubPages.length) {
        setProgress(pagesDone, pages.length, "Building EPUB…");
        const epubBytes = await buildMangaEpub({ title: metaTitle, author: metaAuthor, epubPages, tocEntries });
        extras.push({ name: `${folder}.epub`, bytes: epubBytes, type: "application/epub+zip" });
        logLine(`Built ${folder}.epub (${epubPages.reduce((n, p) => n + p.images.length, 0)} images).`);
      }
      if (pdf && epubPages.length) {
        setProgress(pagesDone, pages.length, "Building PDF…");
        const pdfBytes = await buildMangaPdf({ title: metaTitle, author: metaAuthor, epubPages });
        extras.push({ name: `${folder}.pdf`, bytes: pdfBytes, type: "application/pdf" });
        logLine(`Built ${folder}.pdf (${epubPages.reduce((n, p) => n + p.images.length, 0)} pages).`);
      }
      // The chapter list indexes the EXPORTED page sequence (each page followed by its panels),
      // not the source page numbers, so a chapter starting at source page N lands on that page's
      // entry in xtcPageMap.
      const xtcToc = tocEntries
        .map(([pageIndex, chapterTitle]) => ({ title: chapterTitle, page: xtcPageMap.get(pageIndex) }))
        .filter((c) => c.page !== undefined)
        .sort((a, b) => a.page - b.page);
      // One file, or parts of about `xtcSplit` pages that each start at a chapter where one is close.
      const addXtcParts = (xpages, ext, isHq, depth) => {
        const starts = partStarts(xpages.length, xtcSplit, xtcToc.map((c) => c.page));
        starts.forEach((start, i) => {
          const end = i + 1 < starts.length ? starts[i + 1] : xpages.length;
          const many = starts.length > 1;
          const name = many ? `${folder} - part ${i + 1}.${ext}` : `${folder}.${ext}`;
          const toc = xtcToc.filter((c) => c.page >= start && c.page < end).map((c) => ({ ...c, page: c.page - start }));
          const title = many ? `${metaTitle} (${i + 1}/${starts.length})` : metaTitle;
          extras.push({ name, type: "application/octet-stream",
            bytes: buildXtcFile(xpages.slice(start, end), { title, author: metaAuthor, language: metaLanguage, toc, isHq }) });
          logLine(`Built ${name} (${end - start} pages, ${depth}).`);
        });
      };
      if (wantXtc && xtcPages.length) addXtcParts(xtcPages, "xtc", false, "1-bit");
      if (wantXtch && xtchPages.length) addXtcParts(xtchPages, "xtch", true, "2-bit grayscale");

      setProgress(pagesDone, pages.length, "Packaging…");
      const summary = `Done: ${pagesDone} pages, ${totalPanels} panels` +
        (bookNoOcr && !collected.mokuro && !bookPpocr ? "" : `, ${totalTextBlocks} text blocks`) +
        (deviceTarget ? `, ${deviceTarget[0]}×${deviceTarget[1]}` : "") +
        (mono && matchaFolder ? ", 1-bit dithered BMP" : "") +
        (pagesKeptForCoverage ? `, ${pagesKeptForCoverage} full page(s) kept where panels missed content` : "");

      if (matchaVolume) {
        const volume = matchaVolume.toBlob();
        const files = [{ name: `${folder}.matcha`, blob: volume }];
        if (legacyFolder) files.push({ name: `${folder}.zip`, blob: zip.toBlob() });
        for (const e of extras) files.push({ name: e.name, blob: new Blob([e.bytes], { type: e.type }) });
        logLine(`${summary} — ${formatBytes(volume.size)}`);
        logLine(`Copy "${folder}.matcha" anywhere on the SD card (e.g. /manga/) or upload it via the device's web ` +
          "file transfer. It needs firmware 2.0.0-rc-4 or later.");
        if (files.length === 1) {
          downloadBlob(volume, `${folder}.matcha`);
        } else {
          const outZip = new ZipWriter();
          for (const f of files) outZip.addFile(f.name, new Uint8Array(await f.blob.arrayBuffer()));
          logLine(`The download is a zip holding ${files.map((f) => `"${f.name}"`).join(", ")}.`);
          downloadBlob(outZip.toBlob(), `${folder}-export.zip`);
        }
      } else if (matchaFolder) {
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
        logLine(`Copy "${only.name}" to the reader.`);
        downloadBlob(blob, only.name);
      } else if (extras.length) {
        const outZip = new ZipWriter();
        for (const e of extras) outZip.addFile(e.name, e.bytes);
        const blob = outZip.toBlob();
        logLine(`${summary} — ${formatBytes(blob.size)}`);
        logLine(`Unzip and copy ${extras.map((e) => `"${e.name}"`).join(" / ")} to the reader.`);
        downloadBlob(blob, `${folder}.zip`);
      } else {
        throw new Error("Nothing to export: no pages were produced");
      }
      setProgress(pagesDone, pagesDone, "Complete");
    } finally {
      if (collected && collected.cleanup) collected.cleanup();
    }
  };

  try {
    if (!batch) {
      await convertBook(books[0]);
    } else {
      let done = 0, failed = 0;
      for (let i = 0; i < books.length && !mangaState.cancelled; i++) {
        logLine(`── Book ${i + 1} of ${books.length}: ${bookLabel(books[i])}`);
        announce(`Converting book ${i + 1} of ${books.length}`);
        try {
          await convertBook(books[i]);
          done++;
        } catch (e) {
          failed++;
          logLine(`Error in ${bookLabel(books[i])}: ${e.message}`, "error");
          console.error(e);
        }
      }
      logLine(`Done: ${done} of ${books.length} books converted` + (failed ? `, ${failed} failed` : "") +
        (mangaState.cancelled ? ", stopped early" : "") + ".");
    }
  } catch (e) {
    logLine("Error: " + e.message, "error");
    console.error(e);
  } finally {
    mangaState.running = false;
    $("manga-run").disabled = false;
    $("manga-cancel").hidden = true;
    wakeLock.release();
  }
}

/* ── Panel check ──────────────────────────────────────────────────
 * Detect every page's panels before converting, show them, and let the user fix wrong ones.
 * Fixes land in panelEdits, which the conversion uses instead of detecting again. */

const PANEL_CHECK_THUMB_W = 150;
const PE_HANDLE_PX = 14;      // corner grab size, in screen pixels
const PE_MIN_SIDE = 16;       // smallest panel kept, in page pixels

// release: frees the page source (an open PDF); the editor re-reads pages until then.
const panelCheck = { files: null, opts: null, pages: [], editIndex: -1, release: null };
let panelCheckRunning = false;

function releasePanelCheckSource() {
  if (panelCheck.release) panelCheck.release();
  panelCheck.release = null;
}

/* The page settings the conversion would use, or null (with a message) when one is missing. */
async function panelCheckSettings(forText = false) {
  const bookType = validBookType($("manga-booktype").value);
  if (!bookType) {
    logValidation(`Pick a book type first: it sets the order ${forText ? "the text" : "panels"} are read in.`);
    return null;
  }
  if (bookType === BOOK_WEBTOON) {
    logValidation(forText ? "Webtoon pages are re-cut when converting, so their text can't be checked here."
      : "Webtoon panels come from the strip's gutters and are not checked here.");
    return null;
  }
  const resChoice = validResChoice($("manga-res").value);
  const deviceTarget = resChoice === RES_CUSTOM ? customResTarget()
    : resChoice && resChoice !== RES_FULL ? MANGA_DEVICE_TARGETS[resChoice] : null;
  const cleanup = cleanupSettings();
  let yolo = null;
  if ($("manga-yolo").checked && !forText) {
    try { yolo = await loadYoloDetector(); } catch (e) { logLine(`AI panel detector unavailable (${e.message}); using the grid heuristic.`, "warn"); }
  }
  // The same text the conversion will read, since panel crops grow over its bubbles.
  let ppocr = null;
  if (ocrEngine() === "ppocr" && !mangaState.mokuroInput) {
    try {
      ppocr = await loadPpocr(loadOrtRuntime);
    } catch (e) {
      if (forText) { logLine(`Text recognition could not load (${e.message}).`, "error"); return null; }
      logLine(`Text recognition unavailable (${e.message}); panels are shown without it.`, "warn");
    }
  }
  return {
    ppocr, panels: !forText,
    trimMargins: bookType === BOOK_WESTERN, deviceTarget, cleanup,
    cleanupOn: cleanup.levels || cleanup.contrast !== "off" || cleanup.sharpen,
    isWebtoon: false, yolo, rtl: bookType === BOOK_MANGA || bookType === BOOK_YONKOMA,
    columnMajor: bookType === BOOK_YONKOMA || bookType === BOOK_YONKOMA_LTR,
    yonkomaDetect: $("manga-yonkoma-detect").checked,
    splitSpreads: $("manga-split-spreads").checked && !$("manga-split-spreads").disabled,
  };
}

/* Why a page is worth a look, or "" when detection looks fine. */
// Sound effects and gutter text often sit outside the panels; only a larger miss is worth a look.
const PANEL_CHECK_MIN_COVERAGE = 0.9;
function panelCheckReason(boxes, rgba, w, h) {
  if (!boxes.length) return "No panels found";
  if (boxes.length > 9) return `${boxes.length} panels, more than usual`;
  const margined = boxes.map(([x1, y1, x2, y2]) => [Math.max(0, x1 - 10), Math.max(0, y1 - 10), Math.min(w, x2 + 10), Math.min(h, y2 + 10)]);
  const coverage = panelInkCoverage(grayFromRGBA(rgba, w, h), w, h, margined);
  return coverage < PANEL_CHECK_MIN_COVERAGE ? `${Math.round((1 - coverage) * 100)}% of the art is outside the panels` : "";
}

/* The boxes a page uses now: the user's edit, or what was detected. */
function panelCheckBoxes(p) {
  const e = panelEdits.get(p.name);
  return e ? scaleBoxes(e.boxes, e.w, e.h, p.w, p.h) : p.boxes;
}

/* Draw a page with its numbered panels; `selected` is highlighted. */
function drawPanelsOn(ctx, page, boxes, scale, selected = -1) {
  ctx.drawImage(page, 0, 0, page.width * scale, page.height * scale);
  ctx.lineWidth = Math.max(2, 3 * scale);
  ctx.font = `bold ${Math.max(12, Math.round(26 * scale))}px system-ui, sans-serif`;
  boxes.forEach(([x1, y1, x2, y2], i) => {
    const sel = i === selected;
    ctx.strokeStyle = sel ? "#d9480f" : "#2f9e44";
    // Only the selected panel is tinted: tinting every one muddies the art where panels overlap.
    if (sel) {
      ctx.fillStyle = "rgba(217,72,15,0.10)";
      ctx.fillRect(x1 * scale, y1 * scale, (x2 - x1) * scale, (y2 - y1) * scale);
    }
    ctx.strokeRect(x1 * scale, y1 * scale, (x2 - x1) * scale, (y2 - y1) * scale);
    const label = String(i + 1);
    const tw = ctx.measureText(label).width + 10 * Math.max(0.5, scale);
    const th = Math.max(16, Math.round(34 * scale));
    ctx.fillStyle = sel ? "#d9480f" : "#2f9e44";
    ctx.fillRect(x1 * scale, y1 * scale, tw, th);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x1 * scale + 4 * Math.max(0.5, scale), y1 * scale + th - 5 * Math.max(0.5, scale));
    if (sel) {
      const hs = PE_HANDLE_PX;
      ctx.fillStyle = "#d9480f";
      ctx.fillRect(x2 * scale - hs, y2 * scale - hs, hs, hs);
    }
  });
}

function panelCheckThumb(page, boxes) {
  const scale = PANEL_CHECK_THUMB_W / page.width;
  // A DOM canvas: makeCanvas() may give an OffscreenCanvas, which has no toDataURL().
  const c = document.createElement("canvas");
  c.width = PANEL_CHECK_THUMB_W;
  c.height = Math.round(page.height * scale);
  drawPanelsOn(c.getContext("2d"), page, boxes, scale);
  return c.toDataURL("image/jpeg", 0.75);
}

function renderPanelGrid() {
  const grid = $("panel-grid");
  const onlyFlagged = $("panel-check-flagged").checked;
  grid.textContent = "";
  let flagged = 0;
  panelCheck.pages.forEach((p, i) => {
    const edited = panelEdits.has(p.name);
    if (p.reason && !edited) flagged++;
    if (onlyFlagged && !(p.reason && !edited)) return;
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    const flag = p.reason && !edited;
    btn.className = "panel-thumb" + (flag ? " flagged" : "") + (edited ? " edited" : "");
    const n = panelCheckBoxes(p).length;
    const frame = document.createElement("span");
    frame.className = "panel-thumb-frame";
    const img = document.createElement("img");
    img.src = p.thumb; img.alt = "";
    frame.append(img);
    if (flag || edited) {
      const pill = document.createElement("span");
      pill.className = "panel-thumb-pill";
      pill.textContent = edited ? "Fixed" : "Check";
      frame.append(pill);
    }
    const cap = document.createElement("span");
    cap.className = "panel-thumb-cap";
    const title = document.createElement("span");
    title.className = "panel-thumb-title";
    title.textContent = `Page ${i + 1}`;
    const count = document.createElement("span");
    count.className = "panel-thumb-count";
    count.textContent = `${n} panel${n === 1 ? "" : "s"}`;
    cap.append(title, count);
    btn.append(frame, cap);
    if (flag) {
      const note = document.createElement("span");
      note.className = "panel-thumb-note";
      note.textContent = p.reason;
      btn.append(note);
    }
    btn.setAttribute("aria-label", `Page ${i + 1}, ${n} panel${n === 1 ? "" : "s"}` +
      (edited ? ", fixed by hand" : flag ? `, worth a look: ${p.reason}` : ""));
    btn.addEventListener("click", () => openPanelEditor(i));
    li.append(btn);
    grid.append(li);
  });
  $("panel-check-summary").textContent = (flagged
    ? `${flagged} of ${panelCheck.pages.length} pages may need a look.` : `All ${panelCheck.pages.length} pages look fine.`) +
    " Click a page to fix its panels.";
}

async function runPanelCheck() {
  const files = chosenFiles();
  if (!files || !files.length) { logValidation("Choose a manga first."); return; }
  if (splitIntoBooks(files).length > 1) { logValidation("The panel check works on one book at a time."); return; }
  const btn = $("panel-check-btn");
  btn.disabled = true;
  panelCheckRunning = true;
  try {
    const opts = await panelCheckSettings();
    if (!opts) return;
    if (panelCheck.files !== files) panelEdits.clear();
    releasePanelCheckSource();
    const collected = await collectPagesFromInput(splitIntoBooks(files)[0]);
    panelCheck.release = collected.cleanup || null;
    let pages = collected.pages;
    // The same pages the conversion will see, so a fix lands on the page it was made on.
    if (opts.splitSpreads && !collected.mokuro) pages = (await splitSpreadPages(pages, opts.rtl)).pages;
    const maxPages = parseInt($("manga-max-pages").value, 10);
    if (Number.isInteger(maxPages) && maxPages > 0) pages = pages.slice(0, maxPages);
    Object.assign(panelCheck, { files, opts, source: pages, pages: [] });
    $("panel-check").hidden = false;
    for (let i = 0; i < pages.length; i++) {
      setProgress(i, pages.length, `Checking panels: page ${i + 1} / ${pages.length}`);
      const prep = await preparePage(pages[i], opts);
      prep.bitmap.close && prep.bitmap.close();
      panelCheck.pages.push({
        name: pages[i].name, w: prep.imgW, h: prep.imgH, boxes: prep.boxes,
        reason: panelCheckReason(prep.boxes, prep.rgba, prep.imgW, prep.imgH),
        thumb: "",
      });
      const p = panelCheck.pages[i];
      p.thumb = panelCheckThumb(prep.canvas, panelCheckBoxes(p));
      if (i % 4 === 3 || i === pages.length - 1) renderPanelGrid();
    }
    setProgress(pages.length, pages.length, "Panel check done");
    btn.textContent = "Check again";
    announce($("panel-check-summary").textContent);
  } catch (e) {
    logLine("Panel check failed: " + e.message, "error");
    console.error(e);
  } finally {
    panelCheckRunning = false;
    btn.disabled = false;
  }
}

/* ── Panel editor ── */

// manual: the user set this page's reading order, so it is kept rather than re-sorted.
// draw: the next drag draws a new panel even where it starts inside one.
// pending: the first corner of a panel being drawn by two clicks.
const pe = { page: null, boxes: [], sel: -1, drag: null, scale: 1, manual: false, draw: false, pending: null };

async function openPanelEditor(i) {
  const p = panelCheck.pages[i];
  if (!p) return;
  let prep;
  try {
    prep = await preparePage(panelCheck.source[i], { ...panelCheck.opts, detect: false });
  } catch (e) {
    logLine(`Could not open page ${i + 1}: ${e.message}`, "error");
    console.error(e);
    return;
  }
  panelCheck.editIndex = i;
  prep.bitmap.close && prep.bitmap.close();
  pe.page = prep.canvas;
  pe.boxes = panelCheckBoxes(p).map((b) => b.slice());
  pe.manual = !!(panelEdits.get(p.name) || {}).manual;
  pe.sel = -1;
  setDrawMode(false);
  $("pe-title").textContent = `Page ${i + 1} of ${panelCheck.pages.length}`;
  const reason = panelEdits.has(p.name) ? "" : p.reason;
  $("pe-reason").hidden = !reason;
  $("pe-reason").textContent = reason ? `Worth a look: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.` : "";
  $("pe-prev").disabled = i === 0;
  $("pe-next").disabled = i === panelCheck.pages.length - 1;
  const dlg = $("panel-editor");
  if (!dlg.open) dlg.showModal();
  layoutPanelEditor();
  $("pe-canvas").focus();
  peAnnounce(`${pe.boxes.length} panel${pe.boxes.length === 1 ? "" : "s"} on this page.`);
}

function layoutPanelEditor() {
  const c = $("pe-canvas");
  const stage = c.parentElement.getBoundingClientRect();
  const maxW = Math.max(200, stage.width), maxH = Math.max(200, window.innerHeight * 0.68);
  pe.scale = Math.min(maxW / pe.page.width, maxH / pe.page.height);
  c.width = Math.round(pe.page.width * pe.scale);
  c.height = Math.round(pe.page.height * pe.scale);
  drawPanelEditor();
}

function drawPanelEditor() {
  const c = $("pe-canvas");
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  drawPanelsOn(ctx, pe.page, pe.boxes, pe.scale, pe.sel);
  if (pe.pending) {
    const [px, py] = pe.pending;
    ctx.fillStyle = "#d9480f";
    ctx.beginPath(); ctx.arc(px * pe.scale, py * pe.scale, 5, 0, Math.PI * 2); ctx.fill();
  }
  if (pe.drag && pe.drag.mode === "new") {
    const [x1, y1, x2, y2] = normBox(pe.drag.box);
    ctx.setLineDash([6, 4]); ctx.strokeStyle = "#d9480f";
    ctx.strokeRect(x1 * pe.scale, y1 * pe.scale, (x2 - x1) * pe.scale, (y2 - y1) * pe.scale);
    ctx.setLineDash([]);
  }
  c.setAttribute("aria-label", `Page with ${pe.boxes.length} panel${pe.boxes.length === 1 ? "" : "s"}` +
    (pe.sel >= 0 ? `, panel ${pe.sel + 1} selected` : ""));
  updatePanelFloat();
  keepEditorFocus();
  $("pe-help").textContent = pe.pending ? "Now click the opposite corner (Escape cancels)."
    : pe.draw ? "Drag on the page to draw a panel, or click two opposite corners."
    : pe.sel >= 0 ? "Drag to move · drag the corner to resize · change the reading order above the panel."
    : pe.boxes.length ? "Click a panel to move, resize or reorder it, or drag on empty space to draw one."
    : "Drag on the page to draw a panel.";
}

function normBox([x1, y1, x2, y2]) {
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

function clampBox([x1, y1, x2, y2]) {
  const W = pe.page.width, H = pe.page.height;
  const w = Math.min(W, Math.max(PE_MIN_SIDE, x2 - x1)), h = Math.min(H, Math.max(PE_MIN_SIDE, y2 - y1));
  const nx = Math.min(W - w, Math.max(0, x1)), ny = Math.min(H - h, Math.max(0, y1));
  return [Math.round(nx), Math.round(ny), Math.round(nx + w), Math.round(ny + h)];
}

function peAnnounce(text) {
  const s = $("pe-status");
  s.textContent = "";
  setTimeout(() => { s.textContent = text; }, 50);
}

/* Reading order for panels changed by hand: the conversion's own order, except that 4-koma strip
 * panels are never merged here -- a box the user drew stays as drawn. */
function editedPanelOrder(boxes, pageW, o) {
  const strips = o.yonkomaDetect !== false ? yonkomaReadingOrder(boxes, pageW, o.rtl) : null;
  return strips && strips.length === boxes.length ? strips : sortPanelsReadingOrder(boxes, o.rtl, o.columnMajor);
}

/* Save the editor's boxes for this page, in reading order, keeping the selection. */
function commitPanelEdits() {
  const p = panelCheck.pages[panelCheck.editIndex];
  const selected = pe.boxes[pe.sel];
  pe.boxes = pe.boxes.map(normBox);
  if (!pe.manual) pe.boxes = editedPanelOrder(pe.boxes, pe.page.width, panelCheck.opts);
  pe.sel = selected ? pe.boxes.findIndex((b) => b.join() === normBox(selected).join()) : -1;
  panelEdits.set(p.name, { w: pe.page.width, h: pe.page.height, boxes: pe.boxes.map((b) => b.slice()), manual: pe.manual });
  p.thumb = panelCheckThumb(pe.page, pe.boxes);
  drawPanelEditor();
}

function pePoint(ev) {
  const r = $("pe-canvas").getBoundingClientRect();
  return [(ev.clientX - r.left) / pe.scale, (ev.clientY - r.top) / pe.scale];
}

function peHit([x, y]) {
  const grab = PE_HANDLE_PX / pe.scale;
  for (let i = pe.boxes.length - 1; i >= 0; i--) {
    const [x1, y1, x2, y2] = pe.boxes[i];
    if (Math.abs(x - x2) <= grab && Math.abs(y - y2) <= grab) return { i, corner: true };
  }
  for (let i = pe.boxes.length - 1; i >= 0; i--) {
    const [x1, y1, x2, y2] = pe.boxes[i];
    if (x >= x1 && x <= x2 && y >= y1 && y <= y2) return { i, corner: false };
  }
  return null;
}

function wirePanelEditor() {
  const c = $("pe-canvas");
  c.addEventListener("pointerdown", (ev) => {
    const pt = pePoint(ev);
    const hit = pe.draw || ev.shiftKey ? null : peHit(pt);
    c.setPointerCapture(ev.pointerId);
    if (hit) {
      pe.sel = hit.i;
      pe.drag = { mode: hit.corner ? "resize" : "move", start: pt, orig: pe.boxes[hit.i].slice() };
    } else {
      pe.sel = -1;
      pe.drag = { mode: "new", box: [pt[0], pt[1], pt[0], pt[1]] };
    }
    drawPanelEditor();
  });
  c.addEventListener("pointermove", (ev) => {
    if (!pe.drag) return;
    const [x, y] = pePoint(ev);
    const d = pe.drag;
    if (d.mode === "new") {
      d.box[2] = x; d.box[3] = y;
    } else {
      const dx = x - d.start[0], dy = y - d.start[1];
      const [x1, y1, x2, y2] = d.orig;
      pe.boxes[pe.sel] = d.mode === "move" ? clampBox([x1 + dx, y1 + dy, x2 + dx, y2 + dy])
        : clampBox([x1, y1, Math.max(x1 + PE_MIN_SIDE, x2 + dx), Math.max(y1 + PE_MIN_SIDE, y2 + dy)]);
    }
    drawPanelEditor();
  });
  const end = () => {
    const d = pe.drag;
    if (!d) return;
    pe.drag = null;
    if (d.mode === "new") {
      const b = normBox(d.box);
      // A click without a drag: the first sets a corner, the second the opposite one -- so a
      // panel can be drawn without dragging.
      if (b[2] - b[0] < 4 && b[3] - b[1] < 4) {
        if (!pe.draw) { drawPanelEditor(); return; }  // Select tool: a click on empty space deselects
        if (!pe.pending) {
          pe.pending = [b[0], b[1]];
          peAnnounce("Corner set. Click the opposite corner.");
          drawPanelEditor();
          return;
        }
        d.box = [pe.pending[0], pe.pending[1], b[0], b[1]];
        pe.pending = null;
        return finishNewBox(normBox(d.box));
      }
      pe.pending = null;
      if (b[2] - b[0] >= PE_MIN_SIDE && b[3] - b[1] >= PE_MIN_SIDE) {
        pe.boxes.push(clampBox(b));
        pe.sel = pe.boxes.length - 1;
        setDrawMode(false);
        commitPanelEdits();
        peAnnounce(`Panel added as number ${pe.sel + 1} of ${pe.boxes.length}.`);
        return;
      }
      drawPanelEditor();
      return;
    }
    commitPanelEdits();
  };
  // A finished two-click (or drag) box: added when big enough.
  function finishNewBox(b) {
    if (b[2] - b[0] >= PE_MIN_SIDE && b[3] - b[1] >= PE_MIN_SIDE) {
      pe.boxes.push(clampBox(b));
      pe.sel = pe.boxes.length - 1;
      setDrawMode(false);
      commitPanelEdits();
      peAnnounce(`Panel added as number ${pe.sel + 1} of ${pe.boxes.length}.`);
    } else {
      peAnnounce("Too small for a panel.");
      drawPanelEditor();
    }
  }
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);

  c.addEventListener("keydown", (ev) => {
    const n = pe.boxes.length;
    let handled = true;
    if (ev.key === "]" || ev.key === "[") {
      if (n) pe.sel = ev.key === "]" ? (pe.sel + 1) % n : (pe.sel - 1 + n) % n;
      peAnnounce(n ? `Panel ${pe.sel + 1} of ${n} selected.` : "No panels on this page.");
      drawPanelEditor();
    } else if (/^[1-9]$/.test(ev.key) && Number(ev.key) <= n) {
      pe.sel = Number(ev.key) - 1;
      peAnnounce(`Panel ${pe.sel + 1} of ${n} selected.`);
      drawPanelEditor();
    } else if (ev.key === "Escape" && pe.pending) {
      pe.pending = null;
      peAnnounce("Corner cleared.");
      drawPanelEditor();
    } else if (ev.key === "v" || ev.key === "V") {
      setDrawMode(false);
      peAnnounce("Select tool.");
    } else if (ev.key === "r" || ev.key === "R") {
      setDrawMode(true);
      peAnnounce("Draw tool: drag on the page to draw a panel.");
    } else if (ev.key === "a" || ev.key === "A") {
      const W = pe.page.width, H = pe.page.height;
      pe.boxes.push(clampBox([W / 4, H / 4, (3 * W) / 4, (3 * H) / 4]));
      pe.sel = pe.boxes.length - 1;
      commitPanelEdits();
      peAnnounce(`Panel added in the middle. Move it with the arrow keys, resize with Shift and the arrows.`);
    } else if (ev.key === "," || ev.key === ".") {
      movePanelInOrder(ev.key === "," ? -1 : 1);
    } else if ((ev.key === "Delete" || ev.key === "Backspace") && pe.sel >= 0) {
      deleteSelectedPanel();
    } else if (ev.key.startsWith("Arrow") && pe.sel >= 0) {
      const step = Math.max(2, Math.round(10 / pe.scale));
      const dx = ev.key === "ArrowLeft" ? -step : ev.key === "ArrowRight" ? step : 0;
      const dy = ev.key === "ArrowUp" ? -step : ev.key === "ArrowDown" ? step : 0;
      const [x1, y1, x2, y2] = pe.boxes[pe.sel];
      pe.boxes[pe.sel] = ev.shiftKey ? clampBox([x1, y1, x2 + dx, y2 + dy]) : clampBox([x1 + dx, y1 + dy, x2 + dx, y2 + dy]);
      commitPanelEdits();
    } else {
      handled = false;
    }
    if (handled) ev.preventDefault();
  });

  $("pe-delete").addEventListener("click", deleteSelectedPanel);
  // Arrow keys move between the two tools, as in any radio group.
  for (const id of ["pe-mode-select", "pe-mode-draw"]) {
    $(id).addEventListener("keydown", (ev) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key)) return;
      ev.preventDefault();
      setDrawMode(id === "pe-mode-select");
      $(pe.draw ? "pe-mode-draw" : "pe-mode-select").focus();
    });
  }
  $("pe-mode-select").addEventListener("click", () => { setDrawMode(false); $("pe-canvas").focus(); });
  $("pe-mode-draw").addEventListener("click", () => { setDrawMode(true); $("pe-canvas").focus(); peAnnounce("Draw: drag on the page to draw a panel."); });
  $("pe-earlier").addEventListener("click", () => movePanelInOrder(-1));
  $("pe-later").addEventListener("click", () => movePanelInOrder(1));
  $("pe-whole").addEventListener("click", () => {
    pe.boxes = [[0, 0, pe.page.width, pe.page.height]];
    pe.sel = 0;
    commitPanelEdits();
    peAnnounce("The whole page is now one panel.");
  });
  $("pe-reset").addEventListener("click", () => {
    const p = panelCheck.pages[panelCheck.editIndex];
    panelEdits.delete(p.name);
    pe.boxes = p.boxes.map((b) => b.slice());
    pe.manual = false;
    pe.sel = -1;
    p.thumb = panelCheckThumb(pe.page, pe.boxes);
    drawPanelEditor();
    peAnnounce("Back to the detected panels.");
  });
  $("pe-prev").addEventListener("click", () => openPanelEditor(panelCheck.editIndex - 1));
  $("pe-next").addEventListener("click", () => openPanelEditor(panelCheck.editIndex + 1));
  $("pe-close").addEventListener("click", () => $("panel-editor").close());
  $("panel-editor").addEventListener("close", () => {
    renderPanelGrid();
    // Back to the page just edited, so keyboard users continue where they were.
    const thumbs = [...document.querySelectorAll("#panel-grid .panel-thumb")];
    const i = panelCheck.editIndex;
    const back = thumbs.find((t) => t.textContent.startsWith(`Page ${i + 1} `));
    (back || $("panel-check-btn")).focus();
  });
  window.addEventListener("resize", () => { if ($("panel-editor").open) layoutPanelEditor(); });
  $("panel-check-btn").addEventListener("click", runPanelCheck);
  $("panel-check-flagged").addEventListener("change", renderPanelGrid);
}

function setDrawMode(on) {
  pe.draw = on;
  $("pe-mode-select").setAttribute("aria-checked", on ? "false" : "true");
  $("pe-mode-draw").setAttribute("aria-checked", on ? "true" : "false");
  // Radio group: only the checked tool is a Tab stop; arrow keys move between the two.
  $("pe-mode-select").tabIndex = on ? -1 : 0;
  $("pe-mode-draw").tabIndex = on ? 0 : -1;
  if (!on) pe.pending = null;
  $("pe-canvas").classList.toggle("drawing", on);
  if (pe.page) drawPanelEditor();
}

/* The small bar on the selected panel: its place in the reading order, and delete. It sits just
 * above the panel, or inside its top edge when there is no room above. */
function updatePanelFloat() {
  const float = $("pe-float");
  if (pe.sel < 0 || pe.drag) { float.hidden = true; return; }
  const c = $("pe-canvas");
  const [x1, y1] = pe.boxes[pe.sel];
  $("pe-order").textContent = `${pe.sel + 1} / ${pe.boxes.length}`;
  $("pe-earlier").disabled = pe.sel === 0;
  $("pe-later").disabled = pe.sel === pe.boxes.length - 1;
  float.hidden = false;
  const fw = float.offsetWidth, fh = float.offsetHeight;
  const left = c.offsetLeft + Math.min(Math.max(0, x1 * pe.scale), c.width - fw);
  const above = y1 * pe.scale - fh - 6;
  float.style.left = `${left}px`;
  float.style.top = `${c.offsetTop + (above >= 0 ? above : y1 * pe.scale + 6)}px`;
}

/* A focused control that just got disabled or hidden would drop focus out of the dialog: move it
 * to its partner (the other order button) or back to the page. */
function keepEditorFocus() {
  const a = document.activeElement;
  if (!a || !$("panel-editor").contains(a) || !(a.disabled || a.closest("[hidden]"))) return;
  const partner = a.id === "pe-later" ? $("pe-earlier") : a.id === "pe-earlier" ? $("pe-later") : null;
  (partner && !partner.disabled && !$("pe-float").hidden ? partner : $("pe-canvas")).focus();
}

/* Move the selected panel one step earlier (-1) or later (+1) in the reading order. From then on
 * this page keeps the order the user set. */
function movePanelInOrder(dir) {
  const i = pe.sel, j = i + dir;
  if (i < 0) { peAnnounce("Select a panel first."); return; }
  if (j < 0 || j >= pe.boxes.length) { peAnnounce(`Panel ${i + 1} is already ${dir < 0 ? "first" : "last"}.`); return; }
  [pe.boxes[i], pe.boxes[j]] = [pe.boxes[j], pe.boxes[i]];
  pe.sel = j;
  pe.manual = true;
  commitPanelEdits();
  peAnnounce(`Panel is now number ${j + 1} of ${pe.boxes.length}.`);
}

function deleteSelectedPanel() {
  if (pe.sel < 0) { peAnnounce("Select a panel first."); return; }
  pe.boxes.splice(pe.sel, 1);
  pe.sel = -1;
  commitPanelEdits();
  peAnnounce(`Panel deleted. ${pe.boxes.length} left.`);
}

/* ── Text check ───────────────────────────────────────────────────
 * Read every page's text before converting, show it, and let the user fix or remove wrong lines.
 * Lines the recogniser was unsure of are marked; nothing is removed unless the user removes it.
 * Fixes land in textEdits, which the conversion uses instead of reading the page again. */

const textCheck = { files: null, opts: null, source: [], pages: [], editIndex: -1, release: null };
const TE_ZOOM_W = 260, TE_ZOOM_H = 180;   // largest bubble preview, in screen pixels

function releaseTextCheckSource() {
  if (textCheck.release) textCheck.release();
  textCheck.release = null;
}

function isUnsureLine(conf) { return conf < PPOCR_UNSURE_CONF; }
function unsureLineCount(blocks) {
  return blocks.reduce((n, b) => n + textBlockLines(b).filter((l) => isUnsureLine(l.conf)).length, 0);
}

/* The blocks a page uses now: the user's fix, or what was read. */
function textCheckBlocks(p) {
  const e = textEdits.get(p.name);
  return e ? scaleTextBlocks(e.blocks, e.w, e.h, p.w, p.h) : p.blocks;
}

/* Draw a page with its numbered text blocks: blue, orange where a line is unsure, filled when selected. */
function drawTextBlocksOn(ctx, page, blocks, scale, selected = -1) {
  ctx.drawImage(page, 0, 0, page.width * scale, page.height * scale);
  ctx.lineWidth = Math.max(1.5, 2.5 * scale);
  ctx.font = `bold ${Math.max(10, Math.round(22 * scale))}px system-ui, sans-serif`;
  blocks.forEach((b, i) => {
    const [x1, y1, x2, y2] = b.box;
    // Unsure bubbles are dashed as well as orange, so the colour is not the only sign; added ones green.
    const unsure = textBlockLines(b).some((l) => isUnsureLine(l.conf));
    const color = b.added ? "#2f9e44" : unsure ? "#d9480f" : "#1971c2";
    if (i === selected) {
      ctx.fillStyle = "rgba(25,113,194,0.16)";
      ctx.fillRect(x1 * scale, y1 * scale, (x2 - x1) * scale, (y2 - y1) * scale);
    }
    ctx.strokeStyle = color;
    ctx.setLineDash(unsure ? [Math.max(3, 7 * scale), Math.max(2, 4 * scale)] : []);
    ctx.lineWidth = Math.max(1.5, 2.5 * scale) * (i === selected ? 1.6 : 1);
    ctx.strokeRect(x1 * scale, y1 * scale, (x2 - x1) * scale, (y2 - y1) * scale);
    ctx.setLineDash([]);
    // An added bubble shows how its box is shared out among its lines.
    if (b.added && b.lines.length > 1) {
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      for (const [lx1, ly1, lx2, ly2] of b.lines.slice(1)) {
        ctx.beginPath();
        if (b.vertical) { ctx.moveTo(lx2 * scale, ly1 * scale); ctx.lineTo(lx2 * scale, ly2 * scale); }
        else { ctx.moveTo(lx1 * scale, ly1 * scale); ctx.lineTo(lx2 * scale, ly1 * scale); }
        ctx.stroke();
      }
      ctx.restore();
    }
    const label = String(i + 1);
    const tw = ctx.measureText(label).width + 8 * Math.max(0.5, scale);
    const th = Math.max(13, Math.round(28 * scale));
    // The number sits on the box's top edge, inside it when there is no room above.
    const ty = y1 * scale >= th ? y1 * scale - th : y1 * scale;
    ctx.fillStyle = color;
    ctx.fillRect(x1 * scale, ty, tw, th);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x1 * scale + 3 * Math.max(0.5, scale), ty + th - 4 * Math.max(0.5, scale));
  });
}

function textCheckThumb(page, blocks) {
  const scale = PANEL_CHECK_THUMB_W / page.width;
  const c = document.createElement("canvas");
  c.width = PANEL_CHECK_THUMB_W;
  c.height = Math.round(page.height * scale);
  drawTextBlocksOn(c.getContext("2d"), page, blocks, scale);
  return c.toDataURL("image/jpeg", 0.75);
}

function renderTextGrid() {
  const grid = $("text-grid");
  const onlyFlagged = $("text-check-flagged").checked;
  grid.textContent = "";
  let flagged = 0, lines = 0;
  textCheck.pages.forEach((p, i) => {
    const edited = textEdits.has(p.name);
    const blocks = textCheckBlocks(p);
    const unsure = unsureLineCount(blocks);
    const flag = unsure > 0;
    if (flag) { flagged++; lines += unsure; }
    if (onlyFlagged && !flag) return;
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "panel-thumb" + (flag ? " flagged" : "") + (edited && !flag ? " edited" : "");
    const frame = document.createElement("span");
    frame.className = "panel-thumb-frame";
    const img = document.createElement("img");
    img.src = p.thumb; img.alt = "";
    frame.append(img);
    if (flag || edited) {
      const pill = document.createElement("span");
      pill.className = "panel-thumb-pill";
      pill.textContent = flag ? "Check" : "Fixed";
      frame.append(pill);
    }
    const cap = document.createElement("span");
    cap.className = "panel-thumb-cap";
    const title = document.createElement("span");
    title.className = "panel-thumb-title";
    title.textContent = `Page ${i + 1}`;
    const count = document.createElement("span");
    count.className = "panel-thumb-count";
    count.textContent = `${blocks.length} bubble${blocks.length === 1 ? "" : "s"}`;
    cap.append(title, count);
    btn.append(frame, cap);
    if (flag) {
      const note = document.createElement("span");
      note.className = "panel-thumb-note";
      note.textContent = `${unsure} unsure line${unsure === 1 ? "" : "s"}`;
      btn.append(note);
    }
    btn.setAttribute("aria-label", `Page ${i + 1}, ${blocks.length} bubble${blocks.length === 1 ? "" : "s"}` +
      (flag ? `, ${unsure} unsure line${unsure === 1 ? "" : "s"}` : edited ? ", fixed by hand" : ""));
    btn.addEventListener("click", () => openTextEditor(i));
    li.append(btn);
    grid.append(li);
  });
  $("text-check-review").hidden = !flagged;
  // Mokuro's text has no unsure lines to filter by.
  $("text-check-flagged").closest("label").hidden = !!textCheck.mokuro;
  if (textCheck.mokuro) {
    const bubbles = textCheck.pages.reduce((n, p) => n + textCheckBlocks(p).length, 0);
    $("text-check-summary").textContent = `${bubbles} bubble${bubbles === 1 ? "" : "s"} from Mokuro on ${textCheck.pages.length} pages. Click a page to see its text.`;
    return;
  }
  $("text-check-summary").textContent = (flagged
    ? `${lines} unsure line${lines === 1 ? "" : "s"} on ${flagged} of ${textCheck.pages.length} pages.`
    : `No unsure lines on ${textCheck.pages.length} pages.`) + " Click a page to see its text.";
}

async function runTextCheck() {
  const files = chosenFiles();
  if (!files || !files.length) { logValidation("Choose a manga first."); return; }
  if (splitIntoBooks(files).length > 1) { logValidation("The text check works on one book at a time."); return; }
  const btn = $("text-check-btn");
  btn.disabled = true;
  try {
    const opts = await panelCheckSettings(true);
    if (!opts || (!opts.ppocr && !mangaState.mokuroInput)) return;
    if (textCheck.files !== files) textEdits.clear();
    releaseTextCheckSource();
    const collected = await collectPagesFromInput(splitIntoBooks(files)[0]);
    textCheck.release = collected.cleanup || null;
    let pages = collected.pages;
    // The same pages the conversion will see, so a fix lands on the page it was made on.
    if (opts.splitSpreads) pages = (await splitSpreadPages(pages, opts.rtl)).pages;
    const maxPages = parseInt($("manga-max-pages").value, 10);
    if (Number.isInteger(maxPages) && maxPages > 0) pages = pages.slice(0, maxPages);
    Object.assign(textCheck, { files, opts, source: pages, pages: [], mokuro: !!collected.mokuro });
    $("text-check").hidden = false;
    for (let i = 0; i < pages.length; i++) {
      setProgress(i, pages.length, `Reading text: page ${i + 1} / ${pages.length}`);
      // Read fresh: a fix made earlier is kept in textEdits and shown over this.
      const fixed = textEdits.get(pages[i].name);
      textEdits.delete(pages[i].name);
      const prep = await preparePage(pages[i], opts);
      if (fixed) textEdits.set(pages[i].name, fixed);
      prep.bitmap.close && prep.bitmap.close();
      const p = { name: pages[i].name, w: prep.imgW, h: prep.imgH, blocks: prep.pageText || [], thumb: "" };
      p.thumb = textCheckThumb(prep.canvas, textCheckBlocks(p));
      textCheck.pages.push(p);
      if (i % 4 === 3 || i === pages.length - 1) renderTextGrid();
    }
    setProgress(pages.length, pages.length, "Text check done");
    btn.textContent = "Check again";
    announce($("text-check-summary").textContent);
  } catch (e) {
    logLine("Text check failed: " + e.message, "error");
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

/* ── Text editor ──
 * The page on one side, its bubbles on the other: each bubble enlarged, with one field per line.
 * The line being edited is outlined on the page and in the enlarged bubble. Enter keeps the line as
 * it stands (fixed or not) and moves on to the next unsure line, across pages, so a book can be
 * reviewed line by line without touching the mouse. Text the reader missed gets a bubble drawn over
 * it by hand (or placed with the keyboard) and typed in. */

// line: [block, line] being edited, or null. cursor: the last line visited, where "next unsure" goes on
// from. draw: the next drag on the page draws a bubble. drag: a bubble being drawn, moved or resized.
// pending: the first corner of a bubble being drawn with two clicks.
const te = { page: null, blocks: [], sel: -1, line: null, cursor: null, scale: 1, draw: false, drag: null, pending: null };
const TE_MIN_SIDE = 12;      // smallest bubble that can be drawn, in page pixels
const TE_HANDLE_PX = 14;     // corner grab size of an added bubble, in screen pixels

/* Every unsure line of the book, in reading order: [page, block, line]. */
function unsureLines() {
  const out = [];
  textCheck.pages.forEach((p, pi) => {
    const blocks = pi === textCheck.editIndex && $("text-editor").open ? te.blocks : textCheckBlocks(p);
    blocks.forEach((b, bi) => textBlockLines(b).forEach((l, li) => { if (isUnsureLine(l.conf)) out.push([pi, bi, li]); }));
  });
  return out;
}

/* The next unsure line after [page, block, line] (wrapping round), or null when none is left. */
function nextUnsureLine(from) {
  const all = unsureLines();
  if (!all.length) return null;
  const after = (a) => a[0] > from[0] || (a[0] === from[0] && (a[1] > from[1] || (a[1] === from[1] && a[2] > from[2])));
  return all.find(after) || all[0];
}

async function openTextEditor(i, focus = null) {
  const p = textCheck.pages[i];
  if (!p) return;
  let prep;
  try {
    prep = await preparePage(textCheck.source[i], { ...textCheck.opts, detect: false });
  } catch (e) {
    logLine(`Could not open page ${i + 1}: ${e.message}`, "error");
    console.error(e);
    return;
  }
  const changedPage = textCheck.editIndex !== i || !$("text-editor").open;
  textCheck.editIndex = i;
  prep.bitmap.close && prep.bitmap.close();
  te.page = prep.canvas;
  te.blocks = textCheckBlocks(p).map((b) => ({ ...b }));
  te.sel = -1;
  te.line = null;
  te.cursor = null;
  te.drag = null;
  setTextDrawMode(false);
  $("te-title").textContent = `Page ${i + 1} of ${textCheck.pages.length}`;
  // Mokuro's text has no confidence to go by, so there is no queue of unsure lines.
  document.querySelector(".te-queue").hidden = textCheck.mokuro;
  const help = $("te-help");
  if (help.dataset.reader === undefined) help.dataset.reader = help.innerHTML;
  if (textCheck.mokuro) help.textContent = "Fix a line by typing over it, or clear it to remove it. Add a bubble for text Mokuro missed.";
  else help.innerHTML = help.dataset.reader;
  $("te-prev").disabled = i === 0;
  $("te-next").disabled = i === textCheck.pages.length - 1;
  const dlg = $("text-editor");
  if (!dlg.open) dlg.showModal();
  layoutTextEditor();
  renderTextBlockList();
  const unsure = unsureLineCount(te.blocks);
  const summary = `Page ${i + 1} of ${textCheck.pages.length}: ${te.blocks.length} bubble${te.blocks.length === 1 ? "" : "s"}` +
    (unsure ? `, ${unsure} unsure line${unsure === 1 ? "" : "s"}.` : ".");
  if (focus) {
    if (changedPage) teAnnounce(`Page ${i + 1} of ${textCheck.pages.length}.`);
    focusTextLine(focus[0], focus[1]);
  } else {
    teAnnounce(summary);
    const first = $("te-blocks").querySelector(".te-line.unsure input") || $("te-blocks").querySelector("input, textarea");
    (first || $("te-add")).focus();
  }
}

/* Open the next unsure line after the one being edited (or from the start of the book). */
async function goToNextUnsure() {
  const here = $("text-editor").open ? [textCheck.editIndex, ...(te.cursor || [-1, -1])] : [0, -1, -1];
  const next = nextUnsureLine(here);
  if (!next) {
    teAnnounce("No unsure lines left.");
    updateUnsureCounter();
    return;
  }
  const [pi, bi, li] = next;
  if (pi !== textCheck.editIndex || !$("text-editor").open) await openTextEditor(pi, [bi, li]);
  else focusTextLine(bi, li);
}

function updateUnsureCounter() {
  const n = unsureLines().length;
  $("te-unsure-count").textContent = n ? `${n} unsure line${n === 1 ? "" : "s"} left` : "No unsure lines left";
  $("te-next-unsure").disabled = !n;
  const here = unsureLineCount(te.blocks);
  $("te-drop-unsure").hidden = !here;
  $("te-drop-unsure").textContent = `Remove this page's ${here} unsure line${here === 1 ? "" : "s"}`;
}

/* Drop every unsure line on the page at once: a page of background lettering (a newspaper, a sign
 * wall) is read as many lines of noise that are quicker to clear together. */
function dropUnsureLines() {
  const before = unsureLineCount(te.blocks);
  te.blocks = te.blocks.map((b) => textBlockFromLines(b, textBlockLines(b).filter((l) => !isUnsureLine(l.conf)))).filter(Boolean);
  te.sel = -1;
  te.line = null;
  te.cursor = null;
  commitTextEdits();
  renderTextBlockList();
  teAnnounce(`Removed ${before} unsure line${before === 1 ? "" : "s"}. Reset page brings them back.`);
  ($("te-blocks").querySelector("input, textarea") || $("te-add")).focus();
}

function layoutTextEditor() {
  const c = $("te-canvas");
  const box = c.parentElement.getBoundingClientRect();
  const narrow = window.innerWidth <= 720;
  const maxW = Math.max(160, box.width), maxH = Math.max(200, window.innerHeight * (narrow ? 0.38 : 0.72));
  te.scale = Math.min(maxW / te.page.width, maxH / te.page.height);
  c.width = Math.round(te.page.width * te.scale);
  c.height = Math.round(te.page.height * te.scale);
  drawTextEditor();
}

/* The line being edited, outlined on top of whatever `scale` the target is drawn at. */
function outlineLine(ctx, box, scale, ox = 0, oy = 0) {
  const [x1, y1, x2, y2] = box;
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#fab005";
  ctx.fillStyle = "rgba(250,176,5,0.18)";
  ctx.fillRect((x1 - ox) * scale, (y1 - oy) * scale, (x2 - x1) * scale, (y2 - y1) * scale);
  ctx.strokeRect((x1 - ox) * scale - 1, (y1 - oy) * scale - 1, (x2 - x1) * scale + 2, (y2 - y1) * scale + 2);
  ctx.restore();
}

function teNormBox([x1, y1, x2, y2]) {
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

/* A bubble box kept on the page and at least TE_MIN_SIDE on each side. */
function teClampBox([x1, y1, x2, y2]) {
  const W = te.page.width, H = te.page.height;
  const w = Math.min(W, Math.max(TE_MIN_SIDE, x2 - x1)), h = Math.min(H, Math.max(TE_MIN_SIDE, y2 - y1));
  const nx = Math.min(W - w, Math.max(0, x1)), ny = Math.min(H - h, Math.max(0, y1));
  return [Math.round(nx), Math.round(ny), Math.round(nx + w), Math.round(ny + h)];
}

function drawTextEditor() {
  const c = $("te-canvas");
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  drawTextBlocksOn(ctx, te.page, te.blocks, te.scale, te.sel);
  if (te.line && te.blocks[te.line[0]]) {
    const l = textBlockLines(te.blocks[te.line[0]])[te.line[1]];
    if (l) outlineLine(ctx, l.box, te.scale);
  }
  // The selected added bubble's resize handle.
  const sel = te.blocks[te.sel];
  if (sel && sel.added) {
    const [, , x2, y2] = sel.box;
    ctx.fillStyle = "#1971c2";
    ctx.fillRect(x2 * te.scale - TE_HANDLE_PX, y2 * te.scale - TE_HANDLE_PX, TE_HANDLE_PX, TE_HANDLE_PX);
  }
  if (te.pending) {
    ctx.fillStyle = "#1971c2";
    ctx.beginPath(); ctx.arc(te.pending[0] * te.scale, te.pending[1] * te.scale, 5, 0, Math.PI * 2); ctx.fill();
  }
  if (te.drag && te.drag.mode === "new") {
    const [x1, y1, x2, y2] = teNormBox(te.drag.box);
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#1971c2";
    ctx.strokeRect(x1 * te.scale, y1 * te.scale, (x2 - x1) * te.scale, (y2 - y1) * te.scale);
    ctx.restore();
  }
  c.setAttribute("aria-label", `Page with ${te.blocks.length} text bubble${te.blocks.length === 1 ? "" : "s"}` +
    (te.sel >= 0 ? `, bubble ${te.sel + 1} selected` : ""));
}

function teAnnounce(text) {
  const s = $("te-status");
  s.textContent = "";
  setTimeout(() => { s.textContent = text; }, 50);
}

/* A bubble's part of the page, enlarged so its lettering can be read beside its text; `line` is
 * outlined. */
function drawTextBlockZoom(canvas, block, line) {
  const [x1, y1, x2, y2] = block.box;
  const pad = Math.round(Math.max(x2 - x1, y2 - y1) * 0.08) + 4;
  const sx = Math.max(0, x1 - pad), sy = Math.max(0, y1 - pad);
  const sw = Math.max(1, Math.min(te.page.width, x2 + pad) - sx), sh = Math.max(1, Math.min(te.page.height, y2 + pad) - sy);
  const scale = Math.min(TE_ZOOM_W / sw, TE_ZOOM_H / sh, 3);
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(te.page, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  if (line) outlineLine(ctx, line.box, scale, sx, sy);
}

/* Save the editor's blocks for this page and refresh what shows them. An added bubble still waiting
 * for its text is not saved. */
function commitTextEdits() {
  const p = textCheck.pages[textCheck.editIndex];
  textEdits.set(p.name, { w: te.page.width, h: te.page.height, trim: !!textCheck.opts.trimMargins,
    blocks: te.blocks.filter((b) => b.text.trim()).map((b) => ({ ...b })) });
  p.thumb = textCheckThumb(te.page, te.blocks);
  drawTextEditor();
  updateUnsureCounter();
}

/* Change line `j` of bubble `i`: new text (an empty one removes the line) and/or marked right.
 * Returns whether the bubble is still there. */
function applyTextLine(i, j, { text, confirm }) {
  const lines = textBlockLines(te.blocks[i]);
  const old = lines[j];
  const changed = text !== undefined && text.trim() !== old.text;
  if (!changed && !(confirm && isUnsureLine(old.conf))) return true;
  const edited = lines.map((l, k) => (k === j ? { ...l, text: changed ? text : l.text, conf: 1 } : l));
  const rebuilt = textBlockFromLines(te.blocks[i], edited);
  if (rebuilt) te.blocks[i] = rebuilt; else te.blocks.splice(i, 1);
  commitTextEdits();
  return !!rebuilt;
}

function selectTextBlock(i, focusField) {
  te.sel = i;
  if (!te.line || te.line[0] !== i) te.line = null;
  drawTextEditor();
  for (const li of $("te-blocks").children) li.classList.toggle("selected", Number(li.dataset.i) === i);
  const li = i >= 0 ? $("te-blocks").querySelector(`li[data-i="${i}"]`) : null;
  if (li) {
    li.scrollIntoView({ block: "nearest" });
    if (focusField) { const field = li.querySelector("input, textarea"); if (field) field.focus(); }
  }
}

function focusTextLine(i, j) {
  const field = $("te-blocks").querySelectorAll(`li[data-i="${i}"] .te-line input`)[j]
    || $("te-blocks").querySelector(`li[data-i="${i}"] textarea`);
  if (!field) return;
  field.focus();
  if (field.select) field.select();
  field.closest("li").scrollIntoView({ block: "nearest" });
}

/* One sentence a screen reader says about a bubble when it is picked on the page. */
function describeTextBlock(i) {
  const b = te.blocks[i];
  const text = b.text.replace(/\n/g, " ").trim();
  const unsure = textBlockLines(b).filter((l) => isUnsureLine(l.conf)).length;
  return `Bubble ${i + 1} of ${te.blocks.length}` + (b.added ? ", added by hand" : "") +
    (unsure ? `, ${unsure} unsure line${unsure === 1 ? "" : "s"}` : "") + (text ? `: ${text}` : ", no text yet");
}

/* ── Adding bubbles ── */

function setTextDrawMode(on) {
  te.draw = on;
  if (!on) te.pending = null;
  $("te-add").setAttribute("aria-pressed", on ? "true" : "false");
  $("te-canvas").classList.toggle("drawing", on);
  $("te-draw-help").hidden = !on;
  if (te.page) drawTextEditor();
}

/* A new, empty bubble over `box`, selected and waiting for its text. Vertical when taller than wide. */
function addTextBubble(box, focusText = true) {
  const b = teClampBox(teNormBox(box));
  const vertical = b[3] - b[1] >= b[2] - b[0];
  te.blocks.push({ ...textBlockFromBox(b, "", vertical) });
  te.sel = te.blocks.length - 1;
  te.line = null;
  setTextDrawMode(false);
  renderTextBlockList();
  if (focusText) {
    const area = $("te-blocks").querySelector(`li[data-i="${te.sel}"] textarea`);
    if (area) { area.focus(); area.closest("li").scrollIntoView({ block: "nearest" }); }
    teAnnounce(`Bubble ${te.sel + 1} added. Type its text, one line per printed line.`);
  }
}

/* Move or resize an added bubble; its lines are shared out over the new box. */
function setAddedBox(i, box) {
  const b = te.blocks[i];
  te.blocks[i] = { ...textBlockFromBox(teClampBox(box), b.text, b.vertical) };
}

function tePoint(ev) {
  const r = $("te-canvas").getBoundingClientRect();
  return [(ev.clientX - r.left) / te.scale, (ev.clientY - r.top) / te.scale];
}

/* The smallest bubble under a point, so one inside a larger one can still be picked; for an added
 * bubble, whether the point is on its resize corner. */
function teHit([x, y]) {
  const grab = TE_HANDLE_PX / te.scale;
  let hit = null, area = Infinity;
  te.blocks.forEach((b, i) => {
    const [x1, y1, x2, y2] = b.box;
    if (b.added && Math.abs(x - x2) <= grab && Math.abs(y - y2) <= grab) { hit = { i, corner: true }; area = -1; return; }
    const a = (x2 - x1) * (y2 - y1);
    if (x >= x1 && x <= x2 && y >= y1 && y <= y2 && a < area) { hit = { i, corner: false }; area = a; }
  });
  return hit;
}

/* ── The bubble list ── */

function textBlockCard(block, i, list) {
  const lines = textBlockLines(block);
  const li = document.createElement("li");
  li.dataset.i = String(i);
  li.className = "te-block" + (i === te.sel ? " selected" : "") + (block.added ? " added" : "");
  const headId = `te-block-${i}`;
  li.setAttribute("aria-labelledby", headId);
  const head = document.createElement("div");
  head.className = "te-block-head";
  const name = document.createElement("span");
  name.className = "te-block-name";
  name.id = headId;
  name.innerHTML = `<span aria-hidden="true">${i + 1}</span><span class="sr-only">Bubble ${i + 1}</span>`;
  const unsure = lines.filter((l) => isUnsureLine(l.conf)).length;
  const tag = document.createElement("span");
  tag.className = "te-block-tag";
  tag.textContent = block.added ? "Added by hand" : unsure ? `${unsure} unsure` : "";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "tool-btn danger te-remove";
  remove.innerHTML = '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7l16 0"/><path d="M10 11l0 6"/><path d="M14 11l0 6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/></svg>' +
    `<span>${block.added ? "Remove" : "Not text"}</span>`;
  remove.title = block.added ? "Remove this bubble" : "Remove this bubble: it isn't text";
  remove.setAttribute("aria-label", block.added ? `Remove bubble ${i + 1}` : `Remove bubble ${i + 1}: it isn't text`);
  remove.addEventListener("click", () => removeTextBubble(i));
  head.append(name, tag, remove);
  const zoom = document.createElement("canvas");
  zoom.className = "te-zoom";
  zoom.setAttribute("aria-hidden", "true");
  drawTextBlockZoom(zoom, block, null);
  li.append(head, zoom);
  if (block.added) addedBubbleFields(li, block, i, zoom);
  else lines.forEach((line, j) => li.append(textLineRow(li, block, lines, line, i, j, zoom, tag, list)));
  li.addEventListener("click", (ev) => { if (ev.target === li || ev.target === zoom) selectTextBlock(i, true); });
  return li;
}

function removeTextBubble(i) {
  const added = te.blocks[i].added;
  te.blocks.splice(i, 1);
  te.sel = -1;
  te.line = null;
  commitTextEdits();
  renderTextBlockList();
  teAnnounce(`Bubble ${i + 1} removed. ${te.blocks.length} left.` + (added ? "" : " Reset page brings it back."));
  const next = $("te-blocks").querySelector(`li[data-i="${Math.min(i, te.blocks.length - 1)}"] input, li[data-i="${Math.min(i, te.blocks.length - 1)}"] textarea`);
  (next || $("te-add")).focus();
}

/* An added bubble: its text as typed, one printed line per row, and which way it is written. */
function addedBubbleFields(li, block, i, zoom) {
  const lang = $("manga-language").value.trim() || "ja";
  const areaId = `te-added-${i}`;
  const label = document.createElement("label");
  label.className = "te-added-label";
  label.htmlFor = areaId;
  label.textContent = block.vertical ? "Text, one column per line, right to left" : "Text, one line per row";
  const area = document.createElement("textarea");
  area.id = areaId;
  area.lang = lang;
  area.spellcheck = false;
  area.rows = Math.max(2, block.text.split("\n").length + 1);
  area.value = block.text;
  area.placeholder = "Type the text in this bubble";
  area.setAttribute("aria-describedby", "te-added-help");
  const vertical = document.createElement("label");
  vertical.className = "te-vertical";
  const vbox = document.createElement("input");
  vbox.type = "checkbox";
  vbox.checked = block.vertical;
  vertical.append(vbox, document.createTextNode(" Vertical text"));
  const rebuild = () => {
    te.blocks[i] = { ...textBlockFromBox(te.blocks[i].box, area.value, vbox.checked) };
    label.textContent = vbox.checked ? "Text, one column per line, right to left" : "Text, one line per row";
  };
  area.addEventListener("focus", () => {
    te.sel = i;
    te.line = null;
    for (const other of li.parentElement.children) other.classList.toggle("selected", other === li);
    drawTextEditor();
  });
  area.addEventListener("input", () => { rebuild(); area.rows = Math.max(2, area.value.split("\n").length + 1); drawTextEditor(); });
  area.addEventListener("change", () => {
    if (!area.isConnected) return;
    rebuild();
    commitTextEdits();
    drawTextBlockZoom(zoom, te.blocks[i], null);
    teAnnounce(te.blocks[i].text ? "Bubble saved." : "This bubble has no text yet, so it is not kept.");
  });
  // Ctrl+Enter (Cmd+Enter on a Mac) saves and moves on, as Enter does in a single line.
  area.addEventListener("keydown", async (ev) => {
    if (ev.key !== "Enter" || !(ev.ctrlKey || ev.metaKey) || ev.isComposing) return;
    ev.preventDefault();
    rebuild();
    commitTextEdits();
    te.cursor = [i, Infinity];
    if (unsureLines().length) await goToNextUnsure();
    else { teAnnounce("Bubble saved."); $("te-add").focus(); }
  });
  vbox.addEventListener("change", () => {
    rebuild();
    commitTextEdits();
    teAnnounce(vbox.checked ? "Vertical: lines are columns, right to left." : "Horizontal: lines are rows.");
  });
  li.append(label, area, vertical);
}

function textLineRow(li, block, lines, line, i, j, zoom, tag, list) {
  const row = document.createElement("div");
  const isUnsure = isUnsureLine(line.conf);
  row.className = "te-line" + (isUnsure ? " unsure" : "");
  const flag = document.createElement("span");
  flag.className = "te-flag";
  flag.setAttribute("aria-hidden", "true");
  flag.title = "Hard to read";
  flag.innerHTML = '<svg class="ui-icon" viewBox="0 0 24 24"><path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z"/><path d="M12 16h.01"/></svg>';
  const input = document.createElement("input");
  input.type = "text";
  input.lang = $("manga-language").value.trim() || "ja";
  input.value = line.text;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.enterKeyHint = "next";
  const labelFor = (unsure) => `Bubble ${i + 1}, line ${j + 1} of ${lines.length}` + (unsure ? ", unsure" : "");
  input.setAttribute("aria-label", labelFor(isUnsure));
  if (isUnsure) input.setAttribute("aria-describedby", "te-unsure-help");
  const current = () => textBlockLines(te.blocks[i])[j];
  // The row as it is now that the line was saved or marked right: no longer unsure.
  const settle = () => {
    row.classList.remove("unsure");
    const okBtn = row.querySelector(".te-ok");
    if (okBtn) okBtn.remove();
    input.setAttribute("aria-label", labelFor(false));
    input.removeAttribute("aria-describedby");
    const left = textBlockLines(te.blocks[i]).filter((l) => isUnsureLine(l.conf)).length;
    tag.textContent = left ? `${left} unsure` : "";
  };
  // Saves the field. The list is only rebuilt when a line or bubble went away, so focus and
  // scrolling stay where they are while typing through a bubble.
  const save = (confirm) => {
    const count = lines.length;
    const changed = input.value.trim() !== current().text;
    if (!changed && !(confirm && isUnsureLine(current().conf))) return "same";
    const kept = applyTextLine(i, j, { text: input.value, confirm });
    if (kept && textBlockLines(te.blocks[i]).length === count) { settle(); return "saved"; }
    renderTextBlockList();
    return kept ? "line-removed" : "bubble-removed";
  };
  input.addEventListener("focus", () => {
    te.sel = i;
    te.line = [i, j];
    te.cursor = [i, j];
    for (const other of list.children) other.classList.toggle("selected", other === li);
    drawTextEditor();
    drawTextBlockZoom(zoom, te.blocks[i], current());
  });
  input.addEventListener("blur", () => {
    if (!input.isConnected) return;
    drawTextBlockZoom(zoom, te.blocks[i], null);
    if (te.line && te.line[0] === i && te.line[1] === j) { te.line = null; drawTextEditor(); }
  });
  // Typing saves on leaving the field; Enter saves too and moves on.
  input.addEventListener("change", () => {
    if (!input.isConnected) return;
    const r = save(false);
    if (r === "saved") teAnnounce("Line saved.");
    else if (r === "line-removed") teAnnounce("Line removed.");
    else if (r === "bubble-removed") teAnnounce(`Bubble ${i + 1} is empty and was removed.`);
  });
  input.addEventListener("keydown", async (ev) => {
    if (ev.key !== "Enter" || ev.isComposing) return;
    ev.preventDefault();
    const r = save(true);
    const rebuilt = r === "line-removed" || r === "bubble-removed";
    // Where to look on from: the lines and bubbles after this one moved up when it went.
    te.cursor = r === "bubble-removed" ? [i - 1, Infinity] : [i, r === "line-removed" ? j - 1 : j];
    if (unsureLines().length) { await goToNextUnsure(); return; }
    teAnnounce("No unsure lines left.");
    const fields = [...list.querySelectorAll(".te-line input")];
    const at = rebuilt ? -1 : fields.indexOf(input);
    const next = at >= 0 ? fields[at + 1] : list.querySelector(`li[data-i="${i}"] input`);
    (next || $("te-close")).focus();
  });
  row.append(flag, input);
  if (isUnsure) {
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "tool-btn te-ok";
    ok.innerHTML = '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5l10 -10"/></svg>';
    ok.title = "Looks right (Enter)";
    ok.setAttribute("aria-label", `Line ${j + 1} of bubble ${i + 1} looks right`);
    ok.addEventListener("click", () => {
      const r = save(true);
      teAnnounce(r === "saved" ? "Marked as right." : "Line saved.");
      if (r === "saved") input.focus();
    });
    row.append(ok);
  }
  return row;
}

function renderTextBlockList() {
  const list = $("te-blocks");
  list.textContent = "";
  $("te-empty").hidden = te.blocks.length > 0;
  updateUnsureCounter();
  te.blocks.forEach((block, i) => list.append(textBlockCard(block, i, list)));
  drawTextEditor();
}

function wireTextEditor() {
  const c = $("te-canvas");
  // Pointer: in draw mode a drag (or two clicks) draws a bubble; otherwise a click picks one, and an
  // added bubble can be dragged or resized from its corner.
  c.addEventListener("pointerdown", (ev) => {
    const pt = tePoint(ev);
    const hit = te.draw ? null : teHit(pt);
    if (te.draw) {
      c.setPointerCapture(ev.pointerId);
      te.drag = { mode: "new", box: [pt[0], pt[1], pt[0], pt[1]] };
    } else if (hit && te.blocks[hit.i].added) {
      c.setPointerCapture(ev.pointerId);
      te.sel = hit.i;
      te.drag = { mode: hit.corner ? "resize" : "move", start: pt, orig: te.blocks[hit.i].box.slice(), moved: false };
    } else {
      // A click on a bubble goes straight to its text.
      te.drag = null;
      selectTextBlock(hit ? hit.i : -1, !!hit);
      return;
    }
    drawTextEditor();
  });
  c.addEventListener("pointermove", (ev) => {
    const d = te.drag;
    if (!d) return;
    const [x, y] = tePoint(ev);
    if (d.mode === "new") {
      d.box[2] = x; d.box[3] = y;
    } else {
      const dx = x - d.start[0], dy = y - d.start[1];
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      const [x1, y1, x2, y2] = d.orig;
      setAddedBox(te.sel, d.mode === "move" ? [x1 + dx, y1 + dy, x2 + dx, y2 + dy]
        : [x1, y1, Math.max(x1 + TE_MIN_SIDE, x2 + dx), Math.max(y1 + TE_MIN_SIDE, y2 + dy)]);
    }
    drawTextEditor();
  });
  const end = () => {
    const d = te.drag;
    if (!d) return;
    te.drag = null;
    if (d.mode !== "new") {
      if (d.moved) { commitTextEdits(); renderTextBlockList(); }
      selectTextBlock(te.sel, !d.moved);
      return;
    }
    const b = teNormBox(d.box);
    if (b[2] - b[0] < 4 && b[3] - b[1] < 4) {
      // A click without a drag: the first sets a corner, the second the opposite one.
      if (!te.pending) {
        te.pending = [b[0], b[1]];
        teAnnounce("Corner set. Click the opposite corner.");
        drawTextEditor();
        return;
      }
      const box = teNormBox([te.pending[0], te.pending[1], b[0], b[1]]);
      te.pending = null;
      if (box[2] - box[0] < TE_MIN_SIDE || box[3] - box[1] < TE_MIN_SIDE) { teAnnounce("Too small for a bubble."); drawTextEditor(); return; }
      addTextBubble(box);
      return;
    }
    te.pending = null;
    if (b[2] - b[0] < TE_MIN_SIDE || b[3] - b[1] < TE_MIN_SIDE) { teAnnounce("Too small for a bubble."); drawTextEditor(); return; }
    addTextBubble(b);
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", () => { te.drag = null; drawTextEditor(); });

  // Keyboard on the page: [ and ] pick a bubble, Enter edits its text, Delete removes it, A adds
  // one in the middle, and arrows move an added bubble (Shift resizes it).
  c.addEventListener("keydown", (ev) => {
    const n = te.blocks.length;
    let handled = true;
    if (ev.key === "]" || ev.key === "[") {
      if (n) {
        te.sel = ev.key === "]" ? (te.sel + 1) % n : (te.sel - 1 + n) % n;
        selectTextBlock(te.sel, false);
        teAnnounce(describeTextBlock(te.sel));
      } else teAnnounce("No bubbles on this page. Press A to add one.");
    } else if (ev.key === "Enter" && te.sel >= 0) {
      selectTextBlock(te.sel, true);
    } else if ((ev.key === "Delete" || ev.key === "Backspace") && te.sel >= 0) {
      removeTextBubble(te.sel);
    } else if (ev.key === "a" || ev.key === "A") {
      placeBubbleInMiddle();
    } else if (ev.key === "Escape" && (te.draw || te.pending)) {
      setTextDrawMode(false);
      teAnnounce("Adding cancelled.");
    } else if (ev.key.startsWith("Arrow") && te.sel >= 0) {
      const b = te.blocks[te.sel];
      if (!b.added) { teAnnounce("Only bubbles you added can be moved."); }
      else {
        const step = Math.max(2, Math.round(10 / te.scale));
        const dx = ev.key === "ArrowLeft" ? -step : ev.key === "ArrowRight" ? step : 0;
        const dy = ev.key === "ArrowUp" ? -step : ev.key === "ArrowDown" ? step : 0;
        const [x1, y1, x2, y2] = b.box;
        setAddedBox(te.sel, ev.shiftKey ? [x1, y1, x2 + dx, y2 + dy] : [x1 + dx, y1 + dy, x2 + dx, y2 + dy]);
        commitTextEdits();
        const zoom = $("te-blocks").querySelector(`li[data-i="${te.sel}"] .te-zoom`);
        if (zoom) drawTextBlockZoom(zoom, te.blocks[te.sel], null);
        clearTimeout(te.moveNote);
        te.moveNote = setTimeout(() => teAnnounce(ev.shiftKey ? "Bubble resized." : "Bubble moved."), 400);
      }
    } else {
      handled = false;
    }
    if (handled) ev.preventDefault();
  });
  // Escape while drawing cancels the drawing, not the whole editor.
  $("text-editor").addEventListener("cancel", (ev) => {
    if (te.draw || te.pending || te.drag) { ev.preventDefault(); te.drag = null; setTextDrawMode(false); teAnnounce("Adding cancelled."); }
  });
  $("te-add").addEventListener("click", (ev) => {
    if (te.draw) { setTextDrawMode(false); teAnnounce("Adding cancelled."); return; }
    // From the keyboard there is nothing to drag: a bubble is placed in the middle to move into place.
    if (ev.detail === 0) { placeBubbleInMiddle(); return; }
    setTextDrawMode(true);
    teAnnounce("Drag over the text on the page, or click two opposite corners. Escape cancels.");
  });

  $("te-reset").addEventListener("click", () => {
    const p = textCheck.pages[textCheck.editIndex];
    textEdits.delete(p.name);
    te.blocks = p.blocks.map((b) => ({ ...b }));
    te.sel = -1;
    te.line = null;
    p.thumb = textCheckThumb(te.page, te.blocks);
    renderTextBlockList();
    teAnnounce("Back to the text as read.");
  });
  $("te-drop-unsure").addEventListener("click", dropUnsureLines);
  $("te-prev").addEventListener("click", () => openTextEditor(textCheck.editIndex - 1));
  $("te-next").addEventListener("click", () => openTextEditor(textCheck.editIndex + 1));
  $("te-next-unsure").addEventListener("click", goToNextUnsure);
  $("text-check-review").addEventListener("click", goToNextUnsure);
  $("te-close").addEventListener("click", () => $("text-editor").close());
  $("text-editor").addEventListener("close", () => {
    // A field still being typed in is saved, as leaving it would.
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && $("te-blocks").contains(a)) a.dispatchEvent(new Event("change"));
    setTextDrawMode(false);
    renderTextGrid();
    const thumbs = [...document.querySelectorAll("#text-grid .panel-thumb")];
    const back = thumbs.find((t) => t.getAttribute("aria-label").startsWith(`Page ${textCheck.editIndex + 1},`));
    (back || $("text-check-btn")).focus();
  });
  window.addEventListener("resize", () => { if ($("text-editor").open) layoutTextEditor(); });
  $("text-check-btn").addEventListener("click", runTextCheck);
  $("text-check-flagged").addEventListener("change", renderTextGrid);
}

/* A bubble in the middle of the page, selected on the page so the arrow keys move it into place. */
function placeBubbleInMiddle() {
  const W = te.page.width, H = te.page.height;
  const w = Math.round(W / 8), h = Math.round(H / 5);
  addTextBubble([(W - w) / 2, (H - h) / 2, (W + w) / 2, (H + h) / 2], false);
  $("te-canvas").focus();
  teAnnounce(`Bubble ${te.sel + 1} added in the middle of the page. Move it over the text with the arrow keys, ` +
    "resize it with Shift and the arrows, then press Enter to type its text.");
}

/* The text check is for built-in recognition, which is the only one read before converting. */
function applyTextCheckUi() {
  const mokuro = mangaState.mokuroInput;
  $("text-check-row").hidden = !mokuro && ocrEngine() !== "ppocr";
  if ($("text-check-row").hidden) $("text-check").hidden = true;
  $("text-check-hint").textContent = mokuro
    ? "See Mokuro's text on every page and fix it before converting: correct lines, remove what isn't text, add what it missed."
    : "Read every page first, then fix or remove wrong lines. Lines the reader was unsure of are marked; they stay in the book unless you change them.";
}

/* ── Page wiring ──────────────────────────────────────────────── */

if (typeof document !== "undefined" && document.getElementById("manga-run")) {
  $("manga-key").value = loadSetting("gemini-key", "");
  $("manga-model").value = loadGeminiModel(GEMINI_DEFAULT_MODEL);
  $("manga-yolo").checked = loadSetting("manga-yolo", "1") === "1";
  $("manga-mono").checked = loadSetting("manga-mono", "0") === "1";
  $("manga-panels-only").checked = loadSetting("manga-panels-only", "0") === "1";
  $("manga-rotate-panels").checked = loadSetting("manga-rotate-panels", "1") === "1";
  $("manga-split-spreads").checked = loadSetting("manga-split-spreads", "0") === "1";
  $("manga-yonkoma-detect").checked = loadSetting("manga-yonkoma-detect", "1") === "1";
  {
    const saved = new Set(loadSetting("manga-format", "").split(",").filter(Boolean));
    for (const cb of formatBoxes()) cb.checked = saved.has(cb.value);
    for (const cb of formatBoxes()) {
      cb.addEventListener("change", applyFormatVisibility);
      cb.addEventListener("change", clearValidationWarnings);
    }
    applyFormatVisibility();
  }
  $("manga-booktype").value = validBookType(loadSetting("manga-booktype", ""));
  $("manga-dither").value = loadSetting("manga-dither", "normal");
  $("manga-dither-style").value = validDitherStyle(loadSetting("manga-dither-style", "floyd"));
  $("manga-xtc-split").value = loadSetting("manga-xtc-split", "0");
  $("manga-levels").checked = loadSetting("manga-levels", "0") === "1";
  $("manga-sharpen").checked = loadSetting("manga-sharpen", "0") === "1";
  $("manga-contrast").value = loadSetting("manga-contrast", "off");
  $("manga-ocr-engine").value = savedOcrEngine();
  $("manga-preview-btn").addEventListener("click", () => {
    if ($("manga-preview").hidden) { showCleanupPreview(); return; }
    $("manga-preview").hidden = true;
    $("manga-preview-btn").textContent = "Show preview";
    $("manga-preview-btn").setAttribute("aria-expanded", "false");
  });
  $("manga-preview-prev").addEventListener("click", () => { previewPage--; showCleanupPreview(); });
  $("manga-preview-next").addEventListener("click", () => { previewPage++; showCleanupPreview(); });
  wirePanelEditor();
  wireTextEditor();
  // Screen cards: one per screen size. Any device with that size converts the same, so a card
  // stores the first device key for its size; Other leaves the choice to its pills.
  const screenKey = { "480x800": "x4", "528x792": "x3", "552x768": "eego", "684x1216": "metalio4plus" };
  const syncScreenCards = () => {
    const v = $("manga-res").value;
    const t = MANGA_DEVICE_TARGETS[v];
    const card = t ? `${t[0]}x${t[1]}` : v === RES_FULL || v === RES_CUSTOM ? "other" : "";
    for (const r of document.querySelectorAll('input[name="screen"]')) r.checked = r.value === card;
    for (const r of document.querySelectorAll('input[name="screen-other"]')) r.checked = r.value === v;
    $("screen-other").hidden = card !== "other";
  };
  for (const r of document.querySelectorAll('input[name="screen"]')) {
    r.addEventListener("change", () => {
      const sel = $("manga-res");
      if (r.value === "other") { if (sel.value !== RES_FULL) sel.value = RES_CUSTOM; } else sel.value = screenKey[r.value];
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  $("manga-res").addEventListener("change", syncScreenCards);
  syncScreenCards();
  // Pill rows stand in for the hidden selects the rest of the page reads.
  for (const group of document.querySelectorAll(".pills[data-for]")) {
    const sel = $(group.dataset.for);
    const radios = group.querySelectorAll('input[type="radio"]');
    for (const r of radios) {
      r.checked = r.value === sel.value;
      r.addEventListener("change", () => { sel.value = r.value; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    }
  }
  // Every setting that changes what Convert will do refreshes the line beside it.
  document.querySelector("main").addEventListener("change", updateRunSummary);
  updateRunSummary();
  // A visible preview follows the settings as they change.
  for (const id of ["manga-levels", "manga-sharpen", "manga-contrast"]) {
    $(id).addEventListener("change", () => { if (!$("manga-preview").hidden) showCleanupPreview(); });
  }
  $("manga-ocr-out").value = loadSetting("manga-ocr-out", "en");
  applyBookTypeUi();
  applyOcrUi();
  applyTextCheckUi();
  $("manga-res").value = validResChoice(loadSetting("manga-res", ""));
  $("manga-res-w").value = loadSetting("manga-res-w", "");
  $("manga-res-h").value = loadSetting("manga-res-h", "");
  applyResChoiceUi();
  $("manga-run").addEventListener("click", runMangaConversion);
  $("manga-cancel").addEventListener("click", () => { mangaState.cancelled = true; });
  // Either picker: the file picker (archives, a .mokuro file and its images, page images) or the
  // folder picker (a Mokuro volume or library, a folder of page images). The last pick counts.
  const onFilesChosen = (input) => {
    const files = input.files;
    if (!files.length) return;
    mangaState.files = files;
    mangaState.mokuroInput = false;
    applyFormatVisibility();
    applyOcrUi();
    {
      selectionIsMokuro(files).then((isMokuro) => {
        if (mangaState.files !== files) return;  // a newer pick replaced this one
        mangaState.mokuroInput = isMokuro;
        applyFormatVisibility();
        applyOcrUi();
        applyTextCheckUi();
        updateRunSummary();
      }).catch(() => {});
      const books = splitIntoBooks(files);
      const volumes = books.length > 1 && books.every((b) => isMokuroName(b[0].name));
      const folder = files[0].webkitRelativePath ? files[0].webkitRelativePath.split("/")[0] : "";
      $("manga-file-label").textContent = volumes ? `${books.length} Mokuro volumes${folder ? ` in ${folder}` : ""}, converted one after another`
        : books.length > 1 ? `${books.length} books selected, converted one after another`
        : folder ? `Folder ${folder}: ${books[0].length} file${books[0].length === 1 ? "" : "s"}`
        : files.length === 1 ? files[0].name : `${files.length} files selected`;
      showFileNameMeta();
      panelEdits.clear();
      releasePanelCheckSource();
      panelCheck.pages = [];
      $("panel-check").hidden = true;
      textEdits.clear();
      releaseTextCheckSource();
      textCheck.pages = [];
      $("text-check").hidden = true;
      $("text-check-btn").textContent = "Check text";
      clearValidationWarnings();
      updateRunSummary();
    }
  };
  $("manga-file").addEventListener("change", () => onFilesChosen($("manga-file")));
  $("manga-folder").addEventListener("change", () => onFilesChosen($("manga-folder")));
  $("manga-folder-btn").addEventListener("click", () => $("manga-folder").click());
  // The API-key warning is fixed by either supplying a key or skipping text recognition.
  $("manga-key").addEventListener("input", clearValidationWarnings);
  $("manga-ocr-engine").addEventListener("change", clearValidationWarnings);
  $("manga-ocr-engine").addEventListener("change", applyOcrUi);
  $("manga-ocr-engine").addEventListener("change", applyTextCheckUi);
  // Ticking 1-bit BMP is what brings a dithered output into play for the device folder.
  $("manga-mono").addEventListener("change", applyFormatVisibility);
  for (const r of document.querySelectorAll('input[name="booktype"]')) {
    r.addEventListener("change", () => {
      const sel = $("manga-booktype");
      sel.value = r.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  const panelsOnlyBox = $("manga-panels-only");
  const syncPageMode = () => {
    for (const r of document.querySelectorAll('input[name="pagemode"]')) r.checked = (r.value === "panels") === panelsOnlyBox.checked;
  };
  for (const r of document.querySelectorAll('input[name="pagemode"]')) {
    r.addEventListener("change", () => {
      panelsOnlyBox.checked = r.value === "panels";
      panelsOnlyBox.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  syncPageMode();
  $("manga-booktype").addEventListener("change", clearValidationWarnings);
  $("manga-booktype").addEventListener("change", applyBookTypeUi);
  $("manga-res").addEventListener("change", clearValidationWarnings);
  $("manga-res").addEventListener("change", applyResChoiceUi);
  $("manga-res-w").addEventListener("input", clearValidationWarnings);
  $("manga-res-h").addEventListener("input", clearValidationWarnings);
}
