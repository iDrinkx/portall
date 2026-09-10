const assert = require("assert");
const { Headers } = require("node-fetch");
const { validateTrustedServiceUrl, safeFetchConfiguredUrl } = require("../utils/network-url");

function assertRejected(url) {
  assert.throws(() => validateTrustedServiceUrl(url), /Invalid service URL|not allowed/);
}

function response(status, location = "") {
  return { status, headers: new Headers(location ? { location } : {}) };
}

async function testCrossOriginHeaders() {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, method: options.method, body: options.body, headers: new Headers(options.headers) });
    return requests.length === 1
      ? response(302, "http://localhost:5056/next")
      : response(200);
  };

  await safeFetchConfiguredUrl("http://localhost:5055/start", {
    method: "POST",
    body: JSON.stringify({ authToken: "secret" }),
    headers: {
      "X-API-Key": "seerr-key",
      Authorization: "Bearer wizarr-key",
      Cookie: "connect.sid=secret",
      "X-Plex-Token": "plex-token",
      Accept: "application/json"
    },
    fetchImpl
  });

  assert.strictEqual(requests.length, 2);
  assert.strictEqual(requests[1].method, "GET");
  assert.strictEqual(requests[1].body, undefined);
  for (const name of ["x-api-key", "authorization", "cookie", "x-plex-token"]) {
    assert.strictEqual(requests[1].headers.has(name), false, `${name} must not cross origins`);
  }
  assert.strictEqual(requests[1].headers.get("accept"), "application/json");
}

async function testRejectedRedirect() {
  await assert.rejects(
    safeFetchConfiguredUrl("http://localhost:8181/start", {
      fetchImpl: async () => response(302, "http://169.254.169.254/latest/meta-data")
    }),
    /not allowed/
  );
}

async function testRedirectBodies() {
  const sameOrigin = [];
  await safeFetchConfiguredUrl("http://localhost:5055/start", {
    method: "POST",
    body: "secret",
    fetchImpl: async (url, options) => {
      sameOrigin.push({ url, method: options.method, body: options.body });
      return sameOrigin.length === 1 ? response(307, "/next") : response(200);
    }
  });
  assert.deepStrictEqual(sameOrigin[1], { url: "http://localhost:5055/next", method: "POST", body: "secret" });

  for (const status of [307, 308]) {
    await assert.rejects(
      safeFetchConfiguredUrl("http://localhost:5055/start", {
        method: "POST",
        body: "secret",
        fetchImpl: async () => response(status, "http://localhost:5056/next")
      }),
      /Cross-origin redirect with request body is not allowed/
    );
  }
}

async function main() {
  for (const url of ["http://tautulli:8181", "http://seerr:5055", "http://wizarr:5690", "http://192.168.1.20:8181"]) {
    assert.ok(validateTrustedServiceUrl(url));
  }
  for (const url of ["http://169.254.169.254", "file:///etc/passwd", "http://user:pass@tautulli:8181"]) {
    assertRejected(url);
  }
  assert.strictEqual(new URL("http://[::1]/").hostname, "[::1]");
  assertRejected("http://[::]/");
  assert.ok(validateTrustedServiceUrl("http://[::1]/"));
  assertRejected("http://[fe80::1]/");
  assertRejected("http://[fe90::1]/");
  assertRejected("http://[febf::1]/");
  // fec0::/10 is not fe80::/10 link-local and is allowed by the stated policy.
  assert.ok(validateTrustedServiceUrl("http://[fec0::1]/"));
  assertRejected("http://[ff02::1]/");
  await testRejectedRedirect();
  await testCrossOriginHeaders();
  await testRedirectBodies();
  console.log("network-url tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
