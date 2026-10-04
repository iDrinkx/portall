const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const template = fs.readFileSync(path.join(__dirname, "..", "views", "calendrier", "index.ejs"), "utf8");

test("calendar day, list and overlay use DOM APIs for untrusted event data", () => {
  assert.match(template, /function safeImageUrl\(value\)/);
  assert.match(template, /url\.protocol === 'http:' \|\| url\.protocol === 'https:'/);
  assert.match(template, /function createDayEventCard\(evt\)/);
  assert.match(template, /title\.textContent = String\(evt\.title == null \? '' : evt\.title\)/);
  assert.match(template, /subtitle\.textContent = String\(evt\.subtitle\)/);
  assert.match(template, /calModalOverview'\)\.textContent = overview/);
  assert.match(template, /calModalGenres'\)\.textContent = genres/);
  assert.match(template, /card\.dataset\.eventId = normalizeEventId\(evt\.id\)/);
  assert.match(template, /image\.src = thumb/);
  assert.match(template, /elView\.replaceChildren\(detail\)/);
  assert.match(template, /elView\.replaceChildren\(table\)/);
  assert.match(template, /content\.replaceChildren\(\.\.\.cards\)/);
  assert.doesNotMatch(template, /elView\.innerHTML = html/);
  assert.doesNotMatch(template, /calDayOverlayContent'\)\.innerHTML/);
});

function extractFunction(name) {
  const start = template.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing ${name}`);
  const openBrace = template.indexOf("{", start);
  let depth = 0;
  for (let index = openBrace; index < template.length; index += 1) {
    if (template[index] === "{") depth += 1;
    if (template[index] === "}") depth -= 1;
    if (depth === 0) return template.slice(start, index + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

function createFakeDocument() {
  function createElement(tagName) {
    return {
      tagName: tagName.toUpperCase(),
      children: [],
      dataset: {},
      style: {},
      className: "",
      textContent: "",
      append(...children) { children.forEach((child) => this.appendChild(child)); },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener() {}
    };
  }
  return { createElement };
}

function collectElements(element) {
  return [element, ...element.children.flatMap(collectElements)];
}

test("calendar event cards render hostile strings as text and reject hostile poster URLs", () => {
  const context = {
    document: createFakeDocument(),
    window: { safeHttpUrl: () => null },
    URL,
    String,
    Number,
    Math
  };
  const code = [
    "const allEvents = [];",
    extractFunction("safeImageUrl"),
    extractFunction("normalizeEventId"),
    extractFunction("formatEventDuration"),
    extractFunction("addEventDetailsListener"),
    extractFunction("createDayEventCard")
  ].join("\n");
  vm.runInNewContext(code, context);

  const hostileTitle = '<img src=x onerror=alert(1)>';
  const hostileSubtitle = '\"><svg/onload=alert(1)>';
  for (const thumb of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "//evil.example/test"
  ]) {
    const card = context.createDayEventCard({
      id: "  event-42  ",
      title: hostileTitle,
      subtitle: hostileSubtitle,
      overview: "<script>alert(1)</script>",
      genres: "<svg/onload=alert(1)>",
      duration: "42",
      thumb
    });
    const elements = collectElements(card);
    assert.equal(card.dataset.eventId, "event-42");
    assert.ok(elements.some((element) => element.textContent === hostileTitle));
    assert.ok(elements.some((element) => element.textContent === hostileSubtitle));
    assert.equal(elements.some((element) => element.tagName === "IMG"), false);
  }
});
