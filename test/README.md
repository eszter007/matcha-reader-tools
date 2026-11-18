# Tests

Two suites, plus a script that builds everything they compare against.

Most of what these tests assert is **byte equality with the firmware's own Python
tools**. `js/` is a browser port of `tools/manga_convert/convert_manga.py` and
`tools/dict_convert/convert_jmdict.py` from the
[matcha-reader](https://github.com/eszter007/matcha-reader) repo, and the device reads
whatever they produce — so "the JS output is identical to the Python output" is the
property worth protecting, not "the JS output looks reasonable".

That means the reference outputs must be generated **from a checkout of the firmware
repo** before either suite is fully meaningful. Without it both suites still run, but
every comparison against a reference skips.

## Setup

```sh
# 1. The firmware repo, as a sibling of this one (or set MATCHA_READER below)
git clone https://github.com/eszter007/matcha-reader ../matcha-reader

# 2. Python packages for fixture + reference generation
pip install -r test/requirements.txt

# 3. Node packages for the browser suite
npm install playwright onnxruntime-web
npx playwright install chromium

# 4. Build the fixtures and references (writes into test/fixtures/, gitignored)
MATCHA_READER=../matcha-reader python3 test/gen_references.py
```

`MATCHA_READER` defaults to `../matcha-reader` relative to the repo root, so step 1
above needs no environment variable. Set it if the firmware lives elsewhere.

`gen_references.py` prints `SKIPPED (...)` for anything it cannot build and carries on.

Run it with **Python 3.10 or later and Pillow 13 or later**. `convert_manga.py` packs its output
with a script that needs 3.10. Pillow 13 changed which way `Image.resize` resamples first, and the
AI path's ink grid (`fill_uncovered_art`) is built on that resize, so `js/manga-core.js:pilResizeBox`
follows Pillow 13; references from an older Pillow differ in a few cells (`pil_box/` shows it).
A partial install is fine — you just get fewer comparisons.

The references are only as new as that firmware checkout. Point `MATCHA_READER` at an
up-to-date `develop`, and run `gen_references.py` again whenever the firmware's Python tools
change. A stale checkout shows up as byte differences that look like JS bugs: on 6 Nov 2026,
12 Chinese dictionary and pinyin cases failed against a September checkout and all passed once
the references were rebuilt from `develop`.

## Running

```sh
node test/node/run.cjs        # pure functions vs the Python tools
node test/node/anki.cjs       # anki-core.js vs tools/anki_import/apkg_to_flashcards.py
node test/browser/e2e.mjs     # the real pages, driven in Chromium
```

Both print `ok` / `FAIL` per check and exit non-zero on failure.

### On macOS

The suite was written against Linux paths. Two variables point it elsewhere, for both
`gen_references.py` and `e2e.mjs`:

```sh
export TEST_FONT=../matcha-reader/freeink-sdk/libs/book/FreeInkBook/test/fixtures/fonts/DejaVuSans.ttf
export CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"  # or `npx playwright install chromium`
```

The browser is launched with GPU canvas off, so the no-`OffscreenCanvas` comparison is
byte-exact on desktop browsers too (a GPU-rasterised `<canvas>` scales images a few grey
levels differently from `OffscreenCanvas`).

`cpfont structural comparison` is skipped on macOS: `fonts.html` rasterises glyphs with the
browser's font engine, which is CoreText there rather than FreeType, and bitmap metrics land
3px from `fontconvert_sdcard.py` against the 2px the check allows. It runs on Linux.

The node suite needs **no npm packages at all** (the YOLO comparison skips without
`onnxruntime-web`). The browser suite needs `playwright`.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MATCHA_READER` | `../matcha-reader` | Firmware checkout, for `gen_references.py` |
| `TEST_FONT` | `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf` | Font converted by the `fonts.html` test |
| `TEST_JP_FONT` | Hiragino Mincho on macOS, Noto CJK on Linux | Japanese font for `manga_jp.cbz` |
| `CHROMIUM_PATH` | Playwright's managed browser | Override for environments shipping Chromium elsewhere |

Non-ASCII download filenames need a UTF-8 locale. Under a bare `POSIX` locale Chromium
falls back to naming every download `download`, which fails the tests that check output
filenames — export `LANG=C.UTF-8` if you hit that.

## What each suite covers

**`test/node/run.cjs`** — the pure conversion logic in `js/`, with no browser:
panel detection and reading-order sort, the manga binary formats
(`panels.idx`/`panels.dat`/`meta.bin`/`toc.idx`), XTC/XTCH encoding decoded back the way
the firmware's reader does, 1-bit BMP output, device downscaling, EPUB assembly, the
dictionary converters and their POS flags (Japanese, Chinese and Cantonese), pinyin and
furigana (dictionary and AI paths, the AI fed fixed answers), and the zip writer.

**`test/browser/e2e.mjs`** — the actual pages in Chromium, end to end: a file goes into
the picker, the download that comes out is unzipped and compared. Covers `manga.html`
(CBZ, EPUB, PDF and chapter-foldered input; grid and AI panel detection; panels-only;
XTC/XTCH; the Gemini OCR path with the API stubbed, so it needs no key and no network;
and the no-`OffscreenCanvas` fallback older Safari takes), `dictionary.html`
(Yomitan, MDict, Chinese and Cantonese), `ruby.html` (pinyin from the dictionary, pinyin and
furigana with Gemini stubbed to the reference answers), and `fonts.html`.

## Fixtures

`test/fixtures/` is gitignored and entirely generated. Delete it and re-run
`gen_references.py` at any time.

| Fixture | Built by | Used for |
| --- | --- | --- |
| `manga_pages/`, `manga.cbz` | synthetic | the main conversion comparisons |
| `manga.epub`, `manga.pdf` | synthetic | EPUB spine order, PDF rasterisation |
| `manga_fullbleed.cbz` | synthetic | panels-only on borderless pages |
| `manga_foldered.cbz` | synthetic | page order through chapter subfolders |
| `manga_jp.cbz` | synthetic, needs a Japanese font | built-in text recognition (PP-OCR); its test is skipped without it |
| `ref_manga*/`, `ref_dict_*/` | `convert_manga.py`, `convert_jmdict.py` | byte comparison |
| `zh/`, `ref_dict_zh*/`, `ref_dict_yue/` | synthetic, `convert_jmdict.py --lang zh/yue` | the Chinese paths, every option at once |
| `zh/book.epub`, `ref_pinyin/` | synthetic, `add_pinyin_ruby.py` | pinyin from the dictionary, XHTML comparison |
| `zh/ai_*.xhtml`, `zh/ai_*_answers.json`, `ref_ruby_ai/` | synthetic, `add_pinyin_ruby.py` / `add_furigana_ruby.py` with the answers file standing in for Gemini | AI pinyin and furigana, XHTML comparison; some answers are wrong on purpose |
| `manga_layouts/`, `manga_layouts.epub` | synthetic | a 4-koma page, black gutters, a tall panel between two columns, a two-page spread, with a table of contents |
| `ref_layouts*/` | `convert_manga.py` (default, `--no-yonkoma-detect`, `--split-spreads`, `--split-spreads --ltr --trim-margins`) | gutter cuts, 4-koma detection, split spreads and the chapter after them, byte comparison |
| `yolo_post/` | `convert_manga.py`'s `detect_panels()` on fixed detections | the AI path's post-processing (retry, gap filling, blank panels, grid fallback, scaling, 4-koma order), exact |
| `pil_box/` | Pillow's `Image.resize(..., BOX)` | the ink grid's resampling, byte comparison |
| `ref_yolo/boxes.json`, `ref_yolo/layouts.json` | `convert_manga.py`'s `detect_panels()` with the shipped ONNX model | panel boxes, ±2px |
| `ref_font/` | the firmware's `fontconvert_sdcard.py` | `.cpfont` structure |

## Adding a test

Keep the byte-comparison property intact. If a change makes the JS diverge from the
Python tools on any input the fixtures cover, that is a bug in one of them — fix both
together rather than loosening the assertion. Where the two deliberately agree on
something surprising (XML entity decoding is limited to the five predefined entities
plus numeric references, for instance, because `html.unescape` would decode more), the
test says so and why, so the reasoning survives the next person to look at it.
