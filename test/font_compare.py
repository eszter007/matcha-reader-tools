#!/usr/bin/env python3
"""Structurally compare two .cpfont v4 files (reference vs web-generated).

The web tool rasterizes with the browser's font engine instead of FreeType,
so glyph bitmaps and pixel-derived metrics may differ slightly. Everything
that comes from the font file itself must match exactly:

    header, interval tables, glyph count, kerning class tables + matrix,
    ligature tables

Metrics are allowed small tolerances:

    advanceY/ascender/descender: ±1 px      (fixed-point rounding)
    per-glyph advanceX:          ±1 (1/16px units)
    per-glyph bitmap w/h/left/top: ±2 px    (rasterizer differences)

Exits 0 and prints STRUCTURAL MATCH when everything is within tolerance.
"""

import struct
import sys

HEADER = "<8sHHB19s"
TOC = "<B3xIIBhhHHBBBI4x"

# Default-ignorable codepoints: browsers render these invisibly while
# FreeType renders the font's glyph. The firmware never draws them (soft
# hyphens are stripped before rendering), so bitmap differences there are
# harmless. Their advance widths are still compared.
DEFAULT_IGNORABLE = set([0x00AD, 0x034F, 0x2028, 0x2029, 0xFEFF]) \
    | set(range(0x200B, 0x2010)) | set(range(0x202A, 0x202F)) | set(range(0x2060, 0x2070))


def parse(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, version, flags, style_count, _ = struct.unpack_from(HEADER, data, 0)
    assert magic == b"CPFONT\x00\x00", f"{path}: bad magic"
    styles = []
    for i in range(style_count):
        (style_id, interval_count, glyph_count, advance_y, ascender, descender,
         kern_l, kern_r, kern_lcls, kern_rcls, lig_count, offset) = struct.unpack_from(TOC, data, 32 + i * 32)
        o = offset
        intervals = data[o:o + interval_count * 12]; o += interval_count * 12
        codepoints = []
        for iv in range(interval_count):
            i_start, i_end, _ = struct.unpack_from("<III", intervals, iv * 12)
            codepoints.extend(range(i_start, i_end + 1))
        glyphs = []
        for g in range(glyph_count):
            glyphs.append(struct.unpack_from("<BBHhhH2xI", data, o)); o += 16
        kern_left = data[o:o + kern_l * 3]; o += kern_l * 3
        kern_right = data[o:o + kern_r * 3]; o += kern_r * 3
        matrix = data[o:o + kern_lcls * kern_rcls]; o += kern_lcls * kern_rcls
        ligatures = data[o:o + lig_count * 8]; o += lig_count * 8
        bitmap_size = sum(g[5] for g in glyphs)
        styles.append(dict(style_id=style_id, version=version, flags=flags,
                           intervals=intervals, glyphs=glyphs, codepoints=codepoints,
                           advance_y=advance_y, ascender=ascender, descender=descender,
                           kern_left=kern_left, kern_right=kern_right, matrix=matrix,
                           ligatures=ligatures, bitmap_size=bitmap_size,
                           data_end=o + bitmap_size, file_size=len(data)))
    return version, flags, styles


def main():
    ref_path, got_path = sys.argv[1], sys.argv[2]
    ref_ver, ref_flags, ref_styles = parse(ref_path)
    got_ver, got_flags, got_styles = parse(got_path)

    problems = []

    def expect(cond, msg):
        if not cond:
            problems.append(msg)

    expect(ref_ver == got_ver, f"version {got_ver} != {ref_ver}")
    expect(ref_flags == got_flags, f"flags {got_flags} != {ref_flags}")
    expect(len(ref_styles) == len(got_styles), "style count differs")

    for ref, got in zip(ref_styles, got_styles):
        sid = ref["style_id"]
        expect(got["style_id"] == sid, f"style id {got['style_id']} != {sid}")
        expect(got["intervals"] == ref["intervals"], f"style {sid}: interval table differs")
        expect(len(got["glyphs"]) == len(ref["glyphs"]), f"style {sid}: glyph count {len(got['glyphs'])} != {len(ref['glyphs'])}")
        expect(got["kern_left"] == ref["kern_left"], f"style {sid}: kern left classes differ")
        expect(got["kern_right"] == ref["kern_right"], f"style {sid}: kern right classes differ")
        expect(got["matrix"] == ref["matrix"], f"style {sid}: kern matrix differs")
        expect(got["ligatures"] == ref["ligatures"], f"style {sid}: ligature table differs")
        expect(got["data_end"] == got["file_size"], f"style {sid}: file size inconsistent with section sizes")

        for name, tol in [("advance_y", 1), ("ascender", 1), ("descender", 1)]:
            expect(abs(got[name] - ref[name]) <= tol, f"style {sid}: {name} {got[name]} vs {ref[name]}")

        adv_max = wh_max = 0
        for cp, (rw, rh, radv, rl, rt, rlen, roff), (gw, gh, gadv, gl, gt, glen, goff) in zip(
                ref["codepoints"], ref["glyphs"], got["glyphs"]):
            adv_max = max(adv_max, abs(gadv - radv))
            if cp in DEFAULT_IGNORABLE:
                continue
            for rv, gv in [(rw, gw), (rh, gh), (rl, gl), (rt, gt)]:
                wh_max = max(wh_max, abs(gv - rv))
        expect(adv_max <= 1, f"style {sid}: advanceX max delta {adv_max} > 1")
        expect(wh_max <= 2, f"style {sid}: bitmap metric max delta {wh_max} > 2")
        print(f"style {sid}: {len(got['glyphs'])} glyphs, advanceX max delta {adv_max}/16 px, "
              f"bitmap metric max delta {wh_max} px, bitmaps {got['bitmap_size']} vs {ref['bitmap_size']} bytes")

    if problems:
        for p in problems:
            print("MISMATCH:", p)
        sys.exit(1)
    print("STRUCTURAL MATCH")


if __name__ == "__main__":
    main()
