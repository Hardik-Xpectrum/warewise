// Photo-relief 3D avatar: "inflate" the person's silhouette into a rounded 3D shape. Depth grows
// with distance from the outline, so the torso becomes deep and round and arms and legs thinner
// and round, while the front keeps the exact photo. Pure maths, unit-tested.

/** Chamfer (3-4) distance transform: distance of each inside pixel to the outline, in pixels. */
export function distanceInside(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  for (let i = 0; i < w * h; i++) d[i] /= 3;
  return d;
}

/** Separable max filter: the "ridge" thickness of the limb or torso each pixel belongs to. */
function maxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, src[y * w + k]);
      tmp[y * w + x] = m;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]);
      out[y * w + x] = m;
    }
  return out;
}

/**
 * Depth (in pixels) of the front surface at each inside pixel: an elliptical cross-section whose
 * half-depth is `roundness` times the local half-width. `ridgeFrac` sets how far a limb looks for
 * its own centre line: smaller keeps arms beside the torso thin instead of puffing them up.
 */
export function inflate(mask: Uint8Array, w: number, h: number, roundness = 0.72, ridgeFrac = 0.6): Float32Array {
  const d = distanceInside(mask, w, h);
  let dmax = 0;
  for (const v of d) dmax = Math.max(dmax, v);
  // Local half-width: the largest distance nearby (a limb's own centre line, not the torso's).
  const ridge = maxFilter(d, w, h, Math.max(2, Math.round(dmax * ridgeFrac)));
  const z = new Float32Array(w * h);
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      // Outline cells stay at depth 0, so the front and back surfaces meet in a closed shell.
      if (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) continue;
      const L = Math.max(ridge[i] - 1, 0.5);
      const di = Math.min(d[i] - 1, L);
      z[i] = roundness * Math.sqrt(Math.max(0, di * (2 * L - di)));
    }
  return z;
}

export type ReliefMesh = { positions: Float32Array; uvs: Float32Array; indices: Uint32Array };

/**
 * Front or back surface as a triangle grid over the silhouette. Coordinates are in metres with
 * the feet at y = 0, centred on x = 0; `metresPerPx` scales the photo to the person's height.
 */
export function reliefSurface(mask: Uint8Array, depth: Float32Array, w: number, h: number, metresPerPx: number, side: 1 | -1, depthScale = 1): ReliefMesh {
  let minY = h, maxY = 0, minX = w, maxX = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) {
        minY = Math.min(minY, y); maxY = Math.max(maxY, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      }
  const cx = (minX + maxX) / 2;
  const index = new Int32Array(w * h).fill(-1);
  const pos: number[] = [];
  const uv: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      index[i] = pos.length / 3;
      pos.push((x - cx) * metresPerPx, (maxY - y) * metresPerPx, side * depth[i] * depthScale * metresPerPx);
      uv.push((x + 0.5) / w, 1 - (y + 0.5) / h);
    }
  const idx: number[] = [];
  for (let y = 0; y < h - 1; y++)
    for (let x = 0; x < w - 1; x++) {
      const a = index[y * w + x], b = index[y * w + x + 1], c = index[(y + 1) * w + x], d = index[(y + 1) * w + x + 1];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      // Wind triangles so the front faces +z and the back faces -z.
      if (side === 1) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  return { positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: new Uint32Array(idx) };
}
