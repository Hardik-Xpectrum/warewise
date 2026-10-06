"use client";
// A rotatable 3D avatar built from the user's measurements, dressed in their garments. Loaded on
// demand (three.js is large), and everything runs on the device.
import * as THREE from "three";
import type { RenderGarment } from "@/lib/tryonRender";
import type { Measurements } from "@/modules/tryon/measure";
import type { Landmark } from "@/modules/tryon/placement";

export type Appearance = { skin: string; hair: string; face: HTMLCanvasElement | null };

// ---------------------------------------------------------------------------
// Sampling colours and the face from the avatar photo
// ---------------------------------------------------------------------------

function pixels(img: HTMLImageElement) {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  return { g, c };
}

function average(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fallback: string): string {
  if (w < 1 || h < 1) return fallback;
  const data = g.getImageData(Math.max(0, Math.round(x)), Math.max(0, Math.round(y)), Math.round(w), Math.round(h)).data;
  let r = 0, gg = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue; // skip transparent background
    r += data[i]; gg += data[i + 1]; b += data[i + 2]; n++;
  }
  if (!n) return fallback;
  return `rgb(${Math.round(r / n)},${Math.round(gg / n)},${Math.round(b / n)})`;
}

/** Skin and hair colour, and a soft-edged crop of the face, from the avatar photo and its landmarks. */
export function readAppearance(photo: HTMLImageElement, lm: Landmark[]): Appearance {
  const { g } = pixels(photo);
  const W = photo.naturalWidth, H = photo.naturalHeight;
  const p = (i: number) => ({ x: lm[i].x * W, y: lm[i].y * H });
  const nose = p(0);
  const earSpan = Math.max(Math.abs(p(7).x - p(8).x), W * 0.04);
  // Skin: several patches (cheeks, forehead, neck); sunglasses, beards and shadows spoil any one of
  // them, so take the median by brightness.
  const shoulders = { x: (p(11).x + p(12).x) / 2, y: (p(11).y + p(12).y) / 2 };
  const patch = earSpan * 0.1;
  const candidates = [
    average(g, nose.x + earSpan * 0.2, nose.y + earSpan * 0.08, patch, patch, ""),
    average(g, nose.x - earSpan * 0.3, nose.y + earSpan * 0.08, patch, patch, ""),
    average(g, nose.x - patch / 2, nose.y - earSpan * 0.55, patch, patch * 0.7, ""),
    average(g, nose.x - patch / 2, nose.y + (shoulders.y - nose.y) * 0.62, patch, patch, ""),
  ].filter(Boolean);
  const brightness = (c: string) => (c.match(/\d+/g) ?? []).map(Number).reduce((x, y) => x + y, 0);
  candidates.sort((x, y) => brightness(x) - brightness(y));
  const skin = candidates[Math.floor(candidates.length / 2)] ?? "rgb(200,160,130)";
  // Hair patch: above the forehead.
  const hair = average(g, nose.x - earSpan * 0.2, nose.y - earSpan * 0.95, earSpan * 0.4, earSpan * 0.18, "rgb(40,30,25)");

  // Face crop with a feathered oval edge, so it blends into the head.
  const fw = earSpan * 1.25, fh = earSpan * 1.6;
  const face = document.createElement("canvas");
  face.width = 256;
  face.height = 320;
  const fg = face.getContext("2d")!;
  fg.drawImage(photo, nose.x - fw / 2, nose.y - fh * 0.52, fw, fh, 0, 0, 256, 320);
  fg.globalCompositeOperation = "destination-in";
  const mask = fg.createRadialGradient(128, 160, 60, 128, 160, 150);
  mask.addColorStop(0, "rgba(0,0,0,1)");
  mask.addColorStop(0.75, "rgba(0,0,0,1)");
  mask.addColorStop(1, "rgba(0,0,0,0)");
  fg.fillStyle = mask;
  fg.save();
  fg.scale(1, 1.25);
  fg.fillRect(0, 0, 256, 256);
  fg.restore();
  return { skin, hair, face };
}

// ---------------------------------------------------------------------------
// Fabric textures from garment photos
// ---------------------------------------------------------------------------

function garmentBase(gm: RenderGarment): string {
  const { g } = pixels(gm.img);
  const W = gm.img.naturalWidth, H = gm.img.naturalHeight;
  const S = gm.shape;
  // A patch from the side of the body, usually plain fabric without the print.
  return average(g, (S.bodyL + (S.bodyR - S.bodyL) * 0.08) * W, (S.top + (S.bottom - S.top) * 0.55) * H, (S.bodyR - S.bodyL) * 0.1 * W, (S.bottom - S.top) * 0.2 * H, "rgb(60,60,60)");
}

