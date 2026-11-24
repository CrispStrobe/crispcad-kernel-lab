// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CrispCAD contributors
//
// A libvips-free implementation of the sharp API subset CrispCAD uses:
// construct from an encoded buffer, a file path, raw pixels or a blank canvas;
// ensureAlpha / removeAlpha / grayscale / extract / resize / composite / clone;
// png / jpeg / webp / raw / toFormat; toBuffer / toFile / metadata / stats.
// PNG and JPEG are coded in pure JavaScript (pngjs MIT, jpeg-js BSD-3-Clause).
// SVG, WebP and GIF are decoded, and WebP encoded, by headless Chromium through
// Playwright (BSD/Apache), which CrispCAD's renderer already uses.
'use strict';
const { readFileSync, writeFileSync } = require('node:fs');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

// ---------------------------------------------------------------- images
// Internal image: { width, height, channels (1..4), data: Uint8Array }.

function detectFormat(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  const head = buf.subarray(0, 512).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg')) || head.startsWith('<!DOCTYPE svg')) return 'svg';
  return undefined;
}

/** Header-only metadata for PNG and JPEG (no pixel decode), as libvips reads it. */
function headerMetadata(buf) {
  const format = detectFormat(buf);
  if (format === 'png' && buf.length >= 26 && buf.toString('ascii', 12, 16) === 'IHDR') {
    const colorType = buf[25], channels = { 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 }[colorType] ?? 4;
    return { format, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), channels, hasAlpha: colorType === 4 || colorType === 6, space: channels <= 2 ? 'b-w' : 'srgb' };
  }
  if (format === 'jpeg') {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const channels = buf[i + 9];
        return { format, height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), channels, hasAlpha: false, space: channels === 1 ? 'b-w' : 'srgb' };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return undefined;
}

/** Keep the PNG's own layout (grey, grey+alpha, RGB, RGBA) as libvips does; pngjs always expands to RGBA. */
function decodePng(buf) {
  const png = PNG.sync.read(buf);
  const rgba = { width: png.width, height: png.height, channels: 4, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
  const channels = png.alpha ? (png.color ? 4 : 2) : (png.color ? 3 : 1);
  return { ...toChannels(rgba, channels), hasAlpha: !!png.alpha, sourceChannels: channels };
}

function decodeJpeg(buf) {
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 1024 });
  return { width: img.width, height: img.height, channels: 3, data: img.data, hasAlpha: false, sourceChannels: 3 };
}

// ---------------------------------------------------------------- Chromium
let browserPromise;
function chromiumBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      let playwright;
      try { playwright = require('playwright'); } catch { throw new Error('sharp-compat: this image format needs Playwright Chromium (npm i playwright && npx playwright install chromium)'); }
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
      const browser = await playwright.chromium.launch({ args: ['--disable-dev-shm-usage'], ...(executablePath ? { executablePath } : {}) });
      const close = () => { void browser.close().catch(() => {}); };
      process.once('beforeExit', close);
      return browser;
    })();
  }
  return browserPromise;
}

async function withPage(fn) {
  const browser = await chromiumBrowser();
  const page = await browser.newPage();
  try { return await fn(page); } finally { await page.close().catch(() => {}); }
}

