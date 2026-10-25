const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "portall-trakt-test-")), "portall.db");
process.env.CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TRAKT_CLIENT_ID = "test-client";

const nodeFetch = require("node-fetch");
let requests = 0;
const fetchImpl = async () => {
  requests += 1;
  return { ok: false, status: 429, headers: new nodeFetch.Headers({ "retry-after": "1" }) };
};

const { shouldServeTraktBackoffCache, getTraktListItems, resetCollectionCaches } = require("../utils/tautulli-direct");

const now = Date.now();
assert.equal(
  shouldServeTraktBackoffCache({ ts: now - (31 * 24 * 60 * 60 * 1000), blockedUntil: now + 60_000 }, now),
  true,
  "an active Trakt Retry-After must block requests even when cached data is stale"
);
assert.equal(shouldServeTraktBackoffCache({ blockedUntil: now }, now), false);
assert.equal(shouldServeTraktBackoffCache(null, now), false);

(async () => {
  resetCollectionCaches();
  const [first, second] = await Promise.all([
    getTraktListItems("potter-head", { fetchImpl }),
    getTraktListItems("potter-head", { fetchImpl })
  ]);
  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(requests, 1, "concurrent Trakt loads must share one request");
  await getTraktListItems("potter-head", { fetchImpl });
  assert.equal(requests, 1, "an active 429 backoff must prevent a new request without a cache");
  console.log("Trakt backoff tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

