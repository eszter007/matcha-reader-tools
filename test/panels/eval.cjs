#!/usr/bin/env node
/* Panel-detection benchmark: runs detector variants over a labelled page set and scores them.
 *
 *   python3 test/panels/prepare.py EVAL_DIR            # once: decode pages to raw RGBA
 *   node test/panels/eval.cjs EVAL_DIR [options]
 *
 * Options:
 *   --variants a,b      variants to run (default: every one in the variants module)
 *   --extra FILE.cjs    another module of variants, merged over the built-in ones
 *   --size full|device  score at full resolution (default: the converter detects on the page
 *                       before it is reduced to the screen) or fitted to the device screen;
 *                       prepare.py must have written that size
 *   --device WxH        screen for --size device (default 480x800, the X4 / X4 Pro)
 *   --threads N         ONNX Runtime WASM threads (default 1: GitHub Pages is not
 *                       cross-origin isolated, so the browser gets no threads either)
 *   --pages p01,p02     only these pages
 *   --json FILE         write per-page results
 *   --verbose           print every page's misses
 *
 * Needs onnxruntime-web (`npm install onnxruntime-web`, or ORT_WEB=/path/to/onnxruntime-web).
 * Scoring is in metrics.cjs; the label format is in README.md. */
"use strict";

const fs = require("fs");
const path = require("path");
const metrics = require("./metrics.cjs");
const manga = require("../../js/manga-core.js");

function parseArgs(argv) {
  const o = { evalDir: null, variants: null, extra: null, size: "full", device: [480, 800], threads: 1,
              pages: null, json: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--variants") o.variants = next().split(",");
    else if (a === "--extra") o.extra = path.resolve(next());
    else if (a === "--size") o.size = next();
    else if (a === "--device") o.device = next().split("x").map(Number);
    else if (a === "--threads") o.threads = Number(next());
    else if (a === "--pages") o.pages = new Set(next().split(","));
    else if (a === "--json") o.json = next();
    else if (a === "--verbose") o.verbose = true;
    else if (!o.evalDir) o.evalDir = a;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.evalDir) throw new Error("usage: eval.cjs EVAL_DIR [options]");
  return o;
}

function loadOrt() {
  try {
    return require(process.env.ORT_WEB || "onnxruntime-web");
  } catch (e) {
    console.error("onnxruntime-web not found: npm install onnxruntime-web, or set ORT_WEB");
    process.exit(2);
  }
}

/* Reading direction for sortPanelsReadingOrder(), from the page's labelled layout. */
function layoutFlags(layout) {
  switch (layout) {
    case "ltr": return { rtl: false, columnMajor: false };
    case "yonkoma-rtl": return { rtl: true, columnMajor: true };
    case "yonkoma-ltr": return { rtl: false, columnMajor: true };
    default: return { rtl: true, columnMajor: false };
  }
}

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const ort = loadOrt();
  ort.env.wasm.numThreads = o.threads;
  ort.env.logLevel = "error";

  const variants = Object.assign({}, require("./variants.cjs"), o.extra ? require(o.extra) : {});
  // A key starting with "_" is a helper a variants module exports, not a variant.
  const names = o.variants || Object.keys(variants).filter((n) => !n.startsWith("_"));
  for (const n of names) if (!variants[n]) throw new Error(`no variant ${n}`);

  const labels = JSON.parse(fs.readFileSync(path.join(o.evalDir, "labels.json"), "utf-8"));
  const pages = labels.pages.filter((p) => !o.pages || o.pages.has(p.id));
  const sessionCache = new Map();
  const ctx = {
    ort,
    repoRoot: path.join(__dirname, "..", ".."),
    async session(file) {
      if (!sessionCache.has(file)) {
        const bytes = new Uint8Array(fs.readFileSync(file));
        sessionCache.set(file, await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] }));
      }
      return sessionCache.get(file);
    },
  };

  const results = {};
  const table = [];
  for (const name of names) {
    const v = variants[name];
    const files = (typeof v.models === "function" ? v.models(ctx) : v.models) || [];
    const missing = files.filter((f) => !fs.existsSync(f));
    if (missing.length) {
      console.log(`${name}: skipped (missing ${missing.map((f) => path.basename(f)).join(", ")})`);
      continue;
    }
    const sizeBytes = files.reduce((s, f) => s + fs.statSync(f).size, 0);
    const pageScores = [];
    const times = [];
    const perPage = [];
    let warmed = false;
    for (const page of pages) {
      let w = page.width, h = page.height;
      if (o.size === "device") {
        const fit = manga.fitToDeviceSize(w, h, o.device);
        w = fit.w; h = fit.h;
      }
      const raw = path.join(o.evalDir, "cache", `${page.id}_${w}x${h}.rgba`);
      if (!fs.existsSync(raw)) throw new Error(`${raw} missing: run test/panels/prepare.py${o.size === "device" ? ` --device ${o.device.join("x")}` : ""}`);
      const rgba = new Uint8Array(fs.readFileSync(raw));
      const { rtl, columnMajor } = layoutFlags(page.layout);
      const info = { id: page.id, rtl, columnMajor };
      if (!warmed) { await v.run(ctx, rgba, w, h, info); warmed = true; }
      const t0 = process.hrtime.bigint();
      const frames = await v.run(ctx, rgba, w, h, info);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      times.push(ms);
      const ordered = manga.sortPanelsReadingOrder(frames, rtl, columnMajor);
      const sx = w / page.width, sy = h / page.height;
      const gt = page.panels.map((p) => ({ box: metrics.scaleBox(p.box, sx, sy), ignore: !!p.ignore }));
      const s = metrics.scorePage(ordered, gt);
      pageScores.push(s);
      perPage.push({ id: page.id, ms: Math.round(ms), ...s, boxes: ordered.map((b) => b.map((x) => Math.round(x))) });
      if (o.verbose && (!s.exact || s.orderCorrect === false)) {
        console.log(`  ${name} ${page.id}: gt ${s.gt} pred ${s.pred} tp75 ${s.tp75} fp75 ${s.fp75} fn75 ${s.fn75}` +
                    (s.orderCorrect === false ? " ORDER" : ""));
      }
    }
    const sum = metrics.summarize(pageScores);
    sum.msMean = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
    sum.msMedian = median(times);
    sum.mb = sizeBytes / 1e6;
    results[name] = { summary: sum, pages: perPage };
    table.push([name, sum]);
    const pct = (x) => (x === null ? "  -  " : (100 * x).toFixed(1).padStart(5));
    console.log(`${name.padEnd(28)} P50 ${pct(sum.p50)} R50 ${pct(sum.r50)} F1@50 ${pct(sum.f150)} | ` +
                `P75 ${pct(sum.p75)} R75 ${pct(sum.r75)} F1@75 ${pct(sum.f175)} | exact ${pct(sum.exact)} ` +
                `(${sum.exactCount}/${sum.pages}) order ${pct(sum.order)} (${sum.orderPages}) | ` +
                `IoU ${pct(sum.meanIoU)} | ${sum.msMean.toFixed(0)} ms/page (median ${sum.msMedian.toFixed(0)}) | ` +
                `${sum.mb.toFixed(1)} MB`);
  }
  if (o.json) fs.writeFileSync(o.json, JSON.stringify({ size: o.size, device: o.device, threads: o.threads, results }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
