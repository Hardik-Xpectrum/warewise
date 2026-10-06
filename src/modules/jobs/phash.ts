/** Number of differing bits between two equal-length hex hashes. */
export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}

/**
 * Difference hash (dHash) of a 9x8 greyscale thumbnail: one bit per horizontal neighbour pair,
 * 64 bits as 16 hex chars. Near-identical photos land within a few bits of each other.
 */
export function dHashFromPixels(pixels: Uint8Array | Buffer, width = 9, height = 8): string {
  let bits = "";
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      bits += pixels[y * width + x] > pixels[y * width + x + 1] ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
