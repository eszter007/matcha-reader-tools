#!/usr/bin/env python3
"""Generate reference outputs using the matcha-reader firmware's own Python
conversion tools, for byte-comparison against this repo's JS ports.

Usage:
    MATCHA_READER=/path/to/matcha-reader python3 test/gen_references.py

Produces under test/fixtures/:
    manga_pages/         synthetic PNG pages + raw grayscale (.gray) and RGBA (.rgba) dumps
    manga_fullbleed.cbz  borderless pages (one full-page panel each), for panels-only
    manga_foldered.cbz   one folder per chapter, page numbers restarting in each
    manga_jp.cbz         vertical Japanese in speech bubbles (needs a Japanese font, else skipped)
    ref_manga/           convert_manga.py --no-ocr output
    ref_yolo/boxes.json  YOLO panel boxes (needs numpy + onnxruntime, else skipped)
    ref_manga_pdf/       convert_manga.py --no-ocr output for the PDF fixture
                         (needs pymupdf, else skipped)
    yomitan.zip          synthetic Yomitan dictionary
    jmdict.json          synthetic jmdict-simplified JSON
    ref_dict_yomitan/    convert_jmdict.py output + .spx
    ref_font/            fontconvert_sdcard.py .cpfont (needs freetype-py + fontTools)
    ref_dict_jmdict/     convert_jmdict.py output + .spx
    yomitan_markup.zip   Yomitan entries for the text cleanup (HTML, lists, tables, icons, links)
    yomitan_kanji*.zip   Yomitan kanji dictionaries (kanji banks; single-character term banks)
    pitch1/2.zip         Yomitan pitch-accent dictionaries
    furigana.json, yomitan_images.zip, korean.zip
                         JmdictFurigana rows, a Yomitan dictionary with pictures, a Korean one
    ref_dict_furigana/, ref_dict_images/, ref_dict_ko/
                         convert_jmdict.py --furigana, --images (with images/), --lang ko (StarDict)
    ref_dict_yomitan_markup/, ref_dict_ja_merged/, ref_dict_kanji/, ref_dict_hanzi/
                         convert_jmdict.py output for those (merged inputs, --pitch, --name kanji/hanzi)
    zh/                  synthetic CC-CEDICT, CC-Canto, MoE JSON, word lists, sentence pairs
    ref_dict_zh*/        convert_jmdict.py --lang zh / yue output (+ names.*, .title files)
    ref_pinyin/          add_pinyin_ruby.py output for zh/book.epub
"""

import gzip
import io
import json
import os
import random
import shutil
import subprocess
import sys
import zipfile

from PIL import Image, ImageDraw

# Absolute: some firmware scripts run with their own folder as the working directory.
FIRMWARE = os.path.abspath(os.environ.get("MATCHA_READER", os.path.join(os.path.dirname(__file__), "..", "..", "matcha-reader")))
FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def make_manga_pages():
    out = os.path.join(FIXTURES, "manga_pages")
    os.makedirs(out, exist_ok=True)
    rng = random.Random(42)
    dims = {}

    def noise_rect(draw, x1, y1, x2, y2):
        # Dense mid-gray fill so panel interiors never read as white gutters.
        draw.rectangle([x1, y1, x2 - 1, y2 - 1], fill=(150, 150, 150), outline=0, width=3)
        for _ in range(400):
            px = rng.randint(x1 + 4, x2 - 5)
            py = rng.randint(y1 + 4, y2 - 5)
            draw.point((px, py), fill=rng.randint(0, 180))

    # Page 1: 2x2 grid with white gutters.
    img = Image.new("RGB", (800, 1200), "white")
    d = ImageDraw.Draw(img)
    for (x1, y1, x2, y2) in [(30, 30, 390, 580), (410, 30, 770, 580),
                             (30, 620, 390, 1170), (410, 620, 770, 1170)]:
        noise_rect(d, x1, y1, x2, y2)
    img.save(os.path.join(out, "page01.png"))

    # Page 2: one tall panel beside two stacked panels (reading-order test).
    img = Image.new("RGB", (800, 1200), "white")
    d = ImageDraw.Draw(img)
    noise_rect(d, 420, 40, 760, 1160)   # tall right panel (read first)
    noise_rect(d, 40, 40, 380, 580)     # top-left
    noise_rect(d, 40, 640, 380, 1160)   # bottom-left
    img.save(os.path.join(out, "page02.png"))

    # Page 3: borderless full-page art (single panel fallback). Dense enough that no row or column
    # is 97% paper: sparser dots read as gutters to the recursive grid, and then whether a line
    # just clears the bar depends on how the PDF fixture's JPEG is decoded and scaled.
    img = Image.new("RGB", (800, 1200), "white")
    d = ImageDraw.Draw(img)
    for _ in range(80000):
        px = rng.randint(0, 799)
        py = rng.randint(0, 1199)
        d.point((px, py), fill=rng.randint(0, 200))
    img.save(os.path.join(out, "page03.png"))

    # Raw grayscale dumps: exactly what PIL convert("L") feeds the detector.
    # Raw RGBA dumps: exactly what canvas getImageData feeds the YOLO path
    # (PNG decoding is lossless, so browser RGBA matches PIL byte-for-byte).
    for name in sorted(os.listdir(out)):
        if not name.endswith(".png"):
            continue
        img = Image.open(os.path.join(out, name))
        gray = img.convert("L")
        with open(os.path.join(out, name.replace(".png", ".gray")), "wb") as f:
            f.write(gray.tobytes())
        with open(os.path.join(out, name.replace(".png", ".rgba")), "wb") as f:
            f.write(img.convert("RGBA").tobytes())
        dims[name] = list(img.size)
    with open(os.path.join(out, "dims.json"), "w") as f:
        json.dump(dims, f)
    print(f"manga pages: {out}")


def legacy_flag(script):
    """--legacy where the converter has it: it then writes the folder these references compare,
    not one .matcha file. Older firmware checkouts write the folder anyway."""
    with open(script, encoding="utf-8") as f:
        return ["--legacy"] if '"--legacy"' in f.read() else []


def grid_only_env():
    """Environment that forces convert_manga.py onto its grid-heuristic path
    even when ultralytics/huggingface_hub are installed: a stub module that
    raises ImportError shadows the real ones, triggering the tool's own
    fallback. The grid references must stay byte-comparable to the JS grid
    port no matter what the local Python happens to have installed."""
    stub_dir = os.path.join(FIXTURES, "_grid_only_stub")
    os.makedirs(stub_dir, exist_ok=True)
    with open(os.path.join(stub_dir, "huggingface_hub.py"), "w") as f:
        f.write("raise ImportError('YOLO disabled: grid reference generation')\n")
    env = dict(os.environ)
    env["PYTHONPATH"] = stub_dir + os.pathsep + env.get("PYTHONPATH", "")
    return env


def run_manga_reference():
    out = os.path.join(FIXTURES, "ref_manga")
    shutil.rmtree(out, ignore_errors=True)
    script = os.path.join(FIRMWARE, "tools", "manga_convert", "convert_manga.py")
    subprocess.run([sys.executable, script,
                    "--input", os.path.join(FIXTURES, "manga_pages"),
                    "--output-dir", out,
                    "--no-ocr", *legacy_flag(script),
                    "--title", "Test Manga", "--author", "Test Author"],
                   check=True, env=grid_only_env())
    print(f"manga reference: {out}")


def make_manga_cbz():
    """CBZ of the synthetic pages, for the browser end-to-end test."""
    path = os.path.join(FIXTURES, "manga.cbz")
    pages = os.path.join(FIXTURES, "manga_pages")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(os.listdir(pages)):
            if name.endswith(".png"):
                z.write(os.path.join(pages, name), name)
    print(f"manga cbz: {path}")


def make_manga_fullbleed_cbz():
    """CBZ of borderless, edge-to-edge pages, for the panels-only end-to-end test.

    Every page is inked into all four corners, so the white-gutter detector finds
    no gutter and returns a single panel covering the whole page. That is the one
    shape "panels only" has no crop-free fallback for -- see testMangaPanelsOnly
    in test/browser/e2e.mjs.
    """
    path = os.path.join(FIXTURES, "manga_fullbleed.cbz")
    out = os.path.join(FIXTURES, "manga_fullbleed")
    os.makedirs(out, exist_ok=True)
    for i in range(3):
        img = Image.new("RGB", (800, 1200), "white")
        d = ImageDraw.Draw(img)
        # 45-degree hatching across the whole page: every row and every column
        # crosses a line, so there is no blank band anywhere for the detector to
        # split the page on. The offset just makes the three pages differ.
        for x0 in range(-1200 + i * 2, 800, 6):
            d.line([(x0, 0), (x0 + 1200, 1200)], fill=40, width=3)
        img.save(os.path.join(out, f"full{i + 1:02d}.png"))
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(os.listdir(out)):
            if name.endswith(".png"):
                z.write(os.path.join(out, name), name)
    print(f"manga full-bleed cbz: {path}")


# Text the Japanese pages carry, one entry per speech bubble: its columns, right to left.
MANGA_JP_BUBBLES = [
    ["それじゃあ", "また明日"],
    ["本当に", "行くの？"],
    ["電車が来る"],
    ["待って", "ください"],
]
JP_FONT_CANDIDATES = [
    "/System/Library/Fonts/ヒラギノ明朝 ProN.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
    "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
]


def make_manga_jp_cbz():
    """CBZ of two pages with vertical Japanese in speech bubbles, for the in-browser OCR test.

    Needs a Japanese font (TEST_JP_FONT, or one of JP_FONT_CANDIDATES); skipped without one.
    The text is listed in MANGA_JP_BUBBLES and in testMangaPpocr in test/browser/e2e.mjs.
    """
    from PIL import ImageFont
    font_path = os.environ.get("TEST_JP_FONT") or next((f for f in JP_FONT_CANDIDATES if os.path.exists(f)), None)
    if not font_path:
        print("manga jp cbz: SKIPPED (no Japanese font; set TEST_JP_FONT)")
        return
    font = ImageFont.truetype(font_path, 34)
    out = os.path.join(FIXTURES, "manga_jp")
    os.makedirs(out, exist_ok=True)
    rng = random.Random(7)

    def column(d, x, y, text):
        for ch in text:
            # Upright glyphs, one per cell; real vertical typesetting nudges small kana, which the
            # model does not need.
            l, t, r, b = d.textbbox((0, 0), ch, font=font)
            d.text((x + (34 - (r - l)) / 2 - l, y), ch, font=font, fill=0)
            y += 40

    for page in range(2):
        img = Image.new("RGB", (900, 1300), "white")
        d = ImageDraw.Draw(img)
        panels = [(40, 40, 860, 620), (40, 660, 440, 1260), (480, 660, 860, 1260)]
        for x1, y1, x2, y2 in panels:
            d.rectangle([x1, y1, x2, y2], outline=0, width=6)
            for _ in range(60):  # some artwork, kept clear of the bubbles' corner
                cx, cy = rng.randint(x1 + 20, x2 - 220), rng.randint(y1 + 300, y2 - 30)
                d.ellipse([cx, cy, cx + 30, cy + 20], fill=(rng.randint(80, 200),) * 3)
        for i, (x1, y1, x2, y2) in enumerate(panels[:2]):
            cols = MANGA_JP_BUBBLES[page * 2 + i]
            bw = 60 * len(cols) + 60
            bx2, by1 = x2 - 30, y1 + 30
            d.ellipse([bx2 - bw, by1, bx2, by1 + 360], fill="white", outline=0, width=4)
            for c, text in enumerate(cols):
                column(d, bx2 - 75 - 60 * c, by1 + 50, text)
        d.text((440, 1270), str(page + 1), font=font, fill=0)
        img.save(os.path.join(out, f"jp{page + 1:02d}.png"))
    path = os.path.join(FIXTURES, "manga_jp.cbz")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(os.listdir(out)):
            if name.endswith(".png"):
                z.write(os.path.join(out, name), name)
    print(f"manga jp cbz: {path}")


