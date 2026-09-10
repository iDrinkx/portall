const assert = require("assert");
const ejs = require("ejs");
const { normalizeEmbedUrl } = require("../utils/embed-url");

assert.strictEqual(normalizeEmbedUrl("/library", "/portall"), "/portall/library");
assert.strictEqual(normalizeEmbedUrl("//evil.example"), "");
assert.strictEqual(normalizeEmbedUrl("https://evil.example"), "https://evil.example/");
assert.strictEqual(normalizeEmbedUrl("javascript:alert(1)"), "");
assert.strictEqual(normalizeEmbedUrl("file:///etc/passwd"), "");
assert.strictEqual(normalizeEmbedUrl("data:text/html,test"), "");

const rendered = ejs.render('<div data-name="<%= value %>"><%= value %></div>', { value: '<script>alert("x")</script>' });
assert.ok(!rendered.includes('<script>'));
assert.ok(rendered.includes('&lt;script&gt;'));
assert.ok(/&(?:quot|#34);x&(?:quot|#34);/.test(rendered));
console.log("runtime-hardening tests passed");