/** Wrap-around texture: plain fabric all round, the photo's front panel centred on the front (u = 0). */
function wrapTexture(gm: RenderGarment, src: { x: number; y: number; w: number; h: number }, frontShare: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = garmentBase(gm);
  g.fillRect(0, 0, c.width, c.height);
  const W = gm.img.naturalWidth, H = gm.img.naturalHeight;
  const fw = c.width * frontShare;
  g.drawImage(gm.img, src.x * W, src.y * H, src.w * W, src.h * H, (c.width - fw) / 2, 0, fw, c.height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.offset.x = 0.5; // canvas centre -> front of the body
  return t;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const DEPTH = 0.78; // bodies are elliptical, not round

/** A tube between two points with a start and end radius, open or capped. */
function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, material: THREE.Material, open = false) {
  const len = a.distanceTo(b);
  const geo = new THREE.CylinderGeometry(r1, r0, len, 24, 1, open);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return mesh;
}

function joint(p: THREE.Vector3, r: number, material: THREE.Material) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 16), material);
  m.position.copy(p);
  return m;
}

function lathe(profile: [number, number][], material: THREE.Material) {
  const geo = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 48);
  const m = new THREE.Mesh(geo, material);
  m.scale.z = DEPTH;
  return m;
}

// ---------------------------------------------------------------------------
// The avatar
// ---------------------------------------------------------------------------

export type AvatarScene = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  figure: THREE.Group;
  height: number;
  dispose: () => void;
};

