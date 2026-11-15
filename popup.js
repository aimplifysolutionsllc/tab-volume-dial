const $ = (selector) => document.querySelector(selector);
const slider = $("#volume");
const exact = $("#exact");
const mode = $("#mode");
const feedback = $("#status");
const compare = $("#compare");
const saveSite = $("#save-site");
const applySite = $("#apply-site");
const forgetSite = $("#forget-site");
const toneControls = [...Object.keys(FLAT_EQ), "balance"];
const presetScope = $("#preset-scope");
const defaultPresetKey = "global-preset";

const modeHints = {
  standard: "Volume and tone controls with peak protection.",
  speech: "Brings softer speech forward and reduces low rumble.",
  night: "Narrows volume jumps between dialogue and loud effects.",
  music: "Starts with flat EQ and preserves dynamics until peaks reach the limiter.",
};

let tabId;
let siteKey;
let savedPresets = {};

function presetKey() {
  return presetScope.value === "site" ? siteKey : defaultPresetKey;
}
let state = defaultState();
let queued = 0;
let readingMeter = false;
let siteBusy = false;

function showVolume(volume) {
  slider.value = volume;
  exact.value = slider.value;
  slider.setAttribute("aria-valuetext", slider.value + "%");
}

function showTone(key) {
  const control = $("#" + key);
  const value = control.valueAsNumber;
  let label = (value > 0 ? "+" : "") + value + " dB";
  if (key === "balance") {
    label = value === 0 ? "Center" : Math.abs(value) + "% " + (value < 0 ? "L" : "R");
  }
  $(`output[for="${key}"]`).value = label;
  control.setAttribute("aria-valuetext", label);
}

function updateSiteControls() {
  saveSite.disabled = siteBusy || queued > 0 || state.bypass;
  const hasPreset = Boolean(savedPresets[presetKey()]);
  applySite.disabled = siteBusy || queued > 0 || !hasPreset;
  forgetSite.disabled = siteBusy || queued > 0 || !hasPreset;
  presetScope.disabled = siteBusy;
}

function render() {
  const settings = state.settings;
  showVolume(settings.volume);
  mode.value = settings.mode;
  $("#mode-hint").textContent = modeHints[settings.mode];
  $("#mono").checked = settings.mono;
  $("#leveler").value = settings.leveler;
  for (const key of toneControls) {
    $("#" + key).value = settings[key];
    showTone(key);
  }
  compare.textContent = state.bypass ? "Restore settings" : "Hear original";
  compare.disabled = !state.bypass && isNormal(settings);
  updateSiteControls();
}

function status(message, error = false) {
  feedback.classList.toggle("error", error);
  feedback.textContent = message;
}

async function send(command, patch) {
  const reply = await chrome.runtime.sendMessage({ target: "worker", tabId, command, patch });
  if (!reply?.ok) throw new Error(reply?.error ?? "The audio controls are unavailable.");
  return reply.value;
}

async function apply(command, patch, message = "") {
  queued += 1;
  updateSiteControls();
  status("Applying…");
  try {
    state = await send(command, patch);
    status(message);
  } catch (error) {
    status(error.message, true);
  } finally {
    queued -= 1;
    if (!queued) render();
  }
  void refreshMeters();
}

function updateMeter(element, value) {
  element.value = value ?? -60;
  element.setAttribute("aria-valuetext", value == null
    ? "Inactive"
    : value <= -60 ? "Below −60 dBFS" : Math.round(value) + " dBFS");
}

async function refreshMeters() {
  if (readingMeter || document.hidden) return;
  readingMeter = true;
  let result;
  try {
    if (state.active) result = await send("meter");
  } catch {
    // A closed tab or reloaded extension can end metering between polls.
  } finally {
    readingMeter = false;
  }
  updateMeter($("#input-meter"), result?.input);
  updateMeter($("#output-meter"), result?.output);
  const meterState = $("#meter-state");
  meterState.classList.toggle("limiting", result?.reduction >= 0.1);
  if (!result) meterState.textContent = "Meters start when audio processing is active.";
  else if (result.reduction >= 0.1) {
    meterState.textContent = `Peak protection active · ${result.reduction.toFixed(1)} dB reduction`;
  } else meterState.textContent = "Peak protection ready";
}

