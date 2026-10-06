// The 360° body scan, read from body landmarks: is the person fully in frame, how far round have
// they turned, and which frames show their front, back, left and right. Pure and unit-tested.
//
// Pose trackers often confuse front and back, and usually "see" a face even on the back of a head,
// so this never trusts a single frame's orientation. It reads the turn from the one signal that
// stays reliable, how wide the shoulders look, in order over time: wide (front) → narrow (side) →
// wide (back) → narrow (other side) → wide (front again). Face visibility only breaks ties.
import type { Landmark } from "./placement";

export type ScanSample = {
  t: number; // ms since the turn started
  landmarks: Landmark[]; // 33 points, 0..1 of the frame
  sharpness: number; // higher = sharper (see sharpness())
};

export type View = "front" | "left" | "back" | "right";
export type Phase = "front" | "side1" | "back" | "side2" | "done";

const L = { nose: 0, leftEye: 2, rightEye: 5, lShoulder: 11, rShoulder: 12, lHip: 23, rHip: 24, lAnkle: 27, rAnkle: 28 };
const seen = (p: Landmark | undefined, min = 0.5) => Boolean(p && (p.visibility ?? 1) >= min);

/** Shoulder width as a share of the frame width (small when side-on). */
export function shoulderSpan(lm: Landmark[]): number {
  return Math.abs(lm[L.lShoulder].x - lm[L.rShoulder].x);
}

/** The face is towards the camera: nose and at least one eye clearly seen. */
export function faceVisible(lm: Landmark[]): boolean {
  return seen(lm[L.nose], 0.6) && (seen(lm[L.leftEye], 0.6) || seen(lm[L.rightEye], 0.6));
}

/** What's wrong with the framing, or null when head to feet are in view. */
export function framingProblem(lm: Landmark[] | null): string | null {
  if (!lm || lm.length < 33) return "Step into view";
  const inside = (p: Landmark) => p.x > 0.02 && p.x < 0.98 && p.y > 0.01 && p.y < 0.99;
  const head = lm[L.nose];
  const feet = [lm[L.lAnkle], lm[L.rAnkle]].filter((p) => seen(p, 0.3));
  if (!seen(lm[L.lShoulder], 0.3) && !seen(lm[L.rShoulder], 0.3)) return "Step into view";
  if (!feet.length || !feet.every(inside)) return "Step back until your feet are in the picture";
  if (head && head.y < 0.03) return "Step back: your head is cut off";
  const height = Math.max(...feet.map((p) => p.y)) - Math.min(head?.y ?? 1, lm[L.lShoulder].y, lm[L.rShoulder].y);
  if (height < 0.45) return "Come a little closer";
  return null;
}

/**
 * Follows the turn as samples arrive: front → first side → back → second side → front again.
 * `baseline` is the shoulder span facing the camera, taken from the first second.
 */
export class TurnTracker {
  phase: Phase = "front";
  private baseline: number | null = null;
  private firstSpans: number[] = [];
  private streak = 0;

  update(s: ScanSample): Phase {
    const lm = s.landmarks;
    if (!seen(lm[L.lShoulder], 0.2) || !seen(lm[L.rShoulder], 0.2)) return this.phase;
    const span = shoulderSpan(lm);
    if (this.baseline === null) {
      this.firstSpans.push(span);
      if (s.t < 1000 || this.firstSpans.length < 4) return this.phase;
      this.baseline = median(this.firstSpans);
    }
    const r = span / this.baseline;
    const next = NEXT[this.phase];
    const wantNarrow = this.phase === "front" || this.phase === "back";
    // A couple of frames in a row, so one bad detection doesn't skip a phase.
    this.streak = (wantNarrow ? r < SIDE_RATIO : r > WIDE_RATIO) ? this.streak + 1 : 0;
    if (next && this.streak >= STREAK) {
      this.phase = next;
      this.streak = 0;
    }
    return this.phase;
  }

  /** 0..1 around the circle, for the progress ring. */
  get progress(): number {
    return { front: 0, side1: 0.25, back: 0.5, side2: 0.75, done: 1 }[this.phase];
  }
}

