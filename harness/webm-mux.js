/* webm-mux.js — minimal Matroska/WebM writer for ONE video track of WebCodecs
   EncodedVideoChunks (VP9 by default; VP8/AV1 codec ids accepted). No
   dependencies — the project's standing rule. Structure:
     EBML header · Segment[ Info · Tracks · Cluster* ]
   Element sizes are written as 8-byte vints (always valid, never ambiguous).
   Clusters start at the first keyframe ≥1 s after the previous cluster;
   SimpleBlocks carry int16 relative timecodes. No Cues element: players scan
   for seeks, and the exporter forces a keyframe every 15 frames so seeks stay
   cheap (the receive page's harvest seeks thousands of times). */
(function (global) {
  "use strict";

  function vintSize8(n) {
    const b = new Uint8Array(8); b[0] = 0x01;
    for (let i = 7; i >= 1; i--) { b[i] = n & 0xff; n = Math.floor(n / 256); }
    return b;
  }
  function idBytes(id) {
    const out = [];
    let x = id;
    while (x > 0) { out.unshift(x & 0xff); x = Math.floor(x / 256); }
    return new Uint8Array(out);
  }
  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const o = new Uint8Array(n);
    let off = 0;
    for (const p of parts) { o.set(p, off); off += p.length; }
    return o;
  }
  function el(id, payload) { return concat([idBytes(id), vintSize8(payload.length), payload]); }
  function uintBE(v, bytes) {
    const b = new Uint8Array(bytes);
    for (let i = bytes - 1; i >= 0; i--) { b[i] = v & 0xff; v = Math.floor(v / 256); }
    return b;
  }
  function elUint(id, v) {
    let bytes = 1, t = v;
    while (t >= 256) { t = Math.floor(t / 256); bytes++; }
    return el(id, uintBE(v, bytes));
  }
  function elFloat(id, v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v);
    return el(id, b);
  }
  function elStr(id, s) { return el(id, new TextEncoder().encode(s)); }

  class WebmMuxer {
    constructor(opts) {
      this.w = opts.width; this.h = opts.height;
      this.codec = opts.codec || "V_VP9";
      this.fps = opts.fps || 30;
      this.clusters = []; this.cur = null; this.lastTs = 0;
    }
    addFrame(data, tsUs, isKey) {
      const tsMs = Math.round(tsUs / 1000);
      if (!this.cur || (isKey && tsMs - this.cur.start >= 1000) || tsMs - this.cur.start > 30000)
        this._newCluster(tsMs);
      const rel = tsMs - this.cur.start;
      const hdr = new Uint8Array(4);
      hdr[0] = 0x81;                       // track 1 (vint)
      hdr[1] = (rel >> 8) & 0xff; hdr[2] = rel & 0xff;   // int16 relative timecode
      hdr[3] = isKey ? 0x80 : 0x00;        // keyframe flag
      this.cur.blocks.push(el(0xA3, concat([hdr, data])));
      this.lastTs = tsMs;
    }
    _newCluster(tsMs) { this.cur = { start: tsMs, blocks: [] }; this.clusters.push(this.cur); }
    finish() {
      const ebml = el(0x1A45DFA3, concat([
        elUint(0x4286, 1), elUint(0x42F7, 1), elUint(0x42F2, 4), elUint(0x42F3, 8),
        elStr(0x4282, "webm"), elUint(0x4287, 2), elUint(0x4285, 2)]));
      const durMs = this.lastTs + 1000 / this.fps;
      const info = el(0x1549A966, concat([
        elUint(0x2AD7B1, 1000000), elFloat(0x4489, durMs),
        elStr(0x4D80, "phryctoros"), elStr(0x5741, "phryctoros emit export")]));
      const video = el(0xE0, concat([elUint(0xB0, this.w), elUint(0xBA, this.h)]));
      const track = el(0xAE, concat([
        elUint(0xD7, 1), elUint(0x73C5, 1), elUint(0x83, 1), elUint(0x9C, 0),
        elUint(0x23E383, Math.round(1e9 / this.fps)), elStr(0x86, this.codec), video]));
      const tracks = el(0x1654AE6B, track);
      const clusterEls = this.clusters.map(c => el(0x1F43B675, concat([elUint(0xE7, c.start)].concat(c.blocks))));
      const segment = el(0x18538067, concat([info, tracks].concat(clusterEls)));
      return new Blob([ebml, segment], { type: "video/webm" });
    }
  }
  global.WebmMuxer = WebmMuxer;
})(typeof window !== "undefined" ? window : globalThis);
