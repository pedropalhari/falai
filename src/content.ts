// Content script on web.whatsapp.com: adds a "transcribe" button beside every
// voice message and renders the transcript under it.

import { getSettings, type JobUpdate, type TranscribeRequest } from "./shared";

// WhatsApp's class names are obfuscated; data-icon attributes are the stable hooks.
const PLAY_SELECTORS = [
  '[data-icon="audio-play"]',
  '[data-icon="audio-pause"]',
  '[data-icon="audio-download"]',
  '[data-icon="ptt-play"]',
  '[data-icon="ptt-pause"]',
  '[data-icon="ptt-download"]',
  'button[aria-label="Play voice message"]',
  'button[aria-label="Reproduzir mensagem de voz"]',
].join(",");

const CAPTURE_TIMEOUT_MS = 60_000;
const STORAGE_PREFIX = "transcript:";

type State =
  | { status: "capturing" }
  | { status: "loading"; progress: number | null }
  | { status: "transcribing" }
  | { status: "done"; text: string; language: string | null; hidden: boolean }
  | { status: "error"; error: string };

// Keyed by WhatsApp's message data-id, so state survives the chat list re-rendering.
const states = new Map<string, State>();
const jobToMessage = new Map<string, string>();

// ---------- UI ----------

const ICONS = {
  // Text lines + sound bars: "audio to text".
  idle: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 11h12M3 16h7M15 16v2M18 13.5v7M21 15.5v3"/></svg>',
  spinner: '<span class="falai-spinner"></span>',
};

function findMessage(dataId: string) {
  return document.querySelector<HTMLElement>(
    `[data-id="${CSS.escape(dataId)}"]`,
  );
}

function render(dataId: string) {
  const msg = findMessage(dataId);
  const btn = msg?.querySelector<HTMLButtonElement>(".falai-btn");
  const panel = msg?.querySelector<HTMLElement>(".falai-transcript");
  if (!btn || !panel) return;

  const state = states.get(dataId);
  const busy =
    state?.status === "capturing" ||
    state?.status === "loading" ||
    state?.status === "transcribing";
  btn.disabled = busy;
  btn.innerHTML = busy ? ICONS.spinner : ICONS.idle;
  btn.classList.toggle("falai-done", state?.status === "done");
  btn.title =
    state?.status === "done"
      ? state.hidden
        ? "Show transcript"
        : "Hide transcript"
      : busy
        ? "Transcribing…"
        : "Transcribe voice message";

  panel.classList.remove("falai-error", "falai-muted");
  switch (state?.status) {
    case undefined:
      panel.hidden = true;
      return;
    case "capturing":
      panel.textContent = "Grabbing audio…";
      panel.classList.add("falai-muted");
      break;
    case "loading":
      panel.textContent =
        state.progress === null
          ? "Loading Whisper model…"
          : `Downloading Whisper model… ${Math.round(state.progress * 100)}%`;
      panel.classList.add("falai-muted");
      break;
    case "transcribing":
      panel.textContent = "Transcribing…";
      panel.classList.add("falai-muted");
      break;
    case "done":
      panel.textContent = state.text || "(no speech detected)";
      panel.hidden = state.hidden;
      return;
    case "error":
      panel.textContent = `Transcription failed: ${state.error}`;
      panel.classList.add("falai-error");
      break;
  }
  panel.hidden = false;
}

function setState(dataId: string, state: State) {
  states.set(dataId, state);
  render(dataId);
}

// ---------- audio capture (talks to page-hook.ts in the MAIN world) ----------

let captureQueue: Promise<unknown> = Promise.resolve();