def make_manga_foldered_cbz():
    """CBZ with one folder per chapter, page numbering restarting inside each.

    The layout that cost a reader most of a volume: ch01/001.png and ch03/001.png
    share a basename, so keying pages on the basename kept only the last of each.
    Every chapter gets a distinct page WIDTH so the resulting panels.idx records
    the reading order unambiguously -- see testMangaFolderedCbz in
    test/browser/e2e.mjs.
    """
    path = os.path.join(FIXTURES, "manga_foldered.cbz")
    out = os.path.join(FIXTURES, "manga_foldered")
    os.makedirs(out, exist_ok=True)
    widths = {1: 600, 2: 620, 3: 640}
    for ch in (1, 2, 3):
        for pg in (1, 2, 3):
            w = widths[ch]
            img = Image.new("RGB", (w, 900), "white")
            d = ImageDraw.Draw(img)
            d.rectangle([40, 40, w - 40, 860], fill=(150, 150, 150), outline=0, width=3)
            d.text((60, 60), f"ch{ch} pg{pg}", fill=0)
            img.save(os.path.join(out, f"ch{ch:02d}_{pg:03d}.png"))
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for ch in (1, 2, 3):
            for pg in (1, 2, 3):
                z.write(os.path.join(out, f"ch{ch:02d}_{pg:03d}.png"), f"ch{ch:02d}/{pg:03d}.png")
    print(f"manga foldered cbz: {path}")


def write_pages_epub(path, pages_dir, title, author, uid, toc):
    """Fixed-layout EPUB of the PNG pages in pages_dir: XHTML spine wrappers around the pages,
    dc: metadata, and an EPUB3 nav TOC of (page index, title, href fragment)."""
    page_files = sorted(n for n in os.listdir(pages_dir) if n.endswith(".png"))

    manifest_items = ['<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>']
    spine_items = []
    for i, name in enumerate(page_files):
        manifest_items.append(f'<item id="pg{i}" href="text/pg{i}.xhtml" media-type="application/xhtml+xml"/>')
        manifest_items.append(f'<item id="img{i}" href="images/{name}" media-type="image/png"/>')
        spine_items.append(f'<itemref idref="pg{i}"/>')

    opf = f'''<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">{uid}</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:creator>{author}</dc:creator>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>{"".join(manifest_items)}</manifest>
  <spine>{"".join(spine_items)}</spine>
</package>'''

    links = "\n".join(f'<li><a href="text/pg{i}.xhtml{frag}">{t}</a></li>' for i, t, frag in toc)
    nav = f'''<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol>
{links}
</ol></nav>
</body></html>'''

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("META-INF/container.xml",
                   '<?xml version="1.0"?><container version="1.0" '
                   'xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                   '<rootfiles><rootfile full-path="OEBPS/content.opf" '
                   'media-type="application/oebps-package+xml"/></rootfiles></container>')
        z.writestr("OEBPS/content.opf", opf)
        z.writestr("OEBPS/nav.xhtml", nav)
        for i, name in enumerate(page_files):
            z.writestr(f"OEBPS/text/pg{i}.xhtml",
                       f'<html xmlns="http://www.w3.org/1999/xhtml"><body>'
                       f'<img src="../images/{name}"/></body></html>')
            z.write(os.path.join(pages_dir, name), f"OEBPS/images/{name}")


def make_manga_epub():
    """Synthetic fixed-layout EPUB of the synthetic pages. Exercises spine-order extraction,
    metadata auto-detection, and toc.idx generation."""
    path = os.path.join(FIXTURES, "manga.epub")
    write_pages_epub(path, os.path.join(FIXTURES, "manga_pages"), "Epub Test Manga", "Epub Author", "test-epub",
                     [(0, "Cover", ""), (1, "Chapter 1", ""), (2, "Chapter 2", "#top")])
    print(f"manga epub: {path}")


def run_manga_epub_reference():
    out = os.path.join(FIXTURES, "ref_manga_epub")
    shutil.rmtree(out, ignore_errors=True)
    script = os.path.join(FIRMWARE, "tools", "manga_convert", "convert_manga.py")
    subprocess.run([sys.executable, script,
                    "--input", os.path.join(FIXTURES, "manga.epub"),
                    "--output-dir", out,
                    "--no-ocr", *legacy_flag(script)],
                   check=True, env=grid_only_env())
    print(f"manga epub reference: {out}")


def run_yolo_reference():
    """Reference panel boxes for the AI (YOLO) detection path.

    The firmware tool's own detect_panels() runs with the model swapped for the ONNX export the
    site ships (models/manga_panel_detector_yolo26n.onnx), fed the way js/yolo.js feeds it
    (bilinear letterbox, float32 tensor), so the retry, the gap filling, the blank-panel drop, the
    grid fallback, the 4-koma order and the bubble-aware crops are all convert_manga.py's.

    Decoding runs at PANEL_WEAK_CONF, as ultralytics is asked to: sub-threshold panel boxes are
    kept as corroboration and as gap fillers, and the text class drives the crop expansion.

    Inference backends differ in float rounding, so the JS comparison is tolerance-based
    (±2 px), unlike the byte-exact grid references. yolo_post/ compares the post-processing
    exactly, on fixed detections.
    """
    try:
        import numpy as np
        import onnxruntime as ort
    except ImportError as e:
        print(f"yolo reference: SKIPPED ({e}; pip install numpy onnxruntime)")
        return

    sys.path.insert(0, os.path.join(FIRMWARE, "tools", "manga_convert"))
    import convert_manga

    model_path = os.path.join(os.path.dirname(__file__), "..", "models",
                              "manga_panel_detector_yolo26n.onnx")
    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    stride = 32

    def letterbox(rgb, size):
        # ultralytics LetterBox(new_shape=size, auto=True, stride=32): the long side is scaled to
        # `size` and the short side padded only to the next multiple of 32, NOT out to a square.
        # js/yolo.js:yoloLetterbox does the same, and the model is exported with dynamic
        # height/width so both can feed it.
        h, w = rgb.shape[:2]
        scale = min(size / w, size / h)
        nw, nh = round(w * scale), round(h * scale)
        dw, dh = ((size - nw) % stride) / 2, ((size - nh) % stride) / 2
        padx, pady = max(0, round(dw - 0.1)), max(0, round(dh - 0.1))
        net_w = nw + padx + max(0, round(dw + 0.1))
        net_h = nh + pady + max(0, round(dh + 0.1))
        out = np.full((3, net_h, net_w), np.float32(114 / 255), dtype=np.float32)
        # Each axis maps by its own ratio, as cv2.resize does: nw is rounded, so
        # nw/w and nh/h differ slightly and sampling both at `scale` drifts by up
        # to a third of a pixel. js/yolo.js:yoloLetterbox does the same.
        ys = np.clip((np.arange(nh) + 0.5) / (nh / h) - 0.5, 0, h - 1)
        xs = np.clip((np.arange(nw) + 0.5) / (nw / w) - 0.5, 0, w - 1)
        y0 = np.floor(ys).astype(int); y1 = np.minimum(y0 + 1, h - 1)
        x0 = np.floor(xs).astype(int); x1 = np.minimum(x0 + 1, w - 1)
        fy = (ys - y0)[:, None, None]; fx = (xs - x0)[None, :, None]
        p = rgb.astype(np.float64)
        resized = (p[y0][:, x0] * (1 - fy) * (1 - fx) + p[y0][:, x1] * (1 - fy) * fx +
                   p[y1][:, x0] * fy * (1 - fx) + p[y1][:, x1] * fy * fx)
        out[:, pady:pady + nh, padx:padx + nw] = (resized / 255).transpose(2, 0, 1).astype(np.float32)
        return out[None], scale, padx, pady

    class OnnxModel:
        """model.predict() as convert_manga.py calls it, answered by the ONNX model."""

        def predict(self, img, conf, iou, imgsz, verbose):
            inp, scale, padx, pady = letterbox(np.asarray(img.convert("RGB")), imgsz)
            rows = sess.run(None, {sess.get_inputs()[0].name: inp})[0][0]
            boxes = []
            for x1, y1, x2, y2, score, cls in rows:
                if score < conf:
                    continue
                # Clipped to the page in page pixels, as ultralytics returns them; int() later
                # truncates, as yoloDecodeOutput does.
                xyxy = [min(max((float(v) - pad) / scale, 0), lim)
                        for v, pad, lim in ((x1, padx, img.width), (y1, pady, img.height),
                                            (x2, padx, img.width), (y2, pady, img.height))]
                boxes.append(_FakeBox(xyxy, float(score), round(float(cls))))
            return [_FakeResult(boxes)]

    convert_manga._YOLO_MODEL = OnnxModel()
    out_dir = os.path.join(FIXTURES, "ref_yolo")
    os.makedirs(out_dir, exist_ok=True)
    for pages, ref_name in (("manga_pages", "boxes.json"), ("manga_layouts", "layouts.json")):
        pages_dir = os.path.join(FIXTURES, pages)
        if not os.path.isdir(pages_dir):
            continue
        result = {}
        for name in sorted(os.listdir(pages_dir)):
            if not name.endswith(".png"):
                continue
            img = Image.open(os.path.join(pages_dir, name)).convert("RGB")
            frames, texts = convert_manga.detect_panels(img, img)
            if not frames:
                frames = [[0, 0, img.width, img.height]]
            order = None
            if hasattr(convert_manga, "yonkoma_reading_order"):
                order = convert_manga.yonkoma_reading_order(frames, img.width)
            if order is None:
                order = convert_manga.sort_panels_reading_order(frames)
            result[name] = convert_manga.expand_panels_over_text(order, texts, img.width, img.height)
        with open(os.path.join(out_dir, ref_name), "w") as f:
            json.dump(result, f, indent=1)
        print(f"yolo reference: {os.path.join(out_dir, ref_name)}")
        for name, boxes in result.items():
            print(f"  {name}: {boxes}")
    convert_manga._YOLO_MODEL = None


def dump_page_arrays(img, out_dir, stem, dims):
    """.gray (PIL convert("L"), what the detectors read) and .rgba (what a canvas gives the page)
    dumps of one page, plus its size in dims."""
    with open(os.path.join(out_dir, stem + ".gray"), "wb") as f:
        f.write(img.convert("L").tobytes())
    with open(os.path.join(out_dir, stem + ".rgba"), "wb") as f:
        f.write(img.convert("RGBA").tobytes())
    dims[stem + ".png"] = list(img.size)


