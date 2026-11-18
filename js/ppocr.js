/* PP-OCRv6_manga in the browser: manga text detection and recognition, Japanese and Chinese.
 *
 * Models by Kellenok (https://huggingface.co/Kellenok/PP-OCRv6_manga, Apache-2.0), fine-tuned from
 * PaddlePaddle's PP-OCRv6 on manga (v0.3): a 0.9 MB line detector and a 10.7 MB recogniser, run with the
 * same vendored ONNX Runtime Web (WASM) as panel detection. Nothing leaves the browser.
 *
 * The pipeline follows the model card's reference (examples/onnx_openvino.py): detector input with
 * the long side at 960, DB post-processing (thresh 0.15, box_thresh 0.25, unclip 1.5), each line
 * cropped, vertical ones turned 90° anticlockwise, resized to 48 px high, and CTC-decoded. Manga
 * lettering is axis-aligned, so connected regions and their bounding boxes stand in for OpenCV's
 * contours and rotated rectangles. The lines are then grouped into speech bubbles and returned as a
 * mokuro page record, so mokuro's mapping and panel assignment take it from there.
 */

/* global ort */
const PPOCR_DIR = "models/ppocr/";
const PPOCR_DET_MODEL = "manga_det_fp16.onnx";
const PPOCR_REC_MODEL = "manga_rec_fp16.onnx";
const PPOCR_DICT = "ppocrv6_dict.txt";
const PPOCR_DET_LONG_SIDE = 960;
const PPOCR_THRESH = 0.15;
const PPOCR_BOX_THRESH = 0.25;
const PPOCR_UNCLIP = 1.5;  // the model card's recommended setting (its example script uses 1.4)
const PPOCR_REC_HEIGHT = 48;
// Detector normalisation, per channel in the model's B, G, R order.
const PPOCR_MEAN = [0.485, 0.456, 0.406];
const PPOCR_STD = [0.229, 0.224, 0.225];

/* ── Pure helpers (unit-tested) ───────────────────────────────────── */

/* Detector input size: long side 960 in multiples of 32; a strip longer than 2:1 gets the pixel
 * budget of a 3:4 page at 960 instead. */
function ppocrDetSize(w, h) {
  const ratio = Math.max(w, h) / Math.min(w, h) > 2
    ? Math.min(1, Math.sqrt((0.75 * 960 * 960) / (w * h)))
    : PPOCR_DET_LONG_SIDE / Math.max(w, h);
  return {
    w: Math.max(Math.round((w * ratio) / 32) * 32, 32),
    h: Math.max(Math.round((h * ratio) / 32) * 32, 32),
  };
}

/* DB post-processing on the detector's probability map: one [x1, y1, x2, y2] (map pixels) per
 * confident text region, grown by the unclip distance the DB kernel shrank it by. */
function ppocrDbBoxes(pred, mw, mh, thresh = PPOCR_THRESH, boxThresh = PPOCR_BOX_THRESH, unclip = PPOCR_UNCLIP) {
  const seen = new Uint8Array(mw * mh);
  const stack = new Int32Array(mw * mh);
  const boxes = [];
  for (let start = 0; start < mw * mh; start++) {
    if (seen[start] || pred[start] <= thresh) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let n = 0, sum = 0, x1 = mw, y1 = mh, x2 = -1, y2 = -1;
    while (top) {
      const i = stack[--top];
      const x = i % mw, y = (i - x) / mw;
      n++;
      sum += pred[i];
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= mh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= mw) continue;
          const j = ny * mw + nx;
          if (!seen[j] && pred[j] > thresh) { seen[j] = 1; stack[top++] = j; }
        }
      }
    }
    if (n < 4 || sum / n < boxThresh) continue;
    const bw = x2 - x1, bh = y2 - y1;
    if (bw <= 0 || bh <= 0) continue;
    // PaddleOCR's unclip: a constant offset of area * ratio / perimeter.
    const d = (n * unclip) / (2 * (bw + bh));
    const box = [x1 - d, y1 - d, x2 + d, y2 + d];
    if (Math.min(box[2] - box[0], box[3] - box[1]) < 3) continue;
    boxes.push(box);
  }
  return boxes;
}

