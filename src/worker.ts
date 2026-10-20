// Runs Whisper with transformers.js on WebGPU (falls back to WASM).
// Modeled after https://huggingface.co/spaces/Xenova/realtime-whisper-webgpu

import {
  env,
  pipeline,
  Tensor,
  type AutomaticSpeechRecognitionPipeline,
  type ProgressInfo,
} from "@huggingface/transformers";
import { MODELS, type JobUpdate, type WorkerJob } from "./shared";

env.allowLocalModels = false;
// MV3 forbids remote code, so the ONNX runtime wasm ships inside the extension.
env.backends.onnx.wasm!.wasmPaths = {
  wasm: new URL("ort/ort-wasm-simd-threaded.asyncify.wasm", self.location.href)
    .href,
};

const SAMPLE_RATE = 16_000;

type Loaded = { model: string; pipe: AutomaticSpeechRecognitionPipeline };
let loaded: Promise<Loaded> | null = null;

function post(update: JobUpdate) {
  self.postMessage(update);
}

async function gpuInfo() {
  const gpu = (navigator as any).gpu;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter().catch(() => null);
  if (!adapter) return null;
  return { f16: adapter.features.has("shader-f16") as boolean };
}

async function load(modelId: string, jobId: string): Promise<Loaded> {
  const option = MODELS.find((m) => m.id === modelId) ?? MODELS[1]!;
  const gpu = await gpuInfo();

  // Aggregate per-file download progress into one percentage.
  const files = new Map<string, { loaded: number; total: number }>();
  const progress_callback = (info: ProgressInfo) => {
    if (info.status !== "progress") return;
    files.set(info.file, { loaded: info.loaded, total: info.total });
    let done = 0;
    let total = 0;
    for (const f of files.values()) {
      done += f.loaded;
      total += f.total;
    }
    post({ jobId, type: "loading", progress: total ? done / total : null });
  };

  post({ jobId, type: "loading", progress: null });
  const pipe = (await pipeline("automatic-speech-recognition", option.id, {
    device: gpu ? "webgpu" : "wasm",
    dtype: gpu
      ? {
          encoder_model: option.encoder === "fp16" && gpu.f16 ? "fp16" : "fp32",
          decoder_model_merged: "q4",
        }
      : "q8",
    progress_callback,
  })) as AutomaticSpeechRecognitionPipeline;
  return { model: option.id, pipe };
}

async function getPipeline(modelId: string, jobId: string) {
  const current = loaded && (await loaded.catch(() => null));
  if (current?.model === modelId) return current.pipe;
  await current?.pipe.dispose();
  loaded = load(modelId, jobId);
  try {
    return (await loaded).pipe;
  } catch (err) {
    loaded = null;
    throw err;
  }
}

// transformers.js has no Whisper language detection (it defaults to English),
// so run a single decoder step after <|startoftranscript|> and pick the most
// likely language token, as the reference Whisper implementation does.
async function detectLanguage(
  pipe: AutomaticSpeechRecognitionPipeline,
  audio: Float32Array,
) {
  const config = pipe.model.generation_config as any;
  const langToId: Record<string, number> | undefined = config?.lang_to_id;
  if (!langToId) return null;

  const inputs = await pipe.processor(audio.subarray(0, SAMPLE_RATE * 30));
  const start = BigInt(config.decoder_start_token_id);
  const { logits } = await (pipe.model as any)({
    ...inputs,
    decoder_input_ids: new Tensor("int64", BigInt64Array.of(start), [1, 1]),
  });
  const data = logits.data as Float32Array;
  const vocab = logits.dims.at(-1) as number;
  const offset = data.length - vocab; // logits of the last position

  let best: string | null = null;
  let bestScore = -Infinity;
  for (const [token, id] of Object.entries(langToId)) {
    const score = data[offset + id]!;
    if (score > bestScore) {
      bestScore = score;
      best = token.slice(2, -2); // "<|pt|>" -> "pt"
    }
  }
  return best;
}

async function run({ jobId, audio, model, language }: WorkerJob) {
  try {
    const pipe = await getPipeline(model, jobId);

    let lang: string | null = language === "auto" ? null : language;
    if (!lang) {
      lang = await detectLanguage(pipe, audio).catch((err) => {
        console.warn("[falai] language detection failed", err);
        return null;
      });
    }
    post({ jobId, type: "transcribing", language: lang });

    const output = await pipe(audio, {
      language: lang ?? undefined,
      task: "transcribe",
      // Voice notes are often longer than Whisper's 30 s window.
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const text = (
      Array.isArray(output) ? output.map((o) => o.text).join(" ") : output.text
    ).trim();
    post({ jobId, type: "result", text, language: lang });
  } catch (err) {
    console.error("[falai]", err);
    post({
      jobId,
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// One job at a time: the GPU is shared and the model is loaded once.
let queue = Promise.resolve();
self.onmessage = (e: MessageEvent<WorkerJob>) => {
  queue = queue.then(() => run(e.data));
};
