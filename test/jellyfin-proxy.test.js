const assert = require("node:assert/strict");
const test = require("node:test");
const signature = require("cookie-signature");
// The proxy helpers import configuration; keep its SQLite module inside the workspace in tests.
process.env.DB_PATH = require("node:path").join(__dirname, ".jellyfin-proxy-test.db");
const {
  loadAuthenticatedSessionFromUpgradeRequest,
  rewrittenPath,
  sanitizeSetCookies,
  isAllowedOrigin
} = require("../utils/jellyfin-proxy");

test("Jellyfin proxy only rewrites a local proxy path", () => {
  assert.equal(rewrittenPath("/jellyfin-proxy/foo?bar=1"), "/foo?bar=1");
  assert.equal(rewrittenPath("/jellyfin-proxy/web/index.html"), "/web/index.html");
  assert.equal(rewrittenPath("/jellyfin-proxy//evil.example"), null);
  assert.equal(rewrittenPath("/jellyfin-proxy/https://evil.example"), null);
  assert.equal(rewrittenPath("/jellyfin-proxy/..\\evil"), null);
});

test("upgrade authentication accepts only the signed portall session", async () => {
  const secret = "a secure test secret with enough length";
  const sid = "server-side-session-id";
  const store = { get(requested, cb) { cb(null, requested === sid ? { user: { username: "alice" }, cookie: { expires: new Date(Date.now() + 60_000).toISOString() } } : null); } };
  const valid = `s:${signature.sign(sid, secret)}`;
  const loaded = await loadAuthenticatedSessionFromUpgradeRequest({ headers: { cookie: `portall.sid=${encodeURIComponent(valid)}` } }, { sessionStore: store, sessionSecret: secret });
  assert.equal(loaded.sid, sid);
  const forged = await loadAuthenticatedSessionFromUpgradeRequest({ headers: { cookie: "portall.sid=s:forged.signature" } }, { sessionStore: store, sessionSecret: secret });
  assert.equal(forged, null);
});

test("upstream cookies cannot overwrite Portall and lose their domain", () => {
  assert.deepEqual(sanitizeSetCookies(["portall.sid=bad; Domain=.example.test", "jelly=ok; Domain=jellyfin.internal; Secure; HttpOnly"]), ["jelly=ok; Secure; HttpOnly"]);
});

test("upgrade Origin is normalized and fail-closed", () => {
  assert.equal(isAllowedOrigin("https://example.com", "https://EXAMPLE.com/app/"), true);
  assert.equal(isAllowedOrigin("https://evil.example", "https://example.com/"), false);
  assert.equal(isAllowedOrigin("", "https://example.com/"), false);
});
