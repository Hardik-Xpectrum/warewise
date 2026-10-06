/**
 * Removes a plain background from a garment photo so it can be laid over an avatar.
 * Works on raw RGBA pixels: samples the border colour, then flood-fills from the edges through
 * pixels close to it. Returns null when the background is too busy to key out reliably.
 */
export function keyOutBackground(rgba: Uint8Array | Buffer, width: number, height: number): Uint8Array | null {
  const idx = (x: number, y: number) => (y * width + x) * 4;

  // Already transparent at the corners (e.g. removed in the browser): nothing to do.
  const corners = [idx(0, 0), idx(width - 1, 0), idx(0, height - 1), idx(width - 1, height - 1)];
  if (corners.every((i) => rgba[i + 3] < 16)) return new Uint8Array(rgba);

  // Background estimate: per-channel median of border pixels.
  const border: number[][] = [];
  const step = Math.max(1, Math.floor((width + height) / 400));
  for (let x = 0; x < width; x += step) border.push([...rgba.subarray(idx(x, 0), idx(x, 0) + 3)], [...rgba.subarray(idx(x, height - 1), idx(x, height - 1) + 3)]);
  for (let y = 0; y < height; y += step) border.push([...rgba.subarray(idx(0, y), idx(0, y) + 3)], [...rgba.subarray(idx(width - 1, y), idx(width - 1, y) + 3)]);
  const median = (c: number) => border.map((p) => p[c]).sort((a, b) => a - b)[border.length >> 1];
  const bg = [median(0), median(1), median(2)];

  const THRESHOLD = 42;
  const dist = (i: number) => Math.hypot(rgba[i] - bg[0], rgba[i + 1] - bg[1], rgba[i + 2] - bg[2]);
  const nearBorder = border.filter((p) => Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]) < THRESHOLD).length;
  if (nearBorder / border.length < 0.7) return null; // busy background

  const out = new Uint8Array(rgba);
  const isBg = new Uint8Array(width * height);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const p = y * width + x;
    if (!isBg[p] && dist(p * 4) < THRESHOLD) {
      isBg[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }

  // Quality guard: after keying, the photo's edge should be almost all background. If much of it
  // survives (a textured wall, a floor), the "cut-out" would carry that background along.
  let edge = 0;
  let edgeKept = 0;
  for (let x = 0; x < width; x++) for (const y of [0, height - 1]) { edge++; if (!isBg[y * width + x]) edgeKept++; }
  for (let y = 0; y < height; y++) for (const x of [0, width - 1]) { edge++; if (!isBg[y * width + x]) edgeKept++; }
  if (edgeKept / edge > 0.12) return null;

  for (let p = 0; p < width * height; p++) {
    if (isBg[p]) out[p * 4 + 3] = 0;
    else {
      // Soften the edge: a foreground pixel touching background gets partial alpha.
      const x = p % width;
      const touching = (x > 0 && isBg[p - 1]) || (x < width - 1 && isBg[p + 1]) || (p >= width && isBg[p - width]) || (p + width < isBg.length && isBg[p + width]);
      if (touching) out[p * 4 + 3] = Math.min(out[p * 4 + 3], 150);
    }
  }
  return out;
}