export function buildAvatar(canvas: HTMLCanvasElement, m: Measurements, look: Appearance, garments: RenderGarment[]): AvatarScene {
  const cm = (v: number) => v / 100;
  const H = cm(m.heightCm);
  const inseam = cm(m.inseamCm);
  const torso = cm(m.torsoCm);
  const head = cm(m.headCm);
  const hipY = inseam;
  const shoulderY = hipY + torso;
  const shHalf = cm(m.shoulderCm) / 2;
  const chestR = cm(m.chestCm) / (2 * Math.PI) / ((1 + DEPTH) / 2);
  const waistR = cm(m.waistCm) / (2 * Math.PI) / ((1 + DEPTH) / 2);
  const hipR = cm(m.hipCm) / (2 * Math.PI) / ((1 + DEPTH) / 2);
  const headR = head * 0.42;
  const headY = H - headR * 1.1;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 3 / 4, 0.1, 50);
  camera.position.set(0, H * 0.55, H * 2.55);
  camera.lookAt(0, H * 0.5, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb8aa9a, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 1.9);
  key.position.set(1.5, 3, 2.5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xfff1e0, 0.7);
  rim.position.set(-2, 2, -2);
  scene.add(rim);

  const figure = new THREE.Group();
  scene.add(figure);
  const disposables: { dispose: () => void }[] = [];
  const mat = (opts: THREE.MeshStandardMaterialParameters) => {
    const x = new THREE.MeshStandardMaterial({ roughness: 0.85, ...opts });
    disposables.push(x);
    return x;
  };
  const skin = mat({ color: look.skin, roughness: 0.6 });
  const v = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);

  // --- Body ---------------------------------------------------------------
  figure.add(lathe([[0.001, hipY - 0.1], [hipR * 0.8, hipY - 0.08], [hipR, hipY], [waistR, hipY + torso * 0.4], [chestR, hipY + torso * 0.78], [chestR * 0.8, shoulderY], [0.055, shoulderY + 0.05], [0.05, shoulderY + 0.09]], skin));
  figure.add(limb(v(0, shoulderY + 0.02), v(0, headY - headR * 0.7), 0.05, 0.047, skin));
  const headMesh = joint(v(0, headY), headR, skin);
  headMesh.scale.set(0.9, 1.12, 0.98);
  figure.add(headMesh);

  // Arms hang in a relaxed A-pose.
  const upper = cm(m.upperArmCm), fore = cm(m.armCm - m.upperArmCm);
  const armPts = [-1, 1].map((sgn) => {
    const s = v(sgn * (shHalf - 0.035), shoulderY - 0.03);
    const e = s.clone().add(v(sgn * upper * Math.sin(0.16), -upper * Math.cos(0.16)));
    const w = e.clone().add(v(sgn * fore * Math.sin(0.1), -fore * Math.cos(0.1), 0.02));
    return { s, e, w };
  });
  for (const { s, e, w } of armPts) {
    figure.add(joint(s, 0.05, skin), limb(s, e, 0.046, 0.037, skin), joint(e, 0.037, skin), limb(e, w, 0.036, 0.028, skin), joint(w.clone().add(v(0, -0.05, 0.01)), 0.043, skin));
  }
  // Legs.
  const legPts = [-1, 1].map((sgn) => {
    const h = v(sgn * hipR * 0.5, hipY - 0.02);
    const k = v(sgn * hipR * 0.45, inseam * 0.5);
    const a = v(sgn * hipR * 0.42, 0.08);
    return { h, k, a };
  });
  for (const { h, k, a } of legPts) {
    figure.add(limb(h, k, hipR * 0.5, 0.058, skin), joint(k, 0.056, skin), limb(k, a, 0.056, 0.037, skin));
  }

  // --- Face and hair -----------------------------------------------------------
  const hairMat = mat({ color: look.hair, roughness: 0.95 });
  const cap = new THREE.Mesh(new THREE.SphereGeometry(headR * 1.05, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.42), hairMat);
  cap.position.set(0, headY + headR * 0.08, -headR * 0.04);
  cap.scale.set(0.9, 1.12, 0.98);
  figure.add(cap);
  // In three.js spheres, phi = π/2 faces +z (front) and 3π/2 faces -z (back).
  const back = new THREE.Mesh(new THREE.SphereGeometry(headR * 1.03, 32, 16, Math.PI * 1.05, Math.PI * 0.9, 0, Math.PI * 0.62), hairMat);
  back.position.set(0, headY, 0);
  back.scale.set(0.9, 1.12, 0.98);
  figure.add(back);
  if (look.face) {
    const faceTex = new THREE.CanvasTexture(look.face);
    faceTex.colorSpace = THREE.SRGBColorSpace;
    disposables.push(faceTex);
    const faceMat = mat({ map: faceTex, transparent: true, roughness: 0.75 });
    // Front section of a slightly larger sphere: the photo face wraps around the head.
    const faceMesh = new THREE.Mesh(new THREE.SphereGeometry(headR * 1.015, 48, 32, Math.PI / 2 - Math.PI * 0.36, Math.PI * 0.72, Math.PI * 0.2, Math.PI * 0.62), faceMat);
    faceMesh.position.set(0, headY, 0);
    faceMesh.scale.set(0.9, 1.12, 0.98);
    figure.add(faceMesh);
  }

  // --- Clothes ---------------------------------------------------------------------
  let coversLegs = false;
  let coversFeet = false;
  for (const gm of garments) {
    const fit = gm.fit ?? 1;
    const S = gm.shape;
    const ease = 0.012 + (fit - 1) * 0.06;
    const sub = (gm.subcategory ?? "").toLowerCase();
    const bodySrc = { x: S.bodyL + (S.bodyR - S.bodyL) * 0.06, y: S.top + (S.bottom - S.top) * 0.08, w: (S.bodyR - S.bodyL) * 0.88, h: (S.bottom - S.top) * 0.88 };

    if (gm.slot === "top" || gm.slot === "outer" || gm.slot === "one_piece") {
      const long = /kurta|tunic|kurti/.test(sub);
      const dress = gm.slot === "one_piece";
      const tall = dress && ((S.bottom - S.top) / Math.max(0.01, S.bodyR - S.bodyL) > 2.2 || /saree|maxi|gown|lehenga|anarkali/.test(sub));
      const hemY = dress ? (tall ? 0.1 : inseam * 0.5) : long ? inseam * 0.52 : hipY - (gm.slot === "outer" ? 0.14 : 0.08);
      const grow = gm.slot === "outer" ? 0.015 : 0;
      const flare = dress ? (tall ? 1.5 : 1.3) : long ? 1.15 : 1.02;
      const tex = wrapTexture(gm, bodySrc, 0.45);
      disposables.push(tex);
      const cloth = mat({ map: tex, side: THREE.DoubleSide });
      figure.add(lathe([
        [hipR * flare + ease + grow, hemY],
        [(hemY < hipY ? hipR * flare : waistR) + ease + grow, Math.min(hipY + 0.02, hemY + 0.12)],
        [waistR * 1.02 + ease + grow, hipY + torso * 0.4],
        [chestR + ease + grow, hipY + torso * 0.78],
        [chestR * 0.86 + ease + grow, shoulderY + 0.01],
        [0.068 + grow, shoulderY + 0.05],
      ], cloth));
      // Sleeves.
      const sleeve = /tank|vest|sleeveless|camisole|strap|slip/.test(sub) ? null : gm.slot === "outer" || (/shirt|kurta|sweater|hoodie|long/.test(sub) && !/t-shirt|tee|polo/.test(sub)) ? "long" : "short";
      if (sleeve) {
        const sleeveMat = mat({ color: garmentBase(gm), side: THREE.DoubleSide });
        for (const { s, e, w } of armPts) {
          const end = sleeve === "long" ? w : s.clone().lerp(e, 0.55);
          figure.add(joint(s, 0.05 + ease + 0.008, sleeveMat));
          figure.add(limb(s, sleeve === "long" ? e : end, 0.058 + ease, 0.05 + ease, sleeveMat, true));
          if (sleeve === "long") figure.add(joint(e, 0.045 + ease, sleeveMat), limb(e, w, 0.045 + ease, 0.036 + ease, sleeveMat, true));
        }
      }
      if (dress) coversLegs = true;
    } else if (gm.slot === "bottom") {
      coversLegs = true;
      const short = /shorts|skirt/.test(sub);
      const cx = (S.waistL + S.waistR) / 2;
      const legSrc = { x: S.waistL + (cx - S.waistL) * 0.1, y: S.top + (S.bottom - S.top) * 0.08, w: (cx - S.waistL) * 0.8, h: (S.bottom - S.top) * 0.4 };
      const tex = wrapTexture(gm, legSrc, 0.5);
      tex.repeat.set(1, 1);
      disposables.push(tex);
      const cloth = mat({ map: tex, side: THREE.DoubleSide });
      // Seat and waistband.
      figure.add(lathe([[hipR + ease, hipY - 0.1], [hipR + ease, hipY], [waistR + ease + 0.004, hipY + 0.1], [waistR + ease, hipY + 0.11]], cloth));
      for (const { h, k, a } of legPts) {
        figure.add(limb(h, k, hipR * 0.5 + ease + 0.01, 0.07 + ease, cloth, true), joint(k, 0.066 + ease, cloth));
        if (!short) figure.add(limb(k, a.clone().add(v(0, -0.02)), 0.066 + ease, 0.055 + ease, cloth, true));
      }
    } else if (gm.slot === "shoes") {
      coversFeet = true;
      const shoeMat = mat({ color: garmentBase({ ...gm, shape: { ...gm.shape, bodyL: 0.3, bodyR: 0.7, top: 0.2, bottom: 0.8 } }), roughness: 0.6 });
      const sole = mat({ color: "#eeeeea", roughness: 0.9 });
      for (const { a } of legPts) {
        const shoe = new THREE.Mesh(new THREE.CapsuleGeometry(0.048, 0.17, 8, 16), shoeMat);
        shoe.rotation.x = Math.PI / 2;
        shoe.scale.set(1.05, 1, 0.75);
        shoe.position.set(a.x, 0.045, 0.05);
        const s = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.28), sole);
        s.position.set(a.x, 0.012, 0.05);
        figure.add(shoe, s);
      }
    }
  }
  if (!coversLegs) {
    // Neutral base layer, so the avatar is never undressed below the waist.
    const base = mat({ color: "#3b3b40" });
    figure.add(lathe([[hipR + 0.006, hipY - 0.1], [hipR + 0.006, hipY], [waistR + 0.006, hipY + 0.08]], base));
    for (const { h, k } of legPts) figure.add(limb(h, k.clone().lerp(h, 0.55), hipR * 0.5 + 0.008, 0.07, base, true));
  }
  if (!coversFeet) {
    const bare = mat({ color: "#6d6158" });
    for (const { a } of legPts) {
      const foot = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.14, 6, 12), bare);
      foot.rotation.x = Math.PI / 2;
      foot.position.set(a.x, 0.04, 0.045);
      figure.add(foot);
    }
  }

  // Soft contact shadow.
  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = shadowCanvas.height = 128;
  const sg = shadowCanvas.getContext("2d")!;
  const grad = sg.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,0.35)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  sg.fillStyle = grad;
  sg.fillRect(0, 0, 128, 128);
  const shadowTex = new THREE.CanvasTexture(shadowCanvas);
  disposables.push(shadowTex);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.5), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.001;
  scene.add(shadow);

  return {
    renderer,
    scene,
    camera,
    figure,
    height: H,
    dispose() {
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Photo avatar: the user's own (dressed) photo inflated into 3D
// ---------------------------------------------------------------------------

/** Softens a depth map so the inflated surface has smooth normals instead of grid steps. */
function blurDepth(z: Float32Array, mask: Uint8Array, w: number, h: number, passes = 2) {
  let cur = z;
  for (let p = 0; p < passes; p++) {
    const next = new Float32Array(cur.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        // Keep the outline at depth 0 so front and back still meet after smoothing.
        if (!mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) continue;
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const j = yy * w + xx;
            s += mask[j] ? cur[j] : 0;
            n++;
          }
        next[i] = s / n;
      }
    cur = next;
  }
  return cur;
}

/**
 * Blur by shrinking and re-enlarging with smoothing. Works in every browser (Safari ignores the
 * canvas `filter` property, which left prints sharp on the back view).
 */
export function softBlur(src: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const W = src.width, H = src.height;
  const k = Math.max(1, radius);
  const sw = Math.max(2, Math.round(W / k)), sh = Math.max(2, Math.round(H / k));
  const small = document.createElement("canvas");
  small.width = sw;
  small.height = sh;
  const sg = small.getContext("2d")!;
  sg.imageSmoothingQuality = "high";
  sg.drawImage(src, 0, 0, sw, sh);
  // Enlarge in two steps: one bilinear jump from very small looks blocky.
  const mid = document.createElement("canvas");
  mid.width = Math.min(W, sw * 4);
  mid.height = Math.min(H, sh * 4);
  const mg = mid.getContext("2d")!;
  mg.imageSmoothingQuality = "high";
  mg.drawImage(small, 0, 0, mid.width, mid.height);
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const og = out.getContext("2d")!;
  og.imageSmoothingQuality = "high";
  og.drawImage(mid, 0, 0, W, H);
  return out;
}

/**
 * Copy of an image whose colours are smeared outward past its outline ("edge padding"), so a 3D
 * surface that samples right at the silhouette gets body colour instead of transparent black.
 */
function padded(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext("2d")!;
  const r = Math.max(2, Math.round(src.width * 0.006));
  const far = softBlur(src, r * 3);
  for (let k = 0; k < 4; k++) g.drawImage(far, 0, 0);
  for (const k of [4, 3, 2, 1]) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) g.drawImage(src, dx * r * k, dy * r * k);
  g.drawImage(src, 0, 0);
  return c;
}

