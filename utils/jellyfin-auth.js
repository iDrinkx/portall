const crypto = require("crypto");
const { UserQueries, UserServiceCredentialQueries } = require("./database");
const { encryptCredentialSecret, decryptCredentialSecret } = require("./credential-crypto");
const { getConfigValue } = require("./config");
const { safeFetchConfiguredUrl } = require("./network-url");

function getOrCreateDbUser(user) {
  if (!user?.username) return null;
  return UserQueries.upsert(user.username, user.id || null, user.email || null,
    user.joinedAt || user.joinedAtTimestamp || null);
}

function getUserServiceCredential(user, serviceKey) {
  const dbUser = getOrCreateDbUser(user);
  if (!dbUser?.id) return null;
  const row = UserServiceCredentialQueries.getByUserAndService(dbUser.id, serviceKey);
  if (!row) return null;
  const decrypted = decryptCredentialSecret(row.secretEncrypted, { legacySessionSecret: process.env.SESSION_SECRET });
  if (!row.username || !decrypted.value) return null;
  if (decrypted.legacy) {
    try { UserServiceCredentialQueries.upsert(dbUser.id, serviceKey, row.username, encryptCredentialSecret(decrypted.value), null); } catch (_) {}
  }
  return { username: row.username, password: decrypted.value };
}

function clearUserServiceCredential(user, serviceKey) {
  const dbUser = getOrCreateDbUser(user);
  return !!dbUser?.id && !!UserServiceCredentialQueries.remove(dbUser.id, serviceKey);
}

async function authenticateJellyfin(username, password) {
  const jellyfinUrl = getConfigValue("JELLYFIN_URL", "").replace(/\/$/, "");
  if (!jellyfinUrl || !username || !password) return null;
  try {
    const deviceId = `portall-${crypto.randomUUID()}`;
    const response = await safeFetchConfiguredUrl(`${jellyfinUrl}/Users/AuthenticateByName`, {
      method: "POST", headers: {
        "Content-Type": "application/json", Accept: "application/json",
        "X-Emby-Authorization": `MediaBrowser Client="PlexPortal", Device="Web", DeviceId="${deviceId}", Version="1.0.0"`
      }, body: JSON.stringify({ Username: username, Pw: password })
    });
    if (!response.ok) return null;
    const body = await response.json();
    const accessToken = String(body?.AccessToken || "").trim();
    return accessToken ? { accessToken, userId: String(body?.User?.Id || "").trim(), deviceId } : null;
  } catch (_) { return null; }
}

async function refreshJellyfinSessionAuth(sessionData, sessionUser) {
  const cred = getUserServiceCredential(sessionUser, "jellyfin");
  if (!cred) return { ok: false, needsSetup: true };
  const auth = await authenticateJellyfin(cred.username, cred.password);
  if (!auth) {
    clearUserServiceCredential(sessionUser, "jellyfin");
    return { ok: false, needsSetup: true };
  }
  sessionData.jellyfinAuth = { ...auth, refreshedAt: Date.now() };
  return { ok: true, needsSetup: false };
}

function buildJellyfinAuthorizationHeader(auth) {
  const token = String(auth?.accessToken || "").trim();
  if (!token) return "";
  const deviceId = String(auth?.deviceId || "portall-proxy").trim();
  return `MediaBrowser Token="${token}", Client="PlexPortal", Device="Web", DeviceId="${deviceId}", Version="1.0.0"`;
}

module.exports = { authenticateJellyfin, refreshJellyfinSessionAuth, buildJellyfinAuthorizationHeader, getUserServiceCredential, clearUserServiceCredential };
