#!/usr/bin/env python3
"""Copies the shared header and footer end from partials/ into every page.

The pages stay plain HTML that work without a build step or JavaScript, so each one carries its
own copy. Edit partials/, then run this script. With --check it changes nothing and exits 1
when a page differs from the partials (CI runs it this way).

- partials/header.html replaces each page's <header class="brand">. The nav link to the page
  itself gets aria-current="page".
- partials/footer-end.html replaces the lines from <p class="coffee"> to the
  <p class="legal"> line. Pages without those lines (legal.html) keep their own footer.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
HEADER_RE = re.compile(r'<header class="brand">.*?</header>\n', re.S)
FOOTER_END_RE = re.compile(r'  <p class="coffee">.*?<p class="legal">[^\n]*\n', re.S)


def page_header(template, page):
    header = template.replace(' aria-current="page"', "")
    return header.replace(f'<a href="{page}">', f'<a href="{page}" aria-current="page">')


def main():
    check = "--check" in sys.argv[1:]
    header = (ROOT / "partials/header.html").read_text(encoding="utf-8")
    footer_end = (ROOT / "partials/footer-end.html").read_text(encoding="utf-8")
    differ = []
    for path in sorted(ROOT.glob("*.html")):
        text = path.read_text(encoding="utf-8")
        if not HEADER_RE.search(text):
            continue
        out = HEADER_RE.sub(lambda _: page_header(header, path.name), text, count=1)
        out = FOOTER_END_RE.sub(lambda _: footer_end, out, count=1)
        if out == text:
            continue
        differ.append(path.name)
        if not check:
            path.write_text(out, encoding="utf-8")
    if check and differ:
        print("Header or footer differs from partials/ in: " + ", ".join(differ))
        print("Run: python3 scripts/sync_layout.py")
        return 1
    for name in differ:
        print(f"{name}: updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
