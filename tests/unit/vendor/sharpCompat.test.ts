// SPDX-License-Identifier: MIT
// CrispCAD's libvips-free sharp replacement (vendor/sharp-compat).
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import sharp from 'sharp';

const png = (w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]) => {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p.data.set(fill(x, y), (y * w + x) * 4);
  return PNG.sync.write(p);
};

describe('sharp-compat', () => {
  it('is the vendored implementation, not libvips', () => {
    expect((sharp as unknown as { versions: Record<string, string> }).versions['sharp-compat']).toMatch(/crispcad/);
  });

  it('round-trips PNG and reports metadata', async () => {
    const input = png(4, 3, (x, y) => [x * 60, y * 80, 7, 255]);
    expect(await sharp(input).metadata()).toMatchObject({ format: 'png', width: 4, height: 3, hasAlpha: true });
    const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 4, height: 3, channels: 3 });
    expect([...data.subarray(3 * 5, 3 * 6)]).toEqual([60, 80, 7]); // pixel (1,1)
  });

  it('encodes raw pixels, extracts and composites with alpha', async () => {
    const red = await sharp(Buffer.from(new Uint8Array(4 * 4 * 3).fill(0).map((_, i) => (i % 3 === 0 ? 255 : 0))), { raw: { width: 4, height: 4, channels: 3 } }).png().toBuffer();
    const canvas = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } })
      .composite([{ input: red, top: 2, left: 2 }]).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => [...canvas.data.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)];
    expect(at(0, 0)).toEqual([0, 0, 255, 255]);
    expect(at(3, 3)).toEqual([255, 0, 0, 255]);
    const cropped = await sharp(red).extract({ left: 1, top: 1, width: 2, height: 3 }).toBuffer({ resolveWithObject: true });
    expect(cropped.info).toMatchObject({ width: 2, height: 3, format: 'png' });
  });

  it('resizes with Lanczos-3 preserving a flat field and averaging a checkerboard', async () => {
    const flat = png(16, 16, () => [100, 150, 200, 255]);
    const small = await sharp(flat).resize(4, 4, { kernel: 'lanczos3', fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    expect(small.info).toMatchObject({ width: 4, height: 4 });
    expect(new Set(small.data)).toEqual(new Set([100, 150, 200, 255]));
    const checker = png(16, 16, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const { data } = await sharp(checker).resize(4, 4, { fit: 'fill' }).grayscale().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 2) expect(Math.abs(data[i] - 128)).toBeLessThan(8);
  });

  it('covers by cropping the centre and computes stats', async () => {
    const wide = png(20, 10, x => (x < 5 || x >= 15 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
    const out = await sharp(wide).resize(10, 10, { fit: 'cover', kernel: 'nearest' }).png().toBuffer();
    const s = await sharp(out).stats();
    expect(s.channels[1].min).toBe(255); // only the green centre survives
    expect(s.isOpaque).toBe(true);
  });

  it('round-trips JPEG within lossy tolerance', async () => {
    const input = png(16, 16, () => [200, 100, 50, 255]);
    const jpg = await sharp(input).jpeg({ quality: 95 }).toBuffer();
    expect(jpg[0]).toBe(0xff);
    const { data } = await sharp(jpg).raw().toBuffer({ resolveWithObject: true });
    expect(Math.abs(data[0] - 200) + Math.abs(data[1] - 100) + Math.abs(data[2] - 50)).toBeLessThan(12);
  });

  it('rasterises SVG through Chromium', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="6"><rect width="10" height="6" fill="#00ff00"/></svg>');
    const { data, info } = await sharp(svg).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 10, height: 6, channels: 4 });
    expect([...data.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
  }, 60000);
});
