/* Shared UI helpers for the Matcha Reader Tools pages. */
"use strict";

function $(id) { return document.getElementById(id); }

/* Append a line to the run log, keeping the log scrolled to the bottom. */
function logLine(text, cls) {
  const log = $("log");
  if (!log) return;
  const div = document.createElement("div");
  div.textContent = text;
  if (cls) div.className = cls;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  log.hidden = false;
}

function clearLog() {
  const log = $("log");
  if (log) { log.textContent = ""; log.hidden = true; }
}

function setProgress(done, total, label) {
  const bar = $("progress-bar");
  const text = $("progress-text");
  const wrap = $("progress");
  if (!bar) return;
  wrap.hidden = false;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  bar.style.width = pct + "%";
  text.textContent = label !== undefined ? label : `${done} / ${total}`;
}

function hideProgress() {
  const wrap = $("progress");
  if (wrap) wrap.hidden = true;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function readFileBytes(file) {
  return file.arrayBuffer().then((ab) => new Uint8Array(ab));
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* Run `fn(item, index)` over items with at most `limit` in flight. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* Keep the screen awake during long conversions (best-effort). */
class WakeLock {
  constructor() { this.sentinel = null; this._onVis = null; }
  async acquire() {
    if (!("wakeLock" in navigator)) return;
    try {
      this.sentinel = await navigator.wakeLock.request("screen");
      this._onVis = async () => {
        if (document.visibilityState === "visible" && this.sentinel !== null) {
          try { this.sentinel = await navigator.wakeLock.request("screen"); } catch (e) { /* best-effort */ }
        }
      };
      document.addEventListener("visibilitychange", this._onVis);
    } catch (e) { /* best-effort: denied on some browsers/power states */ }
  }
  release() {
    if (this._onVis) { document.removeEventListener("visibilitychange", this._onVis); this._onVis = null; }
    if (this.sentinel) { this.sentinel.release().catch(() => {}); this.sentinel = null; }
  }
}

/* Persist small settings (API key, options) in localStorage. */
function loadSetting(key, fallback) {
  try {
    const v = localStorage.getItem("matcha-tools/" + key);
    return v === null ? fallback : v;
  } catch (e) { return fallback; }
}

function saveSetting(key, value) {
  try { localStorage.setItem("matcha-tools/" + key, value); } catch (e) { /* private mode */ }
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

/* Strip characters that are unsafe in FAT filenames (SD card target). */
function sanitizeFolderName(name) {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim();
  return cleaned.substring(0, 100) || "Untitled";
}