async function decodeViaChromium(buf, format) {
  const mime = { svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif' }[format];
  const result = await withPage(page => page.evaluate(async ({ b64, mime }) => {
    const img = new Image();
    img.src = `data:${mime};base64,${b64}`;
    await img.decode();
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    let bin = ''; for (let i = 0; i < data.length; i += 32768) bin += String.fromCharCode.apply(null, data.subarray(i, i + 32768));
    return { w, h, rgba: btoa(bin) };
  }, { b64: buf.toString('base64'), mime }));
  if (!result.w || !result.h) throw new Error(`sharp-compat: ${format} image has no intrinsic size`);
  return { width: result.w, height: result.h, channels: 4, data: new Uint8Array(Buffer.from(result.rgba, 'base64')), hasAlpha: true, sourceChannels: 4 };
}

async function encodeViaChromium(img, mime, quality) {
  const rgba = toChannels(img, 4);
  const b64 = await withPage(page => page.evaluate(async ({ w, h, data, mime, quality }) => {
    const bytes = Uint8ClampedArray.from(atob(data), c => c.charCodeAt(0));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    canvas.getContext('2d').putImageData(new ImageData(bytes, w, h), 0, 0);
    return canvas.toDataURL(mime, quality).split(',')[1];
  }, { w: rgba.width, h: rgba.height, data: Buffer.from(rgba.data).toString('base64'), mime, quality }));
  return Buffer.from(b64, 'base64');
}

async function decode(buf) {
  const format = detectFormat(buf);
  if (format === 'png') return { ...decodePng(buf), format };
  if (format === 'jpeg') return { ...decodeJpeg(buf), format };
  if (format) return { ...(await decodeViaChromium(buf, format)), format };
  throw new Error('Input buffer contains unsupported image format');
}

// ---------------------------------------------------------------- pixel ops
function toChannels(img, channels) {
  if (img.channels === channels) return img;
  const { width, height } = img, n = width * height, out = new Uint8Array(n * channels);
  for (let i = 0; i < n; i++) {
    const s = img.data.subarray(i * img.channels, (i + 1) * img.channels);
    const grey = img.channels <= 2, r = s[0], g = grey ? s[0] : s[1], b = grey ? s[0] : s[2];
    const a = img.channels === 4 ? s[3] : img.channels === 2 ? s[1] : 255;
    const o = i * channels;
    if (channels === 1) out[o] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    else if (channels === 2) { out[o] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b); out[o + 1] = a; }
    else { out[o] = r; out[o + 1] = g; out[o + 2] = b; if (channels === 4) out[o + 3] = a; }
  }
  return { width, height, channels, data: out };
}

function parseColour(c) {
  if (c === undefined) return [0, 0, 0, 255];
  if (typeof c === 'string') {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c.trim());
    if (!m) throw new Error(`sharp-compat: unsupported colour ${c}`);
    let h = m[1]; if (h.length === 3) h = h.split('').map(x => x + x).join('');
    const v = parseInt(h.slice(0, 6), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255, h.length === 8 ? parseInt(h.slice(6), 16) : 255];
  }
  return [c.r ?? 0, c.g ?? 0, c.b ?? 0, Math.round((c.alpha ?? 1) * 255)];
}

function blank({ width, height, channels, background }) {
  const [r, g, b, a] = parseColour(background), data = new Uint8Array(width * height * channels);
  for (let i = 0; i < width * height; i++) data.set([r, g, b, a].slice(0, channels === 1 ? 1 : channels), i * channels);
  return { width, height, channels, data };
}

function extract(img, { left, top, width, height }) {
  if (left < 0 || top < 0 || width <= 0 || height <= 0 || left + width > img.width || top + height > img.height) throw new Error('extract_area: bad extract area');
  const c = img.channels, out = new Uint8Array(width * height * c);
  for (let y = 0; y < height; y++) out.set(img.data.subarray(((top + y) * img.width + left) * c, ((top + y) * img.width + left + width) * c), y * width * c);
  return { width, height, channels: c, data: out };
}

const KERNELS = {
  nearest: { support: 0.5, f: x => (Math.abs(x) <= 0.5 ? 1 : 0) },
  linear: { support: 1, f: x => Math.max(0, 1 - Math.abs(x)) },
  cubic: { support: 2, f: x => { x = Math.abs(x); return x < 1 ? 1.5 * x ** 3 - 2.5 * x ** 2 + 1 : x < 2 ? -0.5 * x ** 3 + 2.5 * x ** 2 - 4 * x + 2 : 0; } },
  lanczos2: { support: 2, f: x => lanczos(x, 2) },
  lanczos3: { support: 3, f: x => lanczos(x, 3) },
  mitchell: { support: 2, f: x => { x = Math.abs(x); const B = 1 / 3, C = 1 / 3; return x < 1 ? ((12 - 9 * B - 6 * C) * x ** 3 + (-18 + 12 * B + 6 * C) * x ** 2 + 6 - 2 * B) / 6 : x < 2 ? ((-B - 6 * C) * x ** 3 + (6 * B + 30 * C) * x ** 2 + (-12 * B - 48 * C) * x + 8 * B + 24 * C) / 6 : 0; } },
};
function lanczos(x, a) { if (x === 0) return 1; if (Math.abs(x) >= a) return 0; const p = Math.PI * x; return a * Math.sin(p) * Math.sin(p / a) / (p * p); }

