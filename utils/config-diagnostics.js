const fetch = require("node-fetch");
const { DEFAULT_API_BASE_URL, normalizeProvider } = require("./uptime-status");
const { getConfigValue } = require("./config");
const { probeWizarrConnection } = require("./wizarr");

const CONFIG_TEST_TIMEOUT_MS = 5000;

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function fetchWithConfigTest(url, options = {}) {
  return fetch(url, { timeout: CONFIG_TEST_TIMEOUT_MS, ...options });
}

function summarizeConfigTest(label, ok, message, extra = {}) {
  return { label, ok, message, ...extra };
}

function getValue(key, overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, key)) {
    return overrides[key];
  }
  return getConfigValue(key, "");
}

function summarizeMissingConfig(label, options = {}) {
  if (options.optionalWhenMissing) {
    return summarizeConfigTest(label, true, "Optionnel pour le premier démarrage", {
      optional: true,
      configured: false
    });
  }
  return summarizeConfigTest(label, false, "Configuration incomplète", {
    optional: false,
    configured: false
  });
}

async function testPlexConnection(overrides = {}, options = {}) {
  const plexUrl = normalizeBaseUrl(getValue("PLEX_URL", overrides));
  const plexToken = String(getValue("PLEX_TOKEN", overrides) || "").trim();
  if (!plexUrl || !plexToken) return summarizeMissingConfig("Plex", options);
  try {
    const resp = await fetchWithConfigTest(`${plexUrl}/identity`, {
      headers: { "X-Plex-Token": plexToken, Accept: "application/json" }
    });
    if (resp.ok) return summarizeConfigTest("Plex", true, "Connexion OK", { configured: true });
    if (resp.status === 401 || resp.status === 403) return summarizeConfigTest("Plex", false, "Token invalide", { configured: true });
    return summarizeConfigTest("Plex", false, `HTTP ${resp.status}`, { configured: true });
  } catch (err) {
    return summarizeConfigTest("Plex", false, err.message || "Connexion impossible", { configured: true });
  }
}

async function testTautulliConnection(overrides = {}, options = {}) {
  const tautulliUrl = normalizeBaseUrl(getValue("TAUTULLI_URL", overrides));
  const apiKey = String(getValue("TAUTULLI_API_KEY", overrides) || "").trim();
  if (!tautulliUrl || !apiKey) return summarizeMissingConfig("Tautulli", options);
  try {
    const resp = await fetchWithConfigTest(`${tautulliUrl}/api/v2?apikey=${encodeURIComponent(apiKey)}&cmd=get_activity`, {
      headers: { Accept: "application/json" }
    });
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) return summarizeConfigTest("Tautulli", false, "Clé invalide", { configured: true });
      return summarizeConfigTest("Tautulli", false, `HTTP ${resp.status}`, { configured: true });
    }
    const data = await resp.json().catch(() => null);
    const result = String(data?.response?.result || "").toLowerCase();
    if (result === "success") return summarizeConfigTest("Tautulli", true, "Connexion OK", { configured: true });
    return summarizeConfigTest("Tautulli", false, data?.response?.message || "Réponse invalide", { configured: true });
  } catch (err) {
    return summarizeConfigTest("Tautulli", false, err.message || "Connexion impossible", { configured: true });
  }
}

async function testWizarrConnection(overrides = {}, options = {}) {
  const wizarrUrl = normalizeBaseUrl(getValue("WIZARR_URL", overrides));
  const apiKey = String(getValue("WIZARR_API_KEY", overrides) || "").trim();
  if (!wizarrUrl || !apiKey) return summarizeMissingConfig("Wizarr", options);
  try {
    const result = await probeWizarrConnection(wizarrUrl, apiKey);
    if (result.ok) {
      return summarizeConfigTest("Wizarr", true, "Connexion OK", {
        configured: true,
        detail: result.source
      });
    }
    if (/HTTP 401|HTTP 403/i.test(String(result.reason || ""))) {
      return summarizeConfigTest("Wizarr", false, "Clé invalide", { configured: true });
    }
    return summarizeConfigTest("Wizarr", false, result.reason || "Connexion impossible", { configured: true });
  } catch (err) {
    return summarizeConfigTest("Wizarr", false, err.message || "Connexion impossible", { configured: true });
  }
}

