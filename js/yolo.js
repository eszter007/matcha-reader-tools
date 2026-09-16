/* YOLO panel detection: browser port of the Python tool's primary detector
 * (convert_manga.py:_detect_panels_yolo), running the same fine-tuned
 * YOLO26-nano model (leoxs22/manga-panel-detector-yolo26n) client-side via
 * ONNX Runtime Web instead of PyTorch.
 *
 * Pure logic only in this file — preprocessing (letterbox), output decoding,
 * and the sliver/dedupe post-processing ported line-for-line from the Python
 * tool. Session creation and lazy runtime loading live in manga-ui.js so
 * Node tests can exercise these functions with onnxruntime-web's wasm
 * backend directly.
 */
"use strict";

const YOLO_INPUT_SIZE = 640;
const YOLO_STRIDE = 32;            // ultralytics LetterBox(auto=True) pads to this multiple
const YOLO_CONF_THRESHOLD = 0.4;   // convert_manga.py:_detect_panels_yolo(conf=0.4)
const YOLO_WEAK_CONF = 0.15;       // convert_manga.py:PANEL_WEAK_CONF
const YOLO_PANEL_CLASS = 0;        // 0=panel, 1=text
const YOLO_TEXT_CLASS = 1;

/* convert_manga.py:TEXT_OWNERSHIP_MIN_FRAC — fraction of a text box's area that
 * must fall inside a panel before that panel is grown to cover it. A bubble
 * straddling a gutter belongs to whichever panel holds most of it; below this it
 * is page furniture (page numbers, credits, a title banner in the margin) that no
 * panel should be stretched to reach. */
const TEXT_OWNERSHIP_MIN_FRAC = 0.25;

/* convert_manga.py:TEXT_PAD_FRAC_OF_PAGE / TEXT_PAD_MIN — breathing room put
 * around a text box before a panel is grown over it. The detector boxes the
 * GLYPHS, not the balloon holding them, so unioning on the bare box lands the
 * crop edge on the bubble's own outline, which reads as a second cut. */
const TEXT_PAD_FRAC_OF_PAGE = 0.02;
const TEXT_PAD_MIN = 6;

/* convert_manga.py:SUBPANEL_* — a frame is replaced by the sub-panels found
 * inside it only when each child is meaningfully smaller than the frame, sits
 * almost entirely within it, the children between them account for most of the
 * frame, and they tile rather than restate each other. */
const SUBPANEL_MAX_AREA_FRAC = 0.7;
const SUBPANEL_INSIDE_FRAC = 0.85;
const SUBPANEL_COVER_FRAC = 0.7;
const SUBPANEL_SIBLING_OVERLAP_FRAC = 0.3;

/* Letterbox an RGBA image into a float32 CHW tensor (RGB, /255), padding with
 * 114-gray. Reproduces ultralytics' LetterBox(new_shape=640, auto=True,
 * stride=32) — the preprocessing `model.predict()` applies — which is
 * RECTANGULAR: the long side is scaled to 640 and the short side is padded only
 * up to the next multiple of 32, not out to a square. Squaring the input
 * instead changes the apparent scale of everything in the page and moves the
 * model's confidences enough to gain and lose whole panels, so this has to
 * match the Python tool exactly.
 *
 * Returns {data, netW, netH, scale, padX, padY}; netW/netH are the tensor's
 * spatial dims and scale/pad map detected boxes back to source pixels. */