/** Binary erosion by `r` pixels (separable min filter), e.g. to drop a cut-out's fringe. */
function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = 0; // pixels since the last hole, scanning left to right
    const left = new Int32Array(w);
    for (let x = 0; x < w; x++) {
      run = mask[y * w + x] ? run + 1 : 0;
      left[x] = run;
    }
    run = 0;
    for (let x = w - 1; x >= 0; x--) {
      run = mask[y * w + x] ? run + 1 : 0;
      tmp[y * w + x] = left[x] > r && run > r ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let run = 0;
    const up = new Int32Array(h);
    for (let y = 0; y < h; y++) {
      run = tmp[y * w + x] ? run + 1 : 0;
      up[y] = run;
    }
    run = 0;
    for (let y = h - 1; y >= 0; y--) {
      run = tmp[y * w + x] ? run + 1 : 0;
      out[y * w + x] = up[y] > r && run > r ? 1 : 0;
    }
  }
  return out;
}

/**
 * Texture whose colours are edge-padded but whose alpha is the photo's exact cut-out. With alpha
 * testing, the 3D outline follows the smooth photo edge instead of the mesh's grid steps.
 */
function cutoutTexture(image: HTMLCanvasElement): THREE.DataTexture {
  const W = image.width, H = image.height;
  const alpha = image.getContext("2d")!.getImageData(0, 0, W, H).data;
  // The outermost few pixels of a cut-out still carry the old background (a light halo round hair
  // and arms). Keep only the solid core, eroded a little, and re-grow colour outward from it.
  const r = Math.max(2, Math.round(W * 0.007));
  const solid = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) solid[i] = alpha[i * 4 + 3] > 250 ? 1 : 0;
  const core = erode(solid, W, H, r);
  const coreImg = new ImageData(new Uint8ClampedArray(alpha), W, H);
  for (let i = 0; i < W * H; i++) if (!core[i]) coreImg.data[i * 4 + 3] = 0;
  const coreCanvas = document.createElement("canvas");
  coreCanvas.width = W;
  coreCanvas.height = H;
  coreCanvas.getContext("2d")!.putImageData(coreImg, 0, 0);
  const regrown = padded(coreCanvas).getContext("2d")!.getImageData(0, 0, W, H).data;
  const colour = new Uint8ClampedArray(alpha);
  for (let i = 0; i < W * H; i++)
    if (!core[i]) for (let k = 0; k < 3; k++) colour[i * 4 + k] = regrown[i * 4 + k];
  const data = new Uint8Array(W * H * 4);
  // Rows flipped: the mesh UVs expect the image's top row at v = 1.
  for (let y = 0; y < H; y++) {
    const from = y * W * 4, to = (H - 1 - y) * W * 4;
    for (let x = 0; x < W * 4; x += 4) {
      data[to + x] = colour[from + x];
      data[to + x + 1] = colour[from + x + 1];
      data[to + x + 2] = colour[from + x + 2];
      data[to + x + 3] = alpha[from + x + 3];
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds a 3D avatar that looks like the user: the silhouette of `front` (the dressed photo on a
 * transparent background) is inflated into a rounded body; `front` textures the front surface and
 * `back` (a generated back view) the back.
 */
export async function buildPhotoAvatar(canvas: HTMLCanvasElement, front: HTMLCanvasElement, back: HTMLCanvasElement, heightCm: number): Promise<AvatarScene> {
  const { inflate, reliefSurface } = await import("@/modules/tryon/relief");
  const gw = 200;
  const gh = Math.min(600, Math.round((gw * front.height) / front.width));
  const small = document.createElement("canvas");
  small.width = gw;
  small.height = gh;
  const sg = small.getContext("2d", { willReadFrequently: true })!;
  sg.drawImage(front, 0, 0, gw, gh);
  const rgba = sg.getImageData(0, 0, gw, gh).data;
  const solid = new Uint8Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) solid[i] = rgba[i * 4 + 3] > 128 ? 1 : 0;
  // Grow the mesh one cell past the silhouette; the texture's alpha then trims it to the exact,
  // smooth photo outline. Depth is zero on the two outer rings, so front and back still meet.
  const mask = new Uint8Array(gw * gh);
  let top = gh, bottom = 0;
  for (let y = 1; y < gh - 1; y++)
    for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x;
      if (solid[i] || solid[i - 1] || solid[i + 1] || solid[i - gw] || solid[i + gw]) mask[i] = 1;
      if (solid[i]) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  // Real bodies are about half as deep as they are wide; 0.5 per side avoids the "balloon" look.
  const depth = blurDepth(inflate(mask, gw, gh, 0.5, 0.35), mask, gw, gh);
  // On every cell at or outside the photo's outline, after smoothing, the front sheet tucks just
  // behind the back sheet (and vice versa). The texture's alpha cuts the surface there, so the two
  // must overlap, not merely meet, or the background shows through as a white dotted seam.
  for (let y = 1; y < gh - 1; y++)
    for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x;
      if (!(solid[i] && solid[i - 1] && solid[i + 1] && solid[i - gw] && solid[i + gw])) depth[i] = -1.2;
    }
  const H = heightCm / 100;
  const metresPerPx = H / Math.max(1, bottom - top + 1);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 3 / 4, 0.1, 50);
  camera.position.set(0, H * 0.55, H * 2.55);
  camera.lookAt(0, H * 0.5, 0);
  // Mostly even light keeps the photo's own colours; a soft key light shows the 3D shape.
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8cfc4, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(1.2, 2.5, 2.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-1.5, 1.5, -2.5);
  scene.add(fill);

  const figure = new THREE.Group();
  scene.add(figure);
  const disposables: { dispose: () => void }[] = [];
  for (const [side, image] of [[1, front], [-1, back]] as const) {
    const surf = reliefSurface(mask, depth, gw, gh, metresPerPx, side, side === 1 ? 1 : 0.9);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(surf.positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(surf.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(surf.indices, 1));
    geo.computeVertexNormals();
    const tex = cutoutTexture(image);
    const material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0, alphaTest: 0.5, alphaToCoverage: true });
    disposables.push(geo, tex, material);
    figure.add(new THREE.Mesh(geo, material));
  }
  // The feet stand on the floor; lift slightly so the soles don't clip.
  figure.position.y = 0.005;

  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = shadowCanvas.height = 128;
  const shg = shadowCanvas.getContext("2d")!;
  const grad = shg.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,0.35)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  shg.fillStyle = grad;
  shg.fillRect(0, 0, 128, 128);
  const shadowTex = new THREE.CanvasTexture(shadowCanvas);
  disposables.push(shadowTex);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.5), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.001;
  scene.add(shadow);

  return {
    renderer,
    scene,
    camera,
    figure,
    height: H,
    dispose() {
      disposables.forEach((d) => d.dispose());
      shadow.geometry.dispose();
      renderer.dispose();
    },
  };
}

