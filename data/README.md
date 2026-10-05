# Built-in dictionaries

Served with the pages, so the Furigana & Pinyin page and the Dictionary page's Chinese editions
work without the user choosing any file.

| File | What | Licence |
|---|---|---|
| `cedict_1_0_ts_utf-8_mdbg.txt.gz` | [CC-CEDICT](https://www.mdbg.net/chinese/dictionary?page=cc-cedict), MDBG export of 2026-10-05 | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `jieba-dict.txt.gz`, `jieba-dict-big.txt.gz` | [jieba](https://github.com/fxsjy/jieba) word frequencies, `dict.txt` and `extra_dict/dict.txt.big` | MIT |
| `hsk30.csv.gz` | HSK 3.0 word list, via [ivankra/hsk30](https://github.com/ivankra/hsk30) | MIT (repository); list published by the PRC Ministry of Education |
| `tocfl-202307.csv.gz` | TOCFL 華語八千詞 (2023-07), via [ivankra/tocfl](https://github.com/ivankra/tocfl) | list published by SC-TOP |
| `tatoeba-cmn-eng.tsv.gz` | [Tatoeba](https://tatoeba.org) Mandarin–English sentence pairs, joined by the firmware's `tools/dict_convert/tatoeba_pairs.py` (2026-10-05) | [CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/) |
| `kuromoji/*.dat.gz` | mecab-ipadic-2.7.0-20070801, compiled by [kuromoji.js](https://github.com/takuyaa/kuromoji.js) 0.1.2 | NAIST licence and Apache 2.0; see `js/vendor/kuromoji/NOTICE.md` and `LICENSE-2.0.txt` |

To refresh a source, replace its file with a new download, gzipped; the Tatoeba file is rebuilt
with `tatoeba_pairs.py` from the three per-language exports. Then rerun `test/gen_references.py`.
