"use client";
import { getVideoLandmarker } from "@/lib/pose";
import { drawOutfit, type RenderGarment } from "@/lib/tryonRender";
import { poseUsable, type Landmark } from "@/modules/tryon/placement";
import { smoothLandmarks } from "@/modules/tryon/warp";

type Callbacks = { onHint: (hint: string) => void; onFps: (fps: number, msPerFrame: number) => void };

/**
 * One live-mirror run: camera frame -> pose (+ person mask) -> mirrored scene with the outfit
 * fitted to the body, every animation frame. Nothing leaves the device.
 */
export class MirrorSession {
  garments: RenderGarment[] = [];
  studio = true;
  private raf: number | null = null;
  private prev: Landmark[] | null = null;
  private person = document.createElement("canvas");
  private small = document.createElement("canvas"); // half-size frame for tracking
  private maskCanvas = document.createElement("canvas");
  private frames = 0;
  private since = 0;
  private workMs = 0;
  private lastHint = "";

  constructor(
    private video: HTMLVideoElement,
    private canvas: HTMLCanvasElement,
    private cb: Callbacks,
  ) {}

  start() {
    const tick = async () => {
      await this.frame();
      if (this.raf !== null) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private hint(h: string) {
    if (h !== this.lastHint) this.cb.onHint((this.lastHint = h));
  }

  private async frame() {
    const started = performance.now();
    await this.render();
    const now = performance.now();
    this.workMs += now - started;
    this.frames++;
    if (!this.since) this.since = now;
    if (now - this.since > 1000) {
      this.cb.onFps(Math.round((this.frames * 1000) / (now - this.since)), Math.round(this.workMs / Math.max(1, this.frames)));
      this.frames = 0;
      this.workMs = 0;
      this.since = now;
    }
  }

  private async render() {
    const v = this.video;
    const c = this.canvas;
    if (v.readyState < 2 || !v.videoWidth) return;
    const W = v.videoWidth;
    const H = v.videoHeight;
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const ctx = c.getContext("2d")!;
    const withMasks = this.studio;
    const landmarker = await getVideoLandmarker(withMasks);
    // Track on a small copy: the model works at 256 px anyway, and the mask is 4x cheaper.
    const scale = Math.min(1, 480 / W);
    const sw = Math.round(W * scale);
    const sh = Math.round(H * scale);
    if (this.small.width !== sw || this.small.height !== sh) {
      this.small.width = sw;
      this.small.height = sh;
    }
    this.small.getContext("2d")!.drawImage(v, 0, 0, sw, sh);
    const result = landmarker.detectForVideo(this.small, performance.now());

    ctx.setTransform(-1, 0, 0, 1, W, 0); // mirror the whole scene, like a real mirror
    const mask = result.segmentationMasks?.[0];
    if (withMasks && mask) {
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#f6f1ea");
      bg.addColorStop(1, "#e2d6c6");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      // Mask -> small alpha image -> scaled up by the GPU with 'destination-in' over the frame.
      const conf = mask.getAsFloat32Array();
      const mw = mask.width;
      const mh = mask.height;
      const m = this.maskCanvas;
      if (m.width !== mw || m.height !== mh) {
        m.width = mw;
        m.height = mh;
      }
      const mg = m.getContext("2d")!;
      const alpha = mg.createImageData(mw, mh);
      for (let i = 0; i < conf.length; i++) {
        const a = conf[i];
        alpha.data[i * 4 + 3] = a > 0.65 ? 255 : a < 0.35 ? 0 : Math.round(((a - 0.35) / 0.3) * 255);
      }
      mg.putImageData(alpha, 0, 0);
      const p = this.person;
      if (p.width !== W || p.height !== H) {
        p.width = W;
        p.height = H;
      }
      const pg = p.getContext("2d")!;
      pg.globalCompositeOperation = "source-over";
      pg.clearRect(0, 0, W, H);
      pg.drawImage(v, 0, 0, W, H);
      pg.globalCompositeOperation = "destination-in";
      pg.drawImage(m, 0, 0, W, H);
      pg.globalCompositeOperation = "source-over";
      ctx.drawImage(p, 0, 0);
    } else {
      ctx.drawImage(v, 0, 0, W, H);
    }
    result.segmentationMasks?.forEach((m) => m.close());

    const lm = result.landmarks[0];
    if (lm) {
      this.prev = smoothLandmarks(this.prev, lm);
      if (poseUsable({ landmarks: this.prev })) {
        drawOutfit(ctx, W, H, this.prev, this.garments);
        this.hint("");
      } else this.hint("Step back so your shoulders and hips are in view.");
    } else {
      this.prev = null;
      this.hint("Stand in front of the camera.");
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
