#!/usr/bin/env python3
"""Builds the Anki test packages for anki.html's tests, with the Anki library:
basic, reversed, cloze, furigana filters, conditionals, type-in, images and a subdeck, exported in
Anki's current format (zstd, schema 18) and in the legacy format.

    python3 test/anki/make_decks.py <out dir>
"""
import base64
import io
import os
import sys

from PIL import Image

from anki.collection import Collection
from anki.import_export_pb2 import ExportAnkiPackageOptions

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAG7buVgAAAABJRU5ErkJggg==")

path = os.path.join(OUT, "build.anki2")
if os.path.exists(path):
    os.remove(path)
col = Collection(path)
col.media.write_data("dog.png", PNG)
col.media.write_data("a b&c.png", PNG)
webp = io.BytesIO()
Image.new("RGBA", (640, 320), (200, 40, 40, 255)).save(webp, format="WEBP")
col.media.write_data("photo.webp", webp.getvalue())

vocab = col.decks.id("Vocab")
sub = col.decks.id("Vocab::Verbs")
other = col.decks.id("Grammar")


def add(model_name, deck, **fields):
    note = col.new_note(col.models.by_name(model_name))
    for k, v in fields.items():
        note[k] = v
    col.add_note(note, deck)
    return note


add("Basic", vocab, Front="犬", Back='dog <img src="dog.png"> <img src="photo.webp">')
add("Basic (and reversed card)", vocab, Front="猫", Back="cat<br>a small animal")
add("Basic", sub, Front="食べる", Back="to eat [sound:taberu.mp3]")
add("Cloze", other, Text="{{c1::東京::capital}} is in {{c2::Japan}}. {{c1::Kyoto}} too.", **{"Back Extra": "extra"})
add("Basic (type in the answer)", other, Front="水", Back="みず")

# A note type with filters and conditionals.
m = col.models.new("Rich")
for name in ("Word", "Reading", "Meaning", "Note"):
    col.models.add_field(m, col.models.new_field(name))
t = col.models.new_template("Card 1")
t["qfmt"] = '<div class="w">{{Word}}</div>{{#Note}}<p class="n">{{text:Note}}</p>{{/Note}}{{^Note}}<p>no note</p>{{/Note}}'
t["afmt"] = ('{{FrontSide}}<hr id=answer><div>{{furigana:Reading}}</div><div>{{kana:Reading}}</div>'
             '<div>{{kanji:Reading}}</div>{{hint:Meaning}}<button onclick="x()">menu</button>'
             '<script>var a = 1 < 2;</script><a href="#" onclick="go()">go</a><span style="color: red">{{Meaning}}</span>'
             '<img src="a b&amp;c.png">{{Tags}} {{Deck}} {{Subdeck}} {{Card}} {{Type}}')
col.models.add_template(m, t)
m["css"] = ".card { font-size: 20px; }\n.w { font-weight: bold; }"
col.models.add(m)
note = add("Rich", vocab, Word="日本語", Reading="日本語[にほんご]を 勉強[べんきょう]", Meaning="Japanese &amp; more",
           Note="<b>bold</b> note")
note.tags = ["jlpt", "n5"]
col.update_note(note)
add("Rich", vocab, Word="空", Reading="空[そら]", Meaning="sky", Note="")

for legacy, name in ((False, "test.apkg"), (True, "test-legacy.apkg")):
    col.export_anki_package(out_path=os.path.join(OUT, name),
                            options=ExportAnkiPackageOptions(with_scheduling=False, with_deck_configs=False,
                                                             with_media=True, legacy=legacy), limit=None)
col.close()
print("wrote", OUT)
