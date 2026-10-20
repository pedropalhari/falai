// Builds the unpacked Chrome extension into dist/.
// Usage: bun run build.ts [--watch]

import { cp, mkdir, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, join } from "node:path";

const SRC = "src";
const OUT = "dist";
const STATIC = ["manifest.json", "popup.html", "offscreen.html", "content.css"];

// Content scripts are classic scripts, so they must be self-contained IIFEs.
const CLASSIC = ["page-hook.ts", "content.ts"];
const MODULES = ["background.ts", "offscreen.ts", "worker.ts", "popup.ts"];

async function build() {
  const started = performance.now();
  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, "ort"), { recursive: true });

  const results = await Promise.all([
    Bun.build({
      entrypoints: CLASSIC.map((f) => join(SRC, f)),
      outdir: OUT,
      target: "browser",
      format: "iife",
    }),
    Bun.build({
      entrypoints: MODULES.map((f) => join(SRC, f)),
      outdir: OUT,
      target: "browser",
      format: "esm",
      splitting: false,
    }),
  ]);
  for (const r of results) {
    if (!r.success) {
      for (const log of r.logs) console.error(log);
      throw new Error("build failed");
    }
  }

  await Promise.all(STATIC.map((f) => cp(join(SRC, f), join(OUT, f))));

  // MV3 can't load remote code, so ship the ONNX Runtime WebGPU wasm binary.
  const ortDist = dirname(
    Bun.resolveSync("onnxruntime-web/webgpu", import.meta.dir),
  );
  await cp(
    join(ortDist, "ort-wasm-simd-threaded.asyncify.wasm"),
    join(OUT, "ort", "ort-wasm-simd-threaded.asyncify.wasm"),
  );

  console.log(`built ${OUT}/ in ${Math.round(performance.now() - started)}ms`);
}

await build();

if (process.argv.includes("--watch")) {
  let timer: Timer | undefined;
  watch(SRC, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((e) => console.error(e)), 100);
  });
  console.log("watching src/ …");
}
