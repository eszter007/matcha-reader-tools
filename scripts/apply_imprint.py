#!/usr/bin/env python3
"""Fill the {{IMPRINT_*}} placeholders in legal.html.

Values come from environment variables of the same name, falling back to a
gitignored imprint.config.json (copy imprint.example.json to start). The
deploy workflow passes them from repository secrets, so the operator's
details are never committed.

  python3 scripts/apply_imprint.py              # writes legal.local.html for preview
  python3 scripts/apply_imprint.py --in-place   # rewrites legal.html (CI only)
"""
import html, json, os, pathlib, re, sys

KEYS = ("IMPRINT_NAME", "IMPRINT_STREET", "IMPRINT_CITY", "IMPRINT_EMAIL")
root = pathlib.Path(__file__).resolve().parent.parent
config = root / "imprint.config.json"
values = json.loads(config.read_text(encoding="utf-8")) if config.exists() else {}
values.update({k: os.environ[k] for k in KEYS if os.environ.get(k)})

missing = [k for k in KEYS if not values.get(k)]
if missing:
    sys.exit(f"Missing imprint values: {', '.join(missing)}. Set them as environment "
             "variables or in imprint.config.json (see imprint.example.json).")

src = root / "legal.html"
out = re.sub(r"\{\{(IMPRINT_[A-Z]+)\}\}", lambda m: html.escape(values[m.group(1)]),
             src.read_text(encoding="utf-8"))
left = re.findall(r"\{\{IMPRINT_[A-Z]+\}\}", out)
if left:
    sys.exit(f"Unknown placeholders in legal.html: {sorted(set(left))}")
dest = src if "--in-place" in sys.argv else root / "legal.local.html"
dest.write_text(out, encoding="utf-8")
print(f"Imprint written to {dest.name}")