def make_manga_layouts():
    """Pages for the panel layouts the gutter cuts and the 4-koma detection are about, as an EPUB
    with a table of contents so a split spread's chapter shift is compared too:

      lay01  a 4-koma page: two strips of four, rows lined up across the page
      lay02  black gutters: a black page, a wide panel over two
      lay03  a tall panel between two columns of two, under a full-width strip
      lay04  a two-page spread (landscape): two panels on the left page, four on the right
      lay05  an ordinary page after the spread, so the chapter after it moves
    """
    out = os.path.join(FIXTURES, "manga_layouts")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    rng = random.Random(7)

    def panel(draw, box, fill=(150, 150, 150)):
        x1, y1, x2, y2 = box
        draw.rectangle([x1, y1, x2 - 1, y2 - 1], fill=fill, outline=0, width=3)
        for _ in range(300):
            draw.point((rng.randint(x1 + 4, x2 - 5), rng.randint(y1 + 4, y2 - 5)), fill=rng.randint(60, 180))

    pages = {}
    img = Image.new("RGB", (800, 1200), "white")
    d = ImageDraw.Draw(img)
    for x1 in (60, 420):
        for i in range(4):
            panel(d, (x1, 60 + 275 * i, x1 + 320, 60 + 275 * i + 245))
    pages["lay01"] = img

    img = Image.new("RGB", (800, 1200), "black")
    d = ImageDraw.Draw(img)
    for box in [(40, 40, 760, 560), (40, 620, 380, 1160), (420, 620, 760, 1160)]:
        panel(d, box, fill=(170, 170, 170))
    pages["lay02"] = img

    img = Image.new("RGB", (800, 1200), "white")
    d = ImageDraw.Draw(img)
    for box in [(30, 30, 770, 400), (540, 430, 770, 800), (540, 830, 770, 1170), (300, 430, 510, 1170),
                (30, 430, 270, 800), (30, 830, 270, 1170)]:
        panel(d, box)
    pages["lay03"] = img

    img = Image.new("RGB", (1600, 1200), "white")
    d = ImageDraw.Draw(img)
    for box in [(40, 40, 760, 560), (40, 620, 760, 1160),
                (840, 40, 1180, 560), (1220, 40, 1560, 560), (840, 620, 1180, 1160), (1220, 620, 1560, 1160)]:
        panel(d, box)
    pages["lay04"] = img

    img = Image.new("RGB", (800, 1200), "white")
    d = ImageDraw.Draw(img)
    for box in [(40, 40, 760, 580), (40, 620, 760, 1160)]:
        panel(d, box)
    pages["lay05"] = img

    dims = {}
    for stem, page in pages.items():
        page.save(os.path.join(out, stem + ".png"))
        dump_page_arrays(page, out, stem, dims)
    with open(os.path.join(out, "dims.json"), "w") as f:
        json.dump(dims, f)
    path = os.path.join(FIXTURES, "manga_layouts.epub")
    write_pages_epub(path, out, "Layout Test", "Layout Author", "test-layouts",
                     [(0, "Strips", ""), (3, "Spread", ""), (4, "After", "")])
    print(f"manga layouts: {path}")


# convert_manga.py runs over manga_layouts.epub: (reference folder, extra flags). The browser
# suite converts the same EPUB with the matching settings.
LAYOUT_REFERENCES = [
    ("ref_layouts", []),
    ("ref_layouts_noyonkoma", ["--no-yonkoma-detect"]),
    ("ref_layouts_split", ["--split-spreads"]),
    ("ref_layouts_split_ltr", ["--split-spreads", "--ltr", "--trim-margins"]),
]


def run_manga_layout_references():
    script = os.path.join(FIRMWARE, "tools", "manga_convert", "convert_manga.py")
    with open(script, encoding="utf-8") as f:
        if '"--split-spreads"' not in f.read():
            print("manga layout references: SKIPPED (convert_manga.py has no --split-spreads; "
                  "point MATCHA_READER at a newer checkout)")
            return
    for name, flags in LAYOUT_REFERENCES:
        out = os.path.join(FIXTURES, name)
        shutil.rmtree(out, ignore_errors=True)
        subprocess.run([sys.executable, script,
                        "--input", os.path.join(FIXTURES, "manga_layouts.epub"),
                        "--output-dir", out,
                        "--no-ocr", *legacy_flag(script), *flags],
                       check=True, env=grid_only_env())
        print(f"manga layout reference: {out}")


class _FakeBox:
    """One detection as ultralytics hands it to convert_manga.py: .cls, .conf, .xyxy[0]."""

    def __init__(self, xyxy, conf, cls):
        import numpy as np
        self.xyxy = np.array([xyxy], dtype=np.float64)
        self.conf = conf
        self.cls = cls


class _FakeResult:
    def __init__(self, boxes):
        self.boxes = boxes


class FixedDetectionsModel:
    """Stands in for the YOLO model with fixed detections per input size: {imgsz: [[x1, y1, x2,
    y2, conf, cls], ...]} in page pixels. Lets convert_manga.py's own post-processing run on
    known boxes, so the JS port can be compared with it byte for byte."""

    def __init__(self, by_size):
        self.by_size = by_size

    def predict(self, img, conf, iou, imgsz, verbose):
        rows = self.by_size.get(imgsz, [])
        return [_FakeResult([_FakeBox(r[:4], r[4], r[5]) for r in rows if r[4] >= conf])]


def _art_page(size, boxes, mode="RGB", paper="white"):
    img = Image.new(mode, size, paper)
    d = ImageDraw.Draw(img)
    for b in boxes:
        d.rectangle([b[0], b[1], b[2] - 1, b[3] - 1], fill="black")
    return img


def _text_page(size):
    """A prose page: lines of small dark marks, which no gutter grid should cut into panels."""
    img = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(img)
    rng = random.Random(3)
    for y in range(80, size[1] - 80, 36):
        x = 60
        while x < size[0] - 80:
            w = rng.randint(8, 40)
            d.rectangle([x, y, x + w, y + 14], fill=40)
            x += w + rng.randint(6, 14)
    return img


def run_pil_box_reference():
    """Pillow's Image.resize(..., Image.BOX) on random 8-bit images (pil_box/), which
    convert_manga.py's ink grid is built on. js/manga-core.js:pilResizeBox must match it exactly,
    including the pass order Pillow 13 picks (vertical first for a page shrinking mostly in
    height)."""
    out = os.path.join(FIXTURES, "pil_box")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    rng = random.Random(5)
    cases = []
    for i in range(24):
        w, h = rng.randint(5, 600), rng.randint(5, 600)
        ow, oh = rng.randint(1, w), rng.randint(1, h)
        if i % 3 == 0:  # binary, as the ink grid feeds it
            data = bytes(255 if rng.random() < 0.3 else 0 for _ in range(w * h))
        else:
            data = bytes(rng.randint(0, 255) for _ in range(w * h))
        img = Image.frombytes("L", (w, h), data)
        with open(os.path.join(out, f"c{i:02d}.in"), "wb") as f:
            f.write(data)
        with open(os.path.join(out, f"c{i:02d}.out"), "wb") as f:
            f.write(img.resize((ow, oh), Image.BOX).tobytes())
        cases.append([w, h, ow, oh])
    with open(os.path.join(out, "cases.json"), "w") as f:
        json.dump({"pillow": Image.__version__ if hasattr(Image, "__version__") else "", "cases": cases}, f)
    print(f"pillow BOX resize reference: {out}")


def yolo_post_cases():
    """(name, full-resolution page, stored page or None, detections by input size, rtl)."""
    W, H = 760, 1200
    cases = []
    kept, missed = [40, 40, 720, 500], [40, 560, 720, 1160]
    page = _art_page((W, H), [kept, missed])
    cases.append(("weak proposal fills the gap", page, None,
                  {640: [kept + [0.9, 0], [30, 550, 730, 1170, 0.3, 0]]}, True))
    cases.append(("uncovered ink becomes a panel", page, None, {640: [kept + [0.9, 0]]}, True))
    kept2 = [40, 40, 720, 1100]
    cases.append(("page number and bleed are not panels",
                  _art_page((W, H), [kept2, [360, 1150, 400, 1180], [0, 1110, 760, 1150]]), None,
                  {640: [kept2 + [0.9, 0]]}, True))
    art, blank, strip = [40, 40, 720, 600], [40, 640, 720, 900], [500, 1120, 760, 1200]
    bubble = [40, 920, 400, 1100]
    cases.append(("blank and edge panels dropped, a text panel kept",
                  _art_page((W, H), [art, [700, 1150, 730, 1180]]), None,
                  {640: [art + [0.9, 0], blank + [0.8, 0], strip + [0.7, 0], bubble + [0.6, 0],
                         [100, 960, 300, 1060, 0.8, 1]]}, True))
    quads = [[40, 40, 360, 580], [400, 40, 720, 580], [40, 620, 360, 1160], [400, 620, 720, 1160]]
    cases.append(("one page-sized frame gives way to the grid", _art_page((W, H), quads), None,
                  {640: [[0, 0, W, H, 0.9, 0]]}, True))
    cases.append(("a prose page keeps its one frame", _text_page((W, H)), None,
                  {640: [[0, 0, W, H, 0.9, 0]]}, True))
    rows = [[40, 40 + 280 * i, 720, 40 + 280 * i + 250] for i in range(4)]
    cases.append(("retry at the larger size wins", _art_page((W, H), rows), None,
                  {640: [rows[0] + [0.9, 0]], 1600: [r + [0.8, 0] for r in rows]}, True))
    cases.append(("a failed retry keeps the first pass", _art_page((W, H), rows), None,
                  {640: [rows[0] + [0.9, 0]], 1600: [rows[1][:2] + [300, rows[1][3]] + [0.8, 0]]}, True))
    cases.append(("nothing detected", _art_page((W, H), quads), None, {640: []}, True))
    cases.append(("slivers, duplicates and sub-panels",
                  _art_page((W, H), rows), None,
                  {640: [[40, 40, 720, 570, 0.9, 0], [40, 40, 720, 290, 0.3, 0], [40, 320, 720, 570, 0.25, 0],
                         [45, 45, 715, 565, 0.6, 0], [0, 600, 760, 640, 0.95, 0],
                         rows[2] + [0.8, 0], rows[3] + [0.7, 0], [60, 900, 300, 980, 0.9, 1]]}, True))
    # 4-koma: two strips of four with one panel cut in two by the detector.
    right = [[420, 170 + 235 * i, 710, 390 + 235 * i] for i in range(4)]
    left = [[100, 170 + 235 * i, 390, 390 + 235 * i] for i in range(4)]
    cut = [[100, left[2][1], 240, left[2][3]], [200, left[2][1], 390, left[2][3]]]
    strips = right + left[:2] + cut + left[3:]
    for rtl in (True, False):
        cases.append((f"4-koma strips, a cut panel merged ({'rtl' if rtl else 'ltr'})",
                      _art_page((W, H), right + left), None,
                      {640: [b + [0.9 - 0.01 * i, 0] for i, b in enumerate(strips)]}, rtl))
    # A page over twice as tall as it is wide, with art inked near the ink grid's threshold: Pillow
    # resizes such a page vertically first, and the rounding between its two passes decides cells.
    tall = Image.new("L", (500, 1200), 255)
    rng = random.Random(11)
    px = tall.load()
    for y in range(560, 1160):
        for x in range(30, 470):
            if rng.random() < 0.05:
                px[x, y] = rng.randint(0, 199)
    ImageDraw.Draw(tall).rectangle([30, 30, 469, 519], fill=0)
    cases.append(("sparse art on a tall page", tall, None, {640: [[30, 30, 470, 520, 0.9, 0]]}, True))
    # Detection at full resolution, panels stored at a quarter of the pixels.
    full = _art_page((1520, 2400), [[80, 80, 1440, 1160], [80, 1240, 700, 2320], [780, 1240, 1440, 2320]])
    stored = full.resize((760, 1200), Image.LANCZOS)
    cases.append(("full-resolution boxes scaled to the stored page", full, stored,
                  {640: [[80, 80, 1440, 1160, 0.9, 0], [80, 1240, 700, 2320, 0.9, 0], [780, 1240, 1440, 2320, 0.8, 0],
                         [300, 60, 700, 200, 0.7, 1]]}, True))
    full2 = _art_page((1520, 2400), [[80, 80, 700, 1160], [780, 80, 1440, 1160], [80, 1240, 1440, 2320]])
    cases.append(("a page-sized frame at full resolution, the grid on the stored page", full2,
                  full2.resize((760, 1200), Image.LANCZOS), {640: [[0, 0, 1520, 2400, 0.9, 0]]}, True))
    return cases


