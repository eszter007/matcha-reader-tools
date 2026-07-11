# Vendored PDF.js

`pdf.min.mjs` and `pdf.worker.min.mjs` are the unmodified legacy build of
[pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist) **6.1.200**
(Apache-2.0 license, © Mozilla Foundation), vendored so the site stays fully
self-contained (no CDN). `wasm/` holds its image-decoder sidecars
(JPEG2000 / JBIG2 / color management — licenses included) that some scanned
PDFs need. Lazy-loaded by `js/manga-ui.js` only when a PDF is selected.

To upgrade: `npm pack pdfjs-dist@<version>`, copy `legacy/build/pdf.min.mjs`,
`legacy/build/pdf.worker.min.mjs`, and the `wasm/` directory.
