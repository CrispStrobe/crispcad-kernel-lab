// SPDX-License-Identifier: MIT
// Types for CrispCAD's sharp-compatible subset (see index.js).
/// <reference types="node" />

declare function sharp(input?: sharp.SharpInput | sharp.CreateInput, options?: sharp.SharpOptions): sharp.Sharp;

declare namespace sharp {
  type SharpInput = Buffer | Uint8Array | string;
  interface Colour { r?: number; g?: number; b?: number; alpha?: number }
  type Color = string | Colour;
  interface Create { width: number; height: number; channels: 1 | 2 | 3 | 4; background?: Color }
  interface CreateInput { create: Create }
  interface Raw { width: number; height: number; channels: 1 | 2 | 3 | 4 }
  interface SharpOptions { raw?: Raw }
  interface KernelEnum { nearest: 'nearest'; linear: 'linear'; cubic: 'cubic'; mitchell: 'mitchell'; lanczos2: 'lanczos2'; lanczos3: 'lanczos3' }
  interface FitEnum { contain: 'contain'; cover: 'cover'; fill: 'fill'; inside: 'inside'; outside: 'outside' }
  interface ResizeOptions { width?: number; height?: number; fit?: keyof FitEnum; kernel?: keyof KernelEnum; background?: Color; withoutEnlargement?: boolean; position?: string }
  interface Region { left: number; top: number; width: number; height: number }
  interface OverlayOptions { input: SharpInput; top?: number; left?: number; raw?: Raw; blend?: 'over' }
  interface PngOptions { compressionLevel?: number; quality?: number; palette?: boolean }
  interface JpegOptions { quality?: number }
  interface WebpOptions { quality?: number; lossless?: boolean }
  interface OutputInfo { format: string; width: number; height: number; channels: 1 | 2 | 3 | 4; size: number; premultiplied: boolean }
  interface Metadata { format?: string; width?: number; height?: number; channels?: 1 | 2 | 3 | 4; hasAlpha?: boolean; space?: string }
  interface ChannelStats { min: number; max: number; sum: number; squaresSum: number; mean: number; stdev: number }
  interface Stats { channels: ChannelStats[]; isOpaque: boolean; entropy: number; sharpness: number; dominant?: { r: number; g: number; b: number } }
  interface Sharp {
    clone(): Sharp;
    ensureAlpha(): Sharp;
    removeAlpha(): Sharp;
    grayscale(grayscale?: boolean): Sharp;
    greyscale(greyscale?: boolean): Sharp;
    extract(region: Region): Sharp;
    resize(width?: number | null, height?: number | null, options?: ResizeOptions): Sharp;
    resize(options: ResizeOptions): Sharp;
    composite(images: OverlayOptions[]): Sharp;
    png(options?: PngOptions): Sharp;
    jpeg(options?: JpegOptions): Sharp;
    webp(options?: WebpOptions): Sharp;
    raw(): Sharp;
    toFormat(format: string, options?: Record<string, unknown>): Sharp;
    toBuffer(): Promise<Buffer>;
    toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: OutputInfo }>;
    toFile(path: string): Promise<OutputInfo>;
    metadata(): Promise<Metadata>;
    stats(): Promise<Stats>;
  }
  const kernel: KernelEnum;
  const fit: FitEnum;
}

export = sharp;
