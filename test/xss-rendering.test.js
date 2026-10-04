const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("calendar renderers use text nodes and restrict image URLs", () => {
  const calendar = fs.readFileSync(path.join(__dirname, "../views/calendrier/index.ejs"), "utf8");
  assert.match(calendar, /function safeImageUrl/);
  assert.match(calendar, /url\.protocol === 'http:' \|\| url\.protocol === 'https:'/);
  assert.match(calendar, /title\.textContent = String\(evt\.title == null \? '' : evt\.title\)/);
  assert.match(calendar, /subtitle\.textContent = String\(evt\.subtitle\)/);
  assert.match(calendar, /formatEventDuration\(evt\.duration \?\? evt\.runtime\)/);
  assert.match(calendar, /\.textContent = overview/);
});

test("statistics render external media titles and genres with textContent", () => {
  const page = fs.readFileSync(path.join(__dirname, "../views/statistiques/mes-stats.ejs"), "utf8");
  assert.match(page, /label\.textContent=String\(item\.title\|\|''\)/);
  assert.match(page, /name\.textContent=String\(g\.name\|\|''\)/);
  assert.doesNotMatch(page, /\.innerHTML\s*=/);
});