/**
 * The back view for the photo avatar: the dressed front, blurred so prints and the face vanish,
 * a little darker (the back is in shadow), with hair over the head and skin on the neck.
 */
/** Median colour of the opaque pixels inside the torso box (shoulders to hips, inner part). */
function medianColour(src: HTMLCanvasElement, sL: { x: number; y: number }, sR: { x: number; y: number }, hL: { x: number; y: number }, hR: { x: number; y: number }): string | null {
  const x0 = Math.round(Math.min(sL.x, sR.x, hL.x, hR.x)), x1 = Math.round(Math.max(sL.x, sR.x, hL.x, hR.x));
  const y0 = Math.round(Math.min(sL.y, sR.y)), y1 = Math.round(Math.max(hL.y, hR.y));
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return null;
  const d = src.getContext("2d")!.getImageData(x0 + Math.round(w * 0.2), y0 + Math.round(h * 0.1), Math.round(w * 0.6), Math.round(h * 0.75)).data;
  const ch: number[][] = [[], [], []];
  for (let i = 0; i < d.length; i += 16) {
    if (d[i + 3] < 250) continue;
    for (let k = 0; k < 3; k++) ch[k].push(d[i + k]);
  }
  if (ch[0].length < 20) return null;
  const med = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1];
  return `rgb(${med(ch[0])},${med(ch[1])},${med(ch[2])})`;
}