/* Greedy CTC: the most likely symbol per step, repeats and blanks (index 0) dropped. */
function ppocrCtcDecode(logits, steps, classes, vocab) {
  let text = "";
  let prev = -1;
  for (let t = 0; t < steps; t++) {
    let best = 0, bestV = -Infinity;
    const base = t * classes;
    for (let c = 0; c < classes; c++) {
      const v = logits[base + c];
      if (v > bestV) { bestV = v; best = c; }
    }
    if (best !== 0 && best !== prev && best < vocab.length) text += vocab[best];
    prev = best;
  }
  return text;
}

/* The recogniser's input width for a line `w` x `h` (after turning vertical lines): its natural
 * width at 48 px high, as the reference does, capped so a page-long stroke cannot make a huge tensor. */
const PPOCR_REC_MAX_WIDTH = 3200;
function ppocrRecWidth(w, h) {
  const natural = Math.round((PPOCR_REC_HEIGHT * w) / Math.max(1, h));
  return Math.max(16, Math.min(PPOCR_REC_MAX_WIDTH, natural));
}

/* ── Lines into speech bubbles ──────────────────────────────────────
 * The detector finds printed lines; the device wants one text block per bubble (a saved sentence
 * is a block's text). The columns of a bubble share orientation and size, sit side by side with a
 * gap narrower than a column and start near the same height. Furigana is the same shape at half
 * the size and is dropped, as are page numbers and stray marks. */

const PPOCR_HAS_CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ々〆ヵヶ]/u;
const PPOCR_KANA_ONLY = /^[぀-ヿー・]+$/u;

function ppocrLineText(text) {
  return String(text).trim().replace(/(?:･･･|．．．|・・・|\.\.\.)/g, "…")
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function ppocrThickness(l) { return l.vertical ? l.box[2] - l.box[0] : l.box[3] - l.box[1]; }
function ppocrOverlap(a1, a2, b1, b2) { return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1)); }

function ppocrIsFurigana(line, others) {
  if (!PPOCR_KANA_ONLY.test(line.text.replace(/ /g, ""))) return false;
  const t = ppocrThickness(line);
  const [lx1, ly1, lx2, ly2] = line.box;
  return others.some((o) => {
    if (o === line || o.vertical !== line.vertical || ppocrThickness(o) < 1.6 * t) return false;
    const [ox1, oy1, ox2, oy2] = o.box;
    if (line.vertical) {
      return ppocrOverlap(ly1, ly2, oy1, oy2) > 0.5 * (ly2 - ly1)
        && (Math.abs(lx1 - ox2) < 0.6 * t || Math.abs(ox1 - lx2) < 0.6 * t || ppocrOverlap(lx1, lx2, ox1, ox2) > 0);
    }
    return ppocrOverlap(lx1, lx2, ox1, ox2) > 0.5 * (lx2 - lx1)
      && (Math.abs(ly2 - oy1) < 0.6 * t || Math.abs(oy2 - ly1) < 0.6 * t || ppocrOverlap(ly1, ly2, oy1, oy2) > 0);
  });
}

function ppocrSameBubble(a, b) {
  if (a.vertical !== b.vertical) return false;
  const ta = ppocrThickness(a), tb = ppocrThickness(b);
  if (!(ta / tb >= 0.7 && ta / tb <= 1.43)) return false;
  const t = Math.max(ta, tb);
  const [ax1, ay1, ax2, ay2] = a.box, [bx1, by1, bx2, by2] = b.box;
  if (a.vertical) {
    return Math.max(bx1 - ax2, ax1 - bx2) < 0.75 * t && Math.abs(ay1 - by1) < 1.5 * t
      && ppocrOverlap(ay1, ay2, by1, by2) > 0.3 * Math.min(ay2 - ay1, by2 - by1);
  }
  return Math.max(by1 - ay2, ay1 - by2) < 0.75 * t && Math.abs(ax1 - bx1) < 1.5 * t
    && ppocrOverlap(ax1, ax2, bx1, bx2) > 0.3 * Math.min(ax2 - ax1, bx2 - bx1);
}

