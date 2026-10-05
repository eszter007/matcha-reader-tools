/* Dictionary converter: page wiring. Conversion logic lives in dict.js (Japanese formats),
 * dict-zh.js (Chinese formats and word lists) and mdx.js (MDict). */
"use strict";

/* Where the device reads each language's converted files. Japanese keeps the original /dict
 * folder, which the firmware still accepts beside /dictionaries/jp. */
const DICT_FOLDERS = { ja: "dict", zh: "dictionaries/zh", yue: "dictionaries/yue" };

/* The ready-made Chinese and Cantonese editions, from sources served with the page in data/. The
 * Chinese two are the firmware release workflow's packs, all but the MoE dictionary. */
const CEDICT_FILE = "cedict_1_0_ts_utf-8_mdbg.txt.gz";
const DICT_EDITIONS = {
  simplified: { lang: "zh", inputs: [CEDICT_FILE], frequency: "jieba-dict.txt.gz", levels: "hsk30.csv.gz",
                levelName: "HSK", examples: "tatoeba-cmn-eng.tsv.gz", examplesScript: "simplified", zhuyin: false },
  traditional: { lang: "zh", inputs: [CEDICT_FILE], frequency: "jieba-dict-big.txt.gz", levels: "tocfl-202307.csv.gz",
                 levelName: "TOCFL", examples: "tatoeba-cmn-eng.tsv.gz", examplesScript: "traditional", zhuyin: true },
  cantonese: { lang: "yue", inputs: ["cccanto-webdist.txt.gz", CEDICT_FILE], jyutping: "cccedict-canto-readings.txt.gz",
               examples: "tatoeba-yue-eng.tsv.gz", examplesScript: "traditional", zhuyin: false },
};
const BUILTIN_DATA = "data/";

function dictLanguage() {
  const sel = $("dict-lang");
  return sel ? sel.value : "ja";
}

/* The chosen built-in edition, or null when the user's own files are converted. */
function dictEdition() {
  const checked = document.querySelector('input[name="dict-edition"]:checked');
  const e = checked && DICT_EDITIONS[checked.value];
  return e && e.lang === dictLanguage() ? checked.value : null;
}

async function fetchBuiltin(name) {
  const resp = await fetch(BUILTIN_DATA + name);
  if (!resp.ok) throw new Error(`Could not load the built-in ${name} (HTTP ${resp.status}).`);
  return new File([await resp.arrayBuffer()], name);
}