/** Separable resample of one axis; premultiplies alpha so edges do not darken. */
function resampleAxis(img, outLen, horizontal, kernel) {
  const inLen = horizontal ? img.width : img.height, other = horizontal ? img.height : img.width, c = img.channels;
  const scale = outLen / inLen, filterScale = Math.max(1, 1 / scale), support = kernel.support * filterScale;
  const out = new Float32Array((horizontal ? outLen * other : other * outLen) * c);
  const weights = [];
  for (let o = 0; o < outLen; o++) {
    const centre = (o + 0.5) / scale - 0.5, lo = Math.max(0, Math.ceil(centre - support)), hi = Math.min(inLen - 1, Math.floor(centre + support));
    const w = []; let sum = 0;
    for (let i = lo; i <= hi; i++) { const v = kernel.f((i - centre) / filterScale); w.push(v); sum += v; }
    weights.push({ lo, w: w.map(v => v / (sum || 1)) });
  }
  const alpha = c === 4 || c === 2, ai = c - 1;
  for (let k = 0; k < other; k++) for (let o = 0; o < outLen; o++) {
    const { lo, w } = weights[o], acc = new Float64Array(c);
    for (let t = 0; t < w.length; t++) {
      const i = lo + t, idx = (horizontal ? k * inLen + i : i * other + k) * c, a = alpha ? img.data[idx + ai] / 255 : 1;
      for (let ch = 0; ch < c; ch++) acc[ch] += w[t] * (alpha && ch !== ai ? img.data[idx + ch] * a : img.data[idx + ch]);
    }
    const oi = (horizontal ? k * outLen + o : o * other + k) * c, a = alpha ? Math.max(0, acc[ai]) / 255 : 1;
    for (let ch = 0; ch < c; ch++) out[oi + ch] = alpha && ch !== ai ? (a > 0 ? acc[ch] / a : 0) : acc[ch];
  }
  const data = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(out[i])));
  return horizontal ? { width: outLen, height: img.height, channels: c, data } : { width: img.width, height: outLen, channels: c, data };
}

function resize(img, width, height, opts = {}) {
  const fit = opts.fit ?? 'cover', kernel = KERNELS[opts.kernel ?? 'lanczos3'] ?? KERNELS.lanczos3;
  if (width == null && height == null) return img;
  if (width == null) width = Math.round(img.width * height / img.height);
  if (height == null) height = Math.round(img.height * width / img.width);
  let src = img, w = width, h = height;
  if (fit === 'cover') {
    const s = Math.max(width / img.width, height / img.height), cw = Math.min(img.width, Math.round(width / s)), ch = Math.min(img.height, Math.round(height / s));
    src = extract(img, { left: Math.floor((img.width - cw) / 2), top: Math.floor((img.height - ch) / 2), width: cw, height: ch });
  } else if (fit === 'inside' || fit === 'contain') {
    const s = Math.min(width / img.width, height / img.height); w = Math.max(1, Math.round(img.width * s)); h = Math.max(1, Math.round(img.height * s));
  } else if (fit !== 'fill') throw new Error(`sharp-compat: unsupported resize fit ${fit}`);
  if (opts.withoutEnlargement && (w > img.width || h > img.height)) return img;
  let out = src.width === w ? src : resampleAxis(src, w, true, kernel);
  out = out.height === h ? out : resampleAxis(out, h, false, kernel);
  if (fit === 'contain' && (w !== width || h !== height)) {
    const canvas = blank({ width, height, channels: out.channels, background: opts.background ?? { r: 0, g: 0, b: 0, alpha: 0 } });
    return compositeOver(canvas, out, Math.floor((width - w) / 2), Math.floor((height - h) / 2));
  }
  return out;
}

