const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { safeJsonForScript } = require("../utils/safe-json");

test("JSON embedded in scripts cannot close its script element", () => {
  const result = safeJsonForScript({ value: "</script><script>alert(1)</script>\u2028\u2029" });
  assert.ok(!result.includes("</script"));
  assert.ok(result.includes("\\u003c/script"));
  assert.ok(result.includes("\\u2028"));
  assert.ok(result.includes("\\u2029"));
});

test("statistics does not restore or assign cached HTML", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "js", "statistiques.js"), "utf8");
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /snap\.html/);
  assert.match(source, /replaceChildren\(/);
  assert.match(source, /data:\s*\{ tautulliData, seerrData \}/);
});

test("leaderboard validates avatar URLs and rank colours before HTML rendering", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "views", "classement", "index.ejs"), "utf8");
  assert.match(source, /function safeHttpUrl\(value\)/);
  assert.match(source, /function safeColor\(value/);
  assert.match(source, /effectiveThumb = safeHttpUrl/);
  assert.match(source, /const ME = <%- safeJsonForScript/);
});