function yoloLetterbox(rgba, w, h, size, stride) {
  size = size || YOLO_INPUT_SIZE;
  stride = stride || YOLO_STRIDE;
  const scale = Math.min(size / w, size / h);
  const newW = Math.round(w * scale);
  const newH = Math.round(h * scale);

  // ultralytics: dw/dh are the leftover padding modulo the stride, halved, then
  // split with its round(x-0.1) / round(x+0.1) rule so odd padding favours the
  // bottom/right edge.
  const dw = ((size - newW) % stride) / 2;
  const dh = ((size - newH) % stride) / 2;
  const padX = Math.max(0, Math.round(dw - 0.1));
  const padY = Math.max(0, Math.round(dh - 0.1));
  const netW = newW + padX + Math.max(0, Math.round(dw + 0.1));
  const netH = newH + padY + Math.max(0, Math.round(dh + 0.1));

  const plane = netW * netH;
  const data = new Float32Array(3 * plane).fill(114 / 255);

  for (let y = 0; y < newH; y++) {
    // Bilinear sample positions (align pixel centers, cv2.INTER_LINEAR style).
    const sy = Math.min(Math.max((y + 0.5) / scale - 0.5, 0), h - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, h - 1);
    const fy = sy - y0;
    const row = (padY + y) * netW + padX;
    for (let x = 0; x < newW; x++) {
      const sx = Math.min(Math.max((x + 0.5) / scale - 0.5, 0), w - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, w - 1);
      const fx = sx - x0;
      const p00 = (y0 * w + x0) * 4, p01 = (y0 * w + x1) * 4;
      const p10 = (y1 * w + x0) * 4, p11 = (y1 * w + x1) * 4;
      const w00 = (1 - fy) * (1 - fx), w01 = (1 - fy) * fx;
      const w10 = fy * (1 - fx), w11 = fy * fx;
      const o = row + x;
      for (let c = 0; c < 3; c++) {
        const v = rgba[p00 + c] * w00 + rgba[p01 + c] * w01 +
                  rgba[p10 + c] * w10 + rgba[p11 + c] * w11;
        data[c * plane + o] = v / 255;
      }
    }
  }
  return { data, netW, netH, scale, padX, padY };
}

/* Decode the end-to-end YOLO26 ONNX output — [1, N, 6] rows of
 * (x1, y1, x2, y2, confidence, class) in letterboxed 640x640 pixels — into
 * [box, confidence, class] triples in source-image pixels, keeping everything
 * at or above `conf`. Callers split the classes and apply their own bars;
 * detectPanelsYolo decodes at YOLO_WEAK_CONF because sub-threshold panel boxes
 * are still wanted as corroboration (see yoloSplitFramesOverSubpanels). */
function yoloDecodeOutput(out, rows, lb, imgW, imgH, conf) {
  conf = conf === undefined ? YOLO_CONF_THRESHOLD : conf;
  const decoded = [];
  for (let i = 0; i < rows; i++) {
    const o = i * 6;
    const score = out[o + 4];
    if (score < conf) continue;
    const x1 = Math.min(Math.max((out[o] - lb.padX) / lb.scale, 0), imgW);
    const y1 = Math.min(Math.max((out[o + 1] - lb.padY) / lb.scale, 0), imgH);
    const x2 = Math.min(Math.max((out[o + 2] - lb.padX) / lb.scale, 0), imgW);
    const y2 = Math.min(Math.max((out[o + 3] - lb.padY) / lb.scale, 0), imgH);
    decoded.push([[Math.trunc(x1), Math.trunc(y1), Math.trunc(x2), Math.trunc(y2)],
                  score, Math.round(out[o + 5])]);
  }
  return decoded;
}

/* ── Post-processing ported from convert_manga.py ─────────────── */

