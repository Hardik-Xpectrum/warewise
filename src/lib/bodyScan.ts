"use client";
// The 360° body scan on this device: read frames from the live camera or a recorded video, track
// the body in each, choose the front / back / left / right frames, cut the person out of them and
// upload only those four cut-outs. The video itself never leaves the device.
import { api } from "@/lib/api";
import { cutOutPerson, getVideoLandmarker, prepareAvatarPhoto } from "@/lib/pose";
import { browserClient } from "@/lib/supabase/browser";
import { pickViews, sharpness, type ScanSample, type View } from "@/modules/tryon/scan360";

export type ScanFrame = ScanSample & { blob: Blob };

const FRAME_MAX = 1920; // long side of a kept frame
const GREY_W = 160; // sharpness is measured on a small greyscale copy

let lastTimestamp = 0; // the video pose model needs ever-increasing timestamps across all callers

/** Tracks the body in the current frame of `video` and keeps a JPEG of it. */
export async function sampleFrame(video: HTMLVideoElement, t: number): Promise<ScanFrame | null> {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(1, FRAME_MAX / Math.max(vw, vh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(video, 0, 0, canvas.width, canvas.height);

  const landmarker = await getVideoLandmarker(false);
  lastTimestamp = Math.max(lastTimestamp + 1, Math.round(performance.now()));
  const result = landmarker.detectForVideo(canvas, lastTimestamp);
  const lm = result.landmarks[0];
  if (!lm) return null;

  const gh = Math.round((GREY_W * canvas.height) / canvas.width);
  const small = document.createElement("canvas");
  small.width = GREY_W;
  small.height = gh;
  const sg = small.getContext("2d", { willReadFrequently: true })!;
  sg.drawImage(canvas, 0, 0, GREY_W, gh);
  const rgba = sg.getImageData(0, 0, GREY_W, gh).data;
  const grey = new Uint8Array(GREY_W * gh);
  for (let i = 0; i < grey.length; i++) grey[i] = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000;

  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
  if (!blob) return null;
  return { t, landmarks: lm.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility })), sharpness: sharpness(grey, GREY_W, gh), blob };
}

/** Steps through a recorded turn video about 7 times a second. */
export async function framesFromVideoFile(file: File, onProgress: (share: number) => void): Promise<ScanFrame[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () =>
        reject(new Error("This browser can't play that video. On an iPhone, open this page in Safari, or set Camera → Formats to “Most Compatible” and record again."));
    });
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration < 5) throw new Error("The video is too short: record a full, slow turn of 10 to 20 seconds.");
    if (duration > 90) throw new Error("The video is longer than 90 seconds. Record just the turn.");
    const frames: ScanFrame[] = [];
    for (let s = 0; s < duration; s += 0.15) {
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = s;
      });
      const f = await sampleFrame(video, Math.round(s * 1000));
      if (f) frames.push(f);
      onProgress(s / duration);
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type ScanResult = { modelId: string; previews: Record<View, string> };

/**
 * From the recorded frames: choose the four views, cut the person out of each, upload them, add
 * the front view as an avatar photo (it's a good photo for try-on), and ask for the 3D build.
 */
export async function finishScan(frames: ScanFrame[], onStep: (step: string) => void): Promise<ScanResult> {
  const picked = pickViews(frames);
  if ("error" in picked) throw new Error(picked.error);

  onStep("Cutting you out of the four views (on this device)");
  const order: View[] = ["front", "left", "back", "right"];
  const cut: Partial<Record<View, Blob>> = {};
  for (const v of order) cut[v] = (await cutOutPerson((picked[v] as ScanFrame).blob)).blob;

  onStep("Uploading the four views");
  const paths: Partial<Record<View, string>> = {};
  for (const v of order) {
    const blob = cut[v]!;
    const target = await api<{ path: string; token: string }>("/uploads", { method: "POST", json: { contentType: blob.type, purpose: "scan" } });
    const { error } = await browserClient().storage.from("wardrobe").uploadToSignedUrl(target.path, target.token, blob, { contentType: blob.type });
    if (error) throw new Error(error.message);
    paths[v] = target.path;
  }

  // The front view also makes a good try-on photo. Best effort: the scan still counts without it.
  try {
    onStep("Adding your front view as a try-on photo");
    const prepared = await prepareAvatarPhoto((picked.front as ScanFrame).blob);
    const target = await api<{ path: string; token: string }>("/uploads", { method: "POST", json: { contentType: prepared.blob.type, purpose: "avatar" } });
    await browserClient().storage.from("wardrobe").uploadToSignedUrl(target.path, target.token, prepared.blob, { contentType: prepared.blob.type });
    await api("/avatar/photos", { method: "POST", json: { imagePath: target.path, pose: { landmarks: prepared.landmarks } } });
  } catch {
    /* already five photos, or the front frame wasn't clear enough: fine */
  }

  onStep("Starting your 3D build");
  const model = await api<{ id: string }>("/avatar/models", { method: "POST", json: { source: "scan", views: paths } });
  const previews = Object.fromEntries(order.map((v) => [v, URL.createObjectURL(cut[v]!)])) as Record<View, string>;
  return { modelId: model.id, previews };
}
