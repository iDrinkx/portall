const {
  encryptCredentialSecret,
  decryptCredentialSecretStrict,
  parseEncryptionKey
} = require("./credential-crypto");

const ENCRYPTED_SECRET_PREFIX = "enc:v2:";
const CONFIG_SECRET_KEYS = new Set([
  "PLEX_TOKEN",
  "TAUTULLI_API_KEY",
  "SEERR_API_KEY",
  "WIZARR_API_KEY",
  "TRAKT_CLIENT_ID",
  "UPTIME_KUMA_PASSWORD",
  "UPTIME_ROBOT_API_KEY",
  "RADARR_API_KEY",
  "SONARR_API_KEY",
  "KOMGA_API_KEY"
].map(key => `config_${key}`));

// This value is not part of CONFIG_FIELDS, but is persisted by the Plex OAuth flow.
const APP_SETTING_SECRET_KEYS = new Set([...CONFIG_SECRET_KEYS, "runtime_plex_cloud_token"]);

function isSecretAppSettingKey(key) {
  return APP_SETTING_SECRET_KEYS.has(String(key || ""));
}

function isEncryptedSecret(value) {
  return typeof value === "string" && value.startsWith(ENCRYPTED_SECRET_PREFIX);
}

function encryptSecret(value, key = parseEncryptionKey()) {
  if (isEncryptedSecret(value)) return value;
  return `${ENCRYPTED_SECRET_PREFIX}${encryptCredentialSecret(String(value == null ? "" : value), key)}`;
}

function decryptSecret(value, key = parseEncryptionKey()) {
  if (!isEncryptedSecret(value)) return String(value == null ? "" : value);
  return decryptCredentialSecretStrict(value.slice(ENCRYPTED_SECRET_PREFIX.length), key);
}

module.exports = {
  APP_SETTING_SECRET_KEYS,
  isSecretAppSettingKey,
  isEncryptedSecret,
  encryptSecret,
  decryptSecret
};
