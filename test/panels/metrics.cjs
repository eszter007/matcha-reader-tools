/* Scoring for the panel-detection benchmark (test/panels/eval.cjs).
 *
 * Boxes are [x1, y1, x2, y2] in one pixel space. A ground-truth page lists its panels in
 * reading order; a panel marked `ignore` is one the labeller could not call either way (a
 * borderless vignette, say): a prediction landing on it is neither rewarded nor punished. */
"use strict";

function boxArea(b) {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

function boxIoU(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/* Greedy one-to-one matching, best IoU first: the usual detection-benchmark rule. Returns
 * {pairs: [[predIndex, gtIndex, iou]], unmatchedPred, unmatchedGt}. Pairs below `thr` are not
 * made. Ignored ground truth is matched last, and a prediction it absorbs is dropped from both
 * the false positives and the pairs. */
function matchBoxes(pred, gt, thr, ignore) {
  ignore = ignore || gt.map(() => false);
  const cand = [];
  for (let i = 0; i < pred.length; i++) {
    for (let j = 0; j < gt.length; j++) {
      if (ignore[j]) continue;
      const v = boxIoU(pred[i], gt[j]);
      if (v >= thr) cand.push([v, i, j]);
    }
  }
  cand.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
  const usedP = new Set(), usedG = new Set();
  const pairs = [];
  for (const [v, i, j] of cand) {
    if (usedP.has(i) || usedG.has(j)) continue;
    usedP.add(i); usedG.add(j);
    pairs.push([i, j, v]);
  }
  // A leftover prediction sitting on an ignored panel (IoU >= 0.5, or mostly inside it) is
  // not a false positive.
  const absorbed = new Set();
  for (let i = 0; i < pred.length; i++) {
    if (usedP.has(i)) continue;
    for (let j = 0; j < gt.length; j++) {
      if (!ignore[j]) continue;
      const a = boxArea(pred[i]);
      const ix = Math.max(0, Math.min(pred[i][2], gt[j][2]) - Math.max(pred[i][0], gt[j][0]));
      const iy = Math.max(0, Math.min(pred[i][3], gt[j][3]) - Math.max(pred[i][1], gt[j][1]));
      if (boxIoU(pred[i], gt[j]) >= 0.5 || (a > 0 && (ix * iy) / a >= 0.8)) { absorbed.add(i); break; }
    }
  }
  const unmatchedPred = [];
  for (let i = 0; i < pred.length; i++) if (!usedP.has(i) && !absorbed.has(i)) unmatchedPred.push(i);
  const unmatchedGt = [];
  for (let j = 0; j < gt.length; j++) if (!ignore[j] && !usedG.has(j)) unmatchedGt.push(j);
  return { pairs, unmatchedPred, unmatchedGt };
}

/* Is the predicted reading order right? `pairs` from matchBoxes() on a page where every
 * counted panel was found; the prediction list is in the detector's reading order and the
 * ground truth in the labeller's, so the order is right when walking the ground truth visits
 * the predictions in increasing index. Extra predictions in between do not count against it. */
function readingOrderCorrect(pairs) {
  const byGt = pairs.slice().sort((a, b) => a[1] - b[1]);
  for (let k = 1; k < byGt.length; k++) if (byGt[k][0] < byGt[k - 1][0]) return false;
  return true;
}

/* Score one page. `pred` boxes are in the detector's reading order. */
function scorePage(pred, gtPanels) {
  const gt = gtPanels.map((p) => p.box);
  const ignore = gtPanels.map((p) => !!p.ignore);
  const counted = ignore.filter((x) => !x).length;
  const m50 = matchBoxes(pred, gt, 0.5, ignore);
  const m75 = matchBoxes(pred, gt, 0.75, ignore);
  // Predictions an ignored panel absorbed are not counted either way.
  const predCounted = m50.pairs.length + m50.unmatchedPred.length;
  const allFound50 = m50.unmatchedGt.length === 0;
  return {
    gt: counted,
    pred: predCounted,
    tp50: m50.pairs.length, fp50: m50.unmatchedPred.length, fn50: m50.unmatchedGt.length,
    tp75: m75.pairs.length, fp75: m75.unmatchedPred.length, fn75: m75.unmatchedGt.length,
    meanIoU: m50.pairs.length ? m50.pairs.reduce((s, p) => s + p[2], 0) / m50.pairs.length : null,
    // Exactly right: as many panels as the page has, each one found at IoU >= 0.75.
    exact: m75.unmatchedGt.length === 0 && m75.unmatchedPred.length === 0,
    orderEligible: allFound50 && counted >= 2,
    orderCorrect: allFound50 && counted >= 2 ? readingOrderCorrect(m50.pairs) : null,
  };
}

function prf(tp, fp, fn) {
  const p = tp + fp ? tp / (tp + fp) : 1;
  const r = tp + fn ? tp / (tp + fn) : 1;
  return { p, r, f1: p + r ? (2 * p * r) / (p + r) : 0 };
}

/* Micro-averaged totals over pages. */
function summarize(pageScores) {
  const sum = (k) => pageScores.reduce((s, x) => s + x[k], 0);
  const at50 = prf(sum("tp50"), sum("fp50"), sum("fn50"));
  const at75 = prf(sum("tp75"), sum("fp75"), sum("fn75"));
  const eligible = pageScores.filter((x) => x.orderEligible);
  const ious = pageScores.filter((x) => x.meanIoU !== null);
  return {
    pages: pageScores.length,
    p50: at50.p, r50: at50.r, f150: at50.f1,
    p75: at75.p, r75: at75.r, f175: at75.f1,
    exact: pageScores.filter((x) => x.exact).length / Math.max(1, pageScores.length),
    exactCount: pageScores.filter((x) => x.exact).length,
    orderPages: eligible.length,
    order: eligible.length ? eligible.filter((x) => x.orderCorrect).length / eligible.length : null,
    meanIoU: ious.length ? ious.reduce((s, x) => s + x.meanIoU, 0) / ious.length : null,
  };
}

/* Scale ground-truth boxes from the labelled image's pixels to the evaluated image's. */
function scaleBox(b, sx, sy) {
  return [b[0] * sx, b[1] * sy, b[2] * sx, b[3] * sy];
}

module.exports = { boxArea, boxIoU, matchBoxes, readingOrderCorrect, scorePage, prf, summarize, scaleBox };