async function testSeerrConnection(overrides = {}, options = {}) {
  const seerrUrl = normalizeBaseUrl(getValue("SEERR_URL", overrides));
  const apiKey = String(getValue("SEERR_API_KEY", overrides) || "").trim();
  if (!seerrUrl || !apiKey) return summarizeMissingConfig("Seerr", options);
  try {
    const resp = await fetchWithConfigTest(`${seerrUrl}/api/v1/auth/me`, {
      headers: { Accept: "application/json", "X-API-Key": apiKey }
    });
    if (resp.ok) return summarizeConfigTest("Seerr", true, "Connexion OK", { configured: true });
    if (resp.status === 401 || resp.status === 403) return summarizeConfigTest("Seerr", false, "Clé invalide", { configured: true });
    return summarizeConfigTest("Seerr", false, `HTTP ${resp.status}`, { configured: true });
  } catch (err) {
    return summarizeConfigTest("Seerr", false, err.message || "Connexion impossible", { configured: true });
  }
}

async function testArrConnection(label, urlKey, apiKeyKey, overrides = {}, options = {}) {
  const url = normalizeBaseUrl(getValue(urlKey, overrides));
  const key = String(getValue(apiKeyKey, overrides) || "").trim();
  if (!url || !key) return summarizeMissingConfig(label, options);
  try {
    const resp = await fetchWithConfigTest(`${url}/api/v3/system/status`, {
      headers: { Accept: "application/json", "X-Api-Key": key }
    });
    if (resp.ok) return summarizeConfigTest(label, true, "Connexion OK", { configured: true });
    if (resp.status === 401 || resp.status === 403) return summarizeConfigTest(label, false, "Clé invalide", { configured: true });
    return summarizeConfigTest(label, false, `HTTP ${resp.status}`, { configured: true });
  } catch (err) {
    return summarizeConfigTest(label, false, err.message || "Connexion impossible", { configured: true });
  }
}

async function testUrlReachable(label, urlKey, overrides = {}, options = {}) {
  const url = normalizeBaseUrl(getValue(urlKey, overrides));
  if (!url) return summarizeMissingConfig(label, options);
  try {
    const resp = await fetchWithConfigTest(url, {
      headers: { Accept: "text/html,application/json" }
    });
    if (resp.ok) return summarizeConfigTest(label, true, "Connexion OK", { configured: true });
    return summarizeConfigTest(label, false, `HTTP ${resp.status}`, { configured: true });
  } catch (err) {
    return summarizeConfigTest(label, false, err.message || "Connexion impossible", { configured: true });
  }
}

async function testKomgaConnection(overrides = {}, options = {}) {
  const komgaUrl = normalizeBaseUrl(getValue("KOMGA_URL", overrides));
  const apiKey = String(getValue("KOMGA_API_KEY", overrides) || "").trim();
  if (!komgaUrl || !apiKey) return summarizeMissingConfig("Komga", options);
  const endpoints = ["/api/v2/users/me", "/api/v1/users/me", "/api/v1/books?page=0&size=1"];
  for (const endpoint of endpoints) {
    try {
      const resp = await fetchWithConfigTest(`${komgaUrl}${endpoint}`, {
        headers: { Accept: "application/json", "X-API-Key": apiKey }
      });
      if (resp.ok) return summarizeConfigTest("Komga", true, "Connexion OK", { configured: true });
      if (resp.status === 401 || resp.status === 403) return summarizeConfigTest("Komga", false, "Clé invalide", { configured: true });
      if (resp.status !== 404) return summarizeConfigTest("Komga", false, `HTTP ${resp.status}`, { configured: true });
    } catch (err) {
      return summarizeConfigTest("Komga", false, err.message || "Connexion impossible", { configured: true });
    }
  }
  return summarizeConfigTest("Komga", false, "Endpoint non compatible", { configured: true });
}

