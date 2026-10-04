const assert = require("node:assert/strict");
const test = require("node:test");
process.env.DB_PATH = require("node:path").join(__dirname, ".dashboard-html-test.db");
const { sanitizeDashboardCustomHtml } = require("../utils/dashboard-custom-html");

test("safe dashboard HTML renders executable markup as text", () => {
  const result = sanitizeDashboardCustomHtml('<img src=x onerror=alert(1)><a href=JaVaScRiPt:alert(1)>x</a><svg><script>alert(1)</script></svg><iframe src="data:text/html,x"></iframe><div style="background:url(javascript:alert(1))">x</div>');
  assert.ok(result.includes('&lt;script&gt;'));
  assert.ok(!result.includes('<script'));
  assert.ok(!result.includes('<img'));
});
