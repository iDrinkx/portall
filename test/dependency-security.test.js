const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package-lock.json"), "utf8"));

function atLeast(version, minimum) {
  const current = version.split(".").map(Number);
  const required = minimum.split(".").map(Number);
  return current.some((part, index) => part !== required[index] && part > required[index])
    || current.every((part, index) => part === required[index]);
}

assert.ok(atLeast(packageJson.overrides["proxy-addr"].replace(/^[^\d]*/, ""), "2.0.8"));
assert.ok(atLeast(packageLock.packages["node_modules/proxy-addr"].version, "2.0.8"));
assert.ok(atLeast(packageLock.packages["node_modules/body-parser"].version, "1.20.9"));
assert.ok(atLeast(packageLock.packages["node_modules/ip-address"].version, "10.7.4"));

console.log("dependency security tests passed");