def run_yolo_post_reference():
    """convert_manga.py's YOLO post-processing on fixed detections (yolo_post/): retry,
    fill_uncovered_art, drop_blank_panels, scale_panel_boxes, the grid fallback, the 4-koma order
    and the bubble-aware crops, all from the firmware tool's own functions. No model is involved,
    so unlike ref_yolo the JS comparison is exact."""
    try:
        import numpy  # noqa: F401  (the fake boxes are numpy arrays, as ultralytics' are)
    except ImportError as e:
        print(f"yolo post-processing reference: SKIPPED ({e}; pip install numpy)")
        return
    sys.path.insert(0, os.path.join(FIRMWARE, "tools", "manga_convert"))
    import convert_manga
    if not hasattr(convert_manga, "fill_uncovered_art"):
        print("yolo post-processing reference: SKIPPED (convert_manga.py predates fill_uncovered_art)")
        return

    out = os.path.join(FIXTURES, "yolo_post")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    result = []
    for i, (name, full, stored, by_size, rtl) in enumerate(yolo_post_cases()):
        page = stored or full
        convert_manga._YOLO_MODEL = FixedDetectionsModel(by_size)
        frames, texts = convert_manga.detect_panels(full, page)
        if not frames:
            frames = [[0, 0, page.width, page.height]]
        ordered = convert_manga.yonkoma_reading_order(frames, page.width, rtl=rtl)
        if ordered is None:
            ordered = convert_manga.sort_panels_reading_order(frames, rtl=rtl)
        boxes = convert_manga.expand_panels_over_text(ordered, texts, page.width, page.height)
        dims = {}
        dump_page_arrays(full, out, f"case{i:02d}_full", dims)
        if stored is not None:
            dump_page_arrays(stored, out, f"case{i:02d}_page", dims)
        result.append({
            "name": name, "rtl": rtl,
            "full": dims[f"case{i:02d}_full.png"], "page": list(page.size),
            "stored": stored is not None,
            "detections": {str(k): v for k, v in by_size.items()},
            "frames": [list(map(int, b)) for b in frames], "texts": [list(map(int, b)) for b in texts],
            "boxes": [list(map(int, b)) for b in boxes],
        })
    convert_manga._YOLO_MODEL = None
    with open(os.path.join(out, "cases.json"), "w") as f:
        json.dump(result, f, indent=1)
    print(f"yolo post-processing reference: {out} ({len(result)} cases)")


def make_manga_pdf():
    """Multi-page PDF of the synthetic pages with Title/Author metadata,
    for the PDF-input end-to-end test."""
    path = os.path.join(FIXTURES, "manga.pdf")
    pages_dir = os.path.join(FIXTURES, "manga_pages")
    imgs = [Image.open(os.path.join(pages_dir, n)).convert("RGB")
            for n in sorted(os.listdir(pages_dir)) if n.endswith(".png")]
    # The PDF writer embeds pages as JPEG but does not register that encoder itself; on
    # Pillow 12 a save before anything else loaded it fails with KeyError('JPEG').
    Image.init()
    imgs[0].save(path, save_all=True, append_images=imgs[1:],
                 title="Pdf Test Manga", author="Pdf Author")
    print(f"manga pdf: {path}")


def run_manga_pdf_reference():
    """convert_manga.py output for the PDF fixture (grid detection).

    Needs PyMuPDF, the desktop tool's own PDF dependency; skipped without it.
    Rasterization differs slightly between PyMuPDF and PDF.js (JPEG decoders,
    resamplers), so the JS comparison of panel boxes is tolerance-based —
    only meta.bin (PDF Title/Author metadata) is compared byte-exactly.
    """
    try:
        import fitz  # noqa: F401
    except ImportError as e:
        print(f"manga pdf reference: SKIPPED ({e}; pip install pymupdf)")
        return
    out = os.path.join(FIXTURES, "ref_manga_pdf")
    shutil.rmtree(out, ignore_errors=True)
    script = os.path.join(FIRMWARE, "tools", "manga_convert", "convert_manga.py")
    subprocess.run([sys.executable, script,
                    "--input", os.path.join(FIXTURES, "manga.pdf"),
                    "--output-dir", out,
                    "--no-ocr", *legacy_flag(script)],
                   check=True, env=grid_only_env())
    print(f"manga pdf reference: {out}")


def make_yomitan_zip():
    """Synthetic Yomitan dictionary exercising structured content, redirects,
    readings, list definitions, and priority scores."""
    path = os.path.join(FIXTURES, "yomitan.zip")
    bank1 = [
        # plain string definition
        ["猫", "ねこ", "", "", 5, ["cat; kitty"], 1, ""],
        # structured content with sense groups / tags / examples
        ["食べる", "たべる", "v1", "", 10, [{
            "type": "structured-content",
            "content": [
                {"tag": "span", "data": {"class": "tag", "content": "part-of-speech-info"}, "content": "Ichidan verb"},
                {"tag": "ul", "data": {"content": "glossary"}, "content": [
                    {"tag": "li", "content": "to eat"},
                    {"tag": "li", "content": "to live on (e.g. a salary)"},
                ]},
                {"tag": "div", "data": {"content": "extra-info"}, "content":
                    {"tag": "div", "data": {"content": "example-sentence"}, "class": "extra-box", "content": [
                        {"tag": "div", "data": {"content": "example-sentence-a"}, "content": "ご飯を食べる"},
                        {"tag": "div", "data": {"content": "example-sentence-b"}, "content": "to eat a meal"},
                    ]},
                },
            ],
        }], 2, ""],
        # kana-only entry (reading == headword)
        ["それ", "それ", "", "", 3, ["that; that one"], 3, ""],
        # multiple definitions → numbered
        ["走る", "はしる", "v5r", "", -2, ["to run", "to dash"], 4, ""],
    ]
    bank2 = [
        # redirect entry pointing at 食べる
        ["食べれる", "たべれる", "", "", 1, [{
            "type": "structured-content",
            "content": {"tag": "div", "data": {"content": "redirect-glossary"},
                        "content": "⟶食べる"},
        }], 5, ""],
        # dangling redirect (target missing) — must be skipped
        ["消える語", "きえるご", "", "", 1, [{
            "type": "structured-content",
            "content": {"tag": "div", "data": {"content": "redirect-glossary"},
                        "content": "⟶存在しない"},
        }], 6, ""],
        # list-form definition
        ["引っ張る", "ひっぱる", "", "", 0, [["to pull", ["redirected from 引っぱる"]]], 7, ""],
    ]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("index.json", json.dumps({"title": "Test Dict", "format": 3}))
        z.writestr("term_bank_1.json", json.dumps(bank1, ensure_ascii=False))
        z.writestr("term_bank_2.json", json.dumps(bank2, ensure_ascii=False))
    print(f"yomitan zip: {path}")


def _sc(content):
    return {"type": "structured-content", "content": content}


