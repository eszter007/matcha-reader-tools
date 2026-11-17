#!/usr/bin/env node
/* anki-core.js against tools/anki_import/apkg_to_flashcards.py: every file of every deck folder,
 * byte for byte. Folders are matched by deck name: the Python tool imports into a scratch
 * collection, which gives decks new ids, while the page keeps the package's own. */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const FIXTURES = path.join(ROOT, "test", "fixtures");

const zip = require("../../js/zip.js");
global.ZipReader = zip.ZipReader;
const anki = require("../../js/anki-core.js");
const initSqlJs = require("../../js/vendor/sqljs/sql-wasm.js");
const fzstd = require("../../js/vendor/fzstd/fzstd.js");

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else { console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); failures++; }
}

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// Python's output for each deck, keyed by deck name: its files as paths under the system folder
// (anki/<id>.json, .cards.bin, .css, the empty anki/<id>/ marker, anki-cards/<id>/...), with the
// deck id written as <deck>. Python imports the package into a fresh collection, which gives each
// deck a new id; the converter keeps the package's own, so only the id may differ.
function withoutDeckId(rel, id) {
  return rel.replace(`anki/${id}`, "anki/<deck>").replace(`anki-cards/${id}/`, "anki-cards/<deck>/");
}

function referenceDecks(dir, cardsRoot) {
  const byName = new Map();
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    const deck = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8"));
    const files = new Map();
    for (const suffix of [".json", ".cards.bin", ".css"]) {
      const file = path.join(dir, id + suffix);
      if (fs.existsSync(file)) files.set(`anki/${id}${suffix}`, file);
    }
    if (fs.existsSync(path.join(dir, id))) files.set(`anki/${id}/`, null);
    const walk = (abs, rel) => {
      for (const name of fs.readdirSync(abs)) {
        const childAbs = path.join(abs, name);
        const childRel = `${rel}/${name}`;
        if (fs.statSync(childAbs).isDirectory()) walk(childAbs, childRel);
        else files.set(childRel, childAbs);
      }
    };
    const cards = path.join(cardsRoot, id);
    if (fs.existsSync(cards)) walk(cards, `anki-cards/${id}`);
    const generic = new Map();
    for (const [rel, abs] of files) generic.set(withoutDeckId(rel, id), abs);
    byName.set(deck.name, generic);
  }
  return byName;
}

async function unitChecks() {
  check("furigana", anki.furigana("日本語[にほんご]を 勉強[べんきょう]", "ruby") ===
        "<ruby><rb>日本語</rb><rt>にほんご</rt></ruby>を<ruby><rb>勉強</rb><rt>べんきょう</rt></ruby>");
  check("nested cloze", anki.renderCloze("{{c1::a {{c2::b}} c}}", 2, false) ===
        '<span class="cloze-inactive" data-ordinal="1">a <span class="cloze" data-cloze="b" data-ordinal="2">[...]</span> c</span>');
  check("empty field with <br>", anki.fieldIsEmpty(" <br> <div></div>"));
  check("text kept after a dropped element", anki.cleanSide("<button>x</button>after") === "after");
  check("hidden element dropped", anki.cleanSide('a<div style="display:none">menu</div>b') === "ab");
  check("unclosed li", anki.cleanSide("<ul><li>a<li>b</ul>") === "<ul><li>a</li><li>b</li></ul>");
  check("entities", anki.cleanSide("a &nbsp; &amp; &foo; &#x41;") === "a   &amp; &amp;foo; A");
  check("control characters dropped", anki.cleanSide("a\u000bb&#8;c") === "abc");
  check("Word's <o:p> unwrapped", anki.cleanSide("<p>x<o:p>y</o:p></p>") === "<p>xy</p>");
  check("invalid attribute name dropped", anki.cleanSide('<img src=a.png "b>') === '<img src="a.png"/>');
  check("HTML 4 entity", anki.cleanSide("&zeta;&prime;") === "\u03b6\u2032");
  check("cloze hint after the first ::", anki.renderCloze("{{c1::a::h::x}}", 1, false) ===
        '<span class="cloze" data-cloze="a" data-ordinal="1">[h::x]</span>');
  check("unclosed cloze left out", anki.renderCloze("x {{c1::open", 1, false) === "x ");
  const nt = { name: "Cloze", kind: 1, fields: ["Text"], templates: [{ name: "Cloze", qfmt: "{{cloze:Text}}", afmt: "{{cloze:Text}}" }] };
  check("missing cloze shows Anki's notice",
        anki.renderCard({ ord: 1, flags: 0 }, { fields: ["{{c1::a}}"], tags: "" }, nt, "D").question.startsWith("<div>No cloze \u20682\u2069"));
  check("boolean attribute", anki.cleanSide('<img src=a.png alt>') === '<img src="a.png" alt=""/>');
}

async function compareWithPython(SQL, name) {
  const apkgPath = path.join(FIXTURES, "anki", `${name}.apkg`);
  const refDir = path.join(FIXTURES, "ref_anki", name);
  if (!fs.existsSync(apkgPath) || !fs.existsSync(refDir)) {
    console.log(`  skip ${name}: run test/gen_references.py with the anki and lxml packages`);
    return;
  }
  const apkg = await anki.openApkg(new Uint8Array(fs.readFileSync(apkgPath)), { SQL, fzstd });
  const collection = anki.loadCollection(apkg.db);
  const decks = anki.defaultDecks(anki.listDecks(apkg.db, collection));
  const refs = referenceDecks(refDir, path.join(FIXTURES, "ref_anki", "anki-cards"));
  check(`${name}: same decks`, decks.map((d) => d.name).sort().join("|") === [...refs.keys()].sort().join("|"),
        `${decks.map((d) => d.name)} vs ${[...refs.keys()]}`);
  for (const deck of decks) {
    const refFiles = refs.get(deck.name);
    if (!refFiles) continue;
    // WebP needs a browser canvas: here a stand-in marks the file, its bytes are not compared.
    const exported = await anki.exportDeck(apkg, collection, deck, async () => new Uint8Array([1]));
    const files = new Map([...exported.files].map(([rel, data]) => [withoutDeckId(rel, deck.id), data]));
    const names = [...refFiles.keys()].sort();
    check(`${name}/${deck.name}: same files`, [...files.keys()].sort().join("|") === names.join("|"),
          `${[...files.keys()].sort()} vs ${names}`);
    for (const file of names) {
      const refPath = refFiles.get(file);
      if (refPath === null || !files.has(file) || file.endsWith(".webp.png")) continue;
      const mine = files.get(file);
      const actual = typeof mine === "string" ? Buffer.from(mine, "utf8") : Buffer.from(mine);
      const expected = fs.readFileSync(refPath);
      const at = firstDifference(actual, expected);
      check(`${name}/${deck.name}/${file}`, at < 0,
            at < 0 ? "" : `differs at byte ${at}:\n      js: ${JSON.stringify(actual.slice(Math.max(0, at - 40), at + 60).toString())}` +
                          `\n      py: ${JSON.stringify(expected.slice(Math.max(0, at - 40), at + 60).toString())}`);
    }
  }
  apkg.db.close();
}

(async () => {
  const SQL = await initSqlJs({ locateFile: (f) => path.join(ROOT, "js", "vendor", "sqljs", f) });
  console.log("anki-core");
  await unitChecks();
  await compareWithPython(SQL, "test");
  await compareWithPython(SQL, "test-legacy");
  if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
  console.log("all passed");
})();
