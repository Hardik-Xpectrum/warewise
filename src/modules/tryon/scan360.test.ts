import { describe, expect, it } from "vitest";
import type { Landmark } from "./placement";
import { framingProblem, pickViews, sharpness, TurnTracker, type ScanSample } from "./scan360";

/**
 * A person standing in frame, turned `deg` degrees to their own right (0 = facing the camera).
 * Shoulders narrow as cos(deg); the face is visible while facing the camera's side of the circle.
 */
function body(deg: number, faceAlways = false): Landmark[] {
  const rad = (deg * Math.PI) / 180;
  const half = 0.13 * Math.abs(Math.cos(rad)) + 0.012; // never exactly zero, like a real tracker
  const facing = faceAlways || Math.cos(rad) > 0.15;
  const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
  const set = (i: number, x: number, y: number, v = 0.95) => (lm[i] = { x, y, visibility: v });
  // Turned to their right, the nose points image-left at first (sin > 0 → nose left of centre).
  const noseX = 0.5 - 0.05 * Math.sin(rad);
  set(0, noseX, 0.1, facing ? 0.95 : 0.2);
  set(2, noseX + 0.01, 0.09, facing ? 0.9 : 0.1);
  set(5, noseX - 0.01, 0.09, facing ? 0.9 : 0.1);
  set(11, 0.5 + half, 0.22);
  set(12, 0.5 - half, 0.22);
  set(23, 0.5 + half * 0.7, 0.52);
  set(24, 0.5 - half * 0.7, 0.52);
  set(27, 0.52, 0.93);
  set(28, 0.48, 0.93);
  return lm;
}

/** A full turn recorded at ~7 frames a second over 15 s, plus a still second at the start. */
function turn(faceAlways = false): ScanSample[] {
  const out: ScanSample[] = [];
  for (let k = 0; k < 7; k++) out.push({ t: k * 150, landmarks: body(0, faceAlways), sharpness: 900 });
  for (let k = 0; k <= 100; k++) out.push({ t: 1050 + k * 150, landmarks: body((360 * k) / 100, faceAlways), sharpness: k % 25 === 0 ? 1500 : 600 });
  return out;
}

describe("framingProblem", () => {
  it("accepts a whole body and asks to step back when the feet are cut off", () => {
    expect(framingProblem(body(0))).toBeNull();
    const cut = body(0);
    cut[27] = { ...cut[27], y: 1.05 };
    cut[28] = { ...cut[28], y: 1.05 };
    expect(framingProblem(cut)).toMatch(/feet/);
    expect(framingProblem(null)).toMatch(/Step into view/);
  });
});

describe("TurnTracker", () => {
  it("goes front → side → back → side → front over a full turn", () => {
    const t = new TurnTracker();
    const seenPhases = new Set<string>();
    for (const s of turn()) seenPhases.add(t.update(s));
    expect([...seenPhases]).toEqual(["front", "side1", "back", "side2", "done"]);
    expect(t.progress).toBe(1);
  });

  it("follows the turn even when the tracker \"sees\" a face on the back of the head", () => {
    const t = new TurnTracker();
    for (const s of turn(true)) t.update(s);
    expect(t.phase).toBe("done");
  });

  it("doesn't finish on a half turn", () => {
    const t = new TurnTracker();
    for (const s of turn().slice(0, 60)) t.update(s);
    expect(t.phase).not.toBe("done");
  });
});

describe("pickViews", () => {
  it("finds the front, both sides and the back, and names the sides", () => {
    const views = pickViews(turn());
    expect("error" in views).toBe(false);
    if ("error" in views) return;
    const angle = (s: ScanSample) => Math.round(((s.t - 1050) / 150) * 3.6);
    expect(angle(views.front)).toBeLessThan(45); // facing the camera at the start
    expect(Math.abs(angle(views.back) - 180)).toBeLessThanOrEqual(20);
    // Turned to their right first, so the left side faces the camera at 90°.
    expect(Math.abs(angle(views.left) - 90)).toBeLessThanOrEqual(15);
    expect(Math.abs(angle(views.right) - 270)).toBeLessThanOrEqual(15);
  });

  it("finds the back even when the tracker \"sees\" a face on it", () => {
    const views = pickViews(turn(true));
    expect("error" in views).toBe(false);
    if ("error" in views) return;
    expect(Math.abs(Math.round(((views.back.t - 1050) / 150) * 3.6) - 180)).toBeLessThanOrEqual(20);
  });

  it("explains what went wrong on a half turn", () => {
    const half = turn().slice(0, 55);
    const views = pickViews(half);
    expect("error" in views && views.error).toMatch(/sides|back/);
  });
});

describe("sharpness", () => {
  it("scores a crisp edge above a flat image", () => {
    const w = 32, h = 32;
    const flat = new Uint8Array(w * h).fill(128);
    const edge = new Uint8Array(w * h).map((_, i) => ((i % w) < w / 2 ? 0 : 255));
    expect(sharpness(edge, w, h)).toBeGreaterThan(sharpness(flat, w, h));
    expect(sharpness(flat, w, h)).toBe(0);
  });
});
