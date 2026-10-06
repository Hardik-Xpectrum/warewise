// Serves MediaPipe's WebAssembly files from our own origin (public/mediapipe/wasm) instead of a CDN,
// always matching the installed package version. Runs after npm install.
import { cpSync, existsSync, mkdirSync } from "node:fs";

const from = "node_modules/@mediapipe/tasks-vision/wasm";
const to = "public/mediapipe/wasm";
if (existsSync(from)) {
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`copied MediaPipe wasm to ${to}`);
}