def make_yomitan_markup_zip():
    """Synthetic Yomitan dictionary for the text cleanup convert_jmdict.py applies to every
    dictionary: HTML left in strings, lists, tables, badges, label icons, web links, headword
    echoes, Pixiv's related lists, and the 大辞林 data.name layout."""
    path = os.path.join(FIXTURES, "yomitan_markup.zip")
    related = "・".join(f"記事{i}" for i in range(15))
    bank = [
        # HTML and placeholders inside plain strings, several lines so they stay one sense each
        ["愛", "あい", "", "", 3, [
            "<ruby>愛<rt>あい</rt></ruby>する<br>心。<b>強く</b>{{w_12}}思う\n<span class=\"x\">深い</span><unencoded>",
            "【衬衫】 【襯衫】 [3304] shirt/blouse\n【愛】 【爱】 (愛,爱)",
            "・違い• 「猫に小判」と同じ\n[名]\n\n• いつくしむ\n〔特殊語百科辞典｛１９３１｝〕",
            "┏[変] ►参照 ━を込める\n一[2]\n❶ 一つ目 ➁ 二つ目\n📚使い方\n見る😀\nadsbygoogle push\n"
            "example.com/page\nこれは{{rfdef}}模板。\n{百均（ひゃっきん）:81491}\n莫連{ばくれん}",
            "関連記事: " + related + "\n子記事: 短い・リスト",
        ], 1, ""],
        # monolingual headword echo that says nothing more: dropped
        ["犬", "いぬ", "", "", 2, ["いぬ〖犬〗\n四足の動物。"], 2, ""],
        # echo with more spellings and a tail: kept as spellings only
        ["狗", "いぬ", "", "", 2, ["いぬ〖犬・狗〗 ［名］\n獣。"], 3, ""],
        # plain one-line glosses: one sense, duplicates dropped
        ["仲", "なか", "", "", 1, ["friendship", "relations", "friendship"], 4, ""],
        # a symbol-only line, and headings joined to their text
        ["馬", "うま", "", "", 0, [_sc([
            {"tag": "div", "content": "大きな動物"},
            {"tag": "div", "content": "◇"},
            {"tag": "div", "data": {"class": "related-tags-header"}, "content": "関連記事"},
            {"tag": "div", "content": "競馬・騎手"},
            {"tag": "div", "data": {"class": "related-tags-header"}, "content": "• 子記事"},
            {"tag": "div", "content": "• 一頭目"},
            {"tag": "div", "content": "⋯⋯動物 ＞ 哺乳類"},
            {"tag": "div", "data": {"class": "nav-header"}, "content": "ナビ"},
        ])], 5, ""],
        # lists: glosses, a Japanese list, nested li arrays, example list, unmarked item, pairs
        ["駅", "えき", "", "", 0, [_sc([
            {"tag": "ul", "content": [{"tag": "li", "content": "station"}, {"tag": "li", "content": "stop"}]},
            {"tag": "ul", "content": [
                {"tag": "li", "content": "駅 ▽最寄りの駅"},
                {"tag": "li", "content": [{"tag": "a", "href": "https://example.com", "content": "link"}]},
                {"tag": "li", "style": {"listStyleType": "none"}, "content": "停車場"},
                "地の文",
            ]},
            {"tag": "ol", "content": [[{"tag": "li", "content": "一つ目の駅"}], [{"tag": "li", "content": "二つ目の駅"}]]},
            {"tag": "ul", "data": {"class": "examples"}, "content": [{"tag": "li", "content": "駅に着く"}]},
            {"tag": "ul", "content": [{"tag": "li", "content": "駅がある"}, {"tag": "li", "content": "There is a station."}]},
        ])], 6, ""],
        # tables, a badge, a details summary, images
        ["表", "ひょう", "", "", 0, [_sc([
            {"tag": "span", "style": {"borderStyle": "solid"}, "content": "Definitions"},
            {"tag": "div", "content": "a chart"},
            {"tag": "summary", "content": "show 5 examples"},
            {"tag": "table", "content": [
                {"tag": "tr", "content": [{"tag": "th", "content": "現在"}, {"tag": "th", "content": "過去"}]},
                {"tag": "tr", "content": [{"tag": "th", "content": "肯定"}, {"tag": "td", "content": "書く"},
                                         {"tag": "td", "content": "書いた"}]},
            ]},
            {"tag": "div", "content": [
                {"tag": "img", "path": "img/名-rect.svg"}, {"tag": "img", "path": "img/red_（.svg"},
                {"tag": "img", "path": "img/１-fill.svg"}, {"tag": "img", "path": "img/文法説明ラベル長い-red.svg"},
                {"type": "image", "path": "gaiji/B92D.png"}, {"type": "image", "path": "gaiji/bs一.svg"},
                {"type": "image", "path": "accent/a1.svg"}, {"type": "image", "path": "photo/cat.jpg", "alt": "a cat"},
                {"type": "image", "path": "x/y.svg", "alt": "代替"},
                {"type": "image", "path": "gaiji/k.svg", "alt": "3分の2", "data": {"class": "gaiji"}},
                {"type": "image", "path": "noext", "title": "題"},
            ]},
        ])], 7, ""],
        # 大辞林 data.name layout: senses, part-of-speech and gloss parts
        ["見る", "みる", "v1", "", 0, [_sc([
            {"tag": "div", "data": {"name": "見出部"}, "content": "みる【見る】"},
            {"tag": "div", "data": {"name": "品詞G"}, "content": "（動）"},
            {"tag": "div", "data": {"name": "語義G"}, "content": [
                {"tag": "span", "data": {"name": "語義Gnum"}, "content": "①"},
                {"tag": "div", "data": {"name": "語義"}, "content": ["㋐", {"tag": "span", "data": {"name": "語釈"}, "content": "目で知る。"}]},
            ]},
            {"tag": "div", "data": {"name": "語義G"}, "content": [
                {"tag": "span", "data": {"name": "語釈"}, "content": "調べる。"},
                {"tag": "span", "data": {"name": "見出相当部"}, "content": "━てみる"},
            ]},
        ])], 8, ""],
        # Pixiv: the headword glued in front of the reading
        ["学校", "学校がっこう", "", "", 0, ["学ぶ所"], 9, ""],
        # a definition of only separators left by dropped links: no entry
        ["空", "そら", "", "", 0, [_sc([{"tag": "a", "href": "https://x.example", "content": "x"}, " | "])], 10, ""],
        # a lone surrogate from a JSON escape is dropped from the bytes. Kana only: the Python
        # tool's reading records still encode strictly and stop on one.
        ["ひとり", "ひとり", "", "", 0, ["ひとり\ud800ぼっち"], 11, ""],
        # a picture-only sense stays unnumbered
        ["絵", "え", "", "", 0, ["picture", _sc({"type": "image", "path": "p/a.png"}), "drawing"], 12, ""],
    ]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("index.json", json.dumps({"title": "Markup Dictionary Test (markup.example.com)", "format": 3}))
        # ASCII escapes, so the lone surrogate reaches the converters as JSON writes it.
        z.writestr("term_bank_1.json", json.dumps(bank))
    print(f"yomitan markup zip: {path}")


