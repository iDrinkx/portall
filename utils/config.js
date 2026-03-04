const { AppSettingQueries } = require("./database");

const CONFIG_PREFIX = "config_";

const CONFIG_FIELDS = [
  { key: "APP_URL", label: "URL publique du portail", group: "Portail", type: "url" },
  { key: "BASE_PATH", label: "Base path", group: "Portail", type: "text" },

  { key: "PLEX_URL", label: "URL Plex", group: "Plex", type: "url", required: true },
  { key: "PLEX_TOKEN", label: "Token Plex", group: "Plex", type: "password", required: true, secret: true },

  { key: "TAUTULLI_URL", label: "URL Tautulli", group: "Tautulli", type: "url" },
  { key: "TAUTULLI_API_KEY", label: "API key Tautulli", group: "Tautulli", type: "password", secret: true },
  { key: "TAUTULLI_DB_PATH", label: "Chemin DB Tautulli", group: "Tautulli", type: "text", requiresRestart: true },

  { key: "SEERR_URL", label: "URL Seerr interne", group: "Seerr", type: "url" },
  { key: "SEERR_PUBLIC_URL", label: "URL Seerr publique", group: "Seerr", type: "url" },
  { key: "SEERR_API_KEY", label: "API key Seerr", group: "Seerr", type: "password", secret: true },

  { key: "WIZARR_URL", label: "URL Wizarr", group: "Wizarr", type: "url" },
  { key: "WIZARR_API_KEY", label: "API key Wizarr", group: "Wizarr", type: "password", secret: true },

  { key: "RADARR_URL", label: "URL Radarr", group: "Radarr", type: "url" },
  { key: "RADARR_API_KEY", label: "API key Radarr", group: "Radarr", type: "password", secret: true },

  { key: "SONARR_URL", label: "URL Sonarr", group: "Sonarr", type: "url" },
  { key: "SONARR_API_KEY", label: "API key Sonarr", group: "Sonarr", type: "password", secret: true },

  { key: "KOMGA_URL", label: "URL Komga interne", group: "Komga", type: "url" },
  { key: "KOMGA_PUBLIC_URL", label: "URL Komga publique", group: "Komga", type: "url" },

  { key: "JELLYFIN_URL", label: "URL Jellyfin interne", group: "Jellyfin", type: "url" },
  { key: "JELLYFIN_PUBLIC_URL", label: "URL Jellyfin publique", group: "Jellyfin", type: "url" },

  { key: "ROMM_URL", label: "URL RomM interne", group: "RomM", type: "url" },
  { key: "ROMM_PUBLIC_URL", label: "URL RomM publique", group: "RomM", type: "url" }
];

function settingKey(key) {
  return `${CONFIG_PREFIX}${key}`;
}

function normalizeValue(field, value) {
  if (field.type === "boolean") {
    return value === true || value === "true" || value === "1" ? "true" : "false";
  }
  return String(value == null ? "" : value).trim();
}

function getStoredConfigMap() {
  const rows = AppSettingQueries.listPrefix(CONFIG_PREFIX);
  const map = {};
  rows.forEach(row => {
    map[row.key.slice(CONFIG_PREFIX.length)] = row.value;
  });
  return map;
}

function getConfigValue(key, defaultValue = "") {
  const stored = AppSettingQueries.get(settingKey(key), null);
  if (stored !== null && stored !== undefined) return stored;
  const envValue = process.env[key];
  return envValue !== undefined ? envValue : defaultValue;
}

function applyRuntimeConfig(values = null) {
  const source = values || getEditableConfigValues();
  CONFIG_FIELDS.forEach(field => {
    const value = source[field.key];
    if (value === undefined || value === null || value === "") {
      delete process.env[field.key];
      return;
    }
    process.env[field.key] = String(value);
  });
}

function getEditableConfigValues(options = {}) {
  const includeSecretValues = options.includeSecretValues !== false;
  const values = {};
  CONFIG_FIELDS.forEach(field => {
    const rawValue = getConfigValue(field.key, field.type === "boolean" ? "false" : "");
    values[field.key] = field.secret && !includeSecretValues ? "" : rawValue;
  });
  return values;
}

function getConfigSections(options = {}) {
  const includeSecretValues = options.includeSecretValues !== false;
  const values = getEditableConfigValues({ includeSecretValues });
  const groups = new Map();

  CONFIG_FIELDS.forEach(field => {
    if (!groups.has(field.group)) groups.set(field.group, []);
    const storedValue = getConfigValue(field.key, field.type === "boolean" ? "false" : "");
    const rawValue = values[field.key];
    groups.get(field.group).push({
      ...field,
      value: field.type === "boolean"
        ? (rawValue === "true" || rawValue === "1" ? "true" : "false")
        : rawValue,
      configured: storedValue !== ""
    });
  });

  return Array.from(groups.entries()).map(([group, fields]) => ({ group, fields }));
}

function getRequiredSetupFields() {
  return CONFIG_FIELDS.filter(field => field.required);
}

function getMissingRequiredConfigKeys() {
  return getRequiredSetupFields()
    .map(field => field.key)
    .filter(key => !String(getConfigValue(key, "")).trim());
}

function isSetupComplete() {
  return getMissingRequiredConfigKeys().length === 0;
}

function saveEditableConfig(input = {}, { markSetupComplete = false } = {}) {
  const values = {};

  CONFIG_FIELDS.forEach(field => {
    if (!Object.prototype.hasOwnProperty.call(input, field.key)) return;
    const normalized = normalizeValue(field, input[field.key]);
    const existingValue = getConfigValue(field.key, "");

    if (field.secret && normalized === "" && String(existingValue || "").trim()) {
      values[field.key] = "";
      return;
    }

    values[field.key] = normalized;

    if (normalized === "") {
      AppSettingQueries.remove(settingKey(field.key));
    } else {
      AppSettingQueries.set(settingKey(field.key), normalized);
    }
  });

  if (markSetupComplete) {
    AppSettingQueries.setBool("setup_completed", true);
  }

  applyRuntimeConfig(getEditableConfigValues());
  return values;
}

module.exports = {
  CONFIG_FIELDS,
  getConfigValue,
  getConfigSections,
  getEditableConfigValues,
  getMissingRequiredConfigKeys,
  isSetupComplete,
  saveEditableConfig,
  applyRuntimeConfig
};
