import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MIN_SCREENSHOT_EDGE = 100;
const MAX_SCREENSHOT_EDGE = 16_384;
const MAX_SCREENSHOT_PIXELS = 50_000_000;
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;

export interface ValidatedAuditImage {
  bytes: number;
  height: number;
  sha256: string;
  uniqueColors: number;
  width: number;
}

export type AuditImageValidation =
  | { ok: true; image: ValidatedAuditImage }
  | { ok: false; reason: string };

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function channelsFor(colorType: number): number | null {
  if (colorType === 0 || colorType === 3) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  return null;
}

function pixelKey(row: Buffer, offset: number, colorType: number, palette: Buffer | null, transparency: Buffer | null): string | null {
  if (colorType === 0) return `${row[offset]},${row[offset]},${row[offset]},255`;
  if (colorType === 2) return `${row[offset]},${row[offset + 1]},${row[offset + 2]},255`;
  if (colorType === 4) return row[offset + 1] === 0 ? 'transparent' : `${row[offset]},${row[offset]},${row[offset]},${row[offset + 1]}`;
  if (colorType === 6) return row[offset + 3] === 0 ? 'transparent' : `${row[offset]},${row[offset + 1]},${row[offset + 2]},${row[offset + 3]}`;
  if (!palette) return null;
  const paletteIndex = row[offset];
  const paletteOffset = paletteIndex * 3;
  if (paletteOffset + 2 >= palette.length) return null;
  const alpha = transparency?.[paletteIndex] ?? 255;
  return alpha === 0 ? 'transparent' : `${palette[paletteOffset]},${palette[paletteOffset + 1]},${palette[paletteOffset + 2]},${alpha}`;
}

export function validateAuditPng(path: string): AuditImageValidation {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return { ok: false, reason: 'could not be read' };
  }
  if (bytes.length > MAX_SCREENSHOT_BYTES) return { ok: false, reason: `is too large (${bytes.length} bytes; maximum ${MAX_SCREENSHOT_BYTES})` };
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return { ok: false, reason: 'is not a PNG image' };

  let cursor = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  let sawHeader = false;
  let sawEnd = false;
  const imageChunks: Buffer[] = [];
  try {
    while (cursor < bytes.length) {
      if (cursor + 12 > bytes.length) return { ok: false, reason: 'has a truncated PNG chunk' };
      const length = bytes.readUInt32BE(cursor);
      const chunkEnd = cursor + 12 + length;
      if (chunkEnd > bytes.length) return { ok: false, reason: 'has a truncated PNG chunk' };
      const type = bytes.subarray(cursor + 4, cursor + 8).toString('ascii');
      const data = bytes.subarray(cursor + 8, cursor + 8 + length);
      const recordedCrc = bytes.readUInt32BE(cursor + 8 + length);
      if (crc32(bytes.subarray(cursor + 4, cursor + 8 + length)) !== recordedCrc) return { ok: false, reason: `has an invalid ${type} checksum` };
      if (type === 'IHDR') {
        if (sawHeader || length !== 13) return { ok: false, reason: 'has an invalid PNG header' };
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
        if (data[10] !== 0 || data[11] !== 0) return { ok: false, reason: 'uses unsupported PNG compression or filtering' };
        interlace = data[12];
        sawHeader = true;
      } else if (type === 'PLTE') palette = Buffer.from(data);
      else if (type === 'tRNS') transparency = Buffer.from(data);
      else if (type === 'IDAT') imageChunks.push(Buffer.from(data));
      else if (type === 'IEND') {
        sawEnd = true;
        cursor = chunkEnd;
        break;
      }
      cursor = chunkEnd;
    }
  } catch {
    return { ok: false, reason: 'could not be decoded as PNG' };
  }
  if (!sawHeader || !sawEnd || cursor !== bytes.length || imageChunks.length === 0) return { ok: false, reason: 'is not a complete PNG image' };
  if (width < MIN_SCREENSHOT_EDGE || height < MIN_SCREENSHOT_EDGE) return { ok: false, reason: `is too small (${width}x${height}; minimum ${MIN_SCREENSHOT_EDGE}x${MIN_SCREENSHOT_EDGE})` };
  if (width > MAX_SCREENSHOT_EDGE || height > MAX_SCREENSHOT_EDGE || width * height > MAX_SCREENSHOT_PIXELS) return { ok: false, reason: `has unsafe dimensions (${width}x${height})` };
  const channels = channelsFor(colorType);
  if (bitDepth !== 8 || channels === null || interlace !== 0) return { ok: false, reason: 'uses an unsupported PNG encoding; use an 8-bit non-interlaced screenshot' };
  if (colorType === 3 && (!palette || palette.length === 0 || palette.length % 3 !== 0)) return { ok: false, reason: 'has an invalid PNG palette' };

  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(imageChunks), { maxOutputLength: (width * channels + 1) * height });
  } catch {
    return { ok: false, reason: 'has corrupt compressed image data' };
  }
  const rowBytes = width * channels;
  if (inflated.length !== (rowBytes + 1) * height) return { ok: false, reason: 'has an invalid decoded pixel length' };
  let previous = Buffer.alloc(rowBytes);
  const colorCounts = new Map<string, number>();
  let manyColors = false;
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    if (filter > 4) return { ok: false, reason: 'has an invalid PNG row filter' };
    const row = Buffer.allocUnsafe(rowBytes);
    for (let index = 0; index < rowBytes; index += 1) {
      const raw = inflated[sourceOffset + index];
      const left = index >= channels ? row[index - channels] : 0;
      const above = previous[index];
      const upperLeft = index >= channels ? previous[index - channels] : 0;
      const prediction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
      row[index] = (raw + prediction) & 0xff;
    }
    sourceOffset += rowBytes;
    for (let x = 0; x < width; x += 1) {
      const key = pixelKey(row, x * channels, colorType, palette, transparency);
      if (key === null) return { ok: false, reason: 'has invalid palette pixel data' };
      if (colorCounts.has(key)) colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
      else if (colorCounts.size < 256) colorCounts.set(key, 1);
      else manyColors = true;
    }
    previous = row;
  }
  const pixelCount = width * height;
  const dominantPixels = manyColors ? 0 : Math.max(...colorCounts.values());
  const nonDominantPixels = pixelCount - dominantPixels;
  if (!manyColors && (colorCounts.size < 2 || nonDominantPixels < Math.max(100, Math.ceil(pixelCount * 0.001)))) return { ok: false, reason: 'is uniform or nearly uniform and contains no useful visual content' };
  return {
    ok: true,
    image: {
      bytes: bytes.length,
      height,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      uniqueColors: manyColors ? 257 : colorCounts.size,
      width,
    },
  };
}