/* Pieces of one printed line, split where the detector lost a mark such as 〝 〟: same orientation
 * and size, one in line with the other, and close along it. */
function ppocrSameColumn(a, b) {
  if (a.vertical !== b.vertical) return false;
  const ta = ppocrThickness(a), tb = ppocrThickness(b);
  if (!(ta / tb >= 0.7 && ta / tb <= 1.43)) return false;
  const t = Math.max(ta, tb);
  const [ax1, ay1, ax2, ay2] = a.box, [bx1, by1, bx2, by2] = b.box;
  if (a.vertical) {
    return ppocrOverlap(ax1, ax2, bx1, bx2) > 0.6 * Math.min(ta, tb) && Math.max(by1 - ay2, ay1 - by2) < 0.6 * t;
  }
  return ppocrOverlap(ay1, ay2, by1, by2) > 0.6 * Math.min(ta, tb) && Math.max(bx1 - ax2, ax1 - bx2) < 0.6 * t;
}

/* Merge the pieces of a printed line back into one line, read top to bottom (or left to right). */
function ppocrJoinColumns(input) {
  const lines = input.slice();
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < lines.length && !merged; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const a = lines[i], b = lines[j];
        if (!ppocrSameColumn(a, b)) continue;
        const axis = a.vertical ? 1 : 0;
        const [first, second] = a.box[axis] <= b.box[axis] ? [a, b] : [b, a];
        lines[i] = {
          text: first.text + second.text,
          vertical: a.vertical,
          box: [Math.min(a.box[0], b.box[0]), Math.min(a.box[1], b.box[1]),
            Math.max(a.box[2], b.box[2]), Math.max(a.box[3], b.box[3])],
        };
        lines.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  return lines;
}

/* Blocks in reading order: rows of blocks that sit side by side, top to bottom, each row right to
 * left (left to right when not rtl). */
function ppocrReadingOrder(blocks, rtl = true) {
  const rows = [];
  for (const b of blocks.slice().sort((p, q) => p.box[1] - q.box[1])) {
    const [, y1, , y2] = b.box;
    const row = rows.find((r) => ppocrOverlap(y1, y2, r.top, r.bottom) > 0.5 * Math.min(y2 - y1, r.bottom - r.top));
    if (row) {
      row.top = Math.min(row.top, y1);
      row.bottom = Math.max(row.bottom, y2);
      row.blocks.push(b);
    } else {
      rows.push({ top: y1, bottom: y2, blocks: [b] });
    }
  }
  return rows.sort((p, q) => p.top - q.top)
    .flatMap((r) => r.blocks.sort(rtl ? (p, q) => q.box[2] - p.box[2] : (p, q) => p.box[0] - q.box[0]));
}

/* lines: [{text, box: [x1, y1, x2, y2], vertical}] → a mokuro page record's blocks, in reading order
 * (right to left unless rtl is false). */
function ppocrBubbles(lines, rtl = true) {
  const kept = ppocrJoinColumns(lines.map((l) => ({ ...l, text: ppocrLineText(l.text) })))
    .filter((l) => l.text && (PPOCR_HAS_CJK.test(l.text) || l.text.length >= 4));
  const lines2 = kept.filter((l) => !ppocrIsFurigana(l, kept));
  const parent = lines2.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < lines2.length; i++) {
    for (let j = i + 1; j < lines2.length; j++) {
      if (ppocrSameBubble(lines2[i], lines2[j])) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  lines2.forEach((l, i) => {
    const k = find(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  });
  const blocks = [];
  for (const group of groups.values()) {
    const vertical = group[0].vertical;
    // Columns right to left; rows top to bottom.
    group.sort(vertical ? (a, b) => b.box[2] - a.box[2] : (a, b) => a.box[1] - b.box[1]);
    blocks.push({
      box: [Math.min(...group.map((l) => l.box[0])), Math.min(...group.map((l) => l.box[1])),
        Math.max(...group.map((l) => l.box[2])), Math.max(...group.map((l) => l.box[3]))].map(Math.round),
      vertical,
      lines: group.map((l) => l.text),
      lines_coords: group.map(({ box: [x1, y1, x2, y2] }) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]),
    });
  }
  return ppocrReadingOrder(blocks, rtl);
}

/* ── Half precision ─────────────────────────────────────────────────
 * The FP16 models take and return float16 tensors, which ONNX Runtime Web passes as raw bits in a
 * Uint16Array. */

const f16Scratch = new DataView(new ArrayBuffer(4));

/* A float32 as float16 bits, rounded to nearest even. */
function ppocrToHalf(v) {
  f16Scratch.setFloat32(0, v);
  const x = f16Scratch.getUint32(0);
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);  // Inf, NaN
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;  // overflow to Inf
  if (e <= 0) {  // subnormal or zero
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rest = mant & ((1 << shift) - 1), mid = 1 << (shift - 1);
    if (rest > mid || (rest === mid && (half & 1))) half++;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  const rest = mant & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && (half & 1))) half++;  // may carry into the exponent
  return sign | half;
}