function yoloBoxArea(b) {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

function yoloOverlapArea(a, b) {
  const ox1 = Math.max(a[0], b[0]), oy1 = Math.max(a[1], b[1]);
  const ox2 = Math.min(a[2], b[2]), oy2 = Math.min(a[3], b[3]);
  return Math.max(0, ox2 - ox1) * Math.max(0, oy2 - oy1);
}

/* Collapse boxes that substantially overlap into their union (measured
 * against the smaller box so containment is caught either way), highest
 * confidence first. Port of convert_manga.py:_dedupe_boxes. */
function yoloDedupeBoxes(boxesWithConf, overlapThresh) {
  overlapThresh = overlapThresh === undefined ? 0.6 : overlapThresh;
  const ordered = boxesWithConf.slice().sort((a, b) => b[1] - a[1]);
  const kept = [];
  for (const [box] of ordered) {
    const area = yoloBoxArea(box);
    if (area === 0) continue;
    let mergedInto = -1;
    for (let i = 0; i < kept.length; i++) {
      const kArea = yoloBoxArea(kept[i]);
      if (kArea > 0 && yoloOverlapArea(box, kept[i]) / Math.min(area, kArea) > overlapThresh) {
        mergedInto = i;
        break;
      }
    }
    if (mergedInto >= 0) {
      const k = kept[mergedInto];
      kept[mergedInto] = [Math.min(k[0], box[0]), Math.min(k[1], box[1]),
                          Math.max(k[2], box[2]), Math.max(k[3], box[3])];
    } else {
      kept.push(box.slice());
    }
  }
  return kept;
}

/* Degenerate detections: small relative to the page AND extremely elongated.
 * Port of convert_manga.py:is_sliver_panel. */
function isSliverPanel(box, pageW, pageH) {
  const w = Math.max(1, box[2] - box[0]);
  const h = Math.max(1, box[3] - box[1]);
  const areaFrac = (w * h) / Math.max(1, pageW * pageH);
  const aspect = Math.max(w / h, h / w);
  return areaFrac < 0.025 && aspect > 4.0;
}

/* Padding to put around a text box before growing a panel over it, scaled to
 * the page so it behaves the same on a 290px thumbnail and a 2000px scan.
 * Port of convert_manga.py:text_pad_px. */
function yoloTextPadPx(pageW, pageH) {
  return Math.max(TEXT_PAD_MIN, Math.round(Math.min(pageW, pageH) * TEXT_PAD_FRAC_OF_PAGE));
}

/* Grow each panel box to cover the speech bubbles and caption boxes that belong
 * to it. Manga bubbles routinely overhang the frame they are spoken in -- drawn
 * on top of the border, or pushed out into the gutter -- and cropping on the
 * detected frame alone slices the text off mid-word.
 *
 * Ownership is decided against the ORIGINAL panel boxes and on the UNPADDED text
 * box, so neither a panel's growth nor the padding can claim a neighbour's
 * bubbles. Only sides the bubble actually breaches move, so a balloon drawn just
 * inside the frame leaves the crop exactly where it was.
 *
 * Index-preserving: the caller fixes reading order on the frames first, and this
 * returns the expanded boxes in the same order. Port of
 * convert_manga.py:expand_panels_over_text. */
function yoloExpandPanelsOverText(panels, texts, pageW, pageH) {
  if (!texts || !texts.length) return panels;

  const pad = yoloTextPadPx(pageW, pageH);
  const expanded = panels.map((p) => p.slice());
  for (const text of texts) {
    const textArea = yoloBoxArea(text);
    if (textArea <= 0) continue;
    let owner = -1, bestOverlap = 0;
    for (let i = 0; i < panels.length; i++) {
      const overlap = yoloOverlapArea(panels[i], text);
      if (overlap > bestOverlap) { owner = i; bestOverlap = overlap; }
    }
    if (owner < 0 || bestOverlap < textArea * TEXT_OWNERSHIP_MIN_FRAC) continue;
    const base = panels[owner], box = expanded[owner];
    if (text[0] < base[0]) box[0] = Math.min(box[0], text[0] - pad);
    if (text[1] < base[1]) box[1] = Math.min(box[1], text[1] - pad);
    if (text[2] > base[2]) box[2] = Math.max(box[2], text[2] + pad);
    if (text[3] > base[3]) box[3] = Math.max(box[3], text[3] + pad);
  }

  for (const box of expanded) {
    box[0] = Math.max(0, box[0]);
    box[1] = Math.max(0, box[1]);
    box[2] = Math.min(pageW, box[2]);
    box[3] = Math.min(pageH, box[3]);
  }
  return expanded;
}

/* Replace a frame with the sub-panels the model also found inside it.
 *
 * Neighbouring panels come back as one frame when their shared border is faint
 * or their artwork runs across it -- a whole row of a western strip can arrive
 * as a single box. The model usually does see the individual panels, just below
 * the confidence bar, and yoloDedupeBoxes() then folds those weaker boxes into
 * the frame that contains them. This recovers them: a weak box is trusted only
 * where a set of siblings tiles a confident frame, so nothing is admitted that
 * the model did not propose and no frame is split on the strength of one stray
 * box. Port of convert_manga.py:split_frames_over_subpanels. */
function yoloSplitFramesOverSubpanels(frames, candidates) {
  const out = [];
  for (const frame of frames) {
    const frameArea = yoloBoxArea(frame);
    const children = candidates.filter((box) => {
      const area = yoloBoxArea(box);
      return area > 0 && area <= SUBPANEL_MAX_AREA_FRAC * frameArea &&
             yoloOverlapArea(box, frame) >= SUBPANEL_INSIDE_FRAC * area;
    });
    const covered = children.reduce((sum, c) => sum + yoloBoxArea(c), 0);
    if (children.length < 2 || covered < SUBPANEL_COVER_FRAC * frameArea) {
      out.push(frame);
      continue;
    }
    let tiles = true;
    for (let i = 0; i < children.length && tiles; i++) {
      for (let j = i + 1; j < children.length; j++) {
        const smaller = Math.min(yoloBoxArea(children[i]), yoloBoxArea(children[j]));
        if (yoloOverlapArea(children[i], children[j]) > SUBPANEL_SIBLING_OVERLAP_FRAC * smaller) {
          tiles = false;
          break;
        }
      }
    }
    if (tiles) out.push(...children.map((c) => c.slice()));
    else out.push(frame);
  }
  return out;
}

/* Full pipeline for one page: letterbox → inference → decode → sliver filter
 * → dedupe → sub-panel recovery, falling back to one full-page box when nothing
 * is detected — mirrors convert_manga.py:_detect_panels_yolo. Returns
 * {frames, texts}: the frames as drawn (what reading order must be derived
 * from) and the text boxes yoloExpandPanelsOverText() then grows the CROP
 * rectangles over. `session` is an ONNX Runtime InferenceSession for the panel
 * model; `ortApi` is the onnxruntime module (for its Tensor constructor). */
async function detectPanelsYolo(session, ortApi, rgba, w, h, conf) {
  conf = conf === undefined ? YOLO_CONF_THRESHOLD : conf;
  const lb = yoloLetterbox(rgba, w, h);
  const inputName = session.inputNames[0];
  const feeds = {};
  // The model is exported with dynamic height/width so the rectangular
  // letterbox above can be fed as-is, exactly as ultralytics does.
  feeds[inputName] = new ortApi.Tensor("float32", lb.data, [1, 3, lb.netH, lb.netW]);
  const results = await session.run(feeds);
  const output = results[session.outputNames[0]];
  const rows = output.dims[output.dims.length - 2];

  const decoded = yoloDecodeOutput(output.data, rows, lb, w, h, YOLO_WEAK_CONF);
  const strong = [];
  const candidates = [];
  const texts = [];
  for (const [box, score, cls] of decoded) {
    if (cls === YOLO_TEXT_CLASS) {
      if (score >= conf) texts.push(box);  // a weak text box must not grow a crop
      continue;
    }
    if (cls !== YOLO_PANEL_CLASS) continue;
    if (isSliverPanel(box, w, h)) continue;
    candidates.push(box);
    if (score >= conf) strong.push([box, score]);
  }

  const boxes = yoloDedupeBoxes(strong);
  if (!boxes.length) return { frames: [[0, 0, w, h]], texts };
  return { frames: yoloSplitFramesOverSubpanels(boxes, candidates), texts };
}

if (typeof module !== "undefined") {
  module.exports = {
    YOLO_INPUT_SIZE, YOLO_STRIDE, YOLO_CONF_THRESHOLD, YOLO_WEAK_CONF,
    YOLO_PANEL_CLASS, YOLO_TEXT_CLASS,
    TEXT_OWNERSHIP_MIN_FRAC, TEXT_PAD_FRAC_OF_PAGE, TEXT_PAD_MIN,
    SUBPANEL_MAX_AREA_FRAC, SUBPANEL_INSIDE_FRAC, SUBPANEL_COVER_FRAC,
    SUBPANEL_SIBLING_OVERLAP_FRAC,
    yoloLetterbox, yoloDecodeOutput, yoloDedupeBoxes, isSliverPanel,
    yoloBoxArea, yoloOverlapArea, yoloTextPadPx, yoloExpandPanelsOverText,
    yoloSplitFramesOverSubpanels, detectPanelsYolo,
  };
}
