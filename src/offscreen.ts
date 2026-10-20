// Offscreen document: decodes audio and hosts the Whisper worker.
// Offscreen documents only get chrome.runtime, so updates go back through the background.

import type { JobUpdate, TranscribeRequest, WorkerJob } from "./shared";

const worker = new Worker("worker.js", { type: "module" });
const jobTabs = new Map<string, number>();

function relay(tabId: number, update: JobUpdate) {
  chrome.runtime.sendMessage({
    target: "background",
    type: "job-update",
    tabId,
    update,
  });
}

worker.onmessage = (e: MessageEvent<JobUpdate>) => {
  const update = e.data;
  const tabId = jobTabs.get(update.jobId);
  if (tabId === undefined) return;
  relay(tabId, update);
  if (update.type === "result" || update.type === "error")
    jobTabs.delete(update.jobId);
};

worker.onerror = (e) => console.error("[falai] worker error", e);

async function decode(base64: string): Promise<Float32Array> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  // Decoding through a 16 kHz context resamples to what Whisper expects.
  const ctx = new OfflineAudioContext(1, 1, 16_000);
  const buffer = await ctx.decodeAudioData(bytes.buffer);
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);

  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++)
      mono[i]! += data[i]! / buffer.numberOfChannels;
  }
  return mono;
}

chrome.runtime.onMessage.addListener(
  (msg: TranscribeRequest, sender, sendResponse) => {
    if (msg?.target !== "offscreen" || msg.type !== "transcribe") return;
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;

    jobTabs.set(msg.jobId, tabId);
    decode(msg.audio).then(
      (audio) => {
        const job: WorkerJob = {
          jobId: msg.jobId,
          audio,
          model: msg.model,
          language: msg.language,
        };
        worker.postMessage(job, [audio.buffer]);
      },
      (err) => {
        jobTabs.delete(msg.jobId);
        relay(tabId, {
          jobId: msg.jobId,
          type: "error",
          error: `Could not decode audio: ${err}`,
        });
      },
    );
    sendResponse({ ok: true });
  },
);
