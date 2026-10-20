// Types and constants shared by every extension context.

export type ModelOption = {
  id: string;
  label: string;
  // Encoder precision on WebGPU. "fp16" falls back to fp32 when the GPU lacks shader-f16.
  encoder: "fp32" | "fp16";
};

export const MODELS: ModelOption[] = [
  {
    id: "onnx-community/whisper-tiny",
    label: "Whisper Tiny (~40 MB, fastest)",
    encoder: "fp32",
  },
  {
    id: "onnx-community/whisper-base",
    label: "Whisper Base (~80 MB)",
    encoder: "fp32",
  },
  {
    id: "onnx-community/whisper-small",
    label: "Whisper Small (~250 MB)",
    encoder: "fp32",
  },
  {
    id: "onnx-community/whisper-large-v3-turbo",
    label: "Whisper Large v3 Turbo (~1 GB, best)",
    encoder: "fp16",
  },
];

export const LANGUAGES: [code: string, name: string][] = [
  ["auto", "Auto-detect"],
  ["pt", "Portuguese"],
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["nl", "Dutch"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
  ["pl", "Polish"],
  ["tr", "Turkish"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
];

export type Settings = { model: string; language: string };

export const DEFAULT_SETTINGS: Settings = {
  model: "onnx-community/whisper-base",
  language: "auto",
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return stored as Settings;
}

// content -> offscreen
export type TranscribeRequest = {
  target: "offscreen";
  type: "transcribe";
  jobId: string;
  audio: string; // base64
  model: string;
  language: string;
};

// worker -> offscreen -> background -> content
export type JobUpdate = { jobId: string } & (
  | { type: "loading"; progress: number | null }
  | { type: "transcribing"; language: string | null }
  | { type: "result"; text: string; language: string | null }
  | { type: "error"; error: string }
);

// worker input
export type WorkerJob = {
  jobId: string;
  audio: Float32Array;
  model: string;
  language: string;
};
