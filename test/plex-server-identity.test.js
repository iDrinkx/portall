const assert = require("node:assert/strict");

const networkUrl = require("../utils/network-url");
let identityCalls = 0;
let usersCalls = 0;
networkUrl.safeFetchConfiguredUrl = async (url) => {
  if (url.endsWith("/identity")) {
    identityCalls += 1;
    if (identityCalls === 1) return { ok: true, json: async () => ({ MediaContainer: { machineIdentifier: "server-a" } }) };
    throw new Error("Plex temporarily unavailable");
  }
  usersCalls += 1;
  return {
    ok: true,
    text: async () => usersCalls === 1
      ? '<User id="1"><Server machineIdentifier="server-a" /></User>'
      : '<User id="2"><Server machineIdentifier="server-b" /></User>'
  };
};

const { getServerMachineId, getAuthorizedServerUsers } = require("../utils/plex");

(async () => {
  assert.equal(await getServerMachineId("http://plex.local", "token", { forceRefresh: true }), "server-a");
  assert.equal(await getServerMachineId("http://plex.local", "token", { forceRefresh: true }), null);
  assert.equal(identityCalls, 2, "a forced authentication check must not reuse a stale server identity");
  assert.deepEqual((await getAuthorizedServerUsers("token", "server-a")).map(user => user.id), [1]);
  assert.deepEqual((await getAuthorizedServerUsers("token", "server-b")).map(user => user.id), [2]);
  assert.equal(usersCalls, 2, "an authorization cache must not cross Plex server identities");
  console.log("Plex server identity tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