const SIDE_RATIO = 0.5; // shoulders look under half as wide as facing the camera: side-on
const WIDE_RATIO = 0.7; // over 70%: facing (or with the back to) the camera
const STREAK = 2; // frames in a row before the tracker moves on
const NEXT: Record<Phase, Phase | null> = { front: "side1", side1: "back", back: "side2", side2: "done", done: null };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Picks the four views from a recorded turn. The turn is split by shoulder width into front →
 * side → back → side; the sides are the narrowest frames of the two narrow stretches, the back
 * the widest frame between them and the front the widest face-on frame before the first side.
 * Sharper frames (and, for the back, frames with no face found) win ties. Which side is "left"
 * (the person's left side towards the camera) comes from where the nose points.
 */
export function pickViews(samples: ScanSample[]): Record<View, ScanSample> | { error: string } {
  const usable = samples.filter((s) => seen(s.landmarks[L.lShoulder], 0.2) && seen(s.landmarks[L.rShoulder], 0.2));
  if (usable.length < 12) return { error: "We couldn't follow you through the turn. Make sure your whole body stays in the picture and turn a little more slowly." };
  const raw = usable.map((s) => shoulderSpan(s.landmarks));
  // Median of three neighbours, so a single bad detection doesn't split or join a stretch.
  const spans = raw.map((_, i) => median(raw.slice(Math.max(0, i - 1), i + 2)));
  const baseline = median(spans.slice(0, Math.max(4, Math.floor(usable.length * 0.08))));
  const ratio = (i: number) => spans[i] / baseline;
  const sharp = (i: number) => Math.min(0.15, usable[i].sharpness / 4000);
  const n = usable.length;

  // Walk the turn: wide → narrow → wide → narrow → wide, noting where each stretch starts.
  const starts: number[] = [0];
  for (let i = 0; i < n && starts.length < 5; i++) {
    const wantNarrow = starts.length % 2 === 1;
    if (wantNarrow ? ratio(i) < SIDE_RATIO : ratio(i) > WIDE_RATIO) starts.push(i);
  }
  const stretch = (k: number) => [starts[k], starts[k + 1] ?? n] as const;
  if (starts.length < 2) return { error: "We didn't see you turn side-on. Turn slowly all the way round, keeping your arms a little away from your body." };
  if (starts.length < 3) return { error: "We didn't see your back. Turn all the way round, slowly, keeping your arms a little away from your body." };
  if (starts.length < 4) return { error: "We couldn't see both of your sides. Turn slowly and keep going until you face the camera again." };

  const best = (k: number, score: (i: number) => number) => {
    const [from, to] = stretch(k);
    let pick = from;
    for (let i = from; i < to; i++) if (score(i) > score(pick)) pick = i;
    return pick;
  };
  const side1 = best(1, (i) => -ratio(i) + sharp(i));
  const back = best(2, (i) => ratio(i) + sharp(i) + (faceVisible(usable[i].landmarks) ? 0 : 0.2));
  const side2 = best(3, (i) => -ratio(i) + sharp(i));
  const front = best(0, (i) => ratio(i) + sharp(i) + (faceVisible(usable[i].landmarks) ? 0.2 : 0));
  if (ratio(front) < WIDE_RATIO) return { error: "Start facing the camera, then turn." };

  // Facing image-left (nose left of the shoulders' middle) means the person turned to their own
  // right, so their left side faces the camera.
  const lm = usable[side1].landmarks;
  const firstIsLeft = lm[L.nose].x < (lm[L.lShoulder].x + lm[L.rShoulder].x) / 2;
  return {
    front: usable[front],
    back: usable[back],
    left: usable[firstIsLeft ? side1 : side2],
    right: usable[firstIsLeft ? side2 : side1],
  };
}

/**
 * How sharp a frame is: the variance of the Laplacian of its greyscale pixels (blurry frames,
 * like those taken mid-turn, score low). `grey` is one byte per pixel, row by row.
 */
export function sharpness(grey: Uint8Array | Uint8ClampedArray, w: number, h: number): number {
  let sum = 0;
  let sum2 = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = grey[i - w] + grey[i + w] + grey[i - 1] + grey[i + 1] - 4 * grey[i];
      sum += lap;
      sum2 += lap * lap;
      count++;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  return sum2 / count - mean * mean;
}