/* Float16 bits as a number. */
function ppocrFromHalf(h) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f, mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

/* A tensor's values as plain numbers, whether it came back as float32 or as float16 bits. */
function ppocrValues(tensor) {
  if (tensor.type !== "float16" || !(tensor.data instanceof Uint16Array)) return tensor.data;
  const out = new Float32Array(tensor.data.length);
  for (let i = 0; i < out.length; i++) out[i] = ppocrFromHalf(tensor.data[i]);
  return out;
}

/* ── Inference ─────────────────────────────────────────────────── */

let ppocrLoadPromise = null;

/* Sessions and dictionary, fetched once. `loadOrt` brings the shared ONNX Runtime in. */
function loadPpocr(loadOrt) {
  if (!ppocrLoadPromise) {
    ppocrLoadPromise = (async () => {
      await loadOrt();
      const fetchBytes = async (name) => {
        const resp = await fetch(PPOCR_DIR + name);
        if (!resp.ok) throw new Error(`${name}: download failed (HTTP ${resp.status})`);
        return new Uint8Array(await resp.arrayBuffer());
      };
      const parts = await Promise.allSettled([
        fetchBytes(PPOCR_DET_MODEL).then((b) => ort.InferenceSession.create(b, { executionProviders: ["wasm"] })),
        fetchBytes(PPOCR_REC_MODEL).then((b) => ort.InferenceSession.create(b, { executionProviders: ["wasm"] })),
        fetchBytes(PPOCR_DICT).then((b) => new TextDecoder().decode(b)),
      ]);
      const failed = parts.find((p) => p.status === "rejected");
      if (failed) {
        // Free whichever model did load; the next attempt starts over.
        for (const p of parts.slice(0, 2)) if (p.status === "fulfilled") p.value.release().catch(() => {});
        throw failed.reason;
      }
      const [det, rec, dict] = parts.map((p) => p.value);
      // Index 0 is the CTC blank; the dictionary follows, then a space.
      const vocab = ["", ...dict.split(/\r?\n/).filter((l, i, all) => i < all.length - 1 || l !== ""), " "];
      // Whether each model takes float16 input (the FP16 export) or float32.
      const half = (s) => (s.inputMetadata && s.inputMetadata[0] && s.inputMetadata[0].type) === "float16";
      return { det, rec, vocab, detHalf: half(det), recHalf: half(rec) };
    })().catch((e) => { ppocrLoadPromise = null; throw e; });
  }
  return ppocrLoadPromise;
}

function ppocrCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/* RGBA pixels to a [1, 3, h, w] tensor in B, G, R plane order, float16 when `half`. */
function ppocrTensor(rgba, w, h, mean, std, half) {
  const plane = w * h;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const r = rgba[4 * i] / 255, g = rgba[4 * i + 1] / 255, b = rgba[4 * i + 2] / 255;
    out[i] = (b - mean[0]) / std[0];
    out[plane + i] = (g - mean[1]) / std[1];
    out[2 * plane + i] = (r - mean[2]) / std[2];
  }
  if (!half) return new ort.Tensor("float32", out, [1, 3, h, w]);
  const bits = new Uint16Array(out.length);
  for (let i = 0; i < out.length; i++) bits[i] = ppocrToHalf(out[i]);
  return new ort.Tensor("float16", bits, [1, 3, h, w]);
}

