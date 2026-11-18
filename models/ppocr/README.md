# PP-OCRv6_manga

`manga_det_fp16.onnx`, `manga_rec_fp16.onnx` and `ppocrv6_dict.txt` are unmodified files from
[Kellenok/PP-OCRv6_manga](https://huggingface.co/Kellenok/PP-OCRv6_manga), revision `v0.3`,
licensed under the Apache License 2.0 (`LICENSE-2.0.txt`). They are PaddlePaddle's PP-OCRv6 tiny detector and small
recogniser, fine-tuned on manga and anime text (Japanese and Chinese). `js/ppocr.js` runs them.

SHA-256 (the two models as published on the Hub):

    6cfa057e437fe981810d234eb4761bbd1df35162811b30a53642dd450d587a17  manga_det_fp16.onnx
    ecf4156045b2e87d45158768852afeb210c5f2e8fc4dbfdb4bb4e5836b136c8d  manga_rec_fp16.onnx
    4f0f8971ecb95e3a4d278985d6eaac154413e81fda0b4c941db17389580e9e9b  ppocrv6_dict.txt
