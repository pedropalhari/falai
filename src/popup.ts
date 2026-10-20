import { getSettings, LANGUAGES, MODELS, type Settings } from "./shared";

const modelSelect = document.querySelector<HTMLSelectElement>("#model")!;
const languageSelect = document.querySelector<HTMLSelectElement>("#language")!;
const clearButton = document.querySelector<HTMLButtonElement>("#clear")!;
const status = document.querySelector<HTMLElement>("#status")!;

for (const m of MODELS) modelSelect.add(new Option(m.label, m.id));
for (const [code, name] of LANGUAGES)
  languageSelect.add(new Option(name, code));

const settings = await getSettings();
modelSelect.value = settings.model;
languageSelect.value = settings.language;

function flash(text: string) {
  status.textContent = text;
  setTimeout(() => (status.textContent = ""), 1500);
}

async function save() {
  const next: Settings = {
    model: modelSelect.value,
    language: languageSelect.value,
  };
  await chrome.storage.sync.set(next);
  flash("Saved!");
}

modelSelect.addEventListener("change", save);
languageSelect.addEventListener("change", save);

clearButton.addEventListener("click", async () => {
  await chrome.storage.local.clear();
  flash("Cleared!");
});

const gpu =
  (navigator as any).gpu &&
  (await (navigator as any).gpu.requestAdapter().catch(() => null));
document.querySelector("#backend")!.textContent = gpu
  ? "WebGPU available ✓"
  : "No WebGPU, using WASM (slower)";
