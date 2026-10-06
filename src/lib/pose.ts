"use client";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import type { Landmark } from "@/modules/tryon/placement";

// Google's hosted pose model (about 9 MB, downloaded once per browser and then cached).
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
const MAX_SIDE = 1600;

let landmarker: Promise<PoseLandmarker> | null = null;

function getLandmarker(): Promise<PoseLandmarker> {
  landmarker ??= (async () => {
    const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
    const options = (delegate: "GPU" | "CPU") => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "IMAGE" as const,
      numPoses: 2,
      outputSegmentationMasks: true,
    });
    try {
      return await PoseLandmarker.createFromOptions(vision, options("GPU"));
    } catch {
      return await PoseLandmarker.createFromOptions(vision, options("CPU"));
    }
  })();
  landmarker.catch(() => (landmarker = null));
  return landmarker;
}

const VIDEO_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const videoLandmarkers = new Map<boolean, Promise<PoseLandmarker>>();

/** A lighter, streaming pose model for the live mirror; with masks when the studio background is on. */
export function getVideoLandmarker(withMasks: boolean): Promise<PoseLandmarker> {
  let p = videoLandmarkers.get(withMasks);
  if (!p) {
    p = (async () => {
      const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
      const vision = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      const options = (delegate: "GPU" | "CPU") => ({
        baseOptions: { modelAssetPath: VIDEO_MODEL_URL, delegate },
        runningMode: "VIDEO" as const,
        numPoses: 1,
        outputSegmentationMasks: withMasks,
      });
      try {
        return await PoseLandmarker.createFromOptions(vision, options("GPU"));
      } catch {
        return await PoseLandmarker.createFromOptions(vision, options("CPU"));
      }
    })();
    p.catch(() => videoLandmarkers.delete(withMasks));
    videoLandmarkers.set(withMasks, p);
  }
  return p;
}

export type PreparedAvatar = { blob: Blob; landmarks: Landmark[]; warnings: string[] };

async function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  const webp = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.9));
  if (webp?.type === "image/webp") return webp;
  const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!png) throw new Error("Could not encode the photo");
  return png;
}

type CutOut = { canvas: HTMLCanvasElement; landmarks: Landmark[] };

/**
 * Finds the person (33 landmarks) and cuts them out of the background with the segmentation mask,
 * cropped to the person. On this device only. Works for any view: front, side or back.
 */
async function cutOut(file: Blob): Promise<CutOut> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This browser can't read that photo format. Try a JPEG or PNG.");
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const W = Math.round(bitmap.width * scale);
  const H = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bitmap, 0, 0, W, H);

  const result = (await getLandmarker()).detect(canvas);
  try {
    if (!result.landmarks.length) throw new Error("No person found. Use a clear photo of yourself, standing, facing the camera.");
    if (result.landmarks.length > 1) throw new Error("More than one person found. Use a photo with only you in it.");
    const mask = result.segmentationMasks?.[0];
    if (!mask) throw new Error("Could not separate you from the background. Try a photo with better light.");

    // Soft alpha from mask confidence; track the person's bounding box as we go.
    const conf = mask.getAsFloat32Array();
    const mw = mask.width;
    const mh = mask.height;
    const img = g.getImageData(0, 0, W, H);
    let minX = W, minY = H, maxX = 0, maxY = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = conf[Math.floor((y * mh) / H) * mw + Math.floor((x * mw) / W)];
        const a = Math.max(0, Math.min(1, (c - 0.35) / 0.3));
        img.data[(y * W + x) * 4 + 3] = Math.round(a * 255);
        if (a > 0.5) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX <= minX || maxY <= minY) throw new Error("Could not separate you from the background. Try a photo with better light.");
    g.putImageData(img, 0, 0);

    const margin = Math.round(Math.max(maxX - minX, maxY - minY) * 0.06);
    const cx = Math.max(0, minX - margin);
    const cy = Math.max(0, minY - margin);
    const cw = Math.min(W, maxX + margin) - cx;
    const ch = Math.min(H, maxY + margin) - cy;
    const out = document.createElement("canvas");
    out.width = cw;
    out.height = ch;
    out.getContext("2d")!.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);

    const landmarks = result.landmarks[0].map((p) => ({
      x: (p.x * W - cx) / cw,
      y: (p.y * H - cy) / ch,
      z: p.z,
      visibility: p.visibility,
    }));
    return { canvas: out, landmarks };
  } finally {
    result.segmentationMasks?.forEach((m) => m.close());
  }
}

/** A cut-out of the person in any view (a 360° scan's sides and back), as an image to upload. */
export async function cutOutPerson(file: Blob): Promise<{ blob: Blob; landmarks: Landmark[] }> {
  const { canvas, landmarks } = await cutOut(file);
  return { blob: await encode(canvas), landmarks };
}

/**
 * Everything happens on this device: find the body (33 landmarks), cut the person out of the
 * background with the segmentation mask, and crop to the person. Only the cut-out is uploaded.
 */
export async function prepareAvatarPhoto(file: Blob): Promise<PreparedAvatar> {
  const { canvas, landmarks } = await cutOut(file);
  const seen = (i: number) => (landmarks[i].visibility ?? 1) >= 0.5;
  const warnings: string[] = [];
  if (![11, 12, 23, 24].every(seen)) throw new Error("We couldn't see your shoulders and hips. Stand facing the camera with your upper body and hips in frame.");
  if (![27, 28].every(seen)) warnings.push("Your feet aren't fully visible, so trousers and shoes will be placed approximately.");
  if (Math.abs(landmarks[11].x - landmarks[12].x) < 0.12) warnings.push("You seem to be turned sideways; a front-facing photo works best.");
  return { blob: await encode(canvas), landmarks, warnings };
}
