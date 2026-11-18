/* Detector variants test/panels/eval.cjs can score. Each is
 *   { models: [file, ...] | (ctx) => [...], run: async (ctx, rgba, w, h, info) => frames }
 * where info is {id, rtl, columnMajor} for the page and frames are [x1, y1, x2, y2] panel boxes
 * in the page's pixels, in any order (the harness sorts them the way the converter does).
 * `models` is what the variant downloads, for the size column and to skip a variant whose files
 * are absent. */
"use strict";

const path = require("path");
const yolo = require("../../js/yolo.js");
const manga = require("../../js/manga-core.js");

const SHIPPED = path.join(__dirname, "..", "..", yolo.YOLO_MODEL_URL);

module.exports = {
  // The white-gutter heuristic: the converter's fallback, with no model at all.
  grid: {
    models: [],
    async run(ctx, rgba, w, h) {
      return manga.detectPanelsGrid(manga.grayFromRGBA(rgba, w, h), w, h);
    },
  },
  // What the converter ships: the model on the page, then the same clean-up the conversion applies
  // (missed art recovered, blank boxes dropped, a page-sized frame tried with the grid).
  shipped: {
    models: [SHIPPED],
    async run(ctx, rgba, w, h) {
      const session = await ctx.session(SHIPPED);
      const gray = manga.grayFromRGBA(rgba, w, h);
      const detected = await yolo.detectPanelsYolo(session, ctx.ort, rgba, w, h, undefined, gray);
      const page = { gray, w, h };
      return yolo.detectPanels(detected, page, page).frames;
    },
  },
};