/** Scales an "rgb(r,g,b)" colour's brightness. */
function shade(rgb: string, k: number): string {
  const m = rgb.match(/\d+/g);
  if (!m) return rgb;
  const [r, g, b] = m.map((v) => Math.max(0, Math.min(255, Math.round(Number(v) * k))));
  return `rgb(${r},${g},${b})`;
}

export function backView(front: HTMLCanvasElement, lm: Landmark[], look: Appearance): HTMLCanvasElement {
  const W = front.width, H = front.height;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  // Heavy blur keeps each garment's colour but removes prints and the face (a back has neither).
  // Three small blurs approximate one smooth Gaussian (one big shrink leaves blotches).
  let blurred = front;
  for (let k = 0; k < 3; k++) blurred = softBlur(blurred, Math.max(2, Math.round(W * 0.01)));
  for (let k = 0; k < 4; k++) g.drawImage(blurred, 0, 0); // repeated draws restore opacity lost to the blur
  g.globalCompositeOperation = "destination-in";
  g.drawImage(front, 0, 0); // back to the exact silhouette
  g.globalCompositeOperation = "source-over";
  g.globalCompositeOperation = "source-atop";
  g.fillStyle = "rgba(0,0,0,0.12)";
  g.fillRect(0, 0, W, H);
  // The back of whatever top is worn: its plain median colour over the torso (logos and prints
  // are on the front), feathered so the edges blend into the arms and waist.
  const P = (i: number) => ({ x: lm[i].x * W, y: lm[i].y * H });
  const [sL, sR, hL, hR] = [P(11), P(12), P(23), P(24)];
  const torsoColour = medianColour(c, sL, sR, hL, hR); // sampled after shading, so it matches
  if (torsoColour) {
    const t = document.createElement("canvas");
    t.width = W;
    t.height = H;
    const tg = t.getContext("2d")!;
    const inset = (a: { x: number; y: number }, b: { x: number; y: number }, k: number) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
    const q = [inset(sL, sR, 0.04), inset(sR, sL, 0.04), inset(hR, hL, -0.05), inset(hL, hR, -0.05)];
    const up = (sL.y + sR.y) / 2 - Math.abs(sR.x - sL.x) * 0.08;
    tg.fillStyle = torsoColour;
    tg.beginPath();
    tg.moveTo(q[0].x, up);
    tg.lineTo(q[1].x, up);
    tg.lineTo(q[2].x, q[2].y);
    tg.lineTo(q[3].x, q[3].y);
    tg.closePath();
    tg.fill();
    let feathered = t;
    for (let k = 0; k < 3; k++) feathered = softBlur(feathered, Math.max(2, Math.round(W * 0.012)));
    g.drawImage(feathered, 0, 0);
    g.drawImage(feathered, 0, 0); // twice: fully opaque in the middle, soft at the edges
  }
  const nose = lm[0].y * H;
  const shoulders = ((lm[11].y + lm[12].y) / 2) * H;
  const chin = nose + (shoulders - nose) * 0.42;
  // Back of the head: skin (ears, nape) under a rounded hair cap with a soft, low hairline.
  const neckXh = ((lm[11].x + lm[12].x) / 2) * W;
  const headTop = nose - (chin - nose) * 1.7;
  g.fillStyle = look.skin;
  g.fillRect(0, 0, W, chin);
  const hairCanvas = document.createElement("canvas");
  hairCanvas.width = W;
  hairCanvas.height = H;
  const hg = hairCanvas.getContext("2d")!;
  const ry = (chin - headTop) * 0.5;
  const cy = headTop + ry * 0.92;
  const grad = hg.createRadialGradient(neckXh - ry * 0.2, cy - ry * 0.5, ry * 0.05, neckXh, cy, ry * 1.3);
  grad.addColorStop(0, shade(look.hair, 1.35));
  grad.addColorStop(0.6, look.hair);
  grad.addColorStop(1, shade(look.hair, 0.8));
  hg.fillStyle = grad;
  hg.beginPath();
  hg.ellipse(neckXh, cy, ry * 1.4, ry, 0, 0, Math.PI * 2);
  hg.fill();
  hg.fillRect(0, 0, W, cy); // everything above the cap's middle is hair too
  g.drawImage(softBlur(hairCanvas, Math.max(2, Math.round(W * 0.008))), 0, 0);
  // Skin only on the neck itself, not across the shoulders (the garment's collar sits there).
  const neckX = ((lm[11].x + lm[12].x) / 2) * W;
  const neckHalf = Math.abs(lm[11].x - lm[12].x) * W * 0.17;
  const neckH = (shoulders - chin) * 0.5;
  g.fillStyle = look.skin;
  g.beginPath();
  g.ellipse(neckX, chin + neckH / 2, neckHalf, neckH / 2 + 1, 0, 0, Math.PI * 2);
  g.fill();
  g.globalCompositeOperation = "source-over";
  return c;
}

