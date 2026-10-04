const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizePublicAppUrl } = require("../middleware/reverseproxy.middleware");

test("public app URL accepts only absolute HTTP(S) origins without credentials", () => {
  assert.equal(normalizePublicAppUrl("https://portall.example.test/base/"), "https://portall.example.test/base");
  assert.equal(normalizePublicAppUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(normalizePublicAppUrl("https://user:pass@example.test"), "");
  assert.equal(normalizePublicAppUrl("javascript:alert(1)"), "");
  assert.equal(normalizePublicAppUrl("//evil.example"), "");
});
