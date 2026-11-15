const appearanceDefaults = { theme: "dark", accent: "mint" };
const appearanceStorageKey = "appearance";
const themeSelect = document.querySelector("#theme");
const accentChoices = [...document.querySelectorAll('[name="accent"]')];
const systemTheme = matchMedia("(prefers-color-scheme: light)");
const appearanceStatus = document.querySelector("#appearance-status");
let appearance = appearanceDefaults;
let savingAppearance = Promise.resolve();

function renderAppearance() {
  const { theme, accent } = appearance;
  const useLight = theme === "light" || (theme === "system" && systemTheme.matches);
  document.documentElement.dataset.theme = useLight ? "light" : "dark";
  document.documentElement.dataset.accent = accent;
  themeSelect.value = theme;
  for (const option of accentChoices) option.checked = option.value === accent;
}

function updateAppearance(next) {
  appearance = next;
  renderAppearance();
  appearanceStatus.textContent = "";
  savingAppearance = savingAppearance.catch(() => {}).then(() => {
    return chrome.storage.local.set({ [appearanceStorageKey]: next });
  });
  void savingAppearance.catch(() => {
    if (appearance === next) appearanceStatus.textContent = "Couldn’t save appearance.";
  });
}

async function initializeAppearance() {
  try {
    const stored = (await chrome.storage.local.get(appearanceStorageKey))[appearanceStorageKey];
    appearance = {
      theme: ["dark", "light", "system"].includes(stored?.theme) ? stored.theme : appearanceDefaults.theme,
      accent: accentChoices.some((option) => option.value === stored?.accent)
        ? stored.accent : appearanceDefaults.accent,
    };
    renderAppearance();
  } catch {
    appearanceStatus.textContent = "Couldn’t load saved appearance.";
  }
  document.querySelector("#appearance-button").disabled = false;
}

themeSelect.addEventListener("change", () => {
  updateAppearance({ ...appearance, theme: themeSelect.value });
});
for (const option of accentChoices) {
  option.addEventListener("change", () => updateAppearance({ ...appearance, accent: option.value }));
}
document.querySelector("#reset-appearance").addEventListener("click", () => {
  updateAppearance(appearanceDefaults);
});
systemTheme.addEventListener("change", renderAppearance);
void initializeAppearance();

