# 🍵 Matcha Reader Tools

Browser-based converters for the [Matcha Reader](https://github.com/eszter007/matcha-reader)
e-reader firmware (a CrossPoint Reader fork with Japanese learning features). Everything runs
client-side — **no installs, no uploads**. Your files never leave your
device, except manga panel images sent to Google's Gemini API when you supply your own API key
for OCR.

**Three tools:**

| Tool | Input | Output |
|---|---|---|
| 📖 **Manga Converter** | CBZ / ZIP / EPUB / PDF / page images | Manga folder: renamed pages, panel crops, `panels.idx`/`panels.dat` (with OCR text + translations), `meta.bin`, `toc.idx` — and/or a portable `.epub`, `.xtc` or `.xtch` |
| 📚 **Dictionary Converter** | Yomitan `.zip` (Jitendex, JMnedict, grammar) or jmdict-simplified `.json`/`.json.tgz` | `dict/<name>.idx` + `.dat` + `.spx` lookup accelerator |
| 🔤 **Font Converter** | TTF / OTF (up to 4 styles + fallback font) | `.fonts/<Family>/<Family>_<size>.cpfont` (v4, with kerning + ligatures) |

Each tool downloads a zip already laid out for the SD card: unzip it onto the card, or upload the
files via the reader's built-in Wi-Fi web file transfer.

## What the panel detection does

Red boxes are the panels the converter found; the number on each is its position in the reading
order written to `panels.dat`. Pick the **book type** in step 3 and the rest follows from it.

| Book type | Example | What it does |
|---|---|---|
| **Manga** | <img src="docs/images/panels-manga.jpg" width="300" alt="A manga page with eight numbered panels, walked right to left"> | Panels are walked right to left within each row, then down the page. A full-width panel separates the rows above and below it, and a tall panel beside two stacked shorter ones resolves correctly — the order comes from a topological sort, not from clustering panels by their vertical centre. |
| **Western comic** | <img src="docs/images/panels-calvin.jpg" width="300" alt="A Calvin and Hobbes page with eight numbered panels, walked left to right"> | Same layout logic mirrored: left to right within a row, then down. The blank paper border and the page number are cropped off first, so a scan fills the screen instead of floating in the middle of it. |
| **Western comic**<br>(newspaper strips) | <img src="docs/images/panels-moomin-german.jpg" width="300" alt="A Moomin page of four strips with eleven numbered panels"> | Strip collections work the same way. Trimming the margin before detection is what makes this page come out as all 11 panels — untrimmed it returns 9, with one whole strip left undivided. |
| **Webtoon / manhwa** | <img src="docs/images/panels-webtoon.jpg" width="600" alt="Six webtoon pages re-cut from a vertical strip, each with numbered panels"> | One continuous vertical strip. The fixed-height tiles it was distributed in are reassembled and re-cut at the artwork's own gutters, so no page starts or ends mid-panel, and panels are the art blocks between those gutters. A 48-tile chapter came out as 42 pages filling 90% of the screen on average. |

<details>
<summary>One more western example</summary>

<img src="docs/images/panels-moomin-english.jpg" width="420" alt="An English Moomin page with twelve numbered panels across four strips">

Twelve panels across four strips, in reading order.
</details>

## Hosting / running

It's a static site with no build step. Any static host works:

- **GitHub Pages**: enable Pages for this repo (Settings → Pages → Source: *GitHub Actions*).
  The included workflow (`.github/workflows/pages.yml`) deploys on every push to `main`.
- **Locally**: `python3 -m http.server` in the repo root, then open `http://localhost:8000`.

## Fidelity to the firmware's Python tools

These are ports of the firmware's conversion scripts, not reimplementations from the spec:

- **Manga** ports `tools/manga_convert/convert_manga.py` (AI panel detection, white-gutter grid
  fallback, reading-order topological sort, margin trimming, webtoon re-pagination, Gemini panel
  OCR with the same language-aware prompt/model/retry behaviour, and the same binary writers). Given identical input pixels and the grid detector,
  the binary output is **byte-identical** to the Python tool. AI panel detection runs the *same*
  fine-tuned YOLO26 model as the Python tool
  ([leoxs22/manga-panel-detector-yolo26n](https://huggingface.co/leoxs22/manga-panel-detector-yolo26n),
  exported to ONNX in `models/`) in-browser via a vendored ONNX Runtime Web — no PyTorch, no
  server; the ~21 MB (runtime + model) loads lazily on first use and is cached by the browser.
  Detected boxes match the Python tool's within a pixel or two (float rounding differs across
  inference backends); post-processing (confidence 0.4, sliver filter, overlap dedupe, reading
  order) is identical. Untick *AI panel detection* to force the grid heuristic, which is also
  the automatic fallback wherever WebAssembly or the download fails.
  Tick *Panels only (no full pages)* to leave the full-page images out of the download and ship
  just the panel crops. The device sees pages with no image and goes straight to panel-by-panel
  reading, and the book takes far less space on the card. Nothing is lost to a missed panel: each
  page's ink is measured against its panel rects, and any page whose panels don't cover the artwork
  keeps its full page (the device already handles such mixed books — a page with no crop shows as a
  full page). Page 0 is always kept as well, since the Library takes the cover from it; missing
  pages don't shift the rest, as the device maps page index to image by position. A full-page panel
  normally gets no crop (the page image is already the best view of it), so in this mode its crop is
  written anyway — otherwise such a page would export nothing at all. This is Matcha-tools-only —
  the desktop Python tool has no equivalent flag.
  Panel crops are written to a `panels/` subfolder (matching the Python tool) so the book folder
  holds only page images. The device walks every entry of the book folder when opening a book, and
  a crop per panel dominated that scan — measured at 6499 ms for 2396 entries, of which 219 were
  pages and 974 were crops. The flat layout older conversions used is still supported; re-convert
  to get the faster open.
  *Rotate wide panels to portrait* (on by default) controls what the **EPUB** and **XTC/XTCH**
  exports do with a landscape panel: those formats embed a pre-rendered image, so the orientation is
  baked in at conversion time, and a wide panel is turned upright to fill a portrait screen rather
  than sit in a thin band. Untick it to keep every panel exactly as it was drawn — for a device or
  app that is read in landscape, or when the rotation is more annoying than the extra size is worth.
  The Matcha Reader format is unaffected either way: its panel crops are stored at their own shape
  and the firmware rotates one when it zooms it to the screen, so the option is hidden unless EPUB,
  XTC or XTCH is picked. Full pages are unaffected too — the EPUB never rotates them, and XTC/XTCH
  still turn a landscape spread upright so it fills the fixed page size.
  The *Book type* dropdown carries the desktop tool's `--ltr`, `--trim-margins` and `--webtoon`
  flags, as one choice rather than three checkboxes nobody would think to combine. **Manga** is the
  right-to-left default. **Western comic** walks panels left to right and trims the printed paper
  border off every page — the Python tool keeps those separate, but a western print scan wants both
  every time, so the browser tool doesn't ask twice. **Webtoon / manhwa** reassembles the strip from
  the fixed-height tiles it was sliced into and re-cuts it at the artwork's gutters into
  screen-shaped pages; its panels come from those gutters rather than the AI detector, which looks
  for bordered rectangles in a grid and has nothing to find in a webtoon (the checkbox is disabled
  for that reason). A webtoon's source chapter list is dropped with a warning, since re-cutting
  changes how many pages there are and its page indices no longer point anywhere real. Nothing is
  preselected: reading a western comic in manga order is a silently wrong result, not a default to
  guess at.
  The OCR prompt is built from two things. The language the book is *in* comes from the *Language*
  field in step 5 — the same one that tags the book for reading stats — because a book declaring one
  in its EPUB or `ComicInfo.xml` fills it in by itself, and a second picker in step 4 could only
  disagree with it. Naming that language is what stops the model hallucinating Japanese out of a
  German speech bubble; left blank, the prompt names no language and still works, and the
  conversion log says so. *Translate into* (step 4) picks the language the translation comes back
  in; choose the book's own and you get transcription with no pointless same-language translation.
  The target language is Matcha-tools-only — the desktop tool always translates into English.
  *Skip text recognition* is ticked by default — it needs no API key, sends nothing anywhere and is
  much faster, so the key field and the translation picker only appear once it is unticked. The AI
  detector, panel rotation and the 1-bit BMP option live under *Advanced* at the end of step 3,
  since the book type and target resolution are the two choices that actually have to be made.
  Tick *1-bit BMP (Floyd–Steinberg dithering)* to write pages and panel crops as black-and-white
  dithered BMP instead of JPEG (the desktop tool's `--mono`). The device paints 1-bit BMP with a
  single fast refresh (no 4-level gray pass), so pages and panels turn noticeably quicker; it's
  best for pure line art (screentone gradients become dither patterns) and pairs naturally with
  *Skip text recognition*.
  The *Language* field (the desktop tool's `--language`) tags the book so the reader can split
  reading stats by language. It is written into `meta.bin` as an optional trailer after the author,
  without a format-version bump — firmware predating the field reads exactly the header, title and
  author and never looks further, so it ignores the extra bytes instead of rejecting the file.
  EPUBs (`<dc:language>`) and CBZs carrying a `ComicInfo.xml` (`<LanguageISO>`) fill it in
  automatically; PDFs and loose image files declare nothing, so set it by hand. The tag is read at
  conversion time, so a book converted without one counts as "unknown" until it is converted again.
  Common country-code slips are corrected (`jp` → `ja`, `cn` → `zh`, `kr` → `ko`) so one language
  can't end up split across two buckets; region and script subtags are preserved (`zh-Hant`).
  *Export format* is a set of checkboxes — any combination of **Matcha Reader format** (the native
  panel folder), **EPUB**, **XTC** and **XTCH**. Nothing is preselected; converting without a pick
  is refused rather than guessed at. Selecting one non-folder format downloads that file directly;
  several are zipped together, and when the device folder is included the others ride inside its
  zip. The steps below adapt to the pick: the Gemini step and the install notes only apply to the
  device folder (OCR text lives in `panels.dat`, so it is skipped implicitly otherwise), book
  details stay for the EPUB too since it embeds title/author/chapters, and the 1-bit BMP option
  only affects pages written into the device folder.
  **EPUB** is a fixed-layout EPUB 3 (one image per screen, right-to-left): each manga page is
  followed by its panels as full-screen pages, wide panels rotated to portrait so they display as
  large as possible (see *Rotate wide panels to portrait* above), and the source chapter list is
  carried over as the EPUB table of contents.
  Panel images are JPEG and pages keep their original JPEG/PNG — both core EPUB media types, so the
  1-bit BMP option doesn't affect the EPUB.
  **XTC / XTCH** is Xteink's own page format, for the stock firmware: pages are pre-rendered
  bitmaps, so choose a target resolution to match the screen. XTC is 1-bit (Floyd–Steinberg
  dithered) and XTCH is 2-bit, four-level grayscale at twice the size. Both carry the same page
  sequence as the EPUB — each page followed by its panels. Ported from the firmware's own reader
  (`lib/Xtc/`), and since the desktop tool has no XTC export there is no reference output to diff
  against; the tests instead decode what the encoder writes exactly the way the device does. XTCH
  pads page height to a multiple of 8, which its plane layout requires.
  EPUB and XTC/XTCH are Matcha-tools-only — the desktop Python tool has neither.
  The *Target resolution* dropdown (the desktop tool's `--x3`/`--x4`) downscales pages and panels to
  a device screen — **X4** (480×800) or **X3** (528×792) — before panel detection, so the download
  is smaller and the device decodes far fewer pixels per page; landscape images fit the rotated box,
  and it never upscales. *Custom* reveals a width and height pair for a screen that isn't one of
  the presets; it behaves exactly like a preset (fit to the box, landscape against the swapped one,
  never upscale) and is remembered between sessions. A typed size is checked rather than corrected:
  each dimension must be 1–4096 px, and because XTCH's bit-planes are indexed in 8-row groups, that
  format additionally needs a height divisible by 8 — the conversion says which nearby height works
  instead of silently exporting a size nobody asked for.
  *Full resolution — High file size* keeps the source pixels and is
  byte-identical to the Python tool, at a size the Xteink firmware struggles with, so the hint under
  the dropdown turns into a warning when it is picked. Nothing is preselected — like the export
  format, converting without a pick is refused rather than guessed at, since the choice is a real
  trade-off rather than a detail to fall into. When a device is selected the browser's image
  resampling differs slightly from Pillow's, so — like PDF input — the downscaled pixels (and
  therefore panel boxes) can differ from the desktop tool by a pixel or two.
  PDF input works like the desktop tool's (which uses PyMuPDF): pages are rasterized at 2× zoom
  in document order and Title/Author come from the PDF metadata, but rendering happens in-browser
  via a vendored [PDF.js](https://mozilla.github.io/pdf.js/) (lazy-loaded, ~1.8 MB). PDF
  rasterizers decode embedded images slightly differently, so PDF page pixels — and therefore
  panel boxes — can differ from the desktop tool by a pixel or two (verified within ±2 px);
  every other input type is pixel-exact.
- **Dictionary** ports `tools/dict_convert/convert_jmdict.py` and `scripts/gen_dict_spx.py`
  **byte-identically** — JMdict-simplified JSON, Yomitan zip, and MDict `.mdx` inputs. The MDX
  reader (`js/mdx.js`) is a port of `readmdict` (the desktop tool's MDX dependency): engine
  versions 1.2/2.0, zlib / LZO / uncompressed blocks, `Encrypted=2` key-index encryption
  (ripemd128), and registration-encrypted files (`Encrypted=1`) — enter the owner's
  registration code and the email/device ID it was issued to under *MDict registration*
  (Salsa20/8, same scheme readmdict's passcode uses). Without a passcode the converter falls
  back to readmdict's key-block scan, which recovers most `Encrypted=1` files anyway.
- **Fonts** ports `lib/EpdFont/scripts/fontconvert_sdcard.py` (.cpfont v4). Everything read from
  the font file — cmap intervals, advance widths, kerning classes/matrix, ligature tables —
  matches the Python tool byte-for-byte. Glyph bitmaps are rasterized by the browser's font
  engine instead of FreeType, so pixel edges differ very slightly (typically within antialiasing
  noise; verified within ±2px on bitmap metrics).

## Tests

The test suite generates reference outputs with the actual firmware Python tools and compares
bytes. It needs a checkout of the firmware repo next door (or set `MATCHA_READER=/path/to/repo`):

```bash
pip install Pillow freetype-py fonttools    # for reference generation
pip install numpy onnxruntime               # optional: YOLO panel-detection references
pip install pymupdf                          # optional: PDF-input references
pip install readmdict python-lzo             # optional: MDict .mdx references (needs liblzo2-dev)
python3 test/gen_references.py             # build fixtures + Python references

npm install onnxruntime-web                # optional: YOLO detection in the Node tests
node test/node/run.cjs                     # pure-logic byte comparisons (Node ≥ 18)

npm install playwright                     # browser end-to-end (drives the real pages)
python3 /path/to/matcha-reader/lib/EpdFont/scripts/fontconvert_sdcard.py \
  --intervals latin-ext --size 14 --style regular \
  /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
  -o test/fixtures/ref_font/DejaVuSans_14.cpfont
node test/browser/e2e.mjs
```

## Notes & limits

- **Gemini OCR** requires your own API key (free tier works, but rate limits make long volumes
  slow — the converter retries with backoff, keeps the screen awake, and pressing *Stop* still
  packages every fully-converted page). The key is kept in `localStorage` and sent only to
  Google's API endpoint.
- **Memory**: pages are processed one at a time, but the output zip is assembled in memory —
  very large volumes (many hundreds of MB) may struggle on low-RAM devices.
- Browsers with `DecompressionStream` are required (Chrome/Edge ≥ 80, Safari ≥ 16.4,
  Firefox ≥ 113).

## License

MIT — see [LICENSE](LICENSE).
