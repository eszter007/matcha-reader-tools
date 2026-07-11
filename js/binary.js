/* Little-endian growable binary writer, mirroring Python struct.pack("<...") usage. */
"use strict";

class ByteWriter {
  constructor(initial = 1024) {
    this.buf = new Uint8Array(initial);
    this.len = 0;
  }
  _ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u8(v) { this._ensure(1); this.buf[this.len++] = v & 0xff; }
  i8(v) { this.u8(v < 0 ? v + 0x100 : v); }
  u16(v) { this._ensure(2); this.buf[this.len] = v & 0xff; this.buf[this.len + 1] = (v >>> 8) & 0xff; this.len += 2; }
  i16(v) { this.u16(v < 0 ? v + 0x10000 : v); }
  u32(v) {
    this._ensure(4);
    this.buf[this.len] = v & 0xff;
    this.buf[this.len + 1] = (v >>> 8) & 0xff;
    this.buf[this.len + 2] = (v >>> 16) & 0xff;
    this.buf[this.len + 3] = (v >>> 24) & 0xff;
    this.len += 4;
  }
  bytes(arr) { this._ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
  zeros(n) { this._ensure(n); this.buf.fill(0, this.len, this.len + n); this.len += n; }
  get length() { return this.len; }
  toUint8Array() { return this.buf.slice(0, this.len); }
}

/* Lexicographic comparison of two Uint8Arrays, matching Python bytes comparison. */
function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function bytesEqual(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

if (typeof module !== "undefined") {
  module.exports = { ByteWriter, compareBytes, bytesEqual };
}