function captureAudio(playButton: HTMLElement): Promise<Blob> {
  const job = () =>
    new Promise<Blob>((resolve, reject) => {
      const captureId = crypto.randomUUID();
      const done = () => {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        window.postMessage(
          { source: "falai-content", type: "disarm", captureId },
          location.origin,
        );
      };
      const onMessage = (e: MessageEvent) => {
        if (
          e.source !== window ||
          e.data?.source !== "falai-page" ||
          e.data.captureId !== captureId
        )
          return;
        done();
        if (e.data.type === "captured") resolve(e.data.blob);
        else reject(new Error(e.data.error));
      };
      const timer = setTimeout(() => {
        done();
        reject(
          new Error(
            "couldn't grab the audio. If it's playing, pause it and try again.",
          ),
        );
      }, CAPTURE_TIMEOUT_MS);

      window.addEventListener("message", onMessage);
      window.postMessage(
        { source: "falai-content", type: "arm", captureId },
        location.origin,
      );
      // WhatsApp downloads + decrypts the note, then calls play(), which the hook intercepts.
      playButton.click();
    });

  const result = captureQueue.then(job, job);
  captureQueue = result.catch(() => {});
  return result;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---------- transcription flow ----------

async function transcribe(dataId: string) {
  const playButton = findMessage(dataId)
    ?.querySelector<HTMLElement>(PLAY_SELECTORS)
    ?.closest<HTMLElement>('button, [role="button"]');
  if (!playButton)
    return setState(dataId, {
      status: "error",
      error: "play button not found",
    });

  try {
    setState(dataId, { status: "capturing" });
    const blob = await captureAudio(playButton);

    setState(dataId, { status: "loading", progress: null });
    const [settings, audio, offscreen] = await Promise.all([
      getSettings(),
      blobToBase64(blob),
      chrome.runtime.sendMessage({ type: "ensure-offscreen" }),
    ]);
    if (!offscreen?.ok)
      throw new Error(offscreen?.error ?? "could not start the transcriber");

    const jobId = crypto.randomUUID();
    jobToMessage.set(jobId, dataId);
    const request: TranscribeRequest = {
      target: "offscreen",
      type: "transcribe",
      jobId,
      audio,
      model: settings.model,
      language: settings.language,
    };
    await chrome.runtime.sendMessage(request);
  } catch (err) {
    setState(dataId, {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

chrome.runtime.onMessage.addListener(
  (msg: { type: string; update: JobUpdate }) => {
    if (msg?.type !== "falai-job-update") return;
    const { update } = msg;
    const dataId = jobToMessage.get(update.jobId);
    if (!dataId) return;

    switch (update.type) {
      case "loading":
        setState(dataId, { status: "loading", progress: update.progress });
        break;
      case "transcribing":
        setState(dataId, { status: "transcribing" });
        break;
      case "result":
        jobToMessage.delete(update.jobId);
        setState(dataId, {
          status: "done",
          text: update.text,
          language: update.language,
          hidden: false,
        });
        chrome.storage.local.set({
          [STORAGE_PREFIX + dataId]: {
            text: update.text,
            language: update.language,
          },
        });
        break;
      case "error":
        jobToMessage.delete(update.jobId);
        setState(dataId, { status: "error", error: update.error });
        break;
    }
  },
);

function onButtonClick(dataId: string) {
  const state = states.get(dataId);
  if (state?.status === "done") {
    setState(dataId, { ...state, hidden: !state.hidden });
  } else if (
    state?.status !== "capturing" &&
    state?.status !== "loading" &&
    state?.status !== "transcribing"
  ) {
    transcribe(dataId);
  }
}

// ---------- DOM injection ----------

// The smallest element holding both the play button and the waveform slider is the player row.
function findPlayer(msg: HTMLElement, playButton: HTMLElement) {
  const slider = msg.querySelector('[role="slider"], input[type="range"]');
  if (!slider) return playButton.parentElement;
  let node: HTMLElement | null = playButton;
  while (node && node !== msg && !node.contains(slider))
    node = node.parentElement;
  return node && node !== msg ? node : playButton.parentElement;
}

async function restoreSaved(dataId: string) {
  const key = STORAGE_PREFIX + dataId;
  const saved = (await chrome.storage.local.get(key))[key] as
    { text: string; language: string | null } | undefined;
  if (saved && !states.has(dataId)) {
    setState(dataId, {
      status: "done",
      text: saved.text,
      language: saved.language,
      hidden: false,
    });
  }
}

function inject(icon: Element) {
  const msg = icon.closest<HTMLElement>("[data-id]");
  const dataId = msg?.dataset.id;
  if (!msg || !dataId || msg.querySelector(".falai-btn")) return;

  const playButton =
    icon.closest<HTMLElement>('button, [role="button"]') ??
    (icon as HTMLElement);
  const player = findPlayer(msg, playButton);
  if (!player?.parentElement) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "falai-btn";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onButtonClick(dataId);
  });
  player.insertAdjacentElement("afterend", btn);

  const panel = document.createElement("div");
  panel.className = "falai-transcript";
  panel.hidden = true;
  player.parentElement.insertAdjacentElement("afterend", panel);

  render(dataId);
  if (!states.has(dataId)) restoreSaved(dataId);
}

function scan() {
  document.querySelectorAll(PLAY_SELECTORS).forEach(inject);
}

let scheduled = false;
new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    scan();
  });
}).observe(document.body, { childList: true, subtree: true });
scan();
