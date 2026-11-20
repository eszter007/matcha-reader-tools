/* The Gemini API request shared by the manga OCR and the furigana/pinyin readings. Each caller
 * keeps its own retry rules: the manga converter follows convert_manga.py. */

const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";

/* One generateContent call asking for a JSON answer. Resolves to one of:
 *   { text }             the model's answer text, not yet parsed
 *   { error, status }    an API error, with its status ("UNAVAILABLE", "PERMISSION_DENIED", ...)
 *   null                 no usable response: a network failure or a body that is not JSON */
async function geminiGenerate(parts, apiKey, model) {
  const payload = {
    contents: [{ parts }],
    generationConfig: { responseMimeType: "application/json" },
  };
  let response;
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(payload),
      });
    response = await resp.json();
  } catch (e) {
    return null;
  }
  if (response.error) {
    const status = response.error.status || "";
    return { error: String(response.error.message || status), status };
  }
  try {
    return { text: response.candidates[0].content.parts[0].text };
  } catch (e) {
    return { text: null };
  }
}

if (typeof module !== "undefined") {
  module.exports = { GEMINI_DEFAULT_MODEL, geminiGenerate };
}