function updateSiteLabel() {
  const key = presetKey();
  const description = key === defaultPresetKey ? "all sites" : new URL(key.slice("site:".length)).host;
  $("#site-summary").textContent = savedPresets[siteKey] || savedPresets[defaultPresetKey]
    ? "Presets · Saved" : "Presets";
  $("#site-name").textContent = savedPresets[key]
    ? `Saved for ${description}. Apply from this menu.`
    : `No preset saved for ${description}.`;
  updateSiteControls();
}

async function changeSite(action) {
  const key = presetKey();
  siteBusy = true;
  updateSiteControls();
  try {
    if (action === "save") {
      const settings = { ...state.settings };
      await chrome.storage.local.set({ [key]: settings });
      savedPresets[key] = settings;
      status("Preset saved.");
    } else {
      await chrome.storage.local.remove(key);
      delete savedPresets[key];
      status("Preset removed.");
    }
    updateSiteLabel();
  } catch (error) {
    status(error.message, true);
  } finally {
    siteBusy = false;
    updateSiteControls();
  }
}

async function initialize() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) throw new Error("No active tab to adjust.");
    tabId = tab.id;
    state = await send("get");
    if (/^https?:/.test(tab.url ?? "")) siteKey = "site:" + new URL(tab.url).origin;
    const keys = siteKey ? [siteKey, defaultPresetKey] : [defaultPresetKey];
    savedPresets = await chrome.storage.local.get(keys);
    presetScope.options[0].disabled = !siteKey;
    if (!siteKey || (!savedPresets[siteKey] && savedPresets[defaultPresetKey])) {
      presetScope.value = "global";
    }
    updateSiteLabel();
    render();
    $("#controls").disabled = false;
    void refreshMeters();
    setInterval(refreshMeters, 150);
  } catch (error) {
    status(error.message, true);
  }
}

slider.addEventListener("input", () => showVolume(slider.value));
slider.addEventListener("change", () => void apply("patch", { volume: slider.valueAsNumber }));
exact.addEventListener("change", () => {
  if (!Number.isFinite(exact.valueAsNumber)) {
    showVolume(state.settings.volume);
    return;
  }
  const volume = normalizeSettings({ volume: exact.valueAsNumber }).volume;
  showVolume(volume);
  void apply("patch", { volume });
});
exact.addEventListener("keydown", (event) => {
  if (event.key === "Enter") exact.blur();
});
for (const button of document.querySelectorAll("[data-volume]")) {
  button.addEventListener("click", () => {
    const volume = Number(button.dataset.volume);
    showVolume(volume);
    void apply("patch", { volume });
  });
}

for (const button of document.querySelectorAll("[data-step]")) {
  button.addEventListener("click", () => {
    const volume = normalizeSettings({ volume: slider.valueAsNumber + Number(button.dataset.step) }).volume;
    showVolume(volume);
    void apply("patch", { volume });
  });
}

mode.addEventListener("change", () => {
  const patch = { mode: mode.value };
  if (mode.value === "music") Object.assign(patch, FLAT_EQ);
  void apply("patch", patch);
});
$("#leveler").addEventListener("change", (event) => void apply("patch", { leveler: event.target.value }));
$("#mono").addEventListener("change", (event) => void apply("patch", { mono: event.target.checked }));
for (const key of toneControls) {
  const control = $("#" + key);
  control.addEventListener("input", () => showTone(key));
  control.addEventListener("change", () => void apply("patch", { [key]: control.valueAsNumber }));
}
$("#reset").addEventListener("click", () => void apply("reset", undefined, "Normal playback restored."));
compare.addEventListener("click", () => void apply("compare"));
saveSite.addEventListener("click", () => void changeSite("save"));
applySite.addEventListener("click", () => {
  void apply("patch", normalizeSettings(savedPresets[presetKey()]), "Preset applied.");
});
presetScope.addEventListener("change", updateSiteLabel);
forgetSite.addEventListener("click", () => void changeSite("forget"));

void initialize();