def make_yomitan_kanji_zips():
    """A Yomitan kanji dictionary (kanji_bank rows, KANJIDIC and Wiktionary styles) and one keyed
    by single characters in term banks, for the kanji slot."""
    kanji = [
        ["学", "ガク", "まな.ぶ", "jouyou", ["study", "learning", "science"],
         {"strokes": "8", "grade": "1", "jlpt": "4", "freq": "63", "skip": "2-3-5"}],
        ["学", "", "", "", ["school"], {}],
        ["語", "ゴ", "かた.る かた.らう", "", [
            "＝＝＝日語＝＝＝", "ーーー讀音ーーー", "音読み: ゴ", "ーーー字源ーーー", "＝＝＝漢語＝＝＝",
            "ーーー詞源1ーーー", "ーーー組詞ーーー", "語言", "語法", "語氣", "衍生字", "𧦝, 語",
            "漢字分解:", "言 + 吾", "語", "http://example.com/語", "見：附录:漢字",
        ], {"部首": "言", "総画": 14}],
        ["旧", "キュウ", "ふる.い", "", ["旧字体", "舊は旧の旧字体である。", "", "俗字", "旧の俗字として使われる。"], {}],
        ["空", "", "", "", ["空"], {}],
    ]
    path = os.path.join(FIXTURES, "yomitan_kanji.zip")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("index.json", json.dumps({"title": "Kanji Test", "format": 3}))
        z.writestr("kanji_bank_1.json", json.dumps(kanji, ensure_ascii=False))
    terms = [
        ["水", "すい", "", "", 0, ["water", "<b>liquid</b>"], 1, ""],
        ["水道", "すいどう", "", "", 0, ["water supply"], 2, ""],
        ["a", "a", "", "", 0, ["not han"], 3, ""],
    ]
    path2 = os.path.join(FIXTURES, "yomitan_kanji_terms.zip")
    with zipfile.ZipFile(path2, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("index.json", json.dumps({"title": "Term Kanji", "format": 3}))
        z.writestr("term_bank_1.json", json.dumps(terms, ensure_ascii=False))
    print(f"yomitan kanji zips: {path}, {path2}")


def make_pitch_zips():
    """Two Yomitan pitch dictionaries; the second is the fallback."""
    first = [
        ["猫", "pitch", {"reading": "ねこ", "pitches": [{"position": 1}]}],
        ["食べる", "pitch", {"reading": "たべる", "pitches": [{"position": 2}, {"position": 0}]}],
        ["それ", "pitch", {"reading": "それ", "pitches": [{"position": 0}]}],
        ["犬", "freq", 5],
    ]
    second = [
        ["猫", "pitch", {"reading": "ねこ", "pitches": [{"position": 0}]}],
        ["走る", "pitch", {"reading": "はしる", "pitches": [{"position": 2}]}],
        ["駅", "pitch", {"reading": "えき", "pitches": [{"position": 1}]}],
    ]
    for name, rows in (("pitch1.zip", first), ("pitch2.zip", second)):
        with zipfile.ZipFile(os.path.join(FIXTURES, name), "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("index.json", json.dumps({"title": name, "format": 3}))
            z.writestr("term_meta_bank_1.json", json.dumps(rows, ensure_ascii=False))
    print("pitch zips: pitch1.zip, pitch2.zip")


def make_furigana_json():
    """JmdictFurigana entries for words in jmdict.json and yomitan.zip."""
    rows = [
        {"text": "犬", "reading": "いぬ", "furigana": [{"ruby": "犬", "rt": "いぬ"}]},
        {"text": "山", "reading": "やま", "furigana": [{"ruby": "山", "rt": "やま"}]},
        {"text": "峰", "reading": "やま", "furigana": [{"ruby": "峰"}]},  # no rt: skipped
        {"text": "食べる", "reading": "たべる", "furigana": [{"ruby": "食", "rt": "た"}, {"ruby": "べる"}]},
        {"text": "木漏れ日", "reading": "こもれび", "furigana": [
            {"ruby": "木", "rt": "こ"}, {"ruby": "漏", "rt": "も"}, {"ruby": "れ"}, {"ruby": "日", "rt": "び"}]},
    ]
    with open(os.path.join(FIXTURES, "furigana.json"), "w", encoding="utf-8-sig") as f:
        json.dump(rows, f, ensure_ascii=False)
    print("furigana json: furigana.json")


def make_yomitan_images_zip():
    """A Yomitan dictionary with pictures, for --images: a large one the converter shrinks, a
    small one it keeps, a PNG drawing, a PNG gaiji glyph (too small: no picture), a missing file."""
    def bmp(size, color):
        out = io.BytesIO()
        Image.new("RGB", size, color).save(out, "BMP")
        return out.getvalue()

    def png(size):
        out = io.BytesIO()
        img = Image.new("RGBA", size, (0, 0, 0, 0))
        ImageDraw.Draw(img).ellipse((2, 2, size[0] - 3, size[1] - 3), fill=(40, 40, 40, 255))
        img.save(out, "PNG")
        return out.getvalue()

    bank = [
        ["猫", "ねこ", "", "", 0, ["a cat", _sc({"tag": "img", "path": "img/cat.bmp", "alt": "credit"}),
                                  "a small cat"], 1, ""],
        ["犬", "いぬ", "", "", 0, [_sc(["a dog", {"type": "image", "path": "img/dog.bmp"}])], 2, ""],
        ["絵", "え", "", "", 0, [_sc([{"type": "image", "path": "img/drawing.png"}, "a drawing"])], 3, ""],
        ["字", "じ", "", "", 0, [_sc(["a mark ", {"type": "image", "path": "gaiji/B92D.png"}])], 4, ""],
        ["無", "む", "", "", 0, [_sc(["gone", {"type": "image", "path": "img/missing.jpg"}])], 5, ""],
        ["猫2", "ねこ", "", "", 0, [_sc({"type": "image", "path": "img/cat.bmp"})], 6, ""],
    ]
    path = os.path.join(FIXTURES, "yomitan_images.zip")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("index.json", json.dumps({"title": "Picture Dict", "format": 3}))
        z.writestr("term_bank_1.json", json.dumps(bank, ensure_ascii=False))
        z.writestr("img/cat.bmp", bmp((801, 333), (200, 120, 40)))
        z.writestr("img/dog.bmp", bmp((100, 60), (90, 90, 90)))
        z.writestr("img/drawing.png", png((120, 150)))
        z.writestr("gaiji/B92D.png", png((24, 24)))
    print(f"yomitan images zip: {path}")


def make_korean_zip():
    """A KRDICT-style Yomitan dictionary: tags with part of speech and level, homographs, a
    headword line with level stars, and ASCII headwords for the StarDict sort."""
    bank = [
        ["먹다", "먹따", "동사 초급", "", 5, ["★★★ 먹다\n음식을 입으로 넣다."], 1, ""],
        ["먹다", "먹따", "동사", "", 2, ["귀가 들리지 않게 되다."], 2, ""],
        ["사과", "", "명사 초급", "", 3, ["과일의 하나."], 3, ""],
        ["Apple", "", "", "", 0, ["회사 이름."], 4, ""],
        ["abc", "", "명사", "", 0, ["알파벳."], 5, ""],
        ["안녕", "", "감탄사", "", 1, [_sc({"tag": "ul", "content": [{"tag": "li", "content": "hello"}]})], 6, ""],
    ]
    path = os.path.join(FIXTURES, "korean.zip")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("index.json", json.dumps({"title": "Korean Test", "format": 3}))
        z.writestr("term_bank_1.json", json.dumps(bank, ensure_ascii=False))
    print(f"korean zip: {path}")


def make_jmdict_json():
    path = os.path.join(FIXTURES, "jmdict.json")
    data = {"words": [
        {"kanji": [{"text": "犬", "common": True}],
         "kana": [{"text": "いぬ", "common": True}],
         "sense": [{"gloss": [{"text": "dog"}]}]},
        {"kanji": [{"text": "山", "common": False}, {"text": "峰", "common": False}],
         "kana": [{"text": "やま", "common": False}],
         "sense": [{"gloss": [{"text": "mountain"}, {"text": "hill"}]},
                   {"gloss": [{"text": "heap"}, {"text": "pile"}]}]},
        {"kanji": [],
         "kana": [{"text": "とても", "common": True}],
         "sense": [{"gloss": [{"text": "very"}, {"text": "awfully"}, {"text": "exceedingly"},
                              {"text": "extremely"}, {"text": "dropped-5th"}]}]},
    ]}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"jmdict json: {path}")


def make_mdx_fixtures():
    """Synthetic MDict .mdx fixtures written by a minimal engine-2.0 writer:
    dict.mdx (zlib + one uncompressed record block), dict_enc.mdx
    (Encrypted=2 key index), dict_lzo.mdx (LZO blocks), dict_reg.mdx
    (Encrypted=1, regcode 000102…0f registered to test@example.com).
    Entries exercise
    HTML stripping, entities, <br>, @@@LINK redirects, whitespace-only
    definitions, and over-32-byte headwords. Readable by readmdict, so the
    reference conversion exercises an implementation independent of js/mdx.js.

    Needs readmdict (which itself needs python-lzo); skipped without it.
    """
    import zlib as z
    from struct import pack
    try:
        import lzo
        from readmdict.ripemd128 import ripemd128
        from readmdict.pureSalsa20 import Salsa20
    except ImportError as e:
        print(f"mdx fixtures: SKIPPED ({e}; pip install readmdict python-lzo)")
        return False

    entries = sorted([
        ("猫", '<div class="entry"><b>ねこ</b><br/>cat; kitty &amp; friend</div>'),
        ("犬", "plain dog definition"),
        ("食べる", "<ul><li>to eat</li><li>to &lt;consume&gt;</li></ul>"),
        ("たべれる", "@@@LINK=食べる"),                    # redirect → skipped
        ("空白", "   "),                                    # empty after strip → skipped
        ("この見出し語はとても長いので三十二バイトを超えます", "too-long headword"),  # ≥32 bytes → skipped
        ("走る", "to run<br>to dash&nbsp;quickly"),
        ("nbsp&#x27;quote", "it&#39;s an &quot;entity&quot; test"),
    ])

    def compress(data, comp):
        if comp == 0:
            payload = data
        elif comp == 1:
            payload = lzo.compress(data)[5:]  # strip python-lzo's 0xf0 + u32 length header
        else:
            payload = z.compress(data)
        return pack("<I", comp) + pack(">I", z.adler32(data) & 0xffffffff) + payload

    def fast_encrypt(data, key):
        # Inverse of readmdict._fast_decrypt (nibble swap is self-inverse).
        b = bytearray(data)
        prev = 0x36
        for i in range(len(b)):
            t = (b[i] ^ prev ^ (i & 0xff) ^ key[i % len(key)]) & 0xff
            b[i] = ((t >> 4) | (t << 4)) & 0xff
            prev = b[i]
        return bytes(b)

    def build(path, comp, encrypted, regcode=None, userid=None):
        recs = [(k.encode(), v.encode() + b"\x00") for k, v in entries]
        offsets, off = [], 0
        for _, v in recs:
            offsets.append(off)
            off += len(v)
        half = len(recs) // 2
        groups = [list(range(half)), list(range(half, len(recs)))]

        key_blocks, info_items = [], []
        for g in groups:
            kb = b"".join(pack(">Q", offsets[i]) + recs[i][0] + b"\x00" for i in g)
            cb = compress(kb, comp)
            key_blocks.append(cb)
            info_items.append((len(g), recs[g[0]][0], recs[g[-1]][0], len(cb), len(kb)))

        key_info = b""
        for count, first, last, csize, dsize in info_items:
            key_info += pack(">Q", count)
            key_info += pack(">H", len(first)) + first + b"\x00"
            key_info += pack(">H", len(last)) + last + b"\x00"
            key_info += pack(">Q", csize) + pack(">Q", dsize)
        key_info_block = compress(key_info, 2)  # v2 key index is always zlib
        if encrypted & 2:
            key = ripemd128(key_info_block[4:8] + pack("<L", 0x3695))
            key_info_block = key_info_block[:8] + fast_encrypt(key_info_block[8:], key)

        kw = pack(">QQQQQ", len(groups), len(recs), len(key_info),
                  len(key_info_block), sum(len(b) for b in key_blocks))
        kw_adler = pack(">I", z.adler32(kw) & 0xffffffff)  # of the plaintext numbers
        if encrypted & 1:
            digest = ripemd128(userid.encode("utf-16-le"))  # RegisterBy=EMail
            encrypt_key = Salsa20(key=digest, IV=b"\x00" * 8, rounds=8).encryptBytes(regcode)
            kw = Salsa20(key=encrypt_key, IV=b"\x00" * 8, rounds=8).encryptBytes(kw)
        kw += kw_adler

        # dict.mdx keeps its second record block uncompressed for type-0 coverage.
        rec_data = [b"".join(recs[i][1] for i in g) for g in groups]
        rec_comp = [comp, 0 if (comp == 2 and not encrypted) else comp]
        rec_blocks = [compress(d, c) for d, c in zip(rec_data, rec_comp)]
        rec_hdr = pack(">QQQQ", len(rec_blocks), len(recs), 16 * len(rec_blocks),
                       sum(len(b) for b in rec_blocks))
        rec_info = b"".join(pack(">QQ", len(cb), len(d)) for cb, d in zip(rec_blocks, rec_data))

        register = ' RegisterBy="EMail"' if encrypted & 1 else ""
        attrs = (f'<Dictionary GeneratedByEngineVersion="2.0" RequiredEngineVersion="2.0" '
                 f'Format="Html" KeyCaseSensitive="No" Encrypted="{encrypted}"{register} '
                 f'Encoding="UTF-8" Title="Test MDX &amp; fixture" CreationDate="2026-01-01"/>')
        hb = attrs.encode("utf-16") + b"\x00\x00"
        blob = pack(">I", len(hb)) + hb + pack("<I", z.adler32(hb) & 0xffffffff)
        blob += kw + key_info_block + b"".join(key_blocks)
        blob += rec_hdr + rec_info + b"".join(rec_blocks)
        with open(path, "wb") as f:
            f.write(blob)
        print(f"mdx fixture: {path}")

    build(os.path.join(FIXTURES, "dict.mdx"), comp=2, encrypted=0)
    build(os.path.join(FIXTURES, "dict_enc.mdx"), comp=2, encrypted=2)
    build(os.path.join(FIXTURES, "dict_lzo.mdx"), comp=1, encrypted=0)
    # Registration-encrypted variant; passcode shared with the JS tests.
    build(os.path.join(FIXTURES, "dict_reg.mdx"), comp=2, encrypted=1,
          regcode=bytes(range(16)), userid="test@example.com")
    return True


def run_mdx_reference():
    """convert_jmdict.py + gen_dict_spx.py on the plain MDX fixture."""
    script = os.path.join(FIRMWARE, "tools", "dict_convert", "convert_jmdict.py")
    spx_script = os.path.join(FIRMWARE, "scripts", "gen_dict_spx.py")
    out = os.path.join(FIXTURES, "ref_dict_mdx")
    shutil.rmtree(out, ignore_errors=True)
    subprocess.run([sys.executable, script, "--input", os.path.join(FIXTURES, "dict.mdx"),
                    "--output-dir", out], check=True)
    subprocess.run([sys.executable, spx_script, out], check=True)
    print(f"mdx reference: {out}")


def run_font_reference():
    """Reference .cpfont from the firmware's own converter, for the fonts.html
    end-to-end test. Skipped when the font or the converter's deps are missing --
    freetype-py and fontTools are not needed by anything else here.

    Must match what test/browser/e2e.mjs asks the page for: DejaVuSans at 14pt,
    latin-ext, regular.
    """
    out = os.path.join(FIXTURES, "ref_font")
    script = os.path.join(FIRMWARE, "lib", "EpdFont", "scripts", "fontconvert_sdcard.py")
    font = os.environ.get("TEST_FONT", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    if not os.path.exists(script) or not os.path.exists(font):
        print("font reference: SKIPPED (need the firmware's fontconvert_sdcard.py and DejaVuSans.ttf)")
        return
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out, exist_ok=True)
    try:
        subprocess.run([sys.executable, script,
                        "--intervals", "latin-ext", "--size", "14", "--style", "regular",
                        font, "-o", os.path.join(out, "DejaVuSans_14.cpfont")],
                       check=True, cwd=os.path.dirname(script))
    except subprocess.CalledProcessError:
        shutil.rmtree(out, ignore_errors=True)
        print("font reference: SKIPPED (converter failed; pip install freetype-py fonttools)")
        return
    print(f"font reference: {out}")


def run_dict_references():
    script = os.path.join(FIRMWARE, "tools", "dict_convert", "convert_jmdict.py")
    spx_script = os.path.join(FIRMWARE, "scripts", "gen_dict_spx.py")

    f = lambda name: os.path.join(FIXTURES, name)
    for name, args in [("ref_dict_yomitan", ["--input", f("yomitan.zip")]),
                       ("ref_dict_jmdict", ["--input", f("jmdict.json")]),
                       ("ref_dict_yomitan_markup", ["--input", f("yomitan_markup.zip")]),
                       # merged inputs: source lines, joined title, pitch with a fallback
                       ("ref_dict_ja_merged", ["--input", f("yomitan.zip"), "--input", f("yomitan_markup.zip"),
                                               "--input", f("jmdict.json"), "--pitch", f("pitch1.zip"),
                                               "--pitch", f("pitch2.zip")]),
                       ("ref_dict_kanji", ["--name", "kanji", "--input", f("yomitan_kanji.zip"),
                                           "--input", f("yomitan_kanji_terms.zip")]),
                       ("ref_dict_hanzi", ["--lang", "zh", "--name", "hanzi", "--input", f("yomitan_kanji.zip")]),
                       ("ref_dict_furigana", ["--input", f("yomitan.zip"), "--input", f("jmdict.json"),
                                              "--furigana", f("furigana.json")]),
                       ("ref_dict_images", ["--images", "--input", f("yomitan_images.zip")])]:
        out = os.path.join(FIXTURES, name)
        shutil.rmtree(out, ignore_errors=True)
        subprocess.run([sys.executable, script, *args, "--output-dir", out], check=True)
        subprocess.run([sys.executable, spx_script, out], check=True)
        print(f"dict reference: {out}")

    # Korean: a StarDict dictionary named after its folder, /dictionaries/ko/kotest/kotest.ifo.
    out = f("ref_dict_ko")
    shutil.rmtree(out, ignore_errors=True)
    subprocess.run([sys.executable, script, "--lang", "ko", "--input", f("korean.zip"),
                    "--output-dir", os.path.join(out, "kotest")], check=True)
    print(f"dict reference: {out}")


# ── Chinese dictionaries and pinyin ruby ─────────────────────────

ZH = os.path.join(FIXTURES, "zh")

CEDICT_LINES = """# CC-CEDICT test fixture
你好 你好 [ni3 hao3] /hello/hi/
說話 说话 [shuo1 hua4] /to speak/to say/to talk/CL:個|个[ge4]/
中國 中国 [Zhong1 guo2] /China/
中國人 中国人 [Zhong1 guo2 ren2] /Chinese person/
漢語 汉语 [Han4 yu3] /Chinese language/CL:門|门[men2]/
北京 北京 [Bei3 jing1] /Beijing, capital of People's Republic of China/
星期六 星期六 [Xing1 qi1 liu4] /Saturday/
東西 东西 [dong1 xi1] /east and west/
東西 东西 [dong1 xi5] /thing/stuff/person/animal/CL:個|个[ge4],件[jian4]/
周 周 [Zhou1] /surname Zhou/Zhou Dynasty (1046-256 BC)/
周 周 [zhou1] /to make a circuit/week/
和尚 和尚 [he2 shang5] /Buddhist monk/
尚未 尚未 [shang4 wei4] /not yet/still not/
和 和 [he2] /and/together with/
的 的 [de5] /of/~'s (possessive particle)/
不是 不是 [bu4 shi4] /no/is not/not/
不 不 [bu4] /(negative prefix)/not/no/
是 是 [shi4] /is/are/am/yes/to be/
研究 研究 [yan2 jiu1] /research/CL:項|项[xiang4]/
生命 生命 [sheng1 ming4] /life (as the characteristic of living beings)/
研究生 研究生 [yan2 jiu1 sheng1] /graduate student/
花兒 花儿 [hua1 r5] /erhua variant of 花[hua1]/
長 长 [Zhang3] /surname Zhang/
長 长 [chang2] /length/long/
長 长 [zhang3] /chief/head/to grow/
綠 绿 [lu:4] /green/
一不做，二不休 一不做，二不休 [yi1 bu4 zuo4 , er4 bu4 xiu1] /don't do it, or don't rest (idiom)/
這是一個很長很長很長很長的詞條 这是一个很长很长很长很长的词条 [zhe4 shi4] /too long/
石 石 [shi2] /stone/
石 石 [dan4] /dry measure for grain/
石頭 石头 [shi2 tou5] /stone/
很 很 [hen3] /very/
重 重 [zhong4] /heavy/
重 重 [chong2] /to repeat/again/
米 米 [mi3] /rice/
一 一 [yi1] /one/
他 他 [ta1] /he/
這 这 [zhe4] /this/
好 好 [hao3] /good/
好 好 [hao4] /to be fond of/
乾 干 [gan1] /dry/
幹 干 [gan4] /to do/
干 干 [gan1] /shield/
個 个 [ge4] /individual/
天 天 [tian1] /day/
哪兒 哪儿 [na3 r5] /where?/
慢 慢 [man4] /slow/
地 地 [di4] /earth/ground/
著 着 [zhao1] /(chess) move/
著 着 [zhe5] /aspect particle/
吐溫 吐温 [Tu3 wen1] /see 馬克·吐溫|马克·吐温[Ma3 ke4 · Tu3 wen1]/
綠 绿 [lv4] /green (v spelling)/
一月 一月 [yi1 yue4] /January/
統一 统一 [tong3 yi1] /to unify/
行動 行动 [xing2 dong4] /action/
人人 人人 [ren2 ren2] /everyone/
地位 地位 [di4 wei4] /position/
malformed line without brackets
"""

CANTO_LINES = """# CC-Canto test fixture
你好 你好 [ni3 hao3] {nei5 hou2} /hello/
唔係 唔系 [m2 xi4] {m4 hai6} /is not (Cantonese)/
佢哋 佢哋 [qu2 di4] {keoi5 dei6} /they (Cantonese)/
唔 唔 [wu2] {m4} /(phrase / adverb / noun) no, not./
好 好 [hao3] {hou2} /good/ # adapted from cc-cedict
"""

CANTO_READINGS = """# cccedict-canto-readings test fixture
中國 中国 [Zhong1 guo2] {zung1 gwok3}
說話 说话 [shuo1 hua4] {syut3 waa6}
"""

FREQ_LINES = """的 3188252 uj
是 796991 v
不 700000 d
和 400000 c
长 150000 a
不是 139000 v
中国 108000 ns
研究 90000 vn
东西 50000 n
说话 30000 v
生命 20000 n
研究生 8000 n
尚未 6000 d
和尚 5000 n
你好 2000 l
干 1000 v
乾 10 a
說 3 zg
"""

HSK_CSV = """ID,Simplified,Traditional,Pinyin,POS,Level,WebNo
L1-0001,你好,你好,nǐhǎo,Intj,1,1
L1-0002,不,不,bù,Adv,1,2
L2-0001,说话,說話,shuōhuà,V,2,3
L7-0001,研究生,研究生,yánjiūshēng,N,7-9,4
L1-0003,爸爸|爸,爸爸|爸,bàba,N,1,5
"""

TOCFL_CSV = """ID,Traditional,Simplified,Pinyin,POS,Variants
L0-1001,我,我,wǒ,N,
L0-1002,你/妳,你,nǐ,N,
L1-0001,說話,说话,shuōhuà,V,
L3-0001,研究,研究,yánjiū,V,
"""

PAIRS_TSV = (
    "1\t我不是中国人。\t101\tI am not Chinese.\n"
    "2\t我不是中國人。\t102\tI am not Chinese.\n"
    "3\t他在说话。\t103\tHe is talking.\n"
    "4\t我喜欢Tatoeba。\t104\tI like Tatoeba.\n"
    "5\t这是一个很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的句子。\t105\tA very long sentence.\n"
    "6\t研究生命的起源。\t106\tStudy the origin of life.\n"
    "7\t东西很贵。\t107\tThings are expensive.\n"
    "和尚在说话。\tThe monk is talking.\n"
)

GRAMMAR_TSV = "# pattern\tdefinition\n把…了\tdisposal construction\\nexample: 把书放在桌子上\n是…的\temphasis on time, place or manner\n"

MOE_JSON = [
    {"title": "好", "heteronyms": [
        {"bopomofo": "ㄏㄠˇ", "pinyin": "hǎo", "definitions": [
            {"type": "形", "def": "美、善。與「壞」相對。", "example": ["如：「好人」、「好事」。"]},
            {"type": "副", "def": "很、非常。<br>強調程度。", "example": ["如：「好久」。", "如：「好多」。"]}]},
        {"bopomofo": "ㄏㄠˋ", "pinyin": "hào", "definitions": [
            {"type": "動", "def": "愛、喜愛。", "example": ["如：「好學」。"]}]}]},
    {"title": "一不做，二不休", "heteronyms": [{"bopomofo": "ㄧ ㄅㄨˋ ㄗㄨㄛˋ ㄦˋ ㄅㄨˋ ㄒㄧㄡ",
                                         "definitions": [{"def": "要做就做到底。"}]}]},
    {"title": "行列", "heteronyms": [{"bopomofo": "ㄏㄤˊ ㄌㄧㄝˋ", "pinyin": "háng liè", "definitions": [
        {"type": "名", "def": "排列的行伍。{[8e4f]}", "example": ["如：「行列整齊」。"]}]}]},
    {"title": "說話", "heteronyms": [{"bopomofo": "ㄕㄨㄛ ㄏㄨㄚˋ", "pinyin": "shuō huà", "definitions": [
        {"type": "動", "def": "發言、講話。"}, {"type": "動", "def": "閒談。"}]}]},
    # A name in CC-CEDICT: its monolingual entry must follow it into the names slot.
    {"title": "北京", "heteronyms": [{"bopomofo": "ㄅㄟˇ ㄐㄧㄥ", "pinyin": "Běijīng", "definitions": [
        {"type": "名", "def": "中華人民共和國的首都。"}]}]},
]

BOOK_XHTML = (
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>说话</title><style>p { margin: 0 }</style></head>'
    '<body><p>我不是中国人。花儿很好看。他&amp;她在說話。<ruby>東<rt>dōng</rt></ruby>西</p>'
    '<SCRIPT>var x = "中国";</SCRIPT><p>Saturday 星期六 研究生命 &lt;綠&gt;</p></body></html>'
)


# AI furigana / pinyin: documents plus the answers a model gives for each sentence, so the
# firmware's scripts and the JS port can be run on the same answers without calling Gemini.
# Some answers are wrong on purpose: a syllable count that does not match (dropped whole), a
# reading CC-CEDICT does not list (dictionary kept), a word not in the sentence, a reading that
# does not fit the word.
AI_ZH_XHTML = ('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>石</title></head><body>'
               '<p>石头很重。一石米。他說話。</p><p>这是&lt;好&gt;的。</p>'
               '<p>一个东西不是一天。哪儿？慢慢地着。</p>'
               '<p>不<em>是</em>一月。统一行动。人人地位。第<b>一天</b>。</p></body></html>')
AI_ZH_ANSWERS = {
    "石头很重。": ["shi2", "tou5", "hen4", "zhong4"],
    "一石米。": ["yi1", "dan4", "mi3"],
    "他說話。": ["ta1", "shuo1", "hua4", "x"],
    "这是<好>的。": ["zhe4", "shi4", "hao4", "de5"],
}
AI_JA_XHTML = ('<html xmlns="http://www.w3.org/1999/xhtml"><head><title>本</title></head><body>'
               '<p>今日は本を読む。<ruby>林<rt>はやし</rt></ruby>さんの本。</p>'
               '<p class="a&gt;b">取り引きを食べる。</p></body></html>')
AI_JA_ANSWERS = {
    "今日は本を読む。": [["今日", "きょう"], ["本", "ほん"], ["読む", "よむ"]],
    "さんの本。": [["猫", "ねこ"], ["本", "ほん"]],
    "取り引きを食べる。": [["取り引き", "トリヒキ"], ["食べる", "のむ"]],
}


def write_test_epub(path, xhtml, lang):
    """A one-chapter EPUB around xhtml (as c1.xhtml), for the browser tests of the ruby page."""
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" '
                   'xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
                   '<rootfile full-path="book.opf" media-type="application/oebps-package+xml"/>'
                   '</rootfiles></container>', compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("book.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
                   'unique-identifier="u"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
                   f'<dc:identifier id="u">ruby-test-{lang}</dc:identifier><dc:title>test</dc:title>'
                   f'<dc:language>{lang}</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" '
                   'media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
                   compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("c1.xhtml", xhtml, compress_type=zipfile.ZIP_DEFLATED)


def make_zh_fixtures():
    os.makedirs(ZH, exist_ok=True)
    for name, text in [("cedict.u8", CEDICT_LINES), ("canto.u8", CANTO_LINES),
                       ("canto-readings.txt", CANTO_READINGS), ("freq.txt", FREQ_LINES),
                       ("hsk.csv", HSK_CSV), ("tocfl.csv", TOCFL_CSV), ("pairs.tsv", PAIRS_TSV),
                       ("grammar.tsv", GRAMMAR_TSV)]:
        with open(os.path.join(ZH, name), "w", encoding="utf-8") as f:
            f.write(text)
    with open(os.path.join(ZH, "moe.json"), "w", encoding="utf-8") as f:
        json.dump(MOE_JSON, f, ensure_ascii=False)
    for name, doc, answers in [("ai_zh", AI_ZH_XHTML, AI_ZH_ANSWERS), ("ai_ja", AI_JA_XHTML, AI_JA_ANSWERS)]:
        with open(os.path.join(ZH, f"{name}.xhtml"), "w", encoding="utf-8") as f:
            f.write(doc)
        with open(os.path.join(ZH, f"{name}_answers.json"), "w", encoding="utf-8") as f:
            json.dump(answers, f, ensure_ascii=False)
    write_test_epub(os.path.join(ZH, "ai_zh.epub"), AI_ZH_XHTML, "zh")
    write_test_epub(os.path.join(ZH, "ai_ja.epub"), AI_JA_XHTML, "ja")
    path = os.path.join(ZH, "book.epub")
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" '
                   'xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
                   '<rootfile full-path="book.opf" media-type="application/oebps-package+xml"/>'
                   '</rootfiles></container>', compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("book.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
                   'unique-identifier="u"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
                   '<dc:identifier id="u">pinyin-test</dc:identifier><dc:title>测试</dc:title>'
                   '<dc:language>zh</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" '
                   'media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
                   compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("c1.xhtml", BOOK_XHTML, compress_type=zipfile.ZIP_DEFLATED)
    print(f"zh fixtures: {ZH}")


def run_zh_references():
    """convert_jmdict.py --lang zh / yue, with every option the page offers, and
    add_pinyin_ruby.py on the synthetic book. The converter writes the .spx itself."""
    script = os.path.join(FIRMWARE, "tools", "dict_convert", "convert_jmdict.py")
    f = lambda name: os.path.join(ZH, name)  # noqa: E731
    cases = [
        ("ref_dict_zh", ["--lang", "zh", "--input", f("cedict.u8"), "--input", f("moe.json"),
                         "--frequency", f("freq.txt"), "--levels", f("hsk.csv"), "--level-name", "HSK",
                         "--examples", f("pairs.tsv"), "--examples-script", "simplified",
                         "--split-names", "--zhuyin"]),
        ("ref_dict_zh_tocfl", ["--lang", "zh", "--input", f("cedict.u8"), "--levels", f("tocfl.csv"),
                               "--level-name", "TOCFL", "--frequency", f("hsk.csv"),
                               "--examples", f("pairs.tsv"), "--examples-script", "traditional"]),
        ("ref_dict_yue", ["--lang", "yue", "--input", f("canto.u8"), "--input", f("cedict.u8"),
                          "--jyutping", f("canto-readings.txt")]),
        ("ref_dict_zh_grammar", ["--lang", "zh", "--format", "tsv", "--input", f("grammar.tsv"),
                                 "--name", "grammar"]),
        ("ref_dict_zh_yomitan", ["--lang", "zh", "--input", os.path.join(FIXTURES, "yomitan.zip")]),
        ("ref_dict_zh_title", ["--lang", "zh", "--input", f("cedict.u8"), "--title",
                               "一個非常非常非常長的詞典名字會被切短"]),
    ]
    # The page's built-in editions, from the real sources in data/. The word lists are unpacked
    # first: the page inflates any .gz, the Python converter only the dictionary itself.
    builtin = os.path.join(FIXTURES, "zh_builtin")
    os.makedirs(builtin, exist_ok=True)
    data = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
    for name in ("cccanto-webdist.txt", "jieba-dict.txt", "jieba-dict-big.txt", "hsk30.csv", "tocfl-202307.csv",
                 "tatoeba-cmn-eng.tsv", "tatoeba-yue-eng.tsv", "cccedict-canto-readings.txt"):
        with gzip.open(os.path.join(data, name + ".gz"), "rb") as src, open(os.path.join(builtin, name), "wb") as dst:
            shutil.copyfileobj(src, dst)

    def d(name):
        return os.path.join(data, name) if name.startswith("cedict") else os.path.join(builtin, name.removesuffix(".gz"))

    for edition, freq, levels, level_name, extra in (
            ("simplified", "jieba-dict.txt.gz", "hsk30.csv.gz", "HSK", []),
            ("traditional", "jieba-dict-big.txt.gz", "tocfl-202307.csv.gz", "TOCFL", ["--zhuyin"])):
        cases.append((f"ref_dict_zh_{edition}", [
            "--lang", "zh", "--input", d("cedict_1_0_ts_utf-8_mdbg.txt.gz"), "--frequency", d(freq),
            "--levels", d(levels), "--level-name", level_name, "--examples", d("tatoeba-cmn-eng.tsv.gz"),
            "--examples-script", edition, "--split-names", *extra]))
    cases.append(("ref_dict_yue_cantonese", [
        "--lang", "yue", "--input", d("cccanto-webdist.txt.gz"), "--input", d("cedict_1_0_ts_utf-8_mdbg.txt.gz"),
        "--jyutping", d("cccedict-canto-readings.txt.gz"), "--examples", d("tatoeba-yue-eng.tsv.gz"),
        "--examples-script", "traditional", "--split-names"]))
    for name, args in cases:
        out = os.path.join(FIXTURES, name)
        shutil.rmtree(out, ignore_errors=True)
        subprocess.run([sys.executable, script, *args, "--output-dir", out], check=True)
        print(f"zh dict reference: {out}")

    ruby = os.path.join(FIRMWARE, "tools", "pinyin_ruby", "add_pinyin_ruby.py")
    out = os.path.join(FIXTURES, "ref_pinyin")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out, exist_ok=True)
    subprocess.run([sys.executable, ruby, "--cedict", f("cedict.u8"), "--frequency", f("freq.txt"),
                    "--skip-top", "2", f("book.epub"), os.path.join(out, "book-pinyin.epub")], check=True)
    subprocess.run([sys.executable, ruby, "--cedict", f("cedict.u8"), "--zhuyin",
                    f("book.epub"), os.path.join(out, "book-zhuyin.epub")], check=True)
    print(f"pinyin reference: {out}")

    # The AI paths, with the fixed answers above standing in for Gemini.
    tools = os.path.join(FIRMWARE, "tools")
    for sub in ("pinyin_ruby", "furigana_ruby", "ruby_common", "dict_convert"):
        sys.path.insert(0, os.path.join(tools, sub))
    import html as html_mod
    import add_furigana_ruby
    import add_pinyin_ruby
    import ruby_epub

    def fake(answers):
        return lambda batch: [answers[t] for t in batch] if all(t in answers for t in batch) else None

    out = os.path.join(FIXTURES, "ref_ruby_ai")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out, exist_ok=True)
    char_readings = {}
    words = add_pinyin_ruby.load_cedict(f("cedict.u8"), char_readings)
    passages = [html_mod.unescape(p) for p, is_text in ruby_epub.text_pieces(AI_ZH_XHTML) if is_text]
    contextual = add_pinyin_ruby.contextual_readings(passages, char_readings, fake(AI_ZH_ANSWERS))
    for zhuyin in (False, True):
        with open(os.path.join(out, "zh-zhuyin.xhtml" if zhuyin else "zh-pinyin.xhtml"), "w", encoding="utf-8") as fh:
            fh.write(add_pinyin_ruby.annotate_xhtml(AI_ZH_XHTML, words, set(), zhuyin, contextual))
    passages = [html_mod.unescape(p) for p, is_text in ruby_epub.text_pieces(AI_JA_XHTML) if is_text]
    furigana = add_furigana_ruby.contextual_furigana(passages, fake(AI_JA_ANSWERS))
    with open(os.path.join(out, "ja.xhtml"), "w", encoding="utf-8") as fh:
        fh.write(add_furigana_ruby.annotate_xhtml(AI_JA_XHTML, furigana))
    print(f"ruby AI reference: {out}")


def run_anki_references():
    """Test decks built with the Anki library, and apkg_to_flashcards.py's deck folders for them."""
    script = os.path.join(FIRMWARE, "tools", "anki_import", "apkg_to_flashcards.py")
    try:
        import anki  # noqa: F401
        import lxml  # noqa: F401
    except ImportError as e:
        print(f"anki reference: SKIPPED ({e}; pip install anki lxml)")
        return
    decks = os.path.join(FIXTURES, "anki")
    shutil.rmtree(decks, ignore_errors=True)
    subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "anki", "make_decks.py"), decks],
                   check=True)
    for name in ("test", "test-legacy"):
        out = os.path.join(FIXTURES, "ref_anki", name)
        shutil.rmtree(out, ignore_errors=True)
        subprocess.run([sys.executable, script, os.path.join(decks, name + ".apkg"), "--out", out], check=True)
        print(f"anki reference: {out}")


if __name__ == "__main__":
    os.makedirs(FIXTURES, exist_ok=True)
    make_manga_pages()
    run_manga_reference()
    make_manga_cbz()
    make_manga_fullbleed_cbz()
    make_manga_foldered_cbz()
    make_manga_jp_cbz()
    make_manga_epub()
    run_manga_epub_reference()
    make_manga_layouts()
    run_manga_layout_references()
    run_pil_box_reference()
    run_yolo_post_reference()
    run_yolo_reference()
    make_manga_pdf()
    run_manga_pdf_reference()
    make_yomitan_zip()
    make_yomitan_markup_zip()
    make_yomitan_kanji_zips()
    make_pitch_zips()
    make_furigana_json()
    make_yomitan_images_zip()
    make_korean_zip()
    make_jmdict_json()
    run_font_reference()
    run_dict_references()
    make_zh_fixtures()
    run_zh_references()
    if make_mdx_fixtures():
        run_mdx_reference()
    run_anki_references()
    print("done")
