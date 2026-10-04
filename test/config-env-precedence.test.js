const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "portall-config-test-")), "portall.db");
process.env.CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

const { initDatabase, closeDatabase, getDb } = require("../utils/database");
const { getConfigValue, applyRuntimeConfig } = require("../utils/config");
const reverseProxyMiddleware = require("../middleware/reverseproxy.middleware");

initDatabase();
const db = getDb();

function configure(stored, envValue) {
  db.prepare("DELETE FROM app_settings WHERE key = ?").run("config_APP_URL");
  if (stored !== undefined) {
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run("config_APP_URL", stored);
  }
  if (envValue === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = envValue;
}

configure("https://db.example", "https://env.example");
assert.strictEqual(getConfigValue("APP_URL", "fallback"), "https://db.example");
configure("   ", "https://env.example");
assert.strictEqual(getConfigValue("APP_URL", "fallback"), "https://env.example");
configure(undefined, "https://env.example");
assert.strictEqual(getConfigValue("APP_URL", "fallback"), "https://env.example");
configure("", undefined);
assert.strictEqual(getConfigValue("APP_URL", "fallback"), "");
configure(undefined, undefined);
assert.strictEqual(getConfigValue("APP_URL", "fallback"), "fallback");

// Regression: a legacy empty SQLite APP_URL must not erase Docker APP_URL.
process.env.NODE_ENV = "production";
configure("", "https://idrinktv.ovh");
applyRuntimeConfig();
assert.strictEqual(process.env.APP_URL, "https://idrinktv.ovh");
const req = {
  socket: {}, protocol: "http", ips: [], headers: {},
  get: name => name.toLowerCase() === "host" ? "untrusted.example" : undefined
};
const res = { locals: {} };
reverseProxyMiddleware(req, res, () => {});
assert.strictEqual(req.appUrl, "https://idrinktv.ovh");

closeDatabase();
console.log("config environment precedence tests passed");