/* Lines on one image (an ImageBitmap or canvas, w x h), in its pixels. */
async function ppocrReadLines(engine, image, w, h) {
  const size = ppocrDetSize(w, h);
  const detCanvas = ppocrCanvas(size.w, size.h);
  const dctx = detCanvas.getContext("2d", { willReadFrequently: true });
  dctx.fillStyle = "#ffffff";
  dctx.fillRect(0, 0, size.w, size.h);
  dctx.drawImage(image, 0, 0, size.w, size.h);
  const detIn = ppocrTensor(dctx.getImageData(0, 0, size.w, size.h).data, size.w, size.h, PPOCR_MEAN, PPOCR_STD,
    engine.detHalf);
  const detOut = await engine.det.run({ [engine.det.inputNames[0]]: detIn });
  const pred = ppocrValues(detOut[engine.det.outputNames[0]]);
  const sx = w / size.w, sy = h / size.h;

  const lines = [];
  for (const [bx1, by1, bx2, by2] of ppocrDbBoxes(pred, size.w, size.h)) {
    const x1 = Math.max(0, Math.round(bx1 * sx)), y1 = Math.max(0, Math.round(by1 * sy));
    const x2 = Math.min(w, Math.round(bx2 * sx)), y2 = Math.min(h, Math.round(by2 * sy));
    const cw = x2 - x1, ch = y2 - y1;
    if (cw < 2 || ch < 2) continue;
    const vertical = ch > cw;
    // A vertical line is turned 90° anticlockwise so it reads left to right.
    const tw = vertical ? ppocrRecWidth(ch, cw) : ppocrRecWidth(cw, ch);
    const recCanvas = ppocrCanvas(tw, PPOCR_REC_HEIGHT);
    const rctx = recCanvas.getContext("2d", { willReadFrequently: true });
    // Transparent pixels would reach the model as black.
    rctx.fillStyle = "#ffffff";
    rctx.fillRect(0, 0, tw, PPOCR_REC_HEIGHT);
    rctx.imageSmoothingEnabled = true;
    rctx.imageSmoothingQuality = "high";
    if (vertical) {
      rctx.translate(0, PPOCR_REC_HEIGHT);
      rctx.rotate(-Math.PI / 2);
      rctx.drawImage(image, x1, y1, cw, ch, 0, 0, PPOCR_REC_HEIGHT, tw);
    } else {
      rctx.drawImage(image, x1, y1, cw, ch, 0, 0, tw, PPOCR_REC_HEIGHT);
    }
    rctx.setTransform(1, 0, 0, 1, 0, 0);
    const recIn = ppocrTensor(rctx.getImageData(0, 0, tw, PPOCR_REC_HEIGHT).data, tw, PPOCR_REC_HEIGHT,
      [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], engine.recHalf);
    const recOut = (await engine.rec.run({ [engine.rec.inputNames[0]]: recIn }))[engine.rec.outputNames[0]];
    const [, steps, classes] = recOut.dims;
    const text = ppocrCtcDecode(ppocrValues(recOut), steps, classes, engine.vocab);
    if (text) lines.push({ text, box: [x1, y1, x2, y2], vertical });
  }
  return lines;
}

/* One page as a mokuro page record, measured on the image given. */
async function ppocrReadPage(engine, image, w, h, rtl = true) {
  return { img_width: w, img_height: h, blocks: ppocrBubbles(await ppocrReadLines(engine, image, w, h), rtl) };
}

if (typeof module !== "undefined") {
  module.exports = {
    ppocrDetSize, ppocrDbBoxes, ppocrCtcDecode, ppocrRecWidth, ppocrLineText, ppocrBubbles, ppocrJoinColumns,
    ppocrReadingOrder,
    ppocrToHalf, ppocrFromHalf, ppocrValues,
  };
}
