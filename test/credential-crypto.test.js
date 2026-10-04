const assert = require("assert");
const crypto = require("crypto");
const {
  parseEncryptionKey,
  encryptCredentialSecret,
  decryptCredentialSecret
} = require("../utils/credential-crypto");

const key = crypto.randomBytes(32).toString("base64");
const ciphertext = encryptCredentialSecret("credential-secret", parseEncryptionKey(key));
assert.ok(ciphertext.startsWith("v2."));
assert.strictEqual(decryptCredentialSecret(ciphertext, { key }).value, "credential-secret");
assert.notStrictEqual(ciphertext, encryptCredentialSecret("credential-secret", parseEncryptionKey(key)));
assert.strictEqual(decryptCredentialSecret(ciphertext, { key: crypto.randomBytes(32).toString("base64") }).value, "");
assert.strictEqual(decryptCredentialSecret(`${ciphertext.slice(0, -1)}A`, { key }).value, "");
assert.throws(() => parseEncryptionKey("portall-default"), /32 bytes/);

const legacySeed = "a legacy session secret with enough entropy";
const legacyKey = crypto.createHash("sha256").update(legacySeed).digest();
const legacyPayload = encryptCredentialSecret("legacy", legacyKey).replace(/^v2\./, "");
assert.deepStrictEqual(decryptCredentialSecret(legacyPayload, { key, legacySessionSecret: legacySeed }), { value: "legacy", legacy: true });
console.log("credential crypto tests passed");
