// Service worker: owns the offscreen document and routes job updates back to tabs.

let creating: Promise<void> | null = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification:
        "Run the Whisper speech-to-text model on WebGPU in a worker.",
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "ensure-offscreen") {
    ensureOffscreen().then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) }),
    );
    return true;
  }

  if (msg?.target === "background" && msg.type === "job-update") {
    chrome.tabs
      .sendMessage(msg.tabId, { type: "falai-job-update", update: msg.update })
      .catch(() => {
        // Tab was closed or reloaded; nothing to deliver to.
      });
  }
});
