const assert = require("assert");
const http = require("http");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { getTrustProxySetting } = require("../utils/trust-proxy");

function start(app) {
  return new Promise(resolve => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function request(server, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path: "/", headers }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  assert.strictEqual(getTrustProxySetting(""), false);
  assert.strictEqual(getTrustProxySetting("true"), false);
  assert.strictEqual(getTrustProxySetting("1"), 1);

  const directApp = express();
  directApp.set("trust proxy", getTrustProxySetting(""));
  directApp.use(rateLimit({
    windowMs: 60_000,
    limit: 1,
    standardHeaders: false,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false }
  }));
  directApp.get("/", (req, res) => res.json({ ip: req.ip, secure: req.secure }));
  const directServer = await start(directApp);
  try {
    const first = await request(directServer, { "X-Forwarded-For": "198.51.100.1" });
    const second = await request(directServer, { "X-Forwarded-For": "203.0.113.2" });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 429, "spoofed X-Forwarded-For must not bypass rate limiting by default");
    assert.strictEqual(JSON.parse(first.body).ip, "127.0.0.1");
  } finally {
    await new Promise(resolve => directServer.close(resolve));
  }

  const proxyApp = express();
  proxyApp.set("trust proxy", getTrustProxySetting("1"));
  proxyApp.get("/", (req, res) => res.json({ ip: req.ip, secure: req.secure }));
  const proxyServer = await start(proxyApp);
  try {
    const result = await request(proxyServer, { "X-Forwarded-For": "203.0.113.7", "X-Forwarded-Proto": "https" });
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(JSON.parse(result.body), { ip: "203.0.113.7", secure: true });
  } finally {
    await new Promise(resolve => proxyServer.close(resolve));
  }

  console.log("trust-proxy tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
