#!/usr/bin/env python3
"""Generate reference outputs using the matcha-reader firmware's own Python
conversion tools, for byte-comparison against this repo's JS ports.

Usage:
    MATCHA_READER=/path/to/matcha-reader python3 test/gen_references.py

Produces under test/fixtures/:
    manga_pages/         synthetic PNG pages + raw grayscale (.gray) and RGBA (.rgba) dumps
    manga_fullbleed.cbz  borderless pages (one full-page panel each), for panels-only
    manga_foldered.cbz   one folder per chapter, page numbers restarting in each
    ref_manga/           convert_manga.py --no-ocr output
    ref_yolo/boxes.json  YOLO panel boxes (needs numpy + onnxruntime, else skipped)
    ref_manga_pdf/       convert_manga.py --no-ocr output for the PDF fixture
                         (needs pymupdf, else skipped)
    yomitan.zip          synthetic Yomitan dictionary
    jmdict.json          synthetic jmdict-simplified JSON
    ref_dict_yomitan/    convert_jmdict.py output + .spx
    ref_font/            fontconvert_sdcard.py .cpfont (needs freetype-py + fontTools)
    ref_dict_jmdict/     convert_jmdict.py output + .spx
    zh/                  synthetic CC-CEDICT, CC-Canto, MoE JSON, word lists, sentence pairs
    ref_dict_zh*/        convert_jmdict.py --lang zh / yue output (+ names.*, .title files)
    ref_pinyin/          add_pinyin_ruby.py output for zh/book.epub
"""

import json
import os
import random
import shutil
import subprocess
import sys
import zipfile

from PIL import Image, ImageDraw

FIRMWARE = os.environ.get("MATCHA_READER", os.path.join(os.path.dirname(__file__), "..", "..", "matcha-reader"))
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

    # Page 3: borderless full-page art (single panel fallback).
    img = Image.new("RGB", (800, 1200), "white")
    d = ImageDraw.Draw(img)
    for _ in range(6000):
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
                    "--no-ocr",
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


def make_manga_epub():
    """Synthetic fixed-layout EPUB: XHTML spine wrappers around the pages,
    dc: metadata, and an EPUB3 nav TOC. Exercises spine-order extraction,
    metadata auto-detection, and toc.idx generation."""
    path = os.path.join(FIXTURES, "manga.epub")
    pages_dir = os.path.join(FIXTURES, "manga_pages")
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
    <dc:identifier id="uid">test-epub</dc:identifier>
    <dc:title>Epub Test Manga</dc:title>
    <dc:creator>Epub Author</dc:creator>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>{"".join(manifest_items)}</manifest>
  <spine>{"".join(spine_items)}</spine>
</package>'''

    nav = f'''<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol>
<li><a href="text/pg0.xhtml">Cover</a></li>
<li><a href="text/pg1.xhtml">Chapter 1</a></li>
<li><a href="text/pg2.xhtml#top">Chapter 2</a></li>
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
    print(f"manga epub: {path}")


def run_manga_epub_reference():
    out = os.path.join(FIXTURES, "ref_manga_epub")
    shutil.rmtree(out, ignore_errors=True)
    script = os.path.join(FIRMWARE, "tools", "manga_convert", "convert_manga.py")
    subprocess.run([sys.executable, script,
                    "--input", os.path.join(FIXTURES, "manga.epub"),
                    "--output-dir", out,
                    "--no-ocr"],
                   check=True, env=grid_only_env())
    print(f"manga epub reference: {out}")