function compositeOver(base, overlay, left, top) {
  const b = toChannels(base, 4), o = toChannels(overlay, 4), data = new Uint8Array(b.data);
  for (let y = Math.max(0, top); y < Math.min(b.height, top + o.height); y++) for (let x = Math.max(0, left); x < Math.min(b.width, left + o.width); x++) {
    const bi = (y * b.width + x) * 4, oi = ((y - top) * o.width + (x - left)) * 4, oa = o.data[oi + 3] / 255, ba = data[bi + 3] / 255, a = oa + ba * (1 - oa);
    for (let ch = 0; ch < 3; ch++) data[bi + ch] = a > 0 ? Math.round((o.data[oi + ch] * oa + data[bi + ch] * ba * (1 - oa)) / a) : 0;
    data[bi + 3] = Math.round(a * 255);
  }
  return toChannels({ width: b.width, height: b.height, channels: 4, data }, base.channels === 4 ? 4 : base.channels === 3 ? 3 : 4);
}

function encodePng(img, opts = {}) {
  const c = img.channels;
  const colorType = c === 1 ? 0 : c === 2 ? 4 : c === 3 ? 2 : 6;
  const png = new PNG({ width: img.width, height: img.height, colorType, inputColorType: colorType, inputHasAlpha: c === 2 || c === 4, bitDepth: 8 });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  return PNG.sync.write(png, { colorType, inputColorType: colorType, inputHasAlpha: c === 2 || c === 4, deflateLevel: opts.compressionLevel ?? 6 });
}

function encodeJpeg(img, opts = {}) {
  const rgba = toChannels(img, 4);
  return jpeg.encode({ data: Buffer.from(rgba.data), width: rgba.width, height: rgba.height }, opts.quality ?? 80).data;
}

