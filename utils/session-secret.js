const crypto = require("crypto");

const weakSessionSecrets = new Set(["change-me-to-a-secure-key", "monplex-secret-key"]);

function resolveSessionSecret(env = process.env) {
  const secret = String(env.SESSION_SECRET || "").trim();
  if (env.NODE_ENV === "production") {
    if (!secret || weakSessionSecrets.has(secret) || secret.length < 32) {
      throw new Error("A strong SESSION_SECRET (at least 32 characters) is required in production.");
    }
    return { secret, ephemeral: false };
  }
  return { secret: secret || crypto.randomBytes(32).toString("hex"), ephemeral: !secret };
}

module.exports = { resolveSessionSecret };
