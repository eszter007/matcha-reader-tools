# 🍵 Manga Converter for BOOX Picco

> **Fork attribution:** Adapted from [Matcha Reader Tools](https://github.com/eszter007/matcha-reader-tools) by **Eszter Schuffert**, © 2026, under the original [MIT License](LICENSE). Credit for the original project belongs to Eszter Schuffert.

This fork's website focuses on **one tool: Manga Converter**, optimized for the **BOOX Picco (480 × 800)**. The homepage opens the converter directly, and the only offered export format is **fixed-layout EPUB**.

**[Open the Manga Converter](https://rereprep.github.io/matcha-reader-tools/manga.html)**

## Manga conversion features

- Import **CBZ, ZIP, EPUB, PDF, Mokuro volumes, or page images**.
- Detect panels using the in-browser AI model, or fall back to the non-AI grid detector.
- Choose manga (right-to-left), comics (left-to-right), webtoon, or 4-koma reading order.
- Preview and manually correct detected panel boundaries before exporting.
- Remove white outer page borders automatically for manga, 4-koma, and western comics.
- **Panel crop margin defaults to 0 px**. The detector can still expand crops to protect speech bubbles extending beyond panel boundaries.
- Export full pages and/or individual panels as **480 × 800 JPEGs** embedded in a fixed-layout EPUB. Unused space is always white.
- **Rotate wide panels upright** by default, rather than vertically distorting horizontal artwork.
- **Optional image stretching** is enabled by default with an **18% aspect-ratio tolerance**; available tolerances are 5%, 10%, 18%, 25%, 35%, and 50%. Stretching is applied only to portrait images, including rotated panels. Horizontal images that remain horizontal retain their proportions.
- Turn stretching off to preserve every page and panel's aspect ratio, with white margins where needed.

## Using the site

1. Open the [Manga Converter](https://rereprep.github.io/matcha-reader-tools/manga.html).
2. Select your manga or comic file.
3. Choose the book type and whether to include pages and panels or panels only.
4. Optionally check and correct detected panels, and adjust the rotation/stretching settings.
5. Convert and transfer the downloaded EPUB to your BOOX Picco.

The converter processes pages in the browser. Its ONNX model may need an initial download; it does not upload manga pages for panel detection.

## Hosting

This is a static website that can be published with GitHub Pages. The root `index.html` redirects to `manga.html`. The original repository's other tool source files are retained for provenance and compatibility, but are not linked from the visible site.

## License

MIT — see [LICENSE](LICENSE). Original author: **Eszter Schuffert** (© 2026).

Icons: [Tabler Icons](https://tabler.io/icons) by Paweł Kuna, MIT License.
