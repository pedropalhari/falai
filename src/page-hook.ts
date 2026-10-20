// Runs in WhatsApp's own JS world (MAIN) at document_start.
// WhatsApp decrypts voice notes into Blobs and plays them through an <audio>
// element. We hook play() so that, when the content script "arms" a capture,
// the next play() hands us the audio Blob and is stopped silently.

const audioBlobs = new Map<string, Blob>();

const createObjectURL = URL.createObjectURL;
URL.createObjectURL = function (obj: Blob | MediaSource) {
  const url = createObjectURL.call(URL, obj);
  if (obj instanceof Blob && (obj.type.startsWith("audio/") || obj.type === ""))
    audioBlobs.set(url, obj);
  return url;
};

const revokeObjectURL = URL.revokeObjectURL;
URL.revokeObjectURL = function (url: string) {
  audioBlobs.delete(url);
  return revokeObjectURL.call(URL, url);
};

let armed: string | null = null;

function reply(data: Record<string, unknown>) {
  window.postMessage({ source: "falai-page", ...data }, location.origin);
}

window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.source !== "falai-content") return;
  if (e.data.type === "arm") armed = e.data.captureId;
  if (e.data.type === "disarm" && armed === e.data.captureId) armed = null;
});

async function blobFor(el: HTMLMediaElement): Promise<Blob> {
  const src = el.currentSrc || el.src || el.querySelector("source")?.src;
  if (!src) throw new Error("audio element has no source");
  return audioBlobs.get(src) ?? (await fetch(src)).blob();
}

const play = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
  if (!armed) return play.call(this);
  const captureId = armed;
  armed = null;

  const wasMuted = this.muted;
  this.muted = true;
  const started = play.call(this);
  started.then(
    () => {
      this.pause();
      this.currentTime = 0;
      this.muted = wasMuted;
    },
    () => {
      this.muted = wasMuted;
    },
  );

  blobFor(this).then(
    (blob) => reply({ type: "captured", captureId, blob }),
    (err) => reply({ type: "capture-error", captureId, error: String(err) }),
  );
  return started;
};
