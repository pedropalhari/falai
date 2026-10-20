// Renders the extension icons and the README popup screenshots with headless Chrome.
// Usage: bun run render   (run `bun run build` first; popup shots use dist/)

import { $ } from "bun";
import { mkdtemp, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = resolve(import.meta.dir, "..");
const ICONS = join(ROOT, "src/icons");
const DOCS = join(ROOT, "docs");
const tmp = await mkdtemp(join(tmpdir(), "falai-render-"));

async function screenshot(
  page: string,
  out: string,
  [width, height]: [number, number],
  scale = 2,
) {
  await $`${CHROME} --headless --disable-gpu --hide-scrollbars --allow-file-access-from-files --default-background-color=00000000 --force-device-scale-factor=${scale} --window-size=${width},${height} --virtual-time-budget=1500 --screenshot=${out} file://${page}`.quiet();
}

// ---------- icons ----------

// Toolbar sizes use a full-bleed variant; the shadowed tile would look smaller
// than other extensions' icons there.
const ICON_SOURCES: Record<number, string> = {
  16: "icon-toolbar.svg",
  32: "icon-toolbar.svg",
  48: "icon.svg",
  128: "icon.svg",
};

for (const [size, svg] of Object.entries(ICON_SOURCES)) {
  const page = join(tmp, `${svg}.html`);
  const big = join(tmp, `${svg}-512.png`);
  if (!(await Bun.file(big).exists())) {
    await Bun.write(
      page,
      `<body style="margin:0;background:transparent"><img src="file://${join(ICONS, svg)}" width="128" height="128" style="display:block"></body>`,
    );
    await screenshot(page, big, [128, 128], 4);
  }
  await $`sips -z ${size} ${size} ${big} --out ${join(ICONS, `icon-${size}.png`)}`.quiet();
}
console.log("icons → src/icons/");

// ---------- popup screenshots ----------

type Shot = {
  name: string;
  model: string;
  language: string;
  webgpu: boolean;
  // Fire a change event so the "Saved!" badge shows.
  saved?: boolean;
};

const SHOTS: Shot[] = [
  {
    name: "popup-default",
    model: "onnx-community/whisper-base",
    language: "auto",
    webgpu: true,
  },
  {
    name: "popup-saved",
    model: "onnx-community/whisper-large-v3-turbo",
    language: "pt",
    webgpu: true,
    saved: true,
  },
  {
    name: "popup-no-webgpu",
    model: "onnx-community/whisper-tiny",
    language: "en",
    webgpu: false,
  },
];

await mkdir(DOCS, { recursive: true });
await cp(join(ROOT, "dist/popup.js"), join(tmp, "popup.js"));
const popupHtml = await Bun.file(join(ROOT, "dist/popup.html")).text();

for (const shot of SHOTS) {
  // Stub the few extension APIs the popup touches.
  const stub = `<script>
    window.chrome = { storage: {
      sync: { get: async (d) => ({ ...d, model: ${JSON.stringify(shot.model)}, language: ${JSON.stringify(shot.language)} }), set: async () => {} },
      local: { clear: async () => {} },
    } };
    Object.defineProperty(navigator, "gpu", { value: ${shot.webgpu ? "{ requestAdapter: async () => ({}) }" : "undefined"} });
    ${shot.saved ? `setTimeout(() => document.querySelector("#language").dispatchEvent(new Event("change")), 200);` : ""}
  </script>`;
  const page = join(tmp, `${shot.name}.html`);
  await Bun.write(
    page,
    popupHtml.replace('<script type="module"', `${stub}<script type="module"`),
  );
  await screenshot(page, join(DOCS, `${shot.name}.png`), [300, 352]);
}
console.log("popup screenshots → docs/");