async function testUptimeConnection(overrides = {}, options = {}) {
  try {
    const provider = normalizeProvider(getValue("UPTIME_PROVIDER", overrides) || "kuma");

    if (provider === "robot") {
      const apiKey = String(getValue("UPTIME_ROBOT_API_KEY", overrides) || "").trim();
      if (!apiKey) return summarizeMissingConfig("UptimeRobot", options);
      const resp = await fetchWithConfigTest(`${DEFAULT_API_BASE_URL}/monitors`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`
        }
      });
      if (resp.ok) return summarizeConfigTest("UptimeRobot", true, "Connexion OK", { configured: true });
      if (resp.status === 401 || resp.status === 403) return summarizeConfigTest("UptimeRobot", false, "Clé invalide", { configured: true });
      if (resp.status === 429) return summarizeConfigTest("UptimeRobot", false, "Rate limit atteint", { configured: true });
      return summarizeConfigTest("UptimeRobot", false, `HTTP ${resp.status}`, { configured: true });
    }

    const uptimeKumaUrl = String(getValue("UPTIME_KUMA_URL", overrides) || "").trim();
    const uptimeKumaUsername = String(getValue("UPTIME_KUMA_USERNAME", overrides) || "").trim();
    const uptimeKumaPassword = String(getValue("UPTIME_KUMA_PASSWORD", overrides) || "").trim();
    if (!uptimeKumaUrl || !uptimeKumaUsername || !uptimeKumaPassword) {
      return summarizeMissingConfig("Uptime Kuma", options);
    }

    const resp = await fetchWithConfigTest(normalizeBaseUrl(uptimeKumaUrl), {
      headers: { Accept: "text/html,application/json" }
    });
    if (resp.ok) return summarizeConfigTest("Uptime Kuma", true, "Connexion OK", { configured: true });
    return summarizeConfigTest("Uptime Kuma", false, `HTTP ${resp.status}`, { configured: true });
  } catch (err) {
    return summarizeConfigTest("Uptime", !!options.optionalWhenMissing, err.message || "Connexion impossible", {
      configured: false,
      optional: !!options.optionalWhenMissing
    });
  }
}

async function runConfigDiagnostics(overrides = {}, options = {}) {
  const optionalWhenMissing = !!options.optionalWhenMissing;
  const tests = await Promise.all([
    testPlexConnection(overrides, { optionalWhenMissing: false }),
    testTautulliConnection(overrides, { optionalWhenMissing }),
    testSeerrConnection(overrides, { optionalWhenMissing }),
    testWizarrConnection(overrides, { optionalWhenMissing }),
    testUptimeConnection(overrides, { optionalWhenMissing }),
    testArrConnection("Radarr", "RADARR_URL", "RADARR_API_KEY", overrides, { optionalWhenMissing }),
    testArrConnection("Sonarr", "SONARR_URL", "SONARR_API_KEY", overrides, { optionalWhenMissing }),
    testKomgaConnection(overrides, { optionalWhenMissing }),
    testUrlReachable("Jellyfin", "JELLYFIN_URL", overrides, { optionalWhenMissing }),
    testUrlReachable("RomM", "ROMM_URL", overrides, { optionalWhenMissing })
  ]);

  const normalizedTests = tests.map(test => ({
    ...test,
    blocking: optionalWhenMissing ? test.label === "Plex" : !test.optional
  }));

  return {
    ok: normalizedTests.every(test => test.ok || !test.blocking),
    tests: normalizedTests
  };
}

module.exports = {
  runConfigDiagnostics
};
