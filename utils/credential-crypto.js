const crypto = require("crypto");

const LEGACY_DEFAULT_SEED = "portall-default";

function parseEncryptionKey(value = process.env.CREDENTIALS_ENCRYPTION_KEY) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("CREDENTIALS_ENCRYPTION_KEY must be set to a 32-byte random key");
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64") !== raw) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY must encode exactly 32 bytes");
  }
  return key;
}

function deriveLegacyKey(seed) {
  return crypto.createHash("sha256").update(String(seed || "")).digest();
}

function decryptWithKey(payload, key) {
  const parts = String(payload || "").replace(/^v2\./, "").split(".");
  if (parts.length !== 3) return null;
  const [ivPart, tagPart, dataPart] = parts;
  const iv = Buffer.from(ivPart, "base64");
  const tag = Buffer.from(tagPart, "base64");
  const data = Buffer.from(dataPart, "base64");
  if (iv.length !== 12 || tag.length !== 16 || !data.length) return null;
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function encryptCredentialSecret(secret, key = parseEncryptionKey()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(secret || ""), "utf8"), cipher.final()]);
  return `v2.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptCredentialSecret(payload, options = {}) {
  if (!payload || typeof payload !== "string") return { value: "", legacy: false };
  try {
    const value = decryptWithKey(payload, parseEncryptionKey(options.key));
    if (value !== null) return { value, legacy: !payload.startsWith("v2.") };
  } catch (_) {}

  // Legacy keys are only accepted to migrate an already stored value. They are
  // never used for new encryption and are not a runtime fallback.
  if (!payload.startsWith("v2.")) {
    for (const seed of [options.legacySessionSecret, LEGACY_DEFAULT_SEED]) {
      if (!seed) continue;
      try {
        const value = decryptWithKey(payload, deriveLegacyKey(seed));
        if (value !== null) return { value, legacy: true };
      } catch (_) {}
    }
  }
  return { value: "", legacy: false };
}

// Configuration secrets have no legacy ciphertext format.  Unlike user
// credentials, they must surface an authentication failure instead of being
// interpreted as an empty value.
function decryptCredentialSecretStrict(payload, key = parseEncryptionKey()) {
  if (typeof payload !== "string" || !payload.startsWith("v2.")) {
    throw new Error("Unable to decrypt stored configuration secret; verify CREDENTIALS_ENCRYPTION_KEY");
  }
  try {
    const value = decryptWithKey(payload, key);
    if (value === null) throw new Error("Invalid encrypted configuration secret");
    return value;
  } catch (_) {
    throw new Error("Unable to decrypt stored configuration secret; verify CREDENTIALS_ENCRYPTION_KEY");
  }
}

module.exports = {
  parseEncryptionKey,
  encryptCredentialSecret,
  decryptCredentialSecret,
  decryptCredentialSecretStrict
};
