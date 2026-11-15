const MAX_VOLUME = 1000;

const FLAT_EQ = Object.freeze({ bass: 0, lowMids: 0, mids: 0, highMids: 0, treble: 0 });

const DEFAULT_SETTINGS = Object.freeze({
  volume: 100,
  mode: "standard",
  ...FLAT_EQ,
  leveler: "off",
  balance: 0,
  mono: false,
});

function normalizeSettings(values = {}) {
  const number = (key, min, max) => Number.isFinite(values[key])
    ? Math.round(Math.min(max, Math.max(min, values[key])))
    : DEFAULT_SETTINGS[key];

  return {
    volume: number("volume", 0, MAX_VOLUME),
    mode: ["standard", "speech", "night", "music"].includes(values.mode) ? values.mode : "standard",
    bass: number("bass", -12, 12),
    lowMids: number("lowMids", -12, 12),
    mids: number("mids", -12, 12),
    highMids: number("highMids", -12, 12),
    treble: number("treble", -12, 12),
    leveler: ["gentle", "strong"].includes(values.leveler) ? values.leveler : "off",
    balance: number("balance", -100, 100),
    mono: values.mono === true,
  };
}

function isNormal(settings) {
  return settings.volume === 100 && (settings.mode === "standard" || settings.mode === "music") &&
    Object.keys(FLAT_EQ).every((band) => settings[band] === 0) &&
    settings.leveler === "off" && settings.balance === 0 && !settings.mono;
}

function defaultState() {
  return { settings: DEFAULT_SETTINGS, alternate: null, bypass: false };
}