// ---------------------------------------------------------------- Sharp
class Sharp {
  constructor(input, options = {}) {
    this._input = input; this._options = options; this._ops = []; this._out = { format: undefined, options: {} };
  }
  clone() { const c = new Sharp(this._input, this._options); c._ops = [...this._ops]; c._out = { ...this._out }; return c; }
  async _load() {
    const input = this._input, raw = this._options.raw;
    if (input && typeof input === 'object' && !Buffer.isBuffer(input) && !(input instanceof Uint8Array) && input.create) return { ...blank(input.create), format: 'raw' };
    const buf = typeof input === 'string' ? readFileSync(input) : Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (raw) return { width: raw.width, height: raw.height, channels: raw.channels, data: new Uint8Array(buf.buffer, buf.byteOffset, raw.width * raw.height * raw.channels), format: 'raw' };
    return decode(buf);
  }
  async _pipeline() {
    let img = await this._load();
    const format = img.format;
    for (const op of this._ops) img = await op(img);
    return { img, format };
  }
  _push(op) { this._ops.push(op); return this; }
  ensureAlpha() { return this._push(img => toChannels(img, img.channels <= 2 ? 2 : 4)); }
  removeAlpha() { return this._push(img => (img.channels === 4 ? toChannels(img, 3) : img.channels === 2 ? toChannels(img, 1) : img)); }
  grayscale(on = true) { return on ? this._push(img => toChannels(img, img.channels === 4 || img.channels === 2 ? 2 : 1)) : this; }
  greyscale(on = true) { return this.grayscale(on); }
  extract(area) { return this._push(img => extract(img, area)); }
  resize(width, height, options) {
    if (width && typeof width === 'object') { options = width; width = options.width; height = options.height; }
    return this._push(img => resize(img, width ?? undefined, height ?? undefined, options));
  }
  composite(layers) {
    return this._push(async img => {
      let out = img;
      for (const layer of layers) {
        const overlay = await new Sharp(layer.input, layer.raw ? { raw: layer.raw } : {})._pipeline().then(r => r.img);
        const left = layer.left ?? Math.floor((out.width - overlay.width) / 2), top = layer.top ?? Math.floor((out.height - overlay.height) / 2);
        out = compositeOver(out, overlay, left, top);
      }
      return out;
    });
  }
  png(options = {}) { this._out = { format: 'png', options }; return this; }
  jpeg(options = {}) { this._out = { format: 'jpeg', options }; return this; }
  webp(options = {}) { this._out = { format: 'webp', options }; return this; }
  raw() { this._out = { format: 'raw', options: {} }; return this; }
  toFormat(format, options = {}) { const f = String(format).replace('image/', '').replace('jpg', 'jpeg'); if (!['png', 'jpeg', 'webp', 'raw'].includes(f)) throw new Error(`sharp-compat: unsupported output format ${format}`); this._out = { format: f, options }; return this; }
  async toBuffer(opts = {}) {
    const { img, format: inputFormat } = await this._pipeline();
    const format = this._out.format ?? (inputFormat === 'raw' || !inputFormat ? 'png' : inputFormat === 'jpeg' ? 'jpeg' : 'png');
    const data = format === 'raw' ? Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length)
      : format === 'png' ? encodePng(img, this._out.options)
      : format === 'jpeg' ? encodeJpeg(img, this._out.options)
      : await encodeViaChromium(img, 'image/webp', (this._out.options.quality ?? 80) / 100);
    const info = { format, width: img.width, height: img.height, channels: format === 'jpeg' ? 3 : format === 'webp' ? 4 : img.channels, size: data.length, premultiplied: false };
    return opts.resolveWithObject ? { data, info } : data;
  }
  async toFile(path) { const { data, info } = await this.toBuffer({ resolveWithObject: true }); writeFileSync(path, data); return info; }
  async metadata() {
    const input = this._input;
    if (!this._options.raw && (typeof input === 'string' || input instanceof Uint8Array)) {
      const header = headerMetadata(typeof input === 'string' ? readFileSync(input) : Buffer.from(input.buffer, input.byteOffset, input.byteLength));
      if (header) return header;
    }
    const loaded = await this._load();
    return { format: loaded.format, width: loaded.width, height: loaded.height, channels: loaded.sourceChannels ?? loaded.channels, hasAlpha: loaded.hasAlpha ?? (loaded.channels === 2 || loaded.channels === 4), space: (loaded.sourceChannels ?? loaded.channels) <= 2 ? 'b-w' : 'srgb' };
  }
  async stats() {
    const { img } = await this._pipeline(), c = img.channels, n = img.width * img.height, channels = [];
    for (let ch = 0; ch < c; ch++) {
      let min = 255, max = 0, sum = 0, sq = 0;
      for (let i = 0; i < n; i++) { const v = img.data[i * c + ch]; if (v < min) min = v; if (v > max) max = v; sum += v; sq += v * v; }
      const mean = sum / n; channels.push({ min, max, sum, squaresSum: sq, mean, stdev: Math.sqrt(Math.max(0, sq / n - mean * mean)) });
    }
    const isOpaque = c === 4 || c === 2 ? channels[c - 1].min === 255 : true;
    return { channels, isOpaque, entropy: 0, sharpness: 0, dominant: undefined };
  }
}

function sharp(input, options) { return new Sharp(input, options); }
sharp.Sharp = Sharp;
sharp.kernel = { nearest: 'nearest', linear: 'linear', cubic: 'cubic', mitchell: 'mitchell', lanczos2: 'lanczos2', lanczos3: 'lanczos3' };
sharp.fit = { contain: 'contain', cover: 'cover', fill: 'fill', inside: 'inside', outside: 'outside' };
sharp.cache = () => undefined; sharp.concurrency = () => 1; sharp.simd = () => false;
sharp.versions = { 'sharp-compat': '0.33.5-crispcad.1' };
module.exports = sharp;
module.exports.default = sharp;
