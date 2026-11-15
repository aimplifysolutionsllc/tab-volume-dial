importScripts("settings.js");

const offscreenUrl = chrome.runtime.getURL("offscreen.html");
const pending = new Map();
let creatingDocument;

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  creatingDocument ??= chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Play the selected tab's audio through its audio controls.",
  }).finally(() => { creatingDocument = undefined; });
  await creatingDocument;
}

async function audio(message) {
  const response = await chrome.runtime.sendMessage({ target: "audio", ...message });
  if (!response?.ok) throw new Error(response?.error ?? "The audio controls are unavailable.");
  return response.value;
}

function queue(tabId, operation) {
  const task = (pending.get(tabId) ?? Promise.resolve()).catch(() => {}).then(operation);
  pending.set(tabId, task);
  return task.finally(() => {
    if (pending.get(tabId) === task) pending.delete(tabId);
  });
}

async function update({ tabId, command, patch }) {
  const hasDocument = await hasOffscreenDocument();
  const previous = hasDocument ? await audio({ tabId, command: "get" }) : defaultState();
  if (command === "get") return previous;

  let state;
  if (command === "reset") {
    state = defaultState();
  } else if (command === "compare") {
    if (previous.bypass) {
      state = { settings: previous.alternate, alternate: previous.alternate, bypass: false };
    } else {
      if (isNormal(previous.settings)) return previous;
      state = { settings: DEFAULT_SETTINGS, alternate: previous.settings, bypass: true };
    }
  } else {
    const settings = normalizeSettings({ ...previous.settings, ...patch });
    state = { settings, alternate: null, bypass: false };
  }

  let streamId;
  if (!isNormal(state.settings) && !previous.active) {
    await ensureOffscreenDocument();
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  }
  if (!hasDocument && !streamId) return state;
  return audio({ tabId, command: "set", state, streamId });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== "worker" || sender.url !== chrome.runtime.getURL("popup.html")) return;
  const { tabId, command } = message;
  if (!Number.isInteger(tabId) || !["get", "patch", "reset", "compare", "meter"].includes(command)) {
    respond({ ok: false, error: "Invalid tab or audio control." });
    return;
  }

  const task = command === "meter"
    ? hasOffscreenDocument().then((exists) => exists ? audio({ tabId, command }) : null)
    : queue(tabId, () => update(message));

  task.then(
    (value) => respond({ ok: true, value }),
    (error) => {
      console.warn("Tab audio update failed", error);
      respond({ ok: false, error: "Chrome couldn’t adjust this tab. Reopen the menu on the tab and try again." });
    },
  );
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void queue(tabId, async () => {
    if (await hasOffscreenDocument()) await audio({ tabId, command: "remove" });
  }).catch(console.warn);
});

