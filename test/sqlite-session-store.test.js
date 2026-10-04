const assert = require("assert");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const SQLiteSessionStore = require("../utils/sqlite-session-store");
const { resolveSessionSecret } = require("../utils/session-secret");

process.env.CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const db = new Database(":memory:");
const store = new SQLiteSessionStore({ db, ttlMs: 60_000, cleanupIntervalMs: 60_000 });
const get = sid => new Promise((resolve, reject) => store.get(sid, (error, value) => error ? reject(error) : resolve(value)));
const set = (sid, value) => new Promise((resolve, reject) => store.set(sid, value, error => error ? reject(error) : resolve()));
const touch = (sid, value) => new Promise((resolve, reject) => store.touch(sid, value, error => error ? reject(error) : resolve()));
const destroy = sid => new Promise((resolve, reject) => store.destroy(sid, error => error ? reject(error) : resolve()));
const raw = sid => db.prepare("SELECT session_json, expires_at FROM http_sessions WHERE sid = ?").get(sid);

(async () => {
  const sessionData = {
    cookie: { expires: new Date(Date.now() + 30_000).toISOString() },
    user: { id: 1 },
    plexToken: "TEST_PLEX_TOKEN_123",
    jellyfinAuth: { token: "TEST_JELLYFIN_TOKEN_123" },
    csrfToken: "csrf-test"
  };
  await set("session-1", sessionData);
  const first = raw("session-1");
  assert.ok(first.session_json.startsWith("enc:v2:"));
  assert.ok(!first.session_json.includes("TEST_PLEX_TOKEN_123"));
  assert.ok(!first.session_json.includes("TEST_JELLYFIN_TOKEN_123"));
  assert.deepStrictEqual(await get("session-1"), sessionData);

  await set("session-1", sessionData);
  assert.notStrictEqual(raw("session-1").session_json, first.session_json);

  const beforeTouch = raw("session-1").expires_at;
  const touched = { ...sessionData, cookie: { expires: new Date(Date.now() + 120_000).toISOString() } };
  await touch("session-1", touched);
  assert.ok(raw("session-1").expires_at > beforeTouch);
  assert.ok(!raw("session-1").session_json.includes("TEST_PLEX_TOKEN_123"));

  db.prepare("UPDATE http_sessions SET session_json = ? WHERE sid = ?").run("enc:v2:tampered", "session-1");
  assert.strictEqual(await get("session-1"), null);
  assert.strictEqual(raw("session-1"), undefined);

  await set("session-2", sessionData);
  const validCiphertext = raw("session-2").session_json;
  process.env.CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  assert.strictEqual(await get("session-2"), null);
  assert.strictEqual(raw("session-2"), undefined);
  process.env.CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

  db.prepare("INSERT INTO http_sessions (sid, session_json, expires_at) VALUES (?, ?, ?)")
    .run("legacy", JSON.stringify(sessionData), Date.now() + 60_000);
  assert.strictEqual(await get("legacy"), null);
  assert.strictEqual(raw("legacy"), undefined);

  db.prepare("INSERT INTO http_sessions (sid, session_json, expires_at) VALUES (?, ?, ?)")
    .run("expired", validCiphertext, Date.now() - 1);
  assert.strictEqual(await get("expired"), null);

  await set("session-3", sessionData);
  await destroy("session-3");
  assert.strictEqual(raw("session-3"), undefined);

  assert.throws(() => resolveSessionSecret({ NODE_ENV: "production" }), /strong SESSION_SECRET/);
  const productionSecret = "a".repeat(32);
  assert.deepStrictEqual(resolveSessionSecret({ NODE_ENV: "production", SESSION_SECRET: productionSecret }), {
    secret: productionSecret,
    ephemeral: false
  });
  assert.strictEqual(resolveSessionSecret({ NODE_ENV: "test" }).ephemeral, true);

  db.close();
  console.log("sqlite session store encryption tests passed");
})().catch(error => {
  db.close();
  throw error;
});
