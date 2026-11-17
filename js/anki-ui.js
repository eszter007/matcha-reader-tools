/* anki.html: pick an .apkg, choose decks, download the deck folders for the SD card. */
"use strict";

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

let SQL = null;
let apkg = null, collection = null, decks = [];

async function loadSql() {
  if (!SQL) SQL = await initSqlJs({ locateFile: (f) => "js/vendor/sqljs/" + f });
  return SQL;
}

/* An 8-bit grayscale PNG (as Pillow writes mode "L"): a third of an RGBA one. Rows use the Sub
 * filter; the browser's CompressionStream makes the zlib stream. */
async function grayPng(rgba, w, h) {
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w + 1);
    raw[row] = 1;  // Sub
    let prev = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = Math.round((rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000);
      raw[row + 1 + x] = (l - prev) & 0xff;
      prev = l;
    }
  }
  const idat = new Uint8Array(await new Response(new Blob([raw]).stream()
    .pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr.set([8, 0, 0, 0, 0], 8);  // 8-bit, grayscale, deflate, adaptive filtering, no interlace
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat),
                 chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/* WebP -> grayscale PNG at most 480 px on a side, transparency on white (as the Python tool does
 * with Pillow; the pixels can differ slightly). */
async function webpToPng(bytes) {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/webp" }));
    const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    return await grayPng(d, w, h);
  } catch (e) {
    return null;  // a picture the browser cannot read is left out
  }
}

function isChildOf(name, parent) { return name.startsWith(parent + "::"); }

function renderDeckList() {
  const list = $("anki-decks");
  list.textContent = "";
  const defaults = new Set(defaultDecks(decks).map((d) => d.id));
  for (const deck of decks) {
    const depth = deck.name.split("::").length - 1;
    const label = document.createElement("label");
    label.style.paddingLeft = `${depth * 1.25}rem`;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = deck.id;
    box.checked = defaults.has(deck.id);
    box.className = "anki-deck";
    label.append(box, ` ${deck.name.split("::").pop()} `);
    const count = document.createElement("span");
    count.className = "hint";
    count.textContent = plural(deck.cards, "card");
    label.append(count);
    list.append(label);
  }
  updateSelection();
}

/* A ticked deck includes its subdecks, so their own boxes are switched off. */
function updateSelection() {
  const boxes = [...document.querySelectorAll(".anki-deck")];
  const byId = new Map(decks.map((d) => [d.id, d]));
  const ticked = boxes.filter((b) => b.checked && !b.disabled).map((b) => byId.get(b.value));
  for (const box of boxes) {
    const deck = byId.get(box.value);
    const covered = ticked.some((t) => isChildOf(deck.name, t.name));
    box.disabled = covered;
    if (covered) box.checked = false;
  }
  const chosen = selectedDecks();
  const big = chosen.filter((d) => d.cards > ANKI_MAX_CARDS);
  const warn = $("anki-big");
  warn.hidden = big.length === 0;
  warn.textContent = big.length === 0 ? "" :
    `${big.map((d) => d.name).join(", ")}: more than ${ANKI_MAX_CARDS.toLocaleString()} cards. The reader keeps ` +
    `the first ${ANKI_MAX_CARDS.toLocaleString()} of a deck; tick its subdecks instead to keep them all.`;
  $("anki-run").disabled = chosen.length === 0;
}

function selectedDecks() {
  const byId = new Map(decks.map((d) => [d.id, d]));
  return [...document.querySelectorAll(".anki-deck")].filter((b) => b.checked && !b.disabled)
    .map((b) => byId.get(b.value));
}

async function openPackage(file) {
  clearLog();
  $("anki-step2").hidden = true;
  if (apkg) { apkg.db.close(); apkg = null; }
  try {
    logLine(`Reading ${file.name} (${formatBytes(file.size)})…`);
    await loadSql();
    apkg = await openApkg(await readFileBytes(file), { SQL, fzstd });
    collection = loadCollection(apkg.db);
    decks = listDecks(apkg.db, collection);
    if (decks.length === 0) { logLine("No cards in this package.", "error"); return; }
    logLine(`${plural(decks.length, "deck")} found.`);
    renderDeckList();
    $("anki-step2").hidden = false;
  } catch (e) {
    logLine(`Error: ${e.message}. Is this an Anki deck package (.apkg)?`, "error");
  }
}

async function build() {
  const chosen = selectedDecks();
  if (!apkg || chosen.length === 0) return;
  const run = $("anki-run");
  run.disabled = true;
  const lock = new WakeLock();
  await lock.acquire();
  try {
    const root = $("anki-folder").value;
    const zip = new ZipWriter();
    const enc = new TextEncoder();
    let total = 0;
    for (const [n, deck] of chosen.entries()) {
      logLine(`${deck.name}…`);
      const result = await exportDeck(apkg, collection, deck, webpToPng,
                                      (done, all, what) => setProgress(done, all, `${deck.name}: ${done} of ${all} ${what}`));
      for (const [name, data] of result.files) {
        zip.addFile(`${root}/${name}`, typeof data === "string" ? enc.encode(data) : data);
      }
      total += result.cards;
      const notes = [];
      if (result.cut) notes.push(`${result.cut.toLocaleString()} cards past the first ${ANKI_MAX_CARDS.toLocaleString()} left out`);
      if (result.tooLarge) notes.push(`${result.tooLarge} too large for the reader (shown as a notice; review them in Anki)`);
      if (result.imagesMissing) notes.push(`${plural(result.imagesMissing, "image")} missing from the package`);
      logLine(`${deck.name}: ${plural(result.cards, "card")}, ${plural(result.images, "image")}` +
              (notes.length ? `; ${notes.join("; ")}` : ""), notes.length ? "warn" : "");
      setProgress(n + 1, chosen.length, `${n + 1} of ${chosen.length} decks`);
    }
    downloadBlob(zip.toBlob(), "anki-decks.zip");
    hideProgress();
    logLine(`Done: ${plural(total, "card")} in ${plural(chosen.length, "deck")}.`);
  } catch (e) {
    hideProgress();
    logLine(`Error: ${e.message}`, "error");
  } finally {
    lock.release();
    run.disabled = false;
  }
}

$("anki-file").addEventListener("change", (e) => { if (e.target.files[0]) openPackage(e.target.files[0]); });
$("anki-run").addEventListener("click", build);
$("anki-decks").addEventListener("change", updateSelection);
$("anki-folder").value = loadSetting("anki-folder", ".system");
$("anki-folder").addEventListener("change", (e) => saveSetting("anki-folder", e.target.value));