/* UTF-8 text of an uploaded file, inflating a .gz on the way. */
async function readFileText(file) {
  let bytes = await readFileBytes(file);
  if (file.name.toLowerCase().endsWith(".gz")) bytes = await gunzip(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

function optionalFile(id) {
  const input = $(id);
  return input && input.files.length ? input.files[0] : null;
}

/* The Japanese converter's own inputs: Yomitan zip, jmdict-simplified JSON, MDict. Returns
 * {records, title}. */
async function convertJapaneseFile(file, readingRecords) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".zip")) {
    logLine(`Loading ${file.name} (Yomitan format)…`);
    const zip = new ZipReader(await readFileBytes(file));
    const decoder = new TextDecoder("utf-8");
    let title = "";
    const indexEntry = zip.findEntry("index.json");
    if (indexEntry) {
      try {
        const meta = JSON.parse(decoder.decode(await zip.readEntry(indexEntry)));
        title = typeof meta.title === "string" ? meta.title : "";
        logLine(`  Dictionary: ${title || "(unknown)"}`);
        logLine(`  Format version: ${meta.format ?? meta.version ?? "?"}`);
      } catch (e) { /* metadata is informational only */ }
    }
    const bankEntries = zip.entries
      .filter((e) => /^term_bank_\d+\.json$/.test(e.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (!bankEntries.length) throw new Error("No term_bank_N.json files found in zip — is this a Yomitan dictionary?");
    logLine(`  Found ${bankEntries.length} term bank files`);
    const termBanks = [];
    for (let i = 0; i < bankEntries.length; i++) {
      setProgress(i, bankEntries.length, `Reading term banks: ${i + 1}/${bankEntries.length}`);
      termBanks.push(JSON.parse(decoder.decode(await zip.readEntry(bankEntries[i]))));
      await sleep(0); // keep the UI alive between large JSON parses
    }
    setProgress(0, 1, "Converting entries…");
    const result = convertYomitanRecords(termBanks, (done, total) => setProgress(done, total, `Converting entries: ${done}/${total}`), readingRecords);
    logLine(`Processed ${result.entryCount} Yomitan entries → ${result.records.length} index records`);
    return { records: result.records, title };
  }

  if (lower.endsWith(".json") || lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) {
    logLine(`Loading ${file.name} (jmdict-simplified format)…`);
    let jsonText;
    if (lower.endsWith(".json")) {
      jsonText = new TextDecoder("utf-8").decode(await readFileBytes(file));
    } else {
      setProgress(0, 1, "Decompressing…");
      const tarBytes = await gunzip(await readFileBytes(file));
      const member = parseTar(tarBytes).find((f) => f.name.endsWith(".json"));
      if (!member) throw new Error("No JSON file found in the tarball");
      jsonText = new TextDecoder("utf-8").decode(member.data);
    }
    setProgress(0, 1, "Parsing JSON…");
    await sleep(0);
    const data = JSON.parse(jsonText);
    jsonText = null;
    logLine(`Processing ${(data.words || []).length} JMdict entries…`);
    const records = convertJmdictRecords(data, (done, total) => setProgress(done, total, `Converting entries: ${done}/${total}`));
    return { records, title: "" };
  }

  if (lower.endsWith(".mdx")) {
    logLine(`Loading ${file.name} (MDict format)…`);
    setProgress(0, 1, "Parsing MDX…");
    const bytes = await readFileBytes(file);
    // Optional registration passcode for Encrypted=1 dictionaries.
    let options;
    const regcodeHex = $("dict-regcode").value.replace(/[\s:-]/g, "");
    const userid = $("dict-userid").value.trim();
    if (regcodeHex || userid) {
      if (!/^[0-9a-fA-F]{32}$/.test(regcodeHex)) {
        throw new Error("The MDict registration code must be 32 hex characters");
      }
      if (!userid) throw new Error("Enter the email or device ID the registration code belongs to");
      const regcode = new Uint8Array(16);
      for (let i = 0; i < 16; i++) regcode[i] = parseInt(regcodeHex.substring(i * 2, i * 2 + 2), 16);
      options = { passcode: { regcode, userid } };
    }
    const result = await convertMdictRecords(bytes, (seen) => setProgress(0, 1, `Reading entries: ${seen.toLocaleString()}…`), options);
    if (result.keysReadVia === "brutal") {
      logLine(options
        ? "Registration code didn't match — recovered by scanning for key blocks instead."
        : "Encrypted key index — recovered by scanning for key blocks (fill in the registration fields if this fails).", "warn");
    }
    logLine(`Processed ${result.entryCount} MDict entries (${result.skipped} skipped) → ${result.records.length} index records`);
    return { records: result.records, title: file.name.replace(/\.[^.]+$/, "") };
  }

  throw new Error(`Unsupported input ${file.name}. Use a Yomitan .zip, jmdict-simplified .json/.json.tgz, or MDict .mdx.`);
}

/* One input of a Chinese or Cantonese conversion. Returns {records, names, title}. */
async function convertChineseFile(file, lang, zhOpts) {
  const fmt = detectDictFormat(file.name, lang);
  logLine(`${file.name}: format ${fmt}`);
  if (fmt === "yomitan" || fmt === "mdict") {
    const r = await convertJapaneseFile(file, /*readingRecords=*/false);
    return { records: r.records, names: [], title: r.title };
  }
  if (fmt === "jmdict") {
    throw new Error(`${file.name}: a jmdict-simplified file is Japanese; pick Japanese above, or name a MoE export dict-revised.json.`);
  }
  if (fmt === "moedict") {
    if (file.name.toLowerCase().endsWith(".xz")) {
      throw new Error(`${file.name}: the browser cannot unpack .xz — decompress it first (xz -d) and choose the .json.`);
    }
    setProgress(0, 1, `Parsing ${file.name}…`);
    await sleep(0);
    const data = JSON.parse(new TextDecoder("utf-8").decode(await readFileBytes(file)));
    if (!Array.isArray(data)) throw new Error(`${file.name}: not a g0v dict-revised.json (expected an array of entries)`);
    const r = convertMoedict(data);
    logLine(`Processed ${r.records.length} MoE entries (${r.skipped} skipped)`);
    return { records: r.records, names: [], title: DEFAULT_DICT_TITLES.moedict };
  }
  if (fmt === "tsv") {
    const r = convertTsv(await readFileText(file));
    logLine(`Processed ${r.records.length} TSV entries (${r.skipped} skipped)`);
    return { records: r.records, names: [], title: file.name.replace(/\.[^.]+$/, "") };
  }
  // cedict (also CC-Canto)
  setProgress(0, 1, `Parsing ${file.name}…`);
  await sleep(0);
  const r = convertCedict(await readFileText(file), zhOpts);
  if (zhOpts.sentencePairs) {
    if (r.examplesDropped) logLine(`  Example sentences: ${r.examplesDropped.toLocaleString()} in the other script dropped`);
    logLine(`  Examples attached to ${r.examplesAttached.toLocaleString()} entries`);
  }
  logLine(`Processed ${r.entryCount} CC-CEDICT entries (${r.skipped} skipped) → ${r.records.length} vocab records`
          + (zhOpts.splitNames ? `, ${r.names.length} name records` : ""));
  const title = file.name.toLowerCase().includes("canto") ? "CC-Canto" : DEFAULT_DICT_TITLES.cedict;
  for (const rec of r.records) zhOpts.bilingualHeadwords.add(headwordKey(rec.hw));
  return { records: r.records, names: r.names, title };
}

/* The settings of a Chinese conversion, from the form. */
function formChineseSettings() {
  return {
    zhuyin: $("dict-zhuyin").checked,
    splitNames: $("dict-split-names").checked,
    examplesScript: $("dict-examples-script").value,
    frequencyKind: $("dict-frequency-kind").value,
    title: $("dict-title").value.trim(),
    levelName: $("dict-level-name").value.trim(),
    levelsFile: optionalFile("dict-levels"),
    jyutFile: optionalFile("dict-jyutping"),
    examplesFile: optionalFile("dict-examples"),
    frequencyFile: optionalFile("dict-frequency"),
  };
}

/* The settings of a built-in edition, its files fetched from data/. */
async function editionChineseSettings(edition) {
  const e = DICT_EDITIONS[edition];
  const [frequencyFile, levelsFile, examplesFile, jyutFile] = await Promise.all(
    [e.frequency, e.levels, e.examples, e.jyutping].map((name) => (name ? fetchBuiltin(name) : null)));
  return { zhuyin: e.zhuyin, splitNames: true, examplesScript: e.examplesScript, frequencyKind: "auto",
           title: "", levelName: e.levelName, levelsFile, jyutFile, examplesFile, frequencyFile };
}

/* The word lists a Chinese conversion can take beside the dictionaries themselves. */
async function readChineseOptions(settings) {
  const opts = {
    zhuyin: settings.zhuyin,
    splitNames: settings.splitNames,
    levels: new Map(),
    jyutping: new Map(),
    sentencePairs: null,
    twins: new Map(),
    bilingualHeadwords: new Set(),  // what CC-CEDICT left in the vocabulary; see keepNamesTogether
    examplesScript: settings.examplesScript,
    frequency: null,
    frequencyKind: settings.frequencyKind,
    title: settings.title,
  };
  const levelsFile = settings.levelsFile;
  if (levelsFile) {
    const name = settings.levelName || "HSK";
    opts.levels = loadLevels(await readFileText(levelsFile), name);
    logLine(`Level list ${levelsFile.name}: ${opts.levels.size.toLocaleString()} forms tagged ${name}`);
  }
  const jyutFile = settings.jyutFile;
  if (jyutFile) {
    opts.jyutping = loadCantoReadings(await readFileText(jyutFile));
    logLine(`Jyutping readings ${jyutFile.name}: ${opts.jyutping.size.toLocaleString()} entries`);
  }
  const examplesFile = settings.examplesFile;
  if (examplesFile) {
    opts.sentencePairs = loadSentencePairs(await readFileText(examplesFile), opts.examplesScript);
    logLine(`Sentence pairs ${examplesFile.name}: ${opts.sentencePairs.length.toLocaleString()} usable`);
  }
  const frequencyFile = settings.frequencyFile;
  if (frequencyFile) {
    const f = loadFrequency(await readFileText(frequencyFile), opts.frequencyKind);
    if (!f.priorities.size) logLine(`No words found in frequency list ${frequencyFile.name}`, "warn");
    else logLine(`Frequency list ${frequencyFile.name}: ${f.priorities.size.toLocaleString()} words, ranked by ${f.rankedBy}`);
    opts.frequency = f.priorities;
  }
  return opts;
}

/* Write one slot's idx/dat/spx (and .title when there is one) into the zip. */
function addDictOutput(zipOut, folder, name, records, title) {
  const { idx, dat, recordCount } = dictWriteBinary(records);
  const spx = dictGenSpx(idx);
  logLine(`  ${folder}/${name}.idx: ${formatBytes(idx.length)} (${recordCount.toLocaleString()} records)`);
  logLine(`  ${folder}/${name}.dat: ${formatBytes(dat.length)}`);
  logLine(`  ${folder}/${name}.spx: ${formatBytes(spx.length)} (lookup accelerator)`);
  zipOut.addFile(`${folder}/${name}.idx`, idx);
  zipOut.addFile(`${folder}/${name}.dat`, dat);
  zipOut.addFile(`${folder}/${name}.spx`, spx);
  const titleBytes = encodeDictTitle(title);
  if (titleBytes) {
    zipOut.addFile(`${folder}/${name}.title`, titleBytes);
    logLine(`  ${folder}/${name}.title: ${new TextDecoder().decode(titleBytes).trim()}`);
  }
}

async function runDictConversion() {
  const edition = dictEdition();
  const fileInput = $("dict-file");
  if (!edition && !fileInput.files.length) {
    logLine("Choose a dictionary file first.", "warn");
    return;
  }
  const lang = dictLanguage();
  const chinese = lang !== "ja";
  // vocab | names | grammar (device also accepts legacy jmdict/jmnedict)
  const outName = edition ? "vocab" : $("dict-name").value;
  const folder = DICT_FOLDERS[lang];

  $("dict-run").disabled = true;
  clearLog();
  const wakeLock = new WakeLock();
  await wakeLock.acquire();

  try {
    let records = [];
    let nameRecords = [];
    const titles = [];
    if (edition) setProgress(0, 1, "Loading the built-in sources…");
    const files = edition ? await Promise.all(DICT_EDITIONS[edition].inputs.map(fetchBuiltin)) : [...fileInput.files];
    const zhOpts = chinese
      ? await readChineseOptions(edition ? await editionChineseSettings(edition) : formChineseSettings())
      : null;

    for (const file of files) {
      const part = chinese ? await convertChineseFile(file, lang, zhOpts)
                           : await convertJapaneseFile(file, /*readingRecords=*/true);
      records = records.concat(part.records);
      if (part.names && part.names.length) nameRecords = nameRecords.concat(part.names);
      if (part.title) titles.push(part.title);
    }
    if (!records.length) throw new Error("No entries converted.");

    let title = "";
    if (chinese) {
      if (nameRecords.length) {
        ({ records, names: nameRecords } = keepNamesTogether(records, nameRecords, zhOpts.bilingualHeadwords));
      }
      if (zhOpts.frequency && zhOpts.frequency.size) {
        records = applyFrequency(records, zhOpts.frequency, zhOpts.twins);
        nameRecords = applyFrequency(nameRecords, zhOpts.frequency, zhOpts.twins);
      }
      title = zhOpts.title || joinDictTitles(titles);
      // Proper nouns go to their own files only beside the vocab slot; written into another
      // slot they stay with the rest, as the desktop tool does.
      if (nameRecords.length && outName !== "vocab") {
        logLine("Proper nouns are split off only when writing the vocab slot; kept in this output.", "warn");
        records = records.concat(nameRecords);
        nameRecords = [];
      }
    }

    setProgress(0, 1, "Sorting and writing binary index…");
    await sleep(0);
    const zipOut = new ZipWriter();
    logLine("Output:");
    addDictOutput(zipOut, folder, outName, records, title);
    if (nameRecords.length) addDictOutput(zipOut, folder, "names", nameRecords, "CC-CEDICT names");
    const blob = zipOut.toBlob();
    logLine(`Done — ${formatBytes(blob.size)}. Unzip at the SD card root: files land in /${folder}/.`);
    downloadBlob(blob, edition ? `${lang}-${edition}-dict.zip` : `${chinese ? lang + "-" : ""}${outName}-dict.zip`);
    setProgress(1, 1, "Complete");
  } catch (e) {
    logLine("Error: " + e.message, "error");
    console.error(e);
  } finally {
    $("dict-run").disabled = false;
    wakeLock.release();
  }
}

const DICT_FILE_HINTS = {
  ja: 'For example <a href="https://github.com/stephenmk/Jitendex/releases" target="_blank" rel="noopener">Jitendex</a> '
    + "(vocabulary) or JMnedict (names), both as Yomitan .zip; also jmdict-simplified .json / .json.tgz "
    + "or MDict .mdx. Several files merge into one dictionary.",
  zh: '<a href="https://www.mdbg.net/chinese/dictionary?page=cc-cedict" target="_blank" rel="noopener">CC-CEDICT</a>, '
    + 'the Taiwan Ministry of Education\'s <a href="https://github.com/g0v/moedict-data" target="_blank" rel="noopener">dict-revised.json</a> '
    + "(unpack the .xz first), a Yomitan .zip, MDict .mdx or a headword<TAB>definition .tsv. Several files "
    + "merge into one dictionary: a word in both shows both entries.",
  yue: '<a href="https://cantonese.org/download.html" target="_blank" rel="noopener">CC-Canto</a> together with '
    + '<a href="https://www.mdbg.net/chinese/dictionary?page=cc-cedict" target="_blank" rel="noopener">CC-CEDICT</a>. '
    + "Several files merge into one dictionary.",
};

const EDITION_HINTS = {
  zh: "Everything is built in: just press Build. Either edition looks words up in simplified and traditional books alike.",
  yue: "Everything is built in: just press Build. For books tagged Cantonese (yue); Mandarin books use the Chinese dictionary.",
};

/* Show only the steps that apply, number them, and remember the choices. */
function updateDictLanguageUi() {
  const lang = dictLanguage();
  const edition = dictEdition();
  const own = !edition;
  $("dict-edition-card").hidden = lang === "ja";
  $("dict-file-card").hidden = !own;
  $("dict-zh-options").hidden = !own || lang === "ja";
  $("dict-slot-card").hidden = !own;
  $("dict-mdict-reg").hidden = lang !== "ja";
  $("dict-edition-hint").hidden = own;
  $("dict-edition-hint").textContent = EDITION_HINTS[lang] || "";
  $("dict-file-hint").innerHTML = DICT_FILE_HINTS[lang].replace("<TAB>", "&lt;TAB&gt;");
  let step = 0;
  for (const card of document.querySelectorAll("main > .card[data-step]")) {
    if (!card.hidden) card.querySelector(".step").textContent = `${++step}. `;
  }
  for (const el of document.querySelectorAll(".dict-folder")) el.textContent = `/${DICT_FOLDERS[lang]}/`;
  saveSetting("dict-lang", lang);
  if (lang !== "ja") saveSetting(`dict-edition-${lang}`, edition || "own");
}

/* On a language change: offer that language's editions, picking the one chosen last time. */
function selectLanguageEditions() {
  const lang = dictLanguage();
  const radios = [...document.querySelectorAll('input[name="dict-edition"]')];
  for (const r of radios) r.closest("label").hidden = !r.dataset.lang.split(" ").includes(lang);
  const offered = radios.filter((r) => !r.closest("label").hidden);
  const saved = loadSetting(`dict-edition-${lang}`, "");
  const pick = offered.find((r) => r.value === saved) || offered[0];
  if (pick) pick.checked = true;
}

if (typeof document !== "undefined" && document.getElementById("dict-run")) {
  $("dict-run").addEventListener("click", runDictConversion);
  $("dict-file").addEventListener("change", () => {
    const names = [...$("dict-file").files].map((f) => f.name);
    $("dict-file-label").textContent = names.length ? names.join(", ") : "Tap to choose one or more dictionary files";
  });
  const langSel = $("dict-lang");
  if (langSel) {
    const saved = loadSetting("dict-lang", "ja");
    if (DICT_FOLDERS[saved]) langSel.value = saved;
    langSel.addEventListener("change", () => { selectLanguageEditions(); updateDictLanguageUi(); });
    for (const r of document.querySelectorAll('input[name="dict-edition"]')) r.addEventListener("change", updateDictLanguageUi);
    selectLanguageEditions();
    updateDictLanguageUi();
  }
}
