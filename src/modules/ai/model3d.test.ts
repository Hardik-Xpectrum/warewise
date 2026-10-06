import { describe, expect, it } from "vitest";
import { isGlb, mockGlb, parseFalResult, parseFalStatus, parseMeshyTask, parseTripoTask } from "./model3d";

describe("image-to-3D response parsers", () => {
  it("reads fal.ai queue status and Trellis output", () => {
    expect(parseFalStatus({ status: "IN_QUEUE" })).toBe("running");
    expect(parseFalStatus({ status: "IN_PROGRESS" })).toBe("running");
    expect(parseFalStatus({ status: "COMPLETED" })).toBe("completed");
    expect(parseFalResult({ model_mesh: { url: "https://x/m.glb" } })).toEqual({ state: "done", glbUrl: "https://x/m.glb" });
    expect(parseFalResult({ model_glb: { url: "https://x/h.glb" } })).toEqual({ state: "done", glbUrl: "https://x/h.glb" });
    expect(parseFalResult({ detail: "bad image" }).state).toBe("failed");
  });

  it("reads Tripo v3 task states", () => {
    expect(parseTripoTask({ code: 0, data: { status: "running", progress: 40 } })).toEqual({ state: "running", progress: 40 });
    expect(parseTripoTask({ code: 0, data: { status: "success", output: { model_url: "https://t/m.glb" } } })).toEqual({ state: "done", glbUrl: "https://t/m.glb" });
    expect(parseTripoTask({ code: 0, data: { status: "success", output: { pbr_model_url: "https://t/p.glb", model_url: "https://t/m.glb" } } })).toEqual({ state: "done", glbUrl: "https://t/p.glb" });
    expect(parseTripoTask({ code: 0, data: { status: "banned" } }).state).toBe("failed");
    expect(parseTripoTask({ code: 2010, message: "Insufficient credits" })).toEqual({ state: "failed", error: "Tripo error 2010: Insufficient credits" });
  });

  it("reads Meshy task states", () => {
    expect(parseMeshyTask({ status: "IN_PROGRESS", progress: 55 })).toEqual({ state: "running", progress: 55 });
    expect(parseMeshyTask({ status: "SUCCEEDED", model_urls: { glb: "https://m/a.glb" } })).toEqual({ state: "done", glbUrl: "https://m/a.glb" });
    expect(parseMeshyTask({ status: "FAILED", task_error: { message: "no subject" } })).toEqual({ state: "failed", error: "Meshy task failed: no subject" });
  });
});

describe("GLB", () => {
  it("builds a valid mock model and recognises GLB files", () => {
    const glb = mockGlb();
    expect(isGlb(glb)).toBe(true);
    expect(glb.readUInt32LE(8)).toBe(glb.length); // header length matches
    expect(isGlb(Buffer.from("<html>not a model</html>"))).toBe(false);
  });
});

describe("gradioGlbUrl", () => {
  it("finds the GLB among a Space's outputs (video first, model second)", async () => {
    const { gradioGlbUrl } = await import("./model3d");
    const data = [
      { video: { path: "/tmp/a/sample.mp4", url: "https://s/file=/tmp/a/sample.mp4" }, subtitles: null },
      { path: "/tmp/b/sample.glb", url: "https://s/file=/tmp/b/sample.glb" },
    ];
    expect(gradioGlbUrl(data)).toBe("https://s/file=/tmp/b/sample.glb");
    expect(gradioGlbUrl([{ path: "/x/preview.png", url: "https://s/x.png" }])).toBeNull();
  });
});
