const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "portall-secret-test-")), "portall.db");
process.env.DB_PATH = dbPath;
process.env.CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

const { initDatabase, closeDatabase, getDb, AppSettingQueries } = require("../utils/database");
const { isEncryptedSecret, encryptSecret, decryptSecret } = require("../utils/config-secret-crypto");
const { getConfigSections, getEditableConfigValues } = require("../utils/config");

initDatabase();
const rawValue = key => getDb().prepare("SELECT value FROM app_settings WHERE key = ?").get(key)?.value;

AppSettingQueries.set("config_PLEX_TOKEN", "TEST_PLEX_SECRET_123");
assert.ok(isEncryptedSecret(rawValue("config_PLEX_TOKEN")));
assert.ok(!rawValue("config_PLEX_TOKEN").includes("TEST_PLEX_SECRET_123"));
assert.strictEqual(AppSettingQueries.get("config_PLEX_TOKEN"), "TEST_PLEX_SECRET_123");
assert.strictEqual(getEditableConfigValues({ includeSecretValues: false }).PLEX_TOKEN, "");
const plexTokenField = getConfigSections({ includeSecretValues: false })
  .flatMap(section => section.fields)
  .find(field => field.key === "PLEX_TOKEN");
assert.deepStrictEqual({ value: plexTokenField.value, configured: plexTokenField.configured }, { value: "", configured: true });

const firstCiphertext = rawValue("config_PLEX_TOKEN");
AppSettingQueries.set("config_PLEX_TOKEN", "TEST_PLEX_SECRET_123");
assert.notStrictEqual(rawValue("config_PLEX_TOKEN"), firstCiphertext);
assert.strictEqual(encryptSecret(firstCiphertext), firstCiphertext);

AppSettingQueries.set("runtime_plex_cloud_token", "TEST_RUNTIME_SECRET_123");
assert.ok(isEncryptedSecret(rawValue("runtime_plex_cloud_token")));
AppSettingQueries.set("config_PLEX_URL", "http://plex.internal");
assert.strictEqual(rawValue("config_PLEX_URL"), "http://plex.internal");

getDb().prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run("config_RADARR_API_KEY", "TEST_RADARR_SECRET_123");
assert.strictEqual(AppSettingQueries.get("config_RADARR_API_KEY"), "TEST_RADARR_SECRET_123");
assert.ok(isEncryptedSecret(rawValue("config_RADARR_API_KEY")));

const ciphertext = rawValue("config_RADARR_API_KEY");
assert.throws(() => decryptSecret(`${ciphertext.slice(0, -5)}AAAAA`), /Unable to decrypt stored configuration secret/);
const savedKey = process.env.CREDENTIALS_ENCRYPTION_KEY;
process.env.CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
assert.throws(() => AppSettingQueries.get("config_RADARR_API_KEY"), /Unable to decrypt stored configuration secret/);
assert.strictEqual(rawValue("config_RADARR_API_KEY"), ciphertext);
process.env.CREDENTIALS_ENCRYPTION_KEY = savedKey;

getDb().prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run("config_SEERR_API_KEY", "legacy-rollback");
getDb().prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run("config_SONARR_API_KEY", "enc:v2:invalid");
closeDatabase();
assert.throws(() => initDatabase(), /Unable to decrypt stored configuration secret/);
assert.strictEqual(getDb().prepare("SELECT value FROM app_settings WHERE key = ?").get("config_SEERR_API_KEY").value, "legacy-rollback");
closeDatabase();

console.log("configuration secret storage tests passed");
