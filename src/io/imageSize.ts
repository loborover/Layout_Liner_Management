/**
 * @file imageSize.ts
 *
 * Pixel size of an embedded (data: URL) PNG, GIF, JPEG or WebP image, read from its header bytes. SVG export
 * uses it to keep a tiled face picture's aspect ratio like the canvas does, without decoding the image (no DOM,
 * so it also works in the Node MCP server). Related: src/io/svg.ts, src/model/types.ts (FillImage).
 */

/** Width and height in pixels, or null when the image is not a data: URL of a format this reads. */
export function dataImageSize(src: string): { width: number; height: number } | null {
  const m = /^data:image\/[\w.+-]+;base64,(.*)$/s.exec(src);
  if (!m) return null;
  let bin: string;
  try {
    bin = atob(m[1]);
  } catch {
    return null;
  }
  const b = (i: number) => bin.charCodeAt(i);
  const be16 = (i: number) => (b(i) << 8) | b(i + 1);
  const le16 = (i: number) => b(i) | (b(i + 1) << 8);
  const be32 = (i: number) => ((b(i) << 24) | (b(i + 1) << 16) | (b(i + 2) << 8) | b(i + 3)) >>> 0;
  const ok = (w: number, h: number) => (w > 0 && h > 0 ? { width: w, height: h } : null);
  if (bin.startsWith('\x89PNG') && bin.length >= 24) return ok(be32(16), be32(20));
  if (bin.startsWith('GIF8') && bin.length >= 10) return ok(le16(6), le16(8));
  if (bin.startsWith('RIFF') && bin.slice(8, 12) === 'WEBP' && bin.length >= 30) {
    const kind = bin.slice(12, 16);
    if (kind === 'VP8X') return ok(1 + (b(24) | (b(25) << 8) | (b(26) << 16)), 1 + (b(27) | (b(28) << 8) | (b(29) << 16)));
    if (kind === 'VP8 ') return ok(le16(26) & 0x3fff, le16(28) & 0x3fff);
    if (kind === 'VP8L') {
      const bits = b(21) | (b(22) << 8) | (b(23) << 16) | (b(24) << 24);
      return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    return null;
  }
  if (b(0) === 0xff && b(1) === 0xd8) {
    // Walk the JPEG segments to the first start-of-frame marker (SOF0–SOF15 except DHT, JPG and DAC).
    let i = 2;
    while (i + 9 < bin.length) {
      if (b(i) !== 0xff) return null;
      const marker = b(i + 1);
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok(be16(i + 7), be16(i + 5));
      i += 2 + be16(i + 2);
    }
  }
  return null;
}
