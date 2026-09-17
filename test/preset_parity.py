#!/usr/bin/env python3
"""Check js/fonts.js's INTERVAL_PRESETS against the firmware's own table.

The presets decide a generated font's coverage AND what its interval table costs the
reader in RAM, so a divergence here is expensive in both directions: a preset the
browser defines too narrowly produces a font missing glyphs, and one it defines too
loosely produces a table tens of KB larger than the firmware's build of the same font.

This drifted unnoticed once already -- the browser's cjk-ext held 20 of the firmware's
284 ranges (the whole JIS X 0213 plane 2 tail was absent) and arabic/ipa-chars were
missing entirely -- because nothing compared the two.

Needs MATCHA_READER pointing at the firmware checkout (same convention as
gen_references.py) and node on PATH; skips cleanly without them.

    python3 test/preset_parity.py
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIRMWARE = os.environ.get("MATCHA_READER", os.path.join(HERE, "..", "..", "matcha-reader"))
CONVERTER = os.path.join(FIRMWARE, "lib", "EpdFont", "scripts", "fontconvert_sdcard.py")


def firmware_presets():
    """INTERVAL_PRESETS from the converter, without importing the whole module.

    Executed rather than pattern-matched: cjk-ext's plane-2 tail is computed at import
    time from the euc_jis_2004 codec, so a regex over the source would miss 263 of its
    ranges -- the very gap this test exists to catch.
    """
    src = open(CONVERTER, encoding="utf-8").read()
    ns = {}
    head = src[: src.index("INTERVAL_PRESETS = {")]
    exec(compile(re.sub(r"^(import|from)\s.*$", "", head, flags=re.M), CONVERTER, "exec"), ns)
    start = src.index("INTERVAL_PRESETS = {")
    depth = 0
    end = len(src)
    for i in range(start, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    exec(src[start:end], ns)
    return {k: [list(r) for r in v] for k, v in ns["INTERVAL_PRESETS"].items()}


def browser_presets():
    """INTERVAL_PRESETS as js/fonts.js actually evaluates it, via node."""
    js = os.path.join(HERE, "..", "js", "fonts.js")
    out = subprocess.run(
        ["node", "-e", "console.log(JSON.stringify(require(" + json.dumps(js) + ").INTERVAL_PRESETS))"],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


def main():
    if not os.path.exists(CONVERTER):
        print("SKIPPED (no firmware converter at " + CONVERTER + "; set MATCHA_READER)")
        return 0

    py, js = firmware_presets(), browser_presets()
    failures = []

    for name in sorted(set(py) - set(js)):
        failures.append("preset '" + name + "' is in the firmware but not in js/fonts.js")
    for name in sorted(set(js) - set(py)):
        failures.append("preset '" + name + "' is in js/fonts.js but not in the firmware")
    for name in sorted(set(py) & set(js)):
        if py[name] != js[name]:
            missing = [r for r in py[name] if r not in js[name]]
            extra = [r for r in js[name] if r not in py[name]]
            detail = "%d ranges in firmware vs %d in js" % (len(py[name]), len(js[name]))
            if missing:
                detail += "; %d missing, first U+%04X-U+%04X" % (len(missing), missing[0][0], missing[0][1])
            if extra:
                detail += "; %d unexpected, first U+%04X-U+%04X" % (len(extra), extra[0][0], extra[0][1])
            failures.append("preset '" + name + "' differs: " + detail)

    if failures:
        for f in failures:
            print("FAIL: " + f)
        return 1
    print("PRESETS MATCH (%d presets, cjk-ext %d ranges)" % (len(py), len(py["cjk-ext"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