def run_yolo_reference():
    """Reference panel boxes for the AI (YOLO) detection path.

    Mirrors js/yolo.js preprocessing/decoding numerically (bilinear letterbox,
    float32 tensor) against the same ONNX model the site ships
    (models/manga_panel_detector_yolo26n.onnx), then reuses the firmware tool's
    own is_sliver_panel / _dedupe_boxes / split_frames_over_subpanels /
    sort_panels_reading_order / expand_panels_over_text so post-processing
    semantics can't drift from convert_manga.py.

    Decoding runs at PANEL_WEAK_CONF, not the panel bar: sub-threshold panel
    boxes are kept as corroboration for splitting a merged frame, and the text
    class drives the bubble-aware crop expansion. Both mirror js/yolo.js.

    Inference backends differ in float rounding, so the JS comparison is
    tolerance-based (±2 px), unlike the byte-exact grid references.
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
    size, stride, conf_thresh = 640, 32, 0.4
    weak_conf = convert_manga.PANEL_WEAK_CONF

    def letterbox(rgb):
        # ultralytics LetterBox(new_shape=640, auto=True, stride=32): the long side
        # is scaled to 640 and the short side padded only to the next multiple of
        # 32, NOT out to a square. js/yolo.js:yoloLetterbox does the same, and the
        # model is exported with dynamic height/width so both can feed it.
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

    pages_dir = os.path.join(FIXTURES, "manga_pages")
    out_dir = os.path.join(FIXTURES, "ref_yolo")
    os.makedirs(out_dir, exist_ok=True)
    result = {}
    for name in sorted(os.listdir(pages_dir)):
        if not name.endswith(".png"):
            continue
        img = Image.open(os.path.join(pages_dir, name)).convert("RGB")
        inp, scale, padx, pady = letterbox(np.asarray(img))
        rows = sess.run(None, {sess.get_inputs()[0].name: inp})[0][0]
        boxes_with_conf = []
        candidates = []
        texts = []
        for x1, y1, x2, y2, conf, cls in rows:
            if conf < weak_conf:
                continue
            box = [int(max(0, min((x1 - padx) / scale, img.width))),
                   int(max(0, min((y1 - pady) / scale, img.height))),
                   int(max(0, min((x2 - padx) / scale, img.width))),
                   int(max(0, min((y2 - pady) / scale, img.height)))]
            cls = round(float(cls))
            if cls == 1:
                if conf >= conf_thresh:
                    texts.append(box)
                continue
            if cls != 0:
                continue
            if convert_manga.is_sliver_panel(box, img.width, img.height):
                continue
            candidates.append(box)
            if conf >= conf_thresh:
                boxes_with_conf.append((box, float(conf)))
        boxes = convert_manga._dedupe_boxes(boxes_with_conf)
        if not boxes:
            boxes = [[0, 0, img.width, img.height]]
        else:
            boxes = convert_manga.split_frames_over_subpanels(boxes, candidates)
        boxes = convert_manga.sort_panels_reading_order(boxes)
        result[name] = convert_manga.expand_panels_over_text(boxes, texts, img.width, img.height)
    with open(os.path.join(out_dir, "boxes.json"), "w") as f:
        json.dump(result, f, indent=1)
    print(f"yolo reference: {out_dir}")
    for name, boxes in result.items():
        print(f"  {name}: {boxes}")


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
                    "--no-ocr"],
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

    for name, args in [("ref_dict_yomitan", ["--input", os.path.join(FIXTURES, "yomitan.zip")]),
                       ("ref_dict_jmdict", ["--input", os.path.join(FIXTURES, "jmdict.json")])]:
        out = os.path.join(FIXTURES, name)
        shutil.rmtree(out, ignore_errors=True)
        subprocess.run([sys.executable, script, *args, "--output-dir", out], check=True)
        subprocess.run([sys.executable, spx_script, out], check=True)
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
malformed line without brackets
"""

CANTO_LINES = """# CC-Canto test fixture
你好 你好 [ni3 hao3] {nei5 hou2} /hello/
唔係 唔系 [m2 xi4] {m4 hai6} /is not (Cantonese)/
佢哋 佢哋 [qu2 di4] {keoi5 dei6} /they (Cantonese)/
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
]

BOOK_XHTML = (
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>说话</title><style>p { margin: 0 }</style></head>'
    '<body><p>我不是中国人。花儿很好看。他&amp;她在說話。<ruby>東<rt>dōng</rt></ruby>西</p>'
    '<SCRIPT>var x = "中国";</SCRIPT><p>Saturday 星期六 研究生命 &lt;綠&gt;</p></body></html>'
)


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


if __name__ == "__main__":
    os.makedirs(FIXTURES, exist_ok=True)
    make_manga_pages()
    run_manga_reference()
    run_yolo_reference()
    make_manga_cbz()
    make_manga_fullbleed_cbz()
    make_manga_foldered_cbz()
    make_manga_epub()
    run_manga_epub_reference()
    make_manga_pdf()
    run_manga_pdf_reference()
    make_yomitan_zip()
    make_jmdict_json()
    run_font_reference()
    run_dict_references()
    make_zh_fixtures()
    run_zh_references()
    if make_mdx_fixtures():
        run_mdx_reference()
    print("done")
