const assert = require("node:assert/strict");
const test = require("node:test");
const { requireCsrfToken } = require("../middleware/csrf.middleware");

function invoke(req) {
  return new Promise(resolve => {
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { resolve({ statusCode: this.statusCode, body }); } };
    requireCsrfToken(req, res, () => resolve({ next: true }));
  });
}

test("CSRF accepts the same token in a logout form body and rejects a forged one", async () => {
  const session = { user: { username: "alice" }, csrfToken: "expected-token" };
  assert.deepEqual(await invoke({ path: "/logout", method: "POST", session, body: { _csrf: "expected-token" }, get: () => "" }), { next: true });
  assert.deepEqual(await invoke({ path: "/logout", method: "POST", session, body: { _csrf: "forged" }, get: () => "" }), { statusCode: 403, body: { error: "Invalid request token" } });
});
