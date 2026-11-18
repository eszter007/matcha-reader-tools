#!/usr/bin/env python3
"""Build the Black Jack panel benchmark: fetch the pages labels.json describes and lay them out
for test/panels/prepare.py and eval.cjs.

    python3 test/panels/blackjack/fetch.py EVAL_DIR [--scan SCAN_DIR] [--downloads DIR]

The pages are from ブラックジャックによろしく 佐藤秀峰 (Give My Regards to Black Jack, Shuho Sato),
which the author offers for free secondary use at https://densho810.com/free/ (credit the title
and author; see the terms there). They are not in this repo: this script downloads the official
volumes (about 345 MB each, kept in --downloads so a second run downloads nothing), takes each
labelled page's image out of the volume's PDF unchanged, and checks it against the sha256 in
labels.json. EVAL_DIR gets labels.json and pages/.

--scan also writes a scan-like copy of every page to SCAN_DIR with its labels moved to match:
1600 px tall, tilted up to 0.8 degrees, paper tint, noise, slight blur, a binding shadow on one
side, JPEG quality 65. The tilt and shadow are seeded per page, so every run makes the same pages;
the JPEG bytes can still differ between Pillow versions, so their sha256 is recorded fresh.

Needs PyMuPDF (pip install pymupdf) to read the PDFs, and numpy for --scan.
"""
import argparse
import hashlib
import io
import json
import math
import os
import random
import shutil
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
VOLUME_URL = "https://densho810.com/free/dl/{:03d}bj.zip"


def download(vol: int, folder: str) -> str:
    os.makedirs(folder, exist_ok=True)
    dest = os.path.join(folder, f"{vol:03d}bj.zip")
    if os.path.exists(dest):
        return dest
    url = VOLUME_URL.format(vol)
    print(f"Downloading volume {vol} ({url})...", flush=True)
    part = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "matcha-reader-tools panel benchmark"})
    with urllib.request.urlopen(req) as resp, open(part, "wb") as out:
        shutil.copyfileobj(resp, out, 1 << 20)
    os.replace(part, dest)
    return dest


def pdf_pages(zip_path: str, wanted: set):
    """{pdf page index: image bytes} for the wanted pages, as embedded in the volume's PDF."""
    import fitz  # PyMuPDF
    with zipfile.ZipFile(zip_path) as zf:
        name = next(n for n in zf.namelist() if n.lower().endswith(".pdf"))
        doc = fitz.open(stream=zf.read(name), filetype="pdf")
    out = {}
    for i in sorted(wanted):
        xref = doc[i].get_images(full=True)[0][0]
        out[i] = doc.extract_image(xref)["image"]
    return out


def scanify(src_dir: str, dst_dir: str, labels: dict) -> None:
    """A scan-like copy of every page, its boxes moved by the same scale and tilt."""
    import numpy as np
    from PIL import Image, ImageFilter
    os.makedirs(os.path.join(dst_dir, "pages"), exist_ok=True)
    out = []
    for k, p in enumerate(labels["pages"]):
        rnd = random.Random(k)
        im = Image.open(os.path.join(src_dir, "pages", p["file"])).convert("L")
        s = 1600 / im.height
        w, h = round(im.width * s), 1600
        im = im.resize((w, h), Image.LANCZOS)
        ang = rnd.uniform(-0.8, 0.8)
        im = im.rotate(ang, resample=Image.BICUBIC, fillcolor=255)
        a = np.asarray(im).astype(np.float32)
        side = rnd.choice(("l", "r"))
        band = int(w * 0.06)
        ramp = np.linspace(0.55, 1.0, band)
        if side == "l":
            a[:, :band] *= ramp[None, :]
        else:
            a[:, w - band:] *= ramp[::-1][None, :]
        a += np.random.default_rng(k).normal(0, 6, a.shape)
        g = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))
        tint = np.array([246, 239, 222], np.float32) / 255
        rgb = np.asarray(g).astype(np.float32)[..., None] * tint[None, None, :]
        buf = io.BytesIO()
        Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).save(buf, "JPEG", quality=65)
        data = buf.getvalue()
        name = p["id"] + ".jpg"
        with open(os.path.join(dst_dir, "pages", name), "wb") as f:
            f.write(data)
        # PIL turns the page counter-clockwise about its centre; each box's corners go with it.
        cx, cy, t = w / 2, h / 2, math.radians(ang)

        def turn(x, y):
            dx, dy = x - cx, y - cy
            return cx + dx * math.cos(t) + dy * math.sin(t), cy - dx * math.sin(t) + dy * math.cos(t)

        panels = []
        for q in p["panels"]:
            x1, y1, x2, y2 = [v * s for v in q["box"]]
            pts = [turn(x, y) for x in (x1, x2) for y in (y1, y2)]
            xs, ys = [c[0] for c in pts], [c[1] for c in pts]
            box = [max(0, round(min(xs))), max(0, round(min(ys))), min(w, round(max(xs))), min(h, round(max(ys)))]
            panels.append({**q, "box": box})
        out.append({**p, "file": name, "width": w, "height": h, "sha256": hashlib.sha256(data).hexdigest(),
                    "tags": p.get("tags", []) + ["scan-like"], "panels": panels,
                    "notes": f"tilt {ang:.2f} degrees, shadow {'left' if side == 'l' else 'right'}"})
    with open(os.path.join(dst_dir, "labels.json"), "w", encoding="utf-8") as f:
        json.dump({**labels, "pages": out}, f, ensure_ascii=False, indent=1)
    print(f"{len(out)} scan-like page(s) in {dst_dir}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("eval_dir")
    ap.add_argument("--scan", help="also write scan-like copies of the pages here")
    ap.add_argument("--downloads", help="where the volume zips are kept (default: EVAL_DIR/downloads)")
    args = ap.parse_args()
    try:
        import fitz  # noqa: F401
    except ImportError:
        sys.exit("PyMuPDF is needed to read the volumes: pip install pymupdf")

    with open(os.path.join(HERE, "labels.json"), encoding="utf-8") as f:
        labels = json.load(f)
    pages_dir = os.path.join(args.eval_dir, "pages")
    os.makedirs(pages_dir, exist_ok=True)
    downloads = args.downloads or os.path.join(args.eval_dir, "downloads")
    by_volume = {}
    for p in labels["pages"]:
        by_volume.setdefault(p["source"]["volume"], []).append(p)
    bad = 0
    for vol, pages in sorted(by_volume.items()):
        missing = [p for p in pages if not os.path.exists(os.path.join(pages_dir, p["file"]))]
        if not missing:
            continue
        images = pdf_pages(download(vol, downloads), {p["source"]["pdf_page"] for p in missing})
        for p in missing:
            data = images[p["source"]["pdf_page"]]
            if hashlib.sha256(data).hexdigest() != p["sha256"]:
                print(f"{p['id']}: the page in the downloaded volume is not the one labelled", file=sys.stderr)
                bad += 1
                continue
            with open(os.path.join(pages_dir, p["file"]), "wb") as f:
                f.write(data)
    shutil.copyfile(os.path.join(HERE, "labels.json"), os.path.join(args.eval_dir, "labels.json"))
    print(f"{len(labels['pages']) - bad} page(s) in {pages_dir}")
    if bad:
        sys.exit(1)
    if args.scan:
        scanify(args.eval_dir, args.scan, labels)


if __name__ == "__main__":
    main()
