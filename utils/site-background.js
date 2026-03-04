const { AppSettingQueries } = require("./database");

const MODE_KEY = "site_background_mode";
const CUSTOM_URL_KEY = "site_background_custom_url";
const CUSTOM_OPACITY_KEY = "site_background_custom_opacity";
const CARD_OPACITY_KEY = "site_card_opacity";
const DEFAULT_MODE = "particles";
const DEFAULT_CUSTOM_OPACITY = 0.34;
const DEFAULT_CARD_OPACITY = 0.012;

const BACKGROUND_PRESETS = [
  { key: "particles", kind: "animated" },
  { key: "aurora", kind: "animated" },
  { key: "mesh", kind: "animated" },
  { key: "nebula", kind: "animated" },
  { key: "spotlight", kind: "animated" },
  { key: "waves", kind: "animated" },
  { key: "custom", kind: "custom" }
];

function normalizeMode(mode) {
  const candidate = String(mode || "").trim().toLowerCase();
  return BACKGROUND_PRESETS.some(item => item.key === candidate) ? candidate : DEFAULT_MODE;
}

function sanitizeCustomUrl(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=\s]+$/.test(raw)) return raw.replace(/\s+/g, "");
  if (/^https?:\/\//i.test(raw)) return raw;
  return "";
}

function sanitizeCustomOpacity(value) {
  const parsed = Number.parseFloat(String(value == null ? "" : value).trim());
  if (!Number.isFinite(parsed)) return DEFAULT_CUSTOM_OPACITY;
  const clamped = Math.min(1, Math.max(0.05, parsed));
  return Number(clamped.toFixed(2));
}

function sanitizeCardOpacity(value) {
  const parsed = Number.parseFloat(String(value == null ? "" : value).trim());
  if (!Number.isFinite(parsed)) return DEFAULT_CARD_OPACITY;
  const clamped = Math.min(1, Math.max(0.01, parsed));
  return Number(clamped.toFixed(3));
}

function getSiteBackgroundSettings() {
  const cardOpacity = sanitizeCardOpacity(AppSettingQueries.get(CARD_OPACITY_KEY, DEFAULT_CARD_OPACITY));
  return {
    mode: normalizeMode(AppSettingQueries.get(MODE_KEY, DEFAULT_MODE)),
    customUrl: sanitizeCustomUrl(AppSettingQueries.get(CUSTOM_URL_KEY, "")),
    customOpacity: sanitizeCustomOpacity(AppSettingQueries.get(CUSTOM_OPACITY_KEY, DEFAULT_CUSTOM_OPACITY)),
    cardOpacity,
    cardOpacitySoft: Number(Math.min(1, cardOpacity + 0.21).toFixed(3)),
    cardOpacityElevated: Number(Math.min(1, cardOpacity + 0.23).toFixed(3)),
    cardOpacityInput: Number(Math.min(1, cardOpacity + 0.35).toFixed(3))
  };
}

function saveSiteBackgroundSettings(input = {}) {
  const mode = normalizeMode(input.mode);
  const customUrl = sanitizeCustomUrl(input.customUrl);
  const customOpacity = sanitizeCustomOpacity(input.customOpacity);
  const cardOpacity = sanitizeCardOpacity(input.cardOpacity);

  AppSettingQueries.set(MODE_KEY, mode);
  AppSettingQueries.set(CUSTOM_OPACITY_KEY, String(customOpacity));
  AppSettingQueries.set(CARD_OPACITY_KEY, String(cardOpacity));
  if (mode === "custom" && customUrl) {
    AppSettingQueries.set(CUSTOM_URL_KEY, customUrl);
  } else if (mode === "custom" && !customUrl) {
    AppSettingQueries.remove(CUSTOM_URL_KEY);
  }

  return getSiteBackgroundSettings();
}

module.exports = {
  BACKGROUND_PRESETS,
  getSiteBackgroundSettings,
  saveSiteBackgroundSettings
};
