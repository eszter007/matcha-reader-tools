/* Furigana & Pinyin page wiring. The annotators live in pinyin-ruby.js and furigana-ruby.js. */
"use strict";

// Built-in dictionaries, served with the page: CC-CEDICT for pinyin, IPADIC (kuromoji) for furigana.
const BUILTIN_CEDICT_URL = "data/cedict_1_0_ts_utf-8_mdbg.txt.gz";
const KUROMOJI_DIR = "data/kuromoji/";

async function readRubyText(file) {
  let bytes = await readFileBytes(file);
  if (file.name.toLowerCase().endsWith(".gz")) bytes = await gunzip(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

async function fetchBuiltinCedict() {
  const resp = await fetch(BUILTIN_CEDICT_URL);
  if (!resp.ok) throw new Error(`Could not load the built-in CC-CEDICT (HTTP ${resp.status}).`);
  return new TextDecoder("utf-8").decode(await gunzip(new Uint8Array(await resp.arrayBuffer())));
}

async function loadKuromoji() {
  if (typeof kuromoji === "undefined") await loadScriptOnce("js/vendor/kuromoji/kuromoji.js");
  return new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath: KUROMOJI_DIR }).build((err, tokenizer) => (err ? reject(err) : resolve(tokenizer)));
  });
}

/* Show what applies to the chosen language and method. */
function updateRubyUi() {
  const lang = $("ruby-lang").value;
  const ai = $("ruby-method").value === "ai";
  $("ruby-ai-fields").hidden = !ai;
  $("ruby-zh-fields").hidden = lang !== "zh";
  $("ruby-method-hint").textContent = lang === "ja"
    ? ai ? "Gemini reads each sentence and gives every word its reading there."
         : "Readings come from the built-in Japanese dictionary (IPADIC), word by word. The book stays on this device."
    : ai ? "Gemini picks each character's reading in context; CC-CEDICT checks it and fills in anything it misses."
         : "Readings come from CC-CEDICT, word by word. The book stays on this device.";
  saveSetting("ruby-lang", lang);
  saveSetting("ruby-method", $("ruby-method").value);
}

async function runRuby() {
  const lang = $("ruby-lang").value;
  const ai = $("ruby-method").value === "ai";
  const epubFile = $("ruby-epub").files[0];
  if (!epubFile) { logLine("Choose the EPUB first.", "warn"); return; }
  const cedictFile = $("ruby-cedict").files[0];
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
      let tokenizer = null;
      if (!ai) {
        setProgress(0, 1, "Loading the Japanese dictionary…");
        tokenizer = await loadKuromoji();
      }
      let added = 0;
      annotate = async (name, doc) => {
        docLabel = name;
        const furigana = ai
          ? await contextualFurigana(documentPassages(doc),
              (batch) => askPerPassage(batch, FURIGANA_AI_PROMPT, apiKey, model, warn), onBatch)
          : dictionaryFurigana(documentPassages(doc), (text) => tokenizer.tokenize(text));
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
    const cedictText = cedictFile ? await readRubyText(cedictFile) : await fetchBuiltinCedict();
    const words = loadCedictReadings(cedictText, charReadings);
    logLine(`CC-CEDICT${cedictFile ? "" : " (built-in)"}: ${words.size.toLocaleString()} headwords`);
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
  $("ruby-model").value = loadGeminiModel(RUBY_GEMINI_MODEL);
  const lang = loadSetting("ruby-lang", "ja");
  if (lang === "ja" || lang === "zh") $("ruby-lang").value = lang;
  const method = loadSetting("ruby-method", "dict");
  if (method === "dict" || method === "ai") $("ruby-method").value = method;
  $("ruby-lang").addEventListener("change", updateRubyUi);
  $("ruby-method").addEventListener("change", updateRubyUi);
  updateRubyUi();
}
