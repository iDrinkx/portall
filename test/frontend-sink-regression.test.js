const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const scannedRoots = ["views", path.join("public", "js")];

function frontendFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return frontendFiles(entryPath);
    return /\.(?:ejs|js)$/.test(entry.name) ? [entryPath] : [];
  });
}

const files = scannedRoots.flatMap((directory) => frontendFiles(path.join(root, directory)));

// This is intentionally per occurrence, not per file. A new assignment must be
// reviewed and added here with its category and a narrowly stable source pattern.
const safeInnerHtmlAllowlist = [
  {
    file: "views/calendrier/index.ejs",
    pattern: "return node.innerHTML;",
    category: "SAFE_BY_CONSTRUCTION",
    justification: "textContent is assigned to a detached span solely to obtain escaped HTML serialization."
  },
  {
    file: "views/calendrier/index.ejs",
    pattern: "elView.innerHTML = '<div class=\"cal-error\">❌ Erreur de chargement du calendrier</div>';",
    category: "SAFE_STATIC",
    justification: "Fixed error markup with no interpolation."
  },
  {
    file: "views/calendrier/index.ejs",
    pattern: "elView.innerHTML = '<div class=\"cal-empty\">Aucun événement ce jour-là</div>';",
    category: "SAFE_STATIC",
    justification: "Fixed empty-state markup with no interpolation."
  },
  {
    file: "views/calendrier/index.ejs",
    pattern: "elView.innerHTML = '<div class=\"cal-empty\">Aucun événement trouvé</div>';",
    category: "SAFE_STATIC",
    justification: "Fixed empty-state markup with no interpolation."
  }
];

test("frontend dangerous markup sinks are absent or individually allowlisted", () => {
  const allowed = new Set(safeInnerHtmlAllowlist.map((entry) => entry.file + "\0" + entry.pattern));
  const foundAllowed = new Set();
  const forbidden = /\b(?:outerHTML|insertAdjacentHTML|srcdoc)\b|document\.write\s*\(|\beval\s*\(|new Function\s*\(|set(?:Timeout|Interval)\s*\(\s*["']/;

  for (const file of files) {
    const relative = path.relative(root, file).replaceAll(path.sep, "/");
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      assert.doesNotMatch(line, forbidden, relative + ":" + (index + 1) + " uses a forbidden frontend sink");
      if (!line.includes("innerHTML")) return;
      const key = relative + "\0" + line.trim();
      assert.ok(allowed.has(key), relative + ":" + (index + 1) + " has unreviewed innerHTML: " + line.trim());
      foundAllowed.add(key);
    });
  }

  assert.deepEqual(foundAllowed, allowed, "the allowlist must not contain stale or broad entries");
});