// ---------------------------------------------------------------------------
// AI 3D avatar: a GLB generated by an image-to-3D service (fal.ai, Tripo, Meshy)
// ---------------------------------------------------------------------------

/**
 * Shows a generated GLB model standing on the floor at the person's height, with the same camera,
 * lights and contact shadow as the other avatar styles, so switching styles feels continuous.
 */
export async function buildGlbAvatar(canvas: HTMLCanvasElement, url: string, heightCm: number): Promise<AvatarScene> {
  const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
  const gltf = await new GLTFLoader().loadAsync(url);
  const H = heightCm / 100;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 3 / 4, 0.1, 50);
  camera.position.set(0, H * 0.55, H * 2.55);
  camera.lookAt(0, H * 0.5, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8cfc4, 2.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(1.2, 2.5, 2.5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.8);
  rim.position.set(-1.5, 1.8, -2.5);
  scene.add(rim);

  // Generated models come in arbitrary units and offsets: scale to the person's height, centre on
  // x/z and stand the feet on y = 0.
  const model = gltf.scene;
  // Generated models often leave metalness unset, which glTF treats as fully metallic: with
  // nothing to reflect, cloth and skin render nearly black. They're fabric and skin, so matte.
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (m instanceof THREE.MeshStandardMaterial) {
        m.metalness = 0;
        m.roughness = Math.max(m.roughness, 0.85);
        m.needsUpdate = true;
      }
    }
  });
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const scale = H / Math.max(size.y, 1e-6);
  model.scale.setScalar(scale);
  const scaled = new THREE.Box3().setFromObject(model);
  const centre = scaled.getCenter(new THREE.Vector3());
  model.position.set(-centre.x, -scaled.min.y, -centre.z);
  const figure = new THREE.Group();
  figure.add(model);
  scene.add(figure);

  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = shadowCanvas.height = 128;
  const shg = shadowCanvas.getContext("2d")!;
  const grad = shg.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,0.35)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  shg.fillStyle = grad;
  shg.fillRect(0, 0, 128, 128);
  const shadowTex = new THREE.CanvasTexture(shadowCanvas);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.5), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.001;
  scene.add(shadow);

  return {
    renderer,
    scene,
    camera,
    figure,
    height: H,
    dispose() {
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        for (const m of mats) {
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
          m.dispose();
        }
      });
      shadowTex.dispose();
      shadow.geometry.dispose();
      renderer.dispose();
    },
  };
}
