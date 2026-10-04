/* Furigana & Pinyin page wiring. The annotators live in pinyin-ruby.js and furigana-ruby.js. */
"use strict";

async function readRubyText(file) {
  let bytes = await readFileBytes(file);
  if (file.name.toLowerCase().endsWith(".gz")) bytes = await gunzip(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

/* Show what applies to the chosen language and method. Japanese has no dictionary method. */
function updateRubyUi() {
  const lang = $("ruby-lang").value;
  const methodSel = $("ruby-method");
  const dictOption = methodSel.querySelector('option[value="dict"]');
  dictOption.disabled = lang === "ja";
  if (lang === "ja") methodSel.value = "ai";
  const ai = methodSel.value === "ai";
  $("ruby-ai-fields").hidden = !ai;
  $("ruby-zh-fields").hidden = lang !== "zh";
  $("ruby-method-hint").textContent = lang === "ja"
    ? "Japanese furigana is read in context by Gemini; there is no dictionary method (see below)."
    : ai ? "Gemini picks each character's reading in context; CC-CEDICT checks it and fills in anything it misses."
         : "Readings come from CC-CEDICT, word by word. Nothing leaves this device.";
  saveSetting("ruby-lang", lang);
  if (lang === "zh") saveSetting("ruby-method", methodSel.value);
}

async function runRuby() {
  const lang = $("ruby-lang").value;
  const ai = $("ruby-method").value === "ai";
  const epubFile = $("ruby-epub").files[0];
  if (!epubFile) { logLine("Choose the EPUB first.", "warn"); return; }
  const cedictFile = $("ruby-cedict").files[0];
  if (lang === "zh" && !cedictFile) { logLine("Chinese needs the CC-CEDICT file.", "warn"); return; }
  const apiKey = $("ruby-key").value.trim();
  const model = $("ruby-model").value.trim() || RUBY_GEMINI_MODEL;
  if (ai && !apiKey) { logLine("AI needs a Gemini API key.", "warn"); return; }
  if (ai) {
    saveSetting("gemini-key", apiKey);
    saveSetting("gemini-model", model);
  }

  const button = $("ruby-run");
  button.disabled = true;
  clearLog();
  const wakeLock = new WakeLock();
  await wakeLock.acquire();
  try {
    const warn = (msg) => logLine("  " + msg, "warn");
    const epubBytes = await readFileBytes(epubFile);
    let annotate;
    let suffix;
    let docLabel = "";
    const onBatch = (done, total, ok) => {
      setProgress(done, total, `${docLabel}: request ${done}/${total}`);
      if (!ok) warn("No usable answer for one batch; " + (lang === "ja" ? "left without furigana" : "dictionary readings kept"));
    };

    if (lang === "ja") {
      suffix = "-furigana.epub";
      let added = 0;
      annotate = async (name, doc) => {
        docLabel = name;
        const furigana = await contextualFurigana(documentPassages(doc),
          (batch) => askPerPassage(batch, FURIGANA_AI_PROMPT, apiKey, model, warn), onBatch);
        let n = 0;
        for (const spans of furigana.values()) n += spans.length;
        added += n;
        logLine(`  ${name}: ${n.toLocaleString()} readings added`);
        return annotateFurigana(doc, furigana);
      };
      const result = await rewriteEpub(epubBytes, annotate, (done, total, name) => setProgress(done, total, `Annotated ${done}/${total}: ${name}`));
      finish(result, epubFile, suffix, `${added.toLocaleString()} readings`);
      return;
    }

    setProgress(0, 1, "Reading CC-CEDICT…");
    await sleep(0);
    const charReadings = ai ? new Map() : null;
    const words = loadCedictReadings(await readRubyText(cedictFile), charReadings);
    logLine(`CC-CEDICT: ${words.size.toLocaleString()} headwords`);
    let skip = new Set();
    const skipTop = parseInt($("ruby-skip-top").value, 10) || 0;
    if (skipTop > 0) {
      const freqFile = $("ruby-frequency").files[0];
      if (!freqFile) throw new Error("Leaving the commonest words bare needs a frequency list.");
      skip = topWords(loadFrequency(await readRubyText(freqFile)).priorities, skipTop);
      logLine(`Skipping the ${skip.size.toLocaleString()} commonest words`);
    }
    const zhuyin = $("ruby-zhuyin").checked;
    suffix = zhuyin ? "-zhuyin.epub" : "-pinyin.epub";
    annotate = async (name, doc) => {
      docLabel = name;
      let contextual = null;
      if (ai) {
        contextual = await contextualReadings(documentPassages(doc), charReadings,
          (batch) => askPerPassage(batch, PINYIN_AI_PROMPT, apiKey, model, warn), onBatch);
        let n = 0;
        for (const m of contextual.values()) n += m.size;
        logLine(`  ${name}: ${n.toLocaleString()} readings confirmed in context`);
      }
      return annotateXhtml(doc, words, skip, zhuyin, contextual);
    };
    const result = await rewriteEpub(epubBytes, annotate, (done, total, name) => setProgress(done, total, `Annotated ${done}/${total}: ${name}`));
    finish(result, epubFile, suffix, "");
  } catch (e) {
    logLine("Error: " + e.message, "error");
    console.error(e);
  } finally {
    button.disabled = false;
    wakeLock.release();
  }
}

function finish(result, epubFile, suffix, extra) {
  const outName = epubFile.name.replace(/\.epub$/i, "") + suffix;
  logLine(`Done — ${result.changed} document(s) annotated${extra ? ", " + extra : ""}, ${formatBytes(result.blob.size)}.`);
  downloadBlob(result.blob, outName);
  setProgress(1, 1, "Complete");
}

if (typeof document !== "undefined" && document.getElementById("ruby-run")) {
  $("ruby-run").addEventListener("click", runRuby);
  $("ruby-key").value = loadSetting("gemini-key", "");
  $("ruby-model").value = loadSetting("gemini-model", RUBY_GEMINI_MODEL);
  const lang = loadSetting("ruby-lang", "ja");
  if (lang === "ja" || lang === "zh") $("ruby-lang").value = lang;
  const method = loadSetting("ruby-method", "dict");
  if (method === "dict" || method === "ai") $("ruby-method").value = method;
  $("ruby-lang").addEventListener("change", () => {
    if ($("ruby-lang").value === "zh") $("ruby-method").value = loadSetting("ruby-method", "dict");
    updateRubyUi();
  });
  $("ruby-method").addEventListener("change", updateRubyUi);
  updateRubyUi();
}
