const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

function listEjsFiles(directory, visitedDirectories = new Set()) {
  const realDirectory = fs.realpathSync(directory);
  if (visitedDirectories.has(realDirectory)) return [];
  visitedDirectories.add(realDirectory);

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    const targetStats = entry.isSymbolicLink() ? fs.statSync(fullPath) : null;
    if (entry.isDirectory() || targetStats?.isDirectory()) {
      return listEjsFiles(fullPath, visitedDirectories);
    }
    return (entry.isFile() || targetStats?.isFile()) && entry.name.endsWith(".ejs") ? [fullPath] : [];
  });
}

test("every EJS view compiles", () => {
  const viewsDirectory = path.join(__dirname, "..", "views");
  const files = listEjsFiles(viewsDirectory);
  assert.ok(files.length > 0, "expected at least one EJS view");
  const relativeFiles = files.map(filename => path.relative(path.join(__dirname, ".."), filename));

  for (const filename of files) {
    try {
      ejs.compile(fs.readFileSync(filename, "utf8"), { filename });
    } catch (error) {
      assert.fail(`EJS compilation failed: ${filename}\n${error.message}`);
    }
  }
  console.log(`EJS compilation passed for ${files.length} views:\n${relativeFiles.join("\n")}`);
});
