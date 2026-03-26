const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const crypto = require("crypto");
const { createProxyMiddleware } = require("http-proxy-middleware");
const log = require("../utils/logger");
const logRomm = log.create("[RomM]");

const { computeSubscription, getAllWizarrUsersDetailed } = require("../utils/wizarr");
const { getTautulliStats } = require("../utils/tautulli");
const { getSeerrStats } = require("../utils/seerr");
const { getEffectivePlexToken, getPlexJoinDate, getServerOwnerId } = require("../utils/plex");
const { getRadarrCalendar, getSonarrCalendar } = require("../utils/radarr-sonarr");
const { XP_SYSTEM } = require("../utils/xp-system");
const { ACHIEVEMENTS, hydrateAchievementTexts, areCollectionAchievementsEnabled, getAchievementXp } = require("../utils/achievements");
const {
  UserAchievementQueries,
  UserQueries,
  DatabaseMaintenance,
  AppSettingQueries,
  DashboardCardQueries,
  UserServiceCredentialQueries
} = require("../utils/database");
const { getLastPlayedItem, getUserStatsFromTautulli, getServerLibraryStats } = require("../utils/tautulli-direct");
const CacheManager = require("../utils/cache");
const TautulliEvents = require("../utils/tautulli-events");  // ?? Import EventEmitter
const {
  getUserAchievementState,
  refreshUserAchievementState,
  SUCCESS_REFRESH_TTL_MS,
  queueBackgroundAchievementRefresh,
  getBackgroundAchievementRefreshStatus
} = require("../utils/achievement-state");
const { getConfigSections, getConfigValue, getEditableConfigValues, saveEditableConfig } = require("../utils/config");
const {
  getDashboardBuiltinAdminItems,
  saveDashboardBuiltinConfig,
  buildDashboardBuiltinCards
} = require("../utils/dashboard-builtins");
const {
  getDashboardSectionAdminItems,
  getDashboardSectionConfig,
  saveDashboardSectionConfig
} = require("../utils/dashboard-sections");
const { buildDashboardLayoutItems, saveDashboardLayoutConfig } = require("../utils/dashboard-layout");
const {
  getDashboardCustomHtml,
  getDashboardCustomHtmlBlocks,
  getDashboardCustomHtmlBlocksRaw,
  getDashboardCustomHtmlRaw,
  getDashboardCustomHtmlMode,
  isDashboardCustomHtmlRawMode,
  saveDashboardCustomHtml
} = require("../utils/dashboard-custom-html");
const { SUPPORTED_LOCALES, getSiteLanguage } = require("../utils/i18n");
const { BACKGROUND_PRESETS, getSiteBackgroundSettings, saveSiteBackgroundSettings } = require("../utils/site-background");
const { DEFAULT_API_BASE_URL, getConfiguredStatusSummary, normalizeProvider } = require("../utils/uptime-status");

const PLEX_LIVE_TIMEOUT_MS = 12000;
const NOW_PLAYING_CACHE_TTL_MS = 45 * 1000;
const CONFIG_TEST_TIMEOUT_MS = 6000;

/* ===============================
   ?? AUTH
=============================== */

async function ensureAdminFlag(req) {
  if (!req.session?.user) return;
  if (typeof req.session.user.isAdmin === "boolean") return;

  let isAdmin = false;
  try {
    const persistedAdminUserId = String(AppSettingQueries.get("admin_user_id", "") || "").trim();
    if (persistedAdminUserId) {
      isAdmin = Number(persistedAdminUserId) === Number(req.session.user.id);
    } else {
      const plexToken = getConfigValue("PLEX_TOKEN", "");
      const ownerId = plexToken ? await getServerOwnerId(plexToken) : null;
      isAdmin = !!ownerId && Number(ownerId) === Number(req.session.user.id);
    }
  } catch (_) {
    isAdmin = false;
  }
  req.session.user.isAdmin = isAdmin;
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseXmlAttributes(fragment = "") {
  const attrs = {};
  const attrRegex = /([A-Za-z0-9:_-]+)="([^"]*)"/g;
  let match = null;
  while ((match = attrRegex.exec(fragment)) !== null) {
    attrs[match[1]] = decodeXmlEntities(match[2]);
  }
  return attrs;
}

function parsePlexSessionsResponse(rawBody = "") {
  const sessions = [];
  const itemRegex = /<(Video|Track|Photo)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let match = null;

  while ((match = itemRegex.exec(rawBody)) !== null) {
    const [, mediaType, attrSource, innerXml] = match;
    const mediaAttrs = parseXmlAttributes(attrSource);
    const userMatch = innerXml.match(/<User\b([^>]*)\/?>/i);
    const playerMatch = innerXml.match(/<Player\b([^>]*)\/?>/i);
    const userAttrs = parseXmlAttributes(userMatch?.[1] || "");
    const playerAttrs = parseXmlAttributes(playerMatch?.[1] || "");

    sessions.push({
      type: String(mediaAttrs.type || mediaType || "").toLowerCase(),
      title: mediaAttrs.title || "",
      grandparentTitle: mediaAttrs.grandparentTitle || "",
      year: mediaAttrs.year ? Number(mediaAttrs.year) : null,
      thumb: mediaAttrs.thumb || null,
      duration: mediaAttrs.duration ? Number(mediaAttrs.duration) : 0,
      viewOffset: mediaAttrs.viewOffset ? Number(mediaAttrs.viewOffset) : 0,
      User: {
        title: userAttrs.title || "",
        id: userAttrs.id || userAttrs.userID || userAttrs.userId || ""
      },
      Player: {
        title: playerAttrs.title || "",
        state: playerAttrs.state || "playing"
      }
    });
  }

  return sessions;
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function fetchWithConfigTest(url, options = {}) {
  return fetch(url, { timeout: CONFIG_TEST_TIMEOUT_MS, ...options });
}

function summarizeConfigTest(label, ok, message, extra = {}) {
  return { label, ok, message, ...extra };
}

async function testPlexConnection() {
  const plexUrl = normalizeBaseUrl(getConfigValue("PLEX_URL", ""));
  const plexToken = String(getConfigValue("PLEX_TOKEN", "") || "").trim();
  if (!plexUrl || !plexToken) return summarizeConfigTest("Plex", false, "Configuration incomplète");
  try {
    const resp = await fetchWithConfigTest(`${plexUrl}/identity`, {
      headers: { "X-Plex-Token": plexToken, Accept: "application/json" }
    });
    if (resp.ok) return summarizeConfigTest("Plex", true, "Connexion OK");
    if (resp.status === 401 || resp.status === 403) return summarizeConfigTest("Plex", false, "Token invalide");
    return summarizeConfigTest("Plex", false, `HTTP ${resp.status}`);
  } catch (err) {
    return summarizeConfigTest("Plex", false, err.message || "Connexion impossible");
  }
}

async function testTautulliConnection() {
  const tautulliUrl = normalizeBaseUrl(getConfigValue("TAUTULLI_URL", ""));
  const apiKey = String(getConfigValue("TAUTULLI_API_KEY", "") || "").trim();
  if (!tautulliUrl || !apiKey) return summarizeConfigTest("Tautulli", false, "Configuration incomplète");
  try {
    const resp = await fetchWithConfigTest(`${tautulliUrl}/api/v2?apikey=${encodeURIComponent(apiKey)}&cmd=get_activity`, {
      headers: { Accept: "application/json" }
    });
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) return summarizeConfigTest("Tautulli", false, "Clé invalide");
      return summarizeConfigTest("Tautulli", false, `HTTP ${resp.status}`);
    }
    const data = await resp.json().catch(() => null);
    const result = String(data?.response?.result || "").toLowerCase();
    if (result === "success") return summarizeConfigTest("Tautulli", true, "Connexion OK");
    return summarizeConfigTest("Tautulli", false, data?.response?.message || "Réponse invalide");
  } catch (err) {
    return summarizeConfigTest("Tautulli", false, err.message || "Connexion impossible");
  }
}

async function testWizarrConnection() {
  const wizarrUrl = normalizeBaseUrl(getConfigValue("WIZARR_URL", ""));
  const apiKey = String(getConfigValue("WIZARR_API_KEY", "") || "").trim();
  if (!wizarrUrl || !apiKey) return summarizeConfigTest("Wizarr", false, "Configuration incomplète");
  try {
    const resp = await fetchWithConfigTest(`${wizarrUrl}/api/users?limit=1`, {
      headers: { Accept: "application/json", "X-API-Key": apiKey }
    });
    if (resp.ok) return summarizeConfigTest("Wizarr", true, "Connexion OK");
    if (resp.status === 401 || resp.status === 403) return summarizeConfigTest("Wizarr", false, "Clé invalide");
    return summarizeConfigTest("Wizarr", false, `HTTP ${resp.status}`);
  } catch (err) {
    return summarizeConfigTest("Wizarr", false, err.message || "Connexion impossible");
  }
}

async function testSeerrConnection() {
  const seerrUrl = normalizeBaseUrl(getConfigValue("SEERR_URL", ""));
  const apiKey = String(getConfigValue("SEERR_API_KEY", "") || "").trim();
  if (!seerrUrl || !apiKey) return summarizeConfigTest("Seerr", false, "Configuration incomplète");
  try {
    const resp = await fetchWithConfigTest(`${seerrUrl}/api/v1/auth/me`, {
      headers: { Accept: "application/json", "X-API-Key": apiKey }
    });
    if (resp.ok) return summarizeConfigTest("Seerr", true, "Connexion OK");
    if (resp.status === 401 || resp.status === 403) return summarizeConfigTest("Seerr", false, "Clé invalide");
    return summarizeConfigTest("Seerr", false, `HTTP ${resp.status}`);
  } catch (err) {
    return summarizeConfigTest("Seerr", false, err.message || "Connexion impossible");
  }
}

async function testUrlReachable(label, rawUrl) {
  const url = normalizeBaseUrl(rawUrl);
  if (!url) return summarizeConfigTest(label, false, "Non configuré");
  try {
    const resp = await fetchWithConfigTest(url, { headers: { Accept: "text/html,application/json" } });
    if (resp.ok) return summarizeConfigTest(label, true, "Connexion OK");
    return summarizeConfigTest(label, false, `HTTP ${resp.status}`);
  } catch (err) {
    return summarizeConfigTest(label, false, err.message || "Connexion impossible");
  }
}

async function testArrConnection(label, baseUrl, apiKey) {
  const url = normalizeBaseUrl(baseUrl);
  const key = String(apiKey || "").trim();
  if (!url || !key) return summarizeConfigTest(label, false, "Configuration incomplète");
  try {
    const resp = await fetchWithConfigTest(`${url}/api/v3/system/status`, {
      headers: { Accept: "application/json", "X-Api-Key": key }
    });
    if (resp.ok) return summarizeConfigTest(label, true, "Connexion OK");
    if (resp.status === 401 || resp.status === 403) return summarizeConfigTest(label, false, "Clé invalide");
    return summarizeConfigTest(label, false, `HTTP ${resp.status}`);
  } catch (err) {
    return summarizeConfigTest(label, false, err.message || "Connexion impossible");
  }
}

async function testKomgaConnection() {
  const komgaUrl = normalizeBaseUrl(getConfigValue("KOMGA_URL", ""));
  const apiKey = String(getConfigValue("KOMGA_API_KEY", "") || "").trim();
  if (!komgaUrl || !apiKey) return summarizeConfigTest("Komga", false, "Configuration incomplète");
  const endpoints = ["/api/v2/users/me", "/api/v1/users/me", "/api/v1/books?page=0&size=1"];
  for (const endpoint of endpoints) {
    try {
      const resp = await fetchWithConfigTest(`${komgaUrl}${endpoint}`, {
        headers: { Accept: "application/json", "X-API-Key": apiKey }
      });
      if (resp.ok) return summarizeConfigTest("Komga", true, "Connexion OK");
      if (resp.status === 401 || resp.status === 403) return summarizeConfigTest("Komga", false, "Clé invalide");
      if (resp.status !== 404) return summarizeConfigTest("Komga", false, `HTTP ${resp.status}`);
    } catch (err) {
      return summarizeConfigTest("Komga", false, err.message || "Connexion impossible");
    }
  }
  return summarizeConfigTest("Komga", false, "Endpoint non compatible");
}

async function testUptimeConnection() {
  const provider = normalizeProvider(getConfigValue("UPTIME_PROVIDER", "kuma"));

  if (provider === "robot") {
    const apiKey = String(getConfigValue("UPTIME_ROBOT_API_KEY", "") || "").trim();
    if (!apiKey) return summarizeConfigTest("UptimeRobot", false, "Configuration incomplète");
    try {
      const resp = await fetchWithConfigTest(`${DEFAULT_API_BASE_URL}/monitors`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`
        }
      });
      if (resp.ok) return summarizeConfigTest("UptimeRobot", true, "Connexion OK");
      if (resp.status === 401 || resp.status === 403) return summarizeConfigTest("UptimeRobot", false, "Clé invalide");
      if (resp.status === 429) return summarizeConfigTest("UptimeRobot", false, "Rate limit atteint");
      return summarizeConfigTest("UptimeRobot", false, `HTTP ${resp.status}`);
    } catch (err) {
      return summarizeConfigTest("UptimeRobot", false, err.message || "Connexion impossible");
    }
  }

  const uptimeKumaUrl = String(getConfigValue("UPTIME_KUMA_URL", "") || "").trim();
  const uptimeKumaUsername = String(getConfigValue("UPTIME_KUMA_USERNAME", "") || "").trim();
  const uptimeKumaPassword = String(getConfigValue("UPTIME_KUMA_PASSWORD", "") || "").trim();
  if (!uptimeKumaUrl || !uptimeKumaUsername || !uptimeKumaPassword) {
    return summarizeConfigTest("Uptime Kuma", false, "Configuration incomplète");
  }
  return testUrlReachable("Uptime Kuma", uptimeKumaUrl);
}

async function runAdminConfigDiagnostics() {
  const tests = await Promise.all([
    testPlexConnection(),
    testTautulliConnection(),
    testSeerrConnection(),
    testWizarrConnection(),
    testUptimeConnection(),
    testArrConnection("Radarr", getConfigValue("RADARR_URL", ""), getConfigValue("RADARR_API_KEY", "")),
    testArrConnection("Sonarr", getConfigValue("SONARR_URL", ""), getConfigValue("SONARR_API_KEY", "")),
    testKomgaConnection(),
    testUrlReachable("Jellyfin", getConfigValue("JELLYFIN_URL", "")),
    testUrlReachable("RomM", getConfigValue("ROMM_URL", ""))
  ]);

  return {
    ok: tests.every(test => test.ok),
    tests
  };
}

function normalizePlexIdentity(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

async function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect(req.basePath + "/");
  await ensureAdminFlag(req);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session?.user?.isAdmin) {
    if (req.path.startsWith("/api/")) {
      return res.status(403).json({ error: "Admin requis" });
    }
    return res.redirect(req.basePath + "/dashboard");
  }
  next();
}

const DEFAULT_DASHBOARD_COLOR_KEYS = new Set(["gold", "blue", "green", "purple", "red"]);
const DASHBOARD_CARD_PALETTE = [
  {
    key: "teal",
    name: "Teal",
    bgStart: "rgba(12, 34, 35, 0.72)",
    bgEnd: "rgba(12, 42, 42, 0.68)",
    border: "rgba(45, 212, 191, 0.2)",
    borderHover: "rgba(45, 212, 191, 0.55)",
    glow: "rgba(45, 212, 191, 0.14)",
    accentA: "#2dd4bf",
    accentB: "#5eead4",
    label: "rgba(45, 212, 191, 0.85)",
    arrow: "#5eead4",
    iconBorder: "rgba(45, 212, 191, 0.5)",
    iconGlow: "rgba(45, 212, 191, 0.2)"
  },
  {
    key: "indigo",
    name: "Indigo",
    bgStart: "rgba(20, 22, 43, 0.72)",
    bgEnd: "rgba(24, 24, 53, 0.68)",
    border: "rgba(129, 140, 248, 0.2)",
    borderHover: "rgba(129, 140, 248, 0.55)",
    glow: "rgba(129, 140, 248, 0.14)",
    accentA: "#818cf8",
    accentB: "#a5b4fc",
    label: "rgba(165, 180, 252, 0.85)",
    arrow: "#a5b4fc",
    iconBorder: "rgba(129, 140, 248, 0.5)",
    iconGlow: "rgba(129, 140, 248, 0.2)"
  },
  {
    key: "pink",
    name: "Rose",
    bgStart: "rgba(40, 18, 30, 0.72)",
    bgEnd: "rgba(48, 18, 35, 0.68)",
    border: "rgba(244, 114, 182, 0.2)",
    borderHover: "rgba(244, 114, 182, 0.55)",
    glow: "rgba(244, 114, 182, 0.14)",
    accentA: "#f472b6",
    accentB: "#f9a8d4",
    label: "rgba(249, 168, 212, 0.85)",
    arrow: "#f9a8d4",
    iconBorder: "rgba(244, 114, 182, 0.5)",
    iconGlow: "rgba(244, 114, 182, 0.2)"
  },
  {
    key: "cyan",
    name: "Cyan",
    bgStart: "rgba(12, 28, 40, 0.72)",
    bgEnd: "rgba(12, 32, 46, 0.68)",
    border: "rgba(34, 211, 238, 0.2)",
    borderHover: "rgba(34, 211, 238, 0.55)",
    glow: "rgba(34, 211, 238, 0.14)",
    accentA: "#22d3ee",
    accentB: "#67e8f9",
    label: "rgba(103, 232, 249, 0.85)",
    arrow: "#67e8f9",
    iconBorder: "rgba(34, 211, 238, 0.5)",
    iconGlow: "rgba(34, 211, 238, 0.2)"
  },
  {
    key: "lime",
    name: "Lime",
    bgStart: "rgba(26, 34, 16, 0.72)",
    bgEnd: "rgba(32, 40, 18, 0.68)",
    border: "rgba(163, 230, 53, 0.2)",
    borderHover: "rgba(163, 230, 53, 0.55)",
    glow: "rgba(163, 230, 53, 0.14)",
    accentA: "#a3e635",
    accentB: "#bef264",
    label: "rgba(190, 242, 100, 0.85)",
    arrow: "#bef264",
    iconBorder: "rgba(163, 230, 53, 0.5)",
    iconGlow: "rgba(163, 230, 53, 0.2)"
  },
  {
    key: "orange",
    name: "Orange",
    bgStart: "rgba(40, 24, 14, 0.72)",
    bgEnd: "rgba(45, 24, 12, 0.68)",
    border: "rgba(251, 146, 60, 0.2)",
    borderHover: "rgba(251, 146, 60, 0.55)",
    glow: "rgba(251, 146, 60, 0.14)",
    accentA: "#fb923c",
    accentB: "#fdba74",
    label: "rgba(253, 186, 116, 0.85)",
    arrow: "#fdba74",
    iconBorder: "rgba(251, 146, 60, 0.5)",
    iconGlow: "rgba(251, 146, 60, 0.2)"
  }
];

function getColorMap() {
  return new Map(DASHBOARD_CARD_PALETTE.map(c => [c.key, c]));
}

function getAvailableColorKeys(existingCards = []) {
  const used = new Set([...DEFAULT_DASHBOARD_COLOR_KEYS]);
  existingCards.forEach(c => used.add(c.colorKey));
  return DASHBOARD_CARD_PALETTE.filter(c => !used.has(c.key)).map(c => c.key);
}

function parseRgbaToTintVars(value, fallbackRgb = "255 255 255", fallbackStrength = 1) {
  const match = String(value || "").trim().match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([0-9.]+))?\s*\)$/i);
  if (!match) {
    return {
      rgb: fallbackRgb,
      strength: fallbackStrength
    };
  }

  const alpha = Math.max(0, Number(match[4] ?? 1));
  return {
    rgb: `${match[1]} ${match[2]} ${match[3]}`,
    strength: Number((alpha / 0.012).toFixed(3))
  };
}

const DASHBOARD_INTEGRATIONS = [
  { key: "custom", label: "Iframe simple (URL libre)" },
  { key: "komga_auto", label: "Komga auto-auth (compte utilisateur)" },
  { key: "jellyfin_auto", label: "Jellyfin auto-auth (compte utilisateur)" },
  { key: "romm_auto", label: "RomM auto-auth (compte utilisateur)" }
];

function resolveIntegrationSrc(card, basePath = "") {
  const integrationKey = String(card.integrationKey || "custom");
  const rawUrl = String(card.url || "");

  if (integrationKey === "komga_auto") {
    return (getConfigValue("KOMGA_PUBLIC_URL", "") || rawUrl || "").trim();
  }
  if (integrationKey === "jellyfin_auto" || integrationKey === "jellyfin_iframe") {
    return (getConfigValue("JELLYFIN_PUBLIC_URL", "") || rawUrl || "").trim();
  }
  if (integrationKey === "romm_auto") {
    return (getConfigValue("ROMM_PUBLIC_URL", "") || rawUrl || "").trim();
  }

  if (rawUrl.startsWith("/")) return `${basePath}${rawUrl}`;
  return rawUrl;
}

function slugifyCardTitle(value) {
  const normalized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "app";
}

const RESERVED_CARD_SLUGS = new Set([
  "",
  "api",
  "dashboard",
  "profil",
  "classement",
  "statistiques",
  "mes-stats",
  "succes",
  "calendrier",
  "parametres",
  "seerr",
  "setup",
  "login",
  "logout",
  "auth-complete",
  "app-card",
  "jellyfin-proxy"
]);

function getCardSlug(card) {
  return slugifyCardTitle(card?.title || card?.label || "");
}

function validateCardSlugForTitle(cards, title, excludeId = null) {
  const slug = slugifyCardTitle(title);
  if (RESERVED_CARD_SLUGS.has(slug)) {
    return { ok: false, error: `Titre invalide: "${title}" est reserve` };
  }
  const duplicate = cards.find(c => {
    const sameSlug = slugifyCardTitle(c.title || c.label || "") === slug;
    if (!sameSlug) return false;
    if (excludeId === null) return true;
    return Number(c.id) !== Number(excludeId);
  });
  if (duplicate) {
    return { ok: false, error: "Deux cartes ne peuvent pas avoir le meme titre (URL deja utilisee)" };
  }
  return { ok: true, slug };
}

function toCardHref(card, basePath = "") {
  const integrationKey = String(card.integrationKey || "custom");
  if (integrationKey !== "custom" || card.openInIframe) {
    return `${basePath}/${getCardSlug(card)}`;
  }
  const rawUrl = String(card.url || "");
  return rawUrl.startsWith("/") ? `${basePath}${rawUrl}` : rawUrl;
}

function getIntegrationAvailability() {
  const komgaConfigured = !!(
    getConfigValue("KOMGA_URL", "") &&
    getConfigValue("KOMGA_PUBLIC_URL", "")
  );
  const jellyfinAutoConfigured = !!(
    getConfigValue("JELLYFIN_URL", "") &&
    getConfigValue("JELLYFIN_PUBLIC_URL", "")
  );
  const rommAutoConfigured = !!(
    getConfigValue("ROMM_URL", "") &&
    getConfigValue("ROMM_PUBLIC_URL", "")
  );
  return {
    komgaConfigured,
    jellyfinAutoConfigured,
    rommAutoConfigured
  };
}

function validateIntegrationForCreateOrUpdate(integrationKey, srcUrl) {
  const allowed = new Set([
    ...DASHBOARD_INTEGRATIONS.map(i => i.key),
    // Compat legacy: cartes déjà persistées avant la suppression de l'option UI
    "jellyfin_iframe"
  ]);
  if (!allowed.has(integrationKey)) {
    return { ok: false, error: "Schéma d'intégration invalide" };
  }

  if (integrationKey === "komga_auto") {
    const ok = !!(
      getConfigValue("KOMGA_URL", "") &&
      getConfigValue("KOMGA_PUBLIC_URL", "")
    );
    if (!ok) return { ok: false, error: "Komga non configuré côté serveur (KOMGA_URL + KOMGA_PUBLIC_URL requis)" };
    return { ok: true };
  }

  if (integrationKey === "jellyfin_auto" || integrationKey === "jellyfin_iframe") {
    const ok = !!(
      getConfigValue("JELLYFIN_URL", "") &&
      getConfigValue("JELLYFIN_PUBLIC_URL", "")
    );
    if (!ok) {
      return {
        ok: false,
        error: "Jellyfin auto-auth non configuré (JELLYFIN_URL + JELLYFIN_PUBLIC_URL requis)"
      };
    }
    return { ok: true };
  }

  if (integrationKey === "romm_auto") {
    const ok = !!(
      getConfigValue("ROMM_URL", "") &&
      getConfigValue("ROMM_PUBLIC_URL", "")
    );
    if (!ok) {
      return {
        ok: false,
        error: "RomM auto-auth non configuré (ROMM_URL + ROMM_PUBLIC_URL requis)"
      };
    }
    return { ok: true };
  }

  return { ok: true };
}

function getCookieParentDomain(publicUrl) {
  if (!publicUrl) return null;
  try {
    const hostname = new URL(publicUrl).hostname;
    const parts = hostname.split(".");
    if (parts.length >= 2) return "." + parts.slice(-2).join(".");
  } catch (_) {}
  return null;
}

function buildJellyfinProxyUrl(publicUrl, basePath = "") {
  try {
    const u = new URL(publicUrl);
    return `${basePath}/jellyfin-proxy${u.pathname}${u.search}`;
  } catch (_) {
    return `${basePath}/jellyfin-proxy/web/`;
  }
}

function getCredentialEncryptionKey() {
  const seed = String(process.env.SESSION_SECRET || "portall-default").trim();
  return crypto.createHash("sha256").update(seed).digest();
}

function encryptCredentialSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getCredentialEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(secret || ""), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptCredentialSecret(payload) {
  if (!payload || typeof payload !== "string") return "";
  const parts = payload.split(".");
  if (parts.length !== 3) return "";
  try {
    const iv = Buffer.from(parts[0], "base64");
    const tag = Buffer.from(parts[1], "base64");
    const data = Buffer.from(parts[2], "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", getCredentialEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch (_) {
    return "";
  }
}

function getOrCreateDbUser(sessionUser) {
  if (!sessionUser?.username) return null;
  return UserQueries.upsert(
    sessionUser.username,
    sessionUser.id || null,
    sessionUser.email || null,
    sessionUser.joinedAt || sessionUser.joinedAtTimestamp || null
  );
}

function getUserServiceCredential(sessionUser, serviceKey) {
  const dbUser = getOrCreateDbUser(sessionUser);
  if (!dbUser?.id) return null;
  const row = UserServiceCredentialQueries.getByUserAndService(dbUser.id, serviceKey);
  if (!row) return null;
  const password = decryptCredentialSecret(row.secretEncrypted);
  if (!row.username || !password) return null;
  return { username: row.username, password };
}

function saveUserServiceCredential(sessionUser, serviceKey, username, password) {
  const dbUser = getOrCreateDbUser(sessionUser);
  if (!dbUser?.id) return false;
  const secretEncrypted = encryptCredentialSecret(password);
  UserServiceCredentialQueries.upsert(dbUser.id, serviceKey, username, secretEncrypted, null);
  return true;
}

function clearUserServiceCredential(sessionUser, serviceKey) {
  const dbUser = getOrCreateDbUser(sessionUser);
  if (!dbUser?.id) return false;
  UserServiceCredentialQueries.remove(dbUser.id, serviceKey);
  return true;
}

function decodeCookieValue(rawValue) {
  const value = String(rawValue || "");
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function getSetCookieName(cookieStr) {
  return String(cookieStr || "").split("=")[0].trim();
}

function findRommSessionCookie(setCookies = []) {
  const exactCandidates = ["session_id", "romm_session", "session", "connect.sid"];
  for (const name of exactCandidates) {
    const match = setCookies.find((cookie) => cookie.startsWith(`${name}=`));
    if (match) return { name, raw: match };
  }

  const heuristic = setCookies.find((cookie) => {
    const name = getSetCookieName(cookie).toLowerCase();
    return name.includes("session") && !name.includes("csrf") && !name.includes("xsrf");
  });
  if (heuristic) return { name: getSetCookieName(heuristic), raw: heuristic };
  return null;
}

function findRommCsrfCookie(setCookies = []) {
  const exactCandidates = ["csrftoken", "csrf_token", "xsrf-token", "XSRF-TOKEN"];
  for (const name of exactCandidates) {
    const match = setCookies.find((cookie) => cookie.startsWith(`${name}=`));
    if (match) return { name, raw: match };
  }

  const heuristic = setCookies.find((cookie) => {
    const name = getSetCookieName(cookie).toLowerCase();
    return name.includes("csrf") || name.includes("xsrf");
  });
  if (heuristic) return { name: getSetCookieName(heuristic), raw: heuristic };
  return null;
}

async function authenticateJellyfin(username, password) {
  const jellyfinUrl = getConfigValue("JELLYFIN_URL", "").replace(/\/$/, "");
  if (!jellyfinUrl || !username || !password) return null;
  try {
    const deviceId = `portall-${crypto.randomUUID()}`;
    const authResp = await fetch(`${jellyfinUrl}/Users/AuthenticateByName`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Emby-Authorization": `MediaBrowser Client="PlexPortal", Device="Web", DeviceId="${deviceId}", Version="1.0.0"`
      },
      body: JSON.stringify({ Username: username, Pw: password })
    });
    if (!authResp.ok) return null;
    const payload = await authResp.json();
    const accessToken = String(payload?.AccessToken || "").trim();
    const userId = String(payload?.User?.Id || "").trim();
    if (!accessToken) return null;
    return { accessToken, userId, deviceId };
  } catch (_) {
    return null;
  }
}

async function loginRommAndGetSessionCookies(username, password) {
  const rommUrl = getConfigValue("ROMM_URL", "").replace(/\/$/, "");
  if (!rommUrl || !username || !password) return null;

  let preflightCookieHeader = "";
  let preflightCsrfToken = "";
  let preflightCsrfCookieName = "";
  let loginPostUrl = `${rommUrl}/login`;
  let hiddenFields = {};

  try {
    const preflightResp = await fetch(`${rommUrl}/login`, {
      method: "GET",
      redirect: "manual",
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    const preflightCookies = preflightResp.headers.raw()["set-cookie"] || [];
    const preflightHtml = await preflightResp.text().catch(() => "");
    const formActionMatch = preflightHtml.match(/<form[^>]*action=["']([^"']+)["']/i);
    if (formActionMatch?.[1]) {
      loginPostUrl = new URL(formActionMatch[1], `${rommUrl}/login`).toString();
    }
    const hiddenFieldMatches = [...preflightHtml.matchAll(/<input[^>]*type=["']hidden["'][^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi)];
    hiddenFields = Object.fromEntries(hiddenFieldMatches.map((m) => [m[1], m[2]]));

    logRomm.info(`GET /login -> ${preflightResp.status} | cookies: ${preflightCookies.map(c => c.split("=")[0]).join(", ") || "none"}`);
    const csrfCookieInfo = findRommCsrfCookie(preflightCookies);
    const sessionCookieInfo = findRommSessionCookie(preflightCookies);
    const csrfCookie = csrfCookieInfo?.raw || "";
    const sessionCookie = sessionCookieInfo?.raw || "";
    preflightCsrfCookieName = csrfCookieInfo?.name || "";

    const cookiePairs = [csrfCookie, sessionCookie]
      .filter(Boolean)
      .map(c => c.split(";")[0]);

    if (cookiePairs.length) {
      preflightCookieHeader = cookiePairs.join("; ");
    }
    if (csrfCookie) {
      preflightCsrfToken = decodeCookieValue(csrfCookie.split(";")[0].replace(`${preflightCsrfCookieName}=`, ""));
    }
  } catch (_) {}

  const formBody = new URLSearchParams();
  for (const [name, value] of Object.entries(hiddenFields)) {
    formBody.set(name, value);
  }
  formBody.set("username", username);
  formBody.set("password", password);
  if (preflightCsrfToken) formBody.set("csrfmiddlewaretoken", preflightCsrfToken);
  formBody.set("next", "/");

  const attempts = [
    {
      url: `${rommUrl}/api/login`,
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "Authorization": `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        ...(preflightCookieHeader ? { "Cookie": preflightCookieHeader } : {}),
        ...(preflightCsrfToken ? {
          "X-CSRFToken": preflightCsrfToken,
          "X-CSRF-Token": preflightCsrfToken,
          "X-CSRF-TOKEN": preflightCsrfToken
        } : {}),
        "Referer": `${rommUrl}/login`,
        "Origin": rommUrl
      },
      body: "{}"
    },
    {
      url: loginPostUrl,
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, text/html, */*",
        ...(preflightCookieHeader ? { "Cookie": preflightCookieHeader } : {}),
        ...(preflightCsrfToken ? { "X-CSRFToken": preflightCsrfToken, "X-CSRF-Token": preflightCsrfToken } : {}),
        "Referer": `${rommUrl}/login`,
        "Origin": rommUrl
      },
      body: JSON.stringify({
        username,
        password,
        ...(preflightCsrfToken ? { csrfmiddlewaretoken: preflightCsrfToken } : {})
      })
    },
    {
      url: loginPostUrl,
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json, text/plain, text/html, */*",
        ...(preflightCookieHeader ? { "Cookie": preflightCookieHeader } : {}),
        ...(preflightCsrfToken ? { "X-CSRFToken": preflightCsrfToken, "X-CSRF-Token": preflightCsrfToken } : {}),
        "Referer": `${rommUrl}/login`,
        "Origin": rommUrl
      },
      body: formBody.toString()
    }
  ];

  for (const options of attempts) {
    try {
      const requestUrl = options.url || loginPostUrl;
      const fetchOptions = { ...options };
      delete fetchOptions.url;
      const resp = await fetch(requestUrl, fetchOptions);
      const setCookies = resp.headers.raw()["set-cookie"] || [];
      const location = resp.headers.get("location") || "";
      const contentType = resp.headers.get("content-type") || "unknown";
      logRomm.info(`POST ${requestUrl} -> ${resp.status}${location ? ` -> ${location}` : ""} | cookies: ${setCookies.map(c => c.split("=")[0]).join(", ") || "none"} | content-type: ${contentType}`);
      const sessionCookieInfo = findRommSessionCookie(setCookies);
      const csrfCookieInfo = findRommCsrfCookie(setCookies);
      const sessionCookie = sessionCookieInfo?.raw || null;
      if (!sessionCookie) {
        const bodyPreview = await resp.text().catch(() => "");
        if (bodyPreview) {
          logRomm.warn(`RomM login sans cookie session | content-type: ${contentType}`);
        } else {
          logRomm.warn(`RomM login sans cookie session | body vide | content-type: ${contentType}`);
        }
        continue;
      }

      logRomm.info(`Session RomM detectee via /login (${sessionCookieInfo?.name || "unknown"})`);
      return {
        sessionCookie,
        sessionCookieName: sessionCookieInfo?.name || getSetCookieName(sessionCookie),
        csrfCookie: csrfCookieInfo?.raw || null,
        csrfCookieName: csrfCookieInfo?.name || (csrfCookieInfo?.raw ? getSetCookieName(csrfCookieInfo.raw) : null)
      };
    } catch (err) {
      logRomm.warn(`Erreur RomM sur ${loginPostUrl}: ${err.message}`);
    }
  }
  logRomm.warn("Aucun cookie de session RomM retourne par /login");
  return null;
}

async function loginKomgaAndGetSessionCookies(username, password) {
  const komgaUrl = getConfigValue("KOMGA_URL", "").replace(/\/$/, "");
  if (!komgaUrl || !username || !password) return null;

  const attempts = [
    {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
    },
    {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ username, password })
    }
  ];

  for (const options of attempts) {
    try {
      const resp = await fetch(`${komgaUrl}/login`, options);
      const setCookies = resp.headers.raw()["set-cookie"] || [];
      const sessionCookie = setCookies.find(c => c.startsWith("KOMGA-SESSION="));
      const rememberCookie = setCookies.find(c => c.startsWith("komga-remember-me="));
      if (sessionCookie) return { sessionCookie, rememberCookie };
    } catch (_) {}
  }

  return null;
}

async function fetchKomgaCurrentUser(komgaUrl, headers) {
  const endpoints = ["/api/v2/users/me", "/api/v1/users/me"];
  for (const endpoint of endpoints) {
    try {
      const resp = await fetch(`${komgaUrl}${endpoint}`, {
        method: "GET",
        headers
      });
      if (resp.status !== 404) return resp;
    } catch (_) {}
  }
  return null;
}

async function fetchKomgaBooksTotal(sessionUser) {
  const komgaUrl = getConfigValue("KOMGA_URL", "").replace(/\/$/, "");
  if (!komgaUrl) return null;
  const globalApiKey = String(getConfigValue("KOMGA_API_KEY", "") || "").trim();

  try {
    let resp = null;

    if (globalApiKey) {
      resp = await fetch(`${komgaUrl}/api/v1/books?page=0&size=1`, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "X-API-Key": globalApiKey
        },
        timeout: 12000
      });
    }

    if (!resp || !resp.ok) {
      const cred = getUserServiceCredential(sessionUser, "komga");
      if (!cred?.username || !cred?.password) return null;
      const basic = Buffer.from(`${cred.username}:${cred.password}`).toString("base64");
      resp = await fetch(`${komgaUrl}/api/v1/books?page=0&size=1`, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "Authorization": `Basic ${basic}`
        },
        timeout: 12000
      });
    }

    if (!resp.ok) return null;
    const json = await resp.json();
    const total = Number(json?.totalElements);
    return Number.isFinite(total) && total >= 0 ? total : null;
  } catch (_) {
    return null;
  }
}

async function grabKomgaCookieForUser(res, sessionUser) {
  const komgaUrl = getConfigValue("KOMGA_URL", "").replace(/\/$/, "");
  const komgaPublicUrl = getConfigValue("KOMGA_PUBLIC_URL", "").trim();
  if (!komgaUrl || !komgaPublicUrl) return { ok: false, needsSetup: false, error: "Komga non configuré côté serveur" };

  const cred = getUserServiceCredential(sessionUser, "komga");
  if (!cred?.username || !cred?.password) return { ok: false, needsSetup: true };

  try {
    const basic = Buffer.from(`${cred.username}:${cred.password}`).toString("base64");
    const authHeaders = {
      "Accept": "application/json",
      "Authorization": `Basic ${basic}`
    };

    const parentDomain = getCookieParentDomain(komgaPublicUrl);
    const applyCookie = (cookieStr, cookieName) => {
      const value = decodeCookieValue(cookieStr.split(";")[0].replace(`${cookieName}=`, ""));
      const opts = { path: "/", httpOnly: true, sameSite: "none", secure: true, encode: v => v };
      if (parentDomain) opts.domain = parentDomain;
      res.cookie(cookieName, value, opts);
    };

    const xAuthSeed = crypto.randomUUID();
    const meResp = await fetchKomgaCurrentUser(komgaUrl, {
      ...authHeaders,
      "X-Auth-Token": xAuthSeed
    });
    if (!meResp?.ok) {
      const fallbackCookies = await loginKomgaAndGetSessionCookies(cred.username, cred.password);
      if (!fallbackCookies?.sessionCookie) {
        clearUserServiceCredential(sessionUser, "komga");
        return { ok: false, needsSetup: true };
      }
      applyCookie(fallbackCookies.sessionCookie, "KOMGA-SESSION");
      if (fallbackCookies.rememberCookie) applyCookie(fallbackCookies.rememberCookie, "komga-remember-me");
      return { ok: true };
    }

    const meCookies = meResp.headers.raw()["set-cookie"] || [];
    const meSessionCookie = meCookies.find(c => c.startsWith("KOMGA-SESSION="));
    const meRememberCookie = meCookies.find(c => c.startsWith("komga-remember-me="));
    if (meSessionCookie) {
      applyCookie(meSessionCookie, "KOMGA-SESSION");
      if (meRememberCookie) applyCookie(meRememberCookie, "komga-remember-me");
      return { ok: true };
    }

    const xAuthToken = meResp.headers.get("x-auth-token") || xAuthSeed;
    const setCookieResp = await fetch(`${komgaUrl}/api/v1/login/set-cookie`, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "X-Auth-Token": xAuthToken
      }
    });
    if (!setCookieResp.ok) return { ok: false, needsSetup: true };

    const forcedCookies = setCookieResp.headers.raw()["set-cookie"] || [];
    const forcedSession = forcedCookies.find(c => c.startsWith("KOMGA-SESSION="));
    const forcedRemember = forcedCookies.find(c => c.startsWith("komga-remember-me="));
    if (!forcedSession) return { ok: false, needsSetup: true };

    applyCookie(forcedSession, "KOMGA-SESSION");
    if (forcedRemember) applyCookie(forcedRemember, "komga-remember-me");
    return { ok: true };
  } catch (_) {
    const fallbackCookies = await loginKomgaAndGetSessionCookies(cred.username, cred.password);
    if (fallbackCookies?.sessionCookie) {
      const parentDomain = getCookieParentDomain(komgaPublicUrl);
      const applyCookie = (cookieStr, cookieName) => {
        const value = decodeCookieValue(cookieStr.split(";")[0].replace(`${cookieName}=`, ""));
        const opts = { path: "/", httpOnly: true, sameSite: "none", secure: true, encode: v => v };
        if (parentDomain) opts.domain = parentDomain;
        res.cookie(cookieName, value, opts);
      };
      applyCookie(fallbackCookies.sessionCookie, "KOMGA-SESSION");
      if (fallbackCookies.rememberCookie) applyCookie(fallbackCookies.rememberCookie, "komga-remember-me");
      return { ok: true };
    }
    return { ok: false, needsSetup: true };
  }
}

async function refreshJellyfinSessionAuth(session, sessionUser) {
  const cred = getUserServiceCredential(sessionUser, "jellyfin");
  if (!cred?.username || !cred?.password) return { ok: false, needsSetup: true };
  const auth = await authenticateJellyfin(cred.username, cred.password);
  if (!auth?.accessToken) {
    clearUserServiceCredential(sessionUser, "jellyfin");
    return { ok: false, needsSetup: true };
  }
  session.jellyfinAuth = {
    accessToken: auth.accessToken,
    userId: auth.userId,
    deviceId: auth.deviceId,
    refreshedAt: Date.now()
  };
  return { ok: true, needsSetup: false };
}

async function grabRommCookieForUser(res, sessionUser) {
  const rommUrl = getConfigValue("ROMM_URL", "").replace(/\/$/, "");
  const rommPublicUrl = getConfigValue("ROMM_PUBLIC_URL", "").trim();
  if (!rommUrl || !rommPublicUrl) {
    return { ok: false, needsSetup: false, error: "RomM non configuré côté serveur" };
  }

  const cred = getUserServiceCredential(sessionUser, "romm");
  if (!cred?.username || !cred?.password) return { ok: false, needsSetup: true };

  const cookies = await loginRommAndGetSessionCookies(cred.username, cred.password);
  if (!cookies?.sessionCookie) {
    logRomm.warn(`Echec auto-auth pour ${sessionUser?.username || "unknown"} via ${rommUrl}`);
    return { ok: false, needsSetup: false, error: "Connexion automatique RomM impossible avec les identifiants enregistrés" };
  }

  const parentDomain = getCookieParentDomain(rommPublicUrl);
  const opts = { path: "/", httpOnly: true, sameSite: "none", secure: true, encode: v => v };
  if (parentDomain) opts.domain = parentDomain;

  const sessionCookieName = String(cookies.sessionCookieName || getSetCookieName(cookies.sessionCookie) || "session_id");
  const sessionValue = decodeCookieValue(cookies.sessionCookie.split(";")[0].replace(`${sessionCookieName}=`, ""));
  res.cookie(sessionCookieName, sessionValue, opts);

  if (cookies.csrfCookie) {
    const csrfCookieName = String(cookies.csrfCookieName || getSetCookieName(cookies.csrfCookie) || "csrftoken");
    const csrfValue = decodeCookieValue(cookies.csrfCookie.split(";")[0].replace(`${csrfCookieName}=`, ""));
    res.cookie(csrfCookieName, csrfValue, {
      path: "/",
      httpOnly: false,
      sameSite: "none",
      secure: true,
      encode: v => v,
      ...(parentDomain ? { domain: parentDomain } : {})
    });
  }

  return { ok: true };
}

function renderServiceConnectGate(res, req, card, serviceKey, cardTitle, errorMessage = "") {
  const serviceName =
    serviceKey === "komga" ? "Komga" :
    serviceKey === "jellyfin" ? "Jellyfin" :
    "RomM";
  const returnPath = `${req.basePath || ""}/${getCardSlug(card || {})}`;
  return res.render("apps/service-connect", {
    layout: false,
    basePath: req.basePath || "",
    locale: res.locals.locale || "fr",
    serviceKey,
    serviceName,
    cardTitle: cardTitle || serviceName,
    returnPath,
    errorMessage: errorMessage || ""
  });
}

function findCardBySlug(slug) {
  const normalized = slugifyCardTitle(slug || "");
  return DashboardCardQueries.list().find(c => getCardSlug(c) === normalized) || null;
}

async function openCardByModel(req, res, card) {
  const integrationKey = String(card.integrationKey || "custom");
  let srcUrl = resolveIntegrationSrc(card, req.basePath || "");
  if (!srcUrl) {
    return res.redirect(req.basePath + "/dashboard");
  }

  if (integrationKey === "komga_auto") {
    try {
      const result = await grabKomgaCookieForUser(res, req.session.user);
      if (!result.ok && result.needsSetup) {
        return renderServiceConnectGate(res, req, card, "komga", card.title, "Connecte ton compte Komga pour continuer");
      }
      if (!result.ok && result.error) {
        return res.status(503).send(result.error);
      }
    } catch (_) {
      return renderServiceConnectGate(res, req, card, "komga", card.title, "Connexion Komga requise");
    }
  }

  if (integrationKey === "jellyfin_auto" || integrationKey === "jellyfin_iframe") {
    try {
      const result = await refreshJellyfinSessionAuth(req.session, req.session.user);
      if (!result.ok && result.needsSetup) {
        return renderServiceConnectGate(res, req, card, "jellyfin", card.title, "Connecte ton compte Jellyfin pour continuer");
      }
      srcUrl = buildJellyfinProxyUrl(srcUrl, req.basePath || "");
    } catch (_) {
      return renderServiceConnectGate(res, req, card, "jellyfin", card.title, "Connexion Jellyfin requise");
    }
  }

  if (integrationKey === "romm_auto") {
    try {
      const result = await grabRommCookieForUser(res, req.session.user);
      if (!result.ok && result.needsSetup) {
        return renderServiceConnectGate(res, req, card, "romm", card.title, "Connecte ton compte RomM pour continuer");
      }
      if (!result.ok && result.error) {
        return renderServiceConnectGate(res, req, card, "romm", card.title, result.error);
      }
      return res.redirect(srcUrl);
    } catch (_) {
      return renderServiceConnectGate(res, req, card, "romm", card.title, "Connexion RomM requise");
    }
  }

  return res.render("apps/iframe", {
    basePath: req.basePath || "",
    contentClass: "content--iframe",
    title: card.title || "Application",
    srcUrl
  });
}

function buildJellyfinAuthorizationHeader(jellyfinAuth) {
  const token = String(jellyfinAuth?.accessToken || "").trim();
  const deviceId = String(jellyfinAuth?.deviceId || "portall-proxy").trim();
  if (!token) return "";
  return `MediaBrowser Token="${token}", Client="PlexPortal", Device="Web", DeviceId="${deviceId}", Version="1.0.0"`;
}

router.use("/jellyfin-proxy", requireAuth, async (req, res, next) => {
  const jellyfinUrl = getConfigValue("JELLYFIN_URL", "").replace(/\/$/, "");
  if (!jellyfinUrl) {
    return res.status(503).send("Jellyfin non configure cote serveur");
  }

  const existingAuth = req.session?.jellyfinAuth;
  if (!existingAuth?.accessToken) {
    const result = await refreshJellyfinSessionAuth(req.session, req.session.user);
    if (!result.ok) {
      return res.status(401).send("Connexion Jellyfin requise");
    }
  }

  return createProxyMiddleware({
    target: jellyfinUrl,
    changeOrigin: true,
    ws: true,
    pathRewrite: { "^/jellyfin-proxy": "" },
    cookieDomainRewrite: { "*": "" },
    onProxyReq(proxyReq, proxyReqReq) {
      const jellyfinAuth = proxyReqReq.session?.jellyfinAuth;
      const token = String(jellyfinAuth?.accessToken || "").trim();
      const userId = String(jellyfinAuth?.userId || "").trim();
      const authHeader = buildJellyfinAuthorizationHeader(jellyfinAuth);
      if (token) {
        proxyReq.setHeader("X-Emby-Token", token);
        proxyReq.setHeader("X-MediaBrowser-Token", token);
      }
      if (userId) {
        proxyReq.setHeader("X-MediaBrowser-UserId", userId);
      }
      if (authHeader) {
        proxyReq.setHeader("Authorization", authHeader);
        proxyReq.setHeader("X-Emby-Authorization", authHeader);
      }
    }
  })(req, res, next);
});

/* ===============================
   ?? CACHE MANAGER
=============================== */

// Instance centralisée de cache (60 secondes par défaut)
const cache = new CacheManager(60 * 1000);

/* ===============================
   ?? WIZARR
=============================== */

const logWizarr = log.create('[Wizarr]');

async function getWizarrSubscription(user) {
  try {
    const wizarrUrl = getConfigValue("WIZARR_URL", "");
    const apiKey = getConfigValue("WIZARR_API_KEY", "");

    if (!wizarrUrl || !apiKey) {
      logWizarr.info('Wizarr désactivé — configuration vide');
      return computeSubscription(null);
    }

    const wizarrResult = await getAllWizarrUsersDetailed(wizarrUrl, apiKey);
    const list = wizarrResult.users || [];
    if (!list.length) {
      logWizarr.warn(`Aucun user Wizarr retourne pour abonnement — ${wizarrResult.reason || "raison inconnue"}`);
    }

    const norm = s => (s || "").toLowerCase().trim();
    const plexEmail = norm(user.email);

    if (!plexEmail) {
      logWizarr.warn('Email Plex manquant — abonnement ignoré');
      return computeSubscription(null);
    }

    const wizUser = list.find(u => norm(u.email) === plexEmail) || null;

    const result = computeSubscription(wizUser);
    logWizarr.info(`Abonnement Wizarr calcule (${result.label})`);
    return result;

  } catch (err) {
    logWizarr.error('Erreur:', err.message);
    return computeSubscription(null);
  }
}

/* ===============================
   ?? PAGES
=============================== */

router.get("/dashboard", requireAuth, async (req, res) => {
  const colorMap = getColorMap();
  const dashboardBuiltinItems = getDashboardBuiltinAdminItems(res.locals.t);
  const dashboardSectionItems = getDashboardSectionConfig();
  const dashboardCustomCards = DashboardCardQueries.list()
    .map(card => {
      const color = colorMap.get(card.colorKey);
      if (!color) return null;
      const bgStartTint = parseRgbaToTintVars(color.bgStart, "255 255 255", 1.8);
      const bgEndTint = parseRgbaToTintVars(color.bgEnd, "255 255 255", 0.9);
      return {
        ...card,
        color: {
          ...color,
          bgStartRgb: bgStartTint.rgb,
          bgStartStrength: bgStartTint.strength,
          bgEndRgb: bgEndTint.rgb,
          bgEndStrength: bgEndTint.strength
        },
        openInIframe: !!card.openInIframe,
        openInNewTab: !!card.openInNewTab,
        integrationKey: card.integrationKey || "custom",
        href: toCardHref(card, req.basePath || ""),
        external: String(card.integrationKey || "custom") === "romm_auto" || !!card.openInNewTab
      };
    })
    .filter(Boolean);

  let uptimeStatus = null;
  const uptimeProvider = normalizeProvider(getConfigValue("UPTIME_PROVIDER", "kuma"));
  const uptimeKumaUrl = String(getConfigValue("UPTIME_KUMA_URL", "") || "").trim();
  const uptimeKumaUsername = String(getConfigValue("UPTIME_KUMA_USERNAME", "") || "").trim();
  const uptimeKumaPassword = String(getConfigValue("UPTIME_KUMA_PASSWORD", "") || "").trim();
  const uptimeRobotApiKey = String(getConfigValue("UPTIME_ROBOT_API_KEY", "") || "").trim();
  const hasUptimeConfig = uptimeProvider === "robot"
    ? !!uptimeRobotApiKey
    : !!(uptimeKumaUrl && uptimeKumaUsername && uptimeKumaPassword);
  if (hasUptimeConfig) {
    try {
      uptimeStatus = await getConfiguredStatusSummary({
        provider: uptimeProvider,
        kumaUrl: uptimeKumaUrl,
        kumaUsername: uptimeKumaUsername,
        kumaPassword: uptimeKumaPassword,
        robotApiKey: uptimeRobotApiKey
      });
    } catch (_) {
      uptimeStatus = null;
    }
  }

  const dashboardCustomHtmlBlocks = getDashboardCustomHtmlBlocks();
  const dashboardLayoutItems = buildDashboardLayoutItems({
    builtinItems: dashboardBuiltinItems,
    sectionItems: dashboardSectionItems,
    customCards: dashboardCustomCards,
    htmlBlocks: dashboardCustomHtmlBlocks,
    t: res.locals.t
  });
  const layoutEnabledMap = new Map(dashboardLayoutItems.map(item => [item.id, item.enabled !== false]));
  const dashboardServerStatsEnabled = !!layoutEnabledMap.get("section:server-stats");
  const normalizeLeaderboardUsername = (value) => String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const usernameNormalized = normalizeLeaderboardUsername(req.session.user?.username || "");

  let classementPosition = null;
  try {
    const { getClassementCache, refreshClassementCache } = require("../utils/cron-classement-refresh");
    const resolveClassementPosition = () => {
      const cacheData = getClassementCache();
      const byLevel = Array.isArray(cacheData?.data?.byLevel) ? cacheData.data.byLevel : [];
      const rankIndex = byLevel.findIndex(entry => normalizeLeaderboardUsername(entry?.username || "") === usernameNormalized);
      return rankIndex >= 0 ? rankIndex + 1 : null;
    };

	    classementPosition = resolveClassementPosition();
	    if (classementPosition === null) {
	      await refreshClassementCache({ includeSecretEvaluation: false });
	      classementPosition = resolveClassementPosition();
	    }
  } catch (_) {
    classementPosition = null;
  }

  let totalSessionCount = null;
  try {
    const userStats = await getTautulliStats(
      String(req.session.user?.username || ""),
      getConfigValue("TAUTULLI_URL", ""),
      getConfigValue("TAUTULLI_API_KEY", ""),
      req.session.user?.id,
      getConfigValue("PLEX_URL", ""),
      getConfigValue("PLEX_TOKEN", ""),
      req.session.user?.joinedAtTimestamp
    );
    const parsedCount = Number(userStats?.sessionCount || 0);
    totalSessionCount = Number.isFinite(parsedCount) ? parsedCount : null;
  } catch (_) {
    totalSessionCount = null;
  }

  const calendarNow = new Date();
  const calendarDay = String(calendarNow.getDate());
  const calendarMonth = calendarNow.toLocaleDateString(res.locals.locale || "fr-FR", { month: "short" }).replace(".", "");

  const dashboardBuiltinCards = buildDashboardBuiltinCards(req.session.user, req.basePath || "", res.locals.t)
    .filter(card => layoutEnabledMap.get(`builtin:${card.key}`) !== false)
    .map(card => {
      if (card.key === "classement" && Number.isInteger(classementPosition) && classementPosition > 0) {
        return {
          ...card,
          visual: {
            type: "rank",
            value: classementPosition
          }
        };
      }

      if (card.key === "calendrier") {
        return {
          ...card,
          visual: {
            type: "date",
            day: calendarDay,
            month: String(calendarMonth || "").toUpperCase()
          }
        };
      }

      if (card.key === "mes-stats" && Number.isFinite(totalSessionCount) && totalSessionCount > 0) {
        const countText = String(Math.max(0, Math.trunc(totalSessionCount)));
        return {
          ...card,
          visual: {
            type: "count",
            value: countText,
            size: countText.length >= 6 ? "sm" : (countText.length >= 5 ? "md" : "lg")
          }
        };
      }

      return card;
    });

  res.render("dashboard/index", {
    user: req.session.user,
    basePath: req.basePath,
    dashboardBuiltinCards,
    dashboardCustomCards,
    dashboardCustomHtmlBlocks,
    dashboardCustomHtml: getDashboardCustomHtml(),
    dashboardCustomHtmlMode: getDashboardCustomHtmlMode(),
    dashboardServerStatsEnabled,
    dashboardSectionItems,
    dashboardLayoutItems,
    uptimeStatus
  });
});

router.get("/profil", requireAuth, async (req, res) => {
  try {
    // Rendu rapide : l'entête lit le snapshot progression persistant partagé avec le classement.
    const achievementState = await getUserAchievementState(req.session.user, { skipRefresh: true });
    const userUnlockedMap = achievementState.userUnlockedMap || {};
    const allAchievements = ACHIEVEMENTS.getAll();
    const unlockedAchievementIds = new Set(Object.keys(userUnlockedMap || {}));
    const unlockedAchievements = allAchievements.filter(a => unlockedAchievementIds.has(a.id));
    const totalAchievementsXp = Number(achievementState.snapshot?.totalXp || 0)
      - Math.round(Number(achievementState.snapshot?.totalHours || 0) * 10)
      - Math.round(Number(achievementState.snapshot?.daysJoined || 0) * 1.5);

    res.render("profil/index", {
      user: req.session.user,
      basePath: req.basePath,
      XP_SYSTEM,
      unlockedBadgesCount: Number(achievementState.snapshot?.badgeCount || unlockedAchievements.length),
      totalBadgesCount: allAchievements.length,
      totalAchievementsXp: Math.max(0, totalAchievementsXp)
    });
  } catch (err) {
    log.create('[Profil]').error(err.message);
    res.render("profil/index", {
      user: req.session.user,
      basePath: req.basePath,
      XP_SYSTEM,
      unlockedBadgesCount: 0,
      totalBadgesCount: 0,
      totalAchievementsXp: 0
    });
  }
});

// Route /abonnement supprimée — infos intégrées dans /profil

router.get("/classement", requireAuth, (req, res) => {
  const leaderboardBlurEnabled = AppSettingQueries.getBool("leaderboard_blur_enabled", true);
  res.render("classement/index", {
    user: req.session.user,
    basePath: req.basePath,
    leaderboardBlurEnabled
  });
});

router.get("/statistiques", requireAuth, (req, res) => {
  res.render("statistiques/index", { user: req.session.user, basePath: req.basePath });
});

router.get("/mes-stats", requireAuth, (req, res) => {
  res.render("statistiques/mes-stats", { user: req.session.user, basePath: req.basePath });
});

router.get("/succes", requireAuth, async (req, res) => {
  try {
    const collectionsEnabled = areCollectionAchievementsEnabled();
    let achievementState = await getUserAchievementState(req.session.user, { skipRefresh: true });
    const hasCollectionProgress = collectionsEnabled && ACHIEVEMENTS.collections.some((achievement) => {
      const progressEntry = achievementState.renderProgressMap?.[achievement.id];
      return Number(progressEntry?.total || 0) > 0;
    });

    if (collectionsEnabled && achievementState.needsRefresh && !hasCollectionProgress) {
      await refreshUserAchievementState(req.session.user, { includeSecretEvaluation: true });
      achievementState = await getUserAchievementState(req.session.user, { skipRefresh: true });
    }

    let backgroundRefreshStatus = getBackgroundAchievementRefreshStatus(req.session.user);
    if ((achievementState.needsRefresh || !achievementState.snapshot?.updatedAt) && !backgroundRefreshStatus.running && !backgroundRefreshStatus.queued) {
      queueBackgroundAchievementRefresh(req.session.user, { includeSecretEvaluation: true });
      backgroundRefreshStatus = getBackgroundAchievementRefreshStatus(req.session.user);
    }
    const { data, userUnlockedMap, renderProgressMap } = achievementState;

    const achievementsByCategory = {
      temporels:   { icon: "🎁", name: "Temporels",   achievements: ACHIEVEMENTS.temporels },
      activites:   { icon: "🔥", name: "Activité",    achievements: ACHIEVEMENTS.activites },
      films:       { icon: "🎬", name: "Films",       achievements: ACHIEVEMENTS.films },
      series:      { icon: "📺", name: "Séries",      achievements: ACHIEVEMENTS.series },
      mensuels:    { icon: "📅", name: "Mensuels",    achievements: ACHIEVEMENTS.mensuels },
      collections: { icon: "🎬", name: "Collections", achievements: collectionsEnabled ? ACHIEVEMENTS.collections : [] },
      secrets:     { icon: "🔒", name: "Secrets",     achievements: ACHIEVEMENTS.secrets }
    };
    if (!collectionsEnabled) delete achievementsByCategory.collections;

    for (const category in achievementsByCategory) {
      achievementsByCategory[category].achievements = achievementsByCategory[category].achievements.map(a => ({
        ...hydrateAchievementTexts(a, res.locals.siteTitle),
        xp: getAchievementXp(a, renderProgressMap[a.id]),
        unlocked:     !!userUnlockedMap[a.id],
        unlockedDate: userUnlockedMap[a.id] || null
      }));
    }

    const stats_global = ACHIEVEMENTS.getStats(data, userUnlockedMap);

    res.render("succes", {
      user: req.session.user,
      basePath: req.basePath,
      XP_SYSTEM,
      ACHIEVEMENTS: achievementsByCategory,
      stats: stats_global,
      progressMap: renderProgressMap,
      successRefreshMeta: {
        updatedAt: achievementState.snapshot?.updatedAt || null,
        ttlMs: SUCCESS_REFRESH_TTL_MS,
        refreshed: !!achievementState.refreshed,
        needsRefresh: !!achievementState.needsRefresh,
        running: !!backgroundRefreshStatus.running || !!backgroundRefreshStatus.queued
      },
      layout: req.query.embed === '1' ? false : 'layout',
      embed: req.query.embed === '1'
    });
  } catch (err) {
    log.create('[Badges]').error(err.message);
    res.render("succes", {
      user: req.session.user,
      basePath: req.basePath,
      XP_SYSTEM,
      ACHIEVEMENTS: {},
      stats: { total: 0, unlocked: 0, locked: 0, progress: 0 },
      progressMap: {},
      successRefreshMeta: {
        updatedAt: null,
        ttlMs: SUCCESS_REFRESH_TTL_MS,
        refreshed: false,
        running: false
      },
      error: "Erreur lors du chargement des achievements",
      layout: req.query.embed === '1' ? false : 'layout',
      embed: req.query.embed === '1'
    });
  }
});

/* ===============================
   ?? CALENDRIER
=============================== */

router.get("/calendrier", requireAuth, (req, res) => {
  res.render("calendrier/index", { user: req.session.user, basePath: req.basePath });
});

router.get("/parametres", requireAuth, requireAdmin, (req, res) => {
  const leaderboardBlurEnabled = AppSettingQueries.getBool("leaderboard_blur_enabled", true);
  const navSubscriptionPillEnabled = AppSettingQueries.getBool("nav_subscription_pill_enabled", true);
  const dashboardBuiltinItems = getDashboardBuiltinAdminItems(res.locals.t);
  const dashboardSectionItems = getDashboardSectionAdminItems(res.locals.t);
  const siteBackground = getSiteBackgroundSettings();
  const customCards = DashboardCardQueries.list();
  const availableColorKeys = getAvailableColorKeys(customCards);
  const availableColors = DASHBOARD_CARD_PALETTE.filter(c => availableColorKeys.includes(c.key));
  const colorMap = getColorMap();
  const integrationAvailability = getIntegrationAvailability();
  const integrations = DASHBOARD_INTEGRATIONS.map(i => ({
    ...i,
    available:
      i.key === "komga_auto" ? integrationAvailability.komgaConfigured :
      i.key === "jellyfin_auto" ? integrationAvailability.jellyfinAutoConfigured :
      i.key === "romm_auto" ? integrationAvailability.rommAutoConfigured :
      true
  }));
  const customCardsResolved = customCards.map(card => ({
    ...card,
    openInIframe: !!card.openInIframe,
    openInNewTab: !!card.openInNewTab,
    integrationKey: card.integrationKey || "custom",
    colorName: colorMap.get(card.colorKey)?.name || card.colorKey
  }));
  const dashboardHtmlBlocksRaw = getDashboardCustomHtmlBlocksRaw();
  const dashboardLayoutItems = buildDashboardLayoutItems({
    builtinItems: dashboardBuiltinItems,
    sectionItems: dashboardSectionItems,
    customCards: customCardsResolved,
    htmlBlocks: dashboardHtmlBlocksRaw,
    t: res.locals.t
  });

  res.render("parametres/index", {
    user: req.session.user,
    basePath: req.basePath,
    leaderboardBlurEnabled,
    navSubscriptionPillEnabled,
    siteBackground,
    backgroundPresets: BACKGROUND_PRESETS,
    supportedLocales: SUPPORTED_LOCALES,
    siteLanguage: getSiteLanguage(),
    dashboardBuiltinItems,
    dashboardSectionItems,
    dashboardLayoutItems,
    dashboardCustomHtmlRaw: getDashboardCustomHtmlRaw(),
    dashboardCustomHtmlBlocks: dashboardHtmlBlocksRaw,
    dashboardCustomHtmlPreview: getDashboardCustomHtml(),
    dashboardCustomHtmlPreviewBlocks: getDashboardCustomHtmlBlocks(),
    dashboardCustomHtmlMode: getDashboardCustomHtmlMode(),
    dashboardCustomHtmlRawMode: isDashboardCustomHtmlRawMode(),
    configSections: getConfigSections({ includeSecretValues: false }),
    dashboardCustomCards: customCardsResolved,
    availableDashboardColors: availableColors,
    dashboardIntegrationOptions: integrations
  });
});

/* ===============================
   ?? API BADGES EVAL (arrière-plan)
   Appellé par le browser après rendu de /succes.
   Fait le vrai calcul Tautulli + retourne les mises à jour.
=============================== */
const logBadges = log.create('[Badges]');

router.get('/api/badges-eval', requireAuth, async (req, res) => {
  try {
    let state = await getUserAchievementState(req.session.user, { skipRefresh: true });
    let refreshStatus = getBackgroundAchievementRefreshStatus(req.session.user);
    if ((state.needsRefresh || !state.snapshot?.updatedAt) && !refreshStatus.running && !refreshStatus.queued) {
      queueBackgroundAchievementRefresh(req.session.user, { includeSecretEvaluation: true });
      refreshStatus = getBackgroundAchievementRefreshStatus(req.session.user);
    }

    if (refreshStatus.running || refreshStatus.queued || state.needsRefresh) {
      const waitStart = Date.now();
      const maxWaitMs = 12000;
      while ((Date.now() - waitStart) < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, 400));
        state = await getUserAchievementState(req.session.user, { skipRefresh: true });
        refreshStatus = getBackgroundAchievementRefreshStatus(req.session.user);
        if (!refreshStatus.running && !refreshStatus.queued && !state.needsRefresh) {
          break;
        }
      }
    }

    res.json({
      success: true,
      refreshed: !!state.refreshed,
      queued: !!refreshStatus.queued,
      running: !!refreshStatus.running || !!refreshStatus.queued,
      needsRefresh: !!state.needsRefresh,
      updatedAt: state.snapshot?.updatedAt || null,
      data: state.data,
      unlocked: state.userUnlockedMap,
      progress: state.renderProgressMap
    });
  } catch (err) {
    logBadges.error('badges-eval crash:', err.message);
    res.status(500).json({ success: false, unlocked: {}, progress: {}, data: {} });
  }
});

router.get('/api/badges-refresh-status', requireAuth, async (req, res) => {
  try {
    const state = await getUserAchievementState(req.session.user, { skipRefresh: true });
    const refreshStatus = getBackgroundAchievementRefreshStatus(req.session.user);
    res.json({
      success: true,
      queued: !!refreshStatus.queued,
      running: !!refreshStatus.running,
      needsRefresh: !!state.needsRefresh,
      updatedAt: state.snapshot?.updatedAt || null
    });
  } catch (err) {
    logBadges.error('badges-refresh-status crash:', err.message);
    res.status(500).json({ success: false, queued: false, running: false, needsRefresh: false, updatedAt: null });
  }
});

/* ===============================
   ?? API SUBSCRIPTION
=============================== */

router.get("/api/subscription", requireAuth, async (req, res) => {
  try {
    const cacheKey = `subscription:${req.session.user.id}`;
    
    const subscription = await cache.getOrSet(
      cacheKey,
      () => getWizarrSubscription(req.session.user),
      60 * 1000 // 60 secondes
    );

    res.json(subscription);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch subscription" });
  }
});

/* ===============================
   ?? API STATS
=============================== */

router.get("/api/stats", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const cacheKey = `stats:${userId}`;
    const statsWithTimeout = await cache.getOrSet(
      cacheKey,
      () => Promise.race([
        getTautulliStats(
          req.session.user.username,
          getConfigValue("TAUTULLI_URL", ""),
          getConfigValue("TAUTULLI_API_KEY", ""),
          req.session.user.id,
          getConfigValue("PLEX_URL", ""),
          getConfigValue("PLEX_TOKEN", ""),
          req.session.user.joinedAtTimestamp
        ),
        // Timeout après 10 secondes (au lieu de 30s)
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("TIMEOUT_10S")), 10000)
        )
      ]),
      30 * 1000 // cache court: 30 secondes
    );

    res.json(statsWithTimeout);
    
  } catch (err) {
    if (err.message === "TIMEOUT_10S") {
      log.create('[Stats]').warn('Timeout 10s — cron job mettra à jour en arrière-plan');
      // Retourner un objet par défaut pendant que le cron job travaille
      res.json({
        joinedAt: req.session.user.joinedAtTimestamp ? new Date(req.session.user.joinedAtTimestamp * 1000).toISOString() : null,
        lastActivity: null,
        sessionCount: 0,
        status: "computing",
        message: "Les données des sessions sont en cours de calcul... (rechargez dans quelques minutes)"
      });
    } else {
      log.create('[Stats]').error('Erreur:', err.message);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  }
});

/**
 * ?? ENDPOINT SMART WAIT - Long-polling: Attendre que les données soient prêtes
 * Au lieu de faire 30 polls avec 5 sec chacun, on attend l'événement du serveur
 * TIMEOUT: 5 minutes max (longue requête HTTP)
 */
router.get("/api/stats-wait", requireAuth, async (req, res) => {
  try {
    const username = req.session.user.username;
    log.create('[Stats]').info('Long-poll démarré pour:', username);
    
    // Attendre que le scan finisse (avec timeout de 5 min)
    const startWait = Date.now();
    await TautulliEvents.waitForScanComplete(300000);  // 5 min max
    const waitDuration = Math.round((Date.now() - startWait) / 1000);
    log.create('[Stats]').info(`Scan terminé après ${waitDuration}s — récupération des données`);
    
    // Maintenant récupérer les stats (doivent être en cache)
    const stats = await getTautulliStats(
      username,
      getConfigValue("TAUTULLI_URL", ""),
      getConfigValue("TAUTULLI_API_KEY", ""),
      req.session.user.id,
      getConfigValue("PLEX_URL", ""),
      getConfigValue("PLEX_TOKEN", ""),
      req.session.user.joinedAtTimestamp
    );
    
    if (!stats) {
      log.create('[Stats]').warn('Aucune donnée trouvée après attente pour:', username);
      return res.status(404).json({ error: "User stats not found" });
    }
    
    log.create('[Stats]').debug('Données retournées pour:', username);
    res.json(stats);
    
  } catch (err) {
    log.create('[Stats]').error('Long-poll erreur:', err.message);
    res.status(500).json({ error: "Failed to wait for stats", details: err.message });
  }
});

/* ===============================
   ? API XP-SNAPSHOT (prefetch glow)
   Retourne le rang/niveau calculé de l'user courant.
   Utilisé par layout.ejs pour alimenter le localStorage
   dès la connexion — sans attendre la page Profil.
=============================== */

router.get("/api/xp-snapshot", requireAuth, async (req, res) => {
  try {
    const state = await getUserAchievementState(req.session.user, {
      maxAgeMs: SUCCESS_REFRESH_TTL_MS
    });
    const snapshot = state.snapshot || {};
    const rank = snapshot.rank || XP_SYSTEM.getRankByLevel(snapshot.level || 1);

    res.json({
      rank: {
        color: rank.color,
        name: rank.name,
        icon: rank.icon,
        bgColor: rank.bgColor,
        borderColor: rank.borderColor
      },
      level: Number(snapshot.level || 1),
      totalXp: Number(snapshot.totalXp || 0),
      badgeCount: Number(snapshot.badgeCount || 0),
      progressPercent: Number(snapshot.progressPercent || 0),
      xpNeeded: Number(snapshot.xpNeeded || 0)
    });
  } catch (err) {
    log.create('[XP-SNAPSHOT]').error(`Erreur: ${err.message}`);
    res.status(500).json({ error: 'xp-snapshot failed' });
  }
});

/* ===============================
   ?? API SEERR
=============================== */

router.get("/api/seerr", requireAuth, async (req, res) => {
  try {
    const userEmail = req.session.user?.email;
    const username = req.session.user?.username;
    const plexUserId = req.session.user?.id;
    const connectSidMatch = String(req.headers.cookie || "").match(/(?:^|;\s*)connect\.sid=([^;]+)/);
    const sessionCookie = connectSidMatch ? `connect.sid=${connectSidMatch[1]}` : "";
    
    if (!userEmail) {
      return res.status(400).json({ error: "No user email in session" });
    }

    // Clé de cache utilisant l'ID Plex pour plus de certitude
    const cacheKey = `seerr:${plexUserId}:${sessionCookie ? "sid" : "nosid"}`;
    
    const seerr = await cache.getOrSet(
      cacheKey,
      () => getSeerrStats(
        userEmail,
        username,
        process.env.SEERR_URL,
        process.env.SEERR_API_KEY,
        { sessionCookie }
      ),
      60 * 1000 // 60 secondes
    );

    res.json(seerr || {});
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch seerr data" });
  }
});



/* ===============================
   ? CACHE INVALIDATION
=============================== */

router.post("/api/cache/invalidate", requireAuth, (req, res) => {
  try {
    const userId = req.session.user.id;
    
    // Invalide tous les caches de l'utilisateur
    cache.invalidate(`subscription:${userId}`);
    cache.invalidate(`stats:${userId}`);
    cache.invalidate(`seerr:${userId}`);
    
    res.json({ 
      message: "Cache invalidated", 
      stats: cache.stats() 
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to invalidate cache" });
  }
});

/* ===============================
   ?? API GET ALL USERS (pour cron job)
=============================== */

// Endpoint pour récupérer tous les utilisateurs (utilisé par cron job au démarrage)
router.get("/api/all-users", async (req, res) => {
  try {
    const baseUrl = process.env.SEERR_URL || "http://localhost:5055";
    const apiKey = process.env.SEERR_API_KEY;
    
    if (!apiKey) {
      return res.json([]);
    }

    const users = [];
    let page = 1;
    let pageSize = 50;
    let totalPages = 1;

    while (page <= totalPages) {
      const resp = await fetch(
        `${baseUrl}/api/v1/user?skip=${(page - 1) * pageSize}&take=${pageSize}`,
        {
          headers: {
            "X-API-Key": apiKey,
            "Accept": "application/json"
          }
        }
      );

      if (!resp.ok) break;

      const json = await resp.json();
      const pageInfo = json.pageInfo || {};
      totalPages = Math.ceil((pageInfo.results || 0) / pageSize);

      const pageUsers = Array.isArray(json.results)
        ? json.results
        : Array.isArray(json.data)
          ? json.data
          : [];

      if (pageUsers.length > 0) {
        users.push(...pageUsers.map(u => ({
          id: u.id,
          username: u.username || u.plexUsername,
          plexUserId: u.plexId,
          email: u.email,
          joinedAtTimestamp: u.createdAt ? Math.floor(new Date(u.createdAt).getTime() / 1000) : null
        })));
      }

      page++;
    }

    log.create('[API]').debug('all-users:', users.length, 'utilisateurs');
    res.json(users);
  } catch (err) {
    log.create('[API]').error('fetch users:', err.message);
    res.json([]);
  }
});

router.post("/api/integrations/:service/connect", requireAuth, async (req, res) => {
  const service = String(req.params.service || "").trim().toLowerCase();
  if (service !== "komga" && service !== "jellyfin" && service !== "romm") {
    return res.status(400).json({ error: "Service invalide" });
  }

  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!username || !password) {
    return res.status(400).json({ error: "Username et mot de passe requis" });
  }
  if (username.length > 120 || password.length > 300) {
    return res.status(400).json({ error: "Identifiants invalides" });
  }

  try {
    if (service === "komga") {
      const komgaUrl = getConfigValue("KOMGA_URL", "").replace(/\/$/, "");
      if (!komgaUrl) return res.status(400).json({ error: "KOMGA_URL manquant côté serveur" });

      const basic = Buffer.from(`${username}:${password}`).toString("base64");
      const testResp = await fetchKomgaCurrentUser(komgaUrl, {
        "Accept": "application/json",
        "Authorization": `Basic ${basic}`
      });
      if (!testResp?.ok) {
        const fallbackCookies = await loginKomgaAndGetSessionCookies(username, password);
        if (!fallbackCookies?.sessionCookie) {
          return res.status(401).json({ error: "Identifiants Komga invalides" });
        }
      }
    }

    if (service === "jellyfin") {
      const auth = await authenticateJellyfin(username, password);
      if (!auth?.accessToken) return res.status(401).json({ error: "Identifiants Jellyfin invalides" });
    }
    if (service === "romm") {
      const cookies = await loginRommAndGetSessionCookies(username, password);
      if (!cookies?.sessionCookie) {
        return res.status(401).json({ error: "Identifiants RomM invalides ou login RomM non compatible avec cette configuration" });
      }
    }
    const saved = saveUserServiceCredential(req.session.user, service, username, password);
    if (!saved) return res.status(500).json({ error: "Impossible d'enregistrer les identifiants" });

    res.json({ success: true });
  } catch (_) {
    res.status(500).json({ error: "Erreur de connexion au service" });
  }
});

router.delete("/api/integrations/:service/connect", requireAuth, async (req, res) => {
  const service = String(req.params.service || "").trim().toLowerCase();
  if (service !== "komga" && service !== "jellyfin" && service !== "romm") {
    return res.status(400).json({ error: "Service invalide" });
  }
  clearUserServiceCredential(req.session.user, service);
  res.json({ success: true });
});

/* ===============================
    ADMIN: Révoquer un badge
=============================== */
router.delete("/api/admin/achievement/:achievementId", requireAuth, requireAdmin, (req, res) => {
  const { UserAchievementQueries, UserQueries } = require('../utils/database');
  const username = req.session.user.username;
  const user = UserQueries.getByUsername(username);
  if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
  const { achievementId } = req.params;
  UserAchievementQueries.revoke(user.id, achievementId);
  log.create('[Admin]').info(`Badge "${achievementId}" révoqué pour ${username}`);
  res.json({ success: true, revoked: achievementId });
});

router.get("/api/admin/settings/leaderboard-blur", requireAuth, requireAdmin, (req, res) => {
  const enabled = AppSettingQueries.getBool("leaderboard_blur_enabled", true);
  res.json({ enabled });
});

router.post("/api/admin/settings/leaderboard-blur", requireAuth, requireAdmin, (req, res) => {
  const enabled = !!req.body?.enabled;
  AppSettingQueries.setBool("leaderboard_blur_enabled", enabled);
  log.create("[Admin]").info(`Leaderboard blur ${enabled ? "activé" : "désactivé"} par ${req.session.user.username}`);
  res.json({ success: true, enabled });
});

router.get("/api/admin/settings/dashboard-server-stats", requireAuth, requireAdmin, (req, res) => {
  const enabled = AppSettingQueries.getBool("dashboard_server_stats_enabled", true);
  res.json({ enabled });
});

router.post("/api/admin/settings/dashboard-server-stats", requireAuth, requireAdmin, (req, res) => {
  const enabled = !!req.body?.enabled;
  AppSettingQueries.setBool("dashboard_server_stats_enabled", enabled);
  log.create("[Admin]").info(`Barre stats dashboard ${enabled ? "activée" : "désactivée"} par ${req.session.user.username}`);
  res.json({ success: true, enabled });
});

router.get("/api/admin/settings/nav-subscription-pill", requireAuth, requireAdmin, (req, res) => {
  const enabled = AppSettingQueries.getBool("nav_subscription_pill_enabled", true);
  res.json({ enabled });
});

router.post("/api/admin/settings/nav-subscription-pill", requireAuth, requireAdmin, (req, res) => {
  const enabled = !!req.body?.enabled;
  AppSettingQueries.setBool("nav_subscription_pill_enabled", enabled);
  log.create("[Admin]").info(`Pastille abonnement navbar ${enabled ? "activée" : "désactivée"} par ${req.session.user.username}`);
  res.json({ success: true, enabled });
});

router.get("/api/admin/settings/site-language", requireAuth, requireAdmin, (req, res) => {
  res.json({ language: getSiteLanguage(), supportedLocales: SUPPORTED_LOCALES });
});

router.post("/api/admin/settings/site-language", requireAuth, requireAdmin, (req, res) => {
  const raw = String(req.body?.language || "").trim().toLowerCase();
  const language = SUPPORTED_LOCALES.includes(raw) ? raw : "fr";
  AppSettingQueries.set("site_language", language);
  log.create("[Admin]").info(`Langue du site ${language} par ${req.session.user.username}`);
  res.json({ success: true, language });
});

router.get("/api/admin/settings/site-title", requireAuth, requireAdmin, (req, res) => {
  res.json({ siteTitle: String(AppSettingQueries.get("site_title", "portall") || "portall") });
});

router.post("/api/admin/settings/site-title", requireAuth, requireAdmin, (req, res) => {
  const siteTitle = String(req.body?.siteTitle || "").trim() || "portall";
  AppSettingQueries.set("site_title", siteTitle);
  log.create("[Admin]").info(`Nom du site mis a jour par ${req.session.user.username}: ${siteTitle}`);
  res.json({ success: true, siteTitle });
});

router.get("/api/admin/settings/site-background", requireAuth, requireAdmin, (req, res) => {
  res.json({
    background: getSiteBackgroundSettings(),
    presets: BACKGROUND_PRESETS
  });
});

router.post("/api/admin/settings/site-background", requireAuth, requireAdmin, (req, res) => {
  const background = saveSiteBackgroundSettings(req.body || {});
  log.create("[Admin]").info(`Background du site ${background.mode} par ${req.session.user.username}`);
  res.json({ success: true, background });
});

router.get("/api/admin/dashboard-builtins", requireAuth, requireAdmin, (req, res) => {
  res.json({ items: getDashboardBuiltinAdminItems() });
});

router.post("/api/admin/dashboard-builtins", requireAuth, requireAdmin, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const savedItems = saveDashboardBuiltinConfig(items);
  log.create("[Admin]").info(`Ordre des cartes dashboard mis a jour par ${req.session.user.username}`);
  res.json({ success: true, items: savedItems });
});

router.get("/api/admin/dashboard-sections", requireAuth, requireAdmin, (req, res) => {
  res.json({ items: getDashboardSectionAdminItems(res.locals.t) });
});

router.post("/api/admin/dashboard-sections", requireAuth, requireAdmin, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const savedItems = saveDashboardSectionConfig(items);
  const serverStatsItem = savedItems.find(item => item.key === "server-stats");
  if (serverStatsItem) {
    AppSettingQueries.setBool("dashboard_server_stats_enabled", serverStatsItem.enabled !== false);
  }
  log.create("[Admin]").info(`Agencement des sections dashboard mis a jour par ${req.session.user.username}`);
  res.json({ success: true, items: savedItems });
});

router.post("/api/admin/dashboard-layout", requireAuth, requireAdmin, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const savedItems = saveDashboardLayoutConfig(items);

  const builtinItems = getDashboardBuiltinAdminItems(res.locals.t).map(item => {
    const layoutItem = savedItems.find(entry => entry.id === `builtin:${item.key}`);
    return {
      key: item.key,
      enabled: layoutItem ? layoutItem.enabled !== false : item.enabled !== false,
      order: item.order
    };
  });
  saveDashboardBuiltinConfig(builtinItems);

  const sectionItems = getDashboardSectionAdminItems(res.locals.t).map(item => {
    const layoutItem = savedItems.find(entry => entry.id === `section:${item.key}`);
    return {
      key: item.key,
      enabled: layoutItem ? layoutItem.enabled !== false : item.enabled !== false,
      position: item.position,
      order: item.order
    };
  });
  const savedSections = saveDashboardSectionConfig(sectionItems);
  const serverStatsItem = savedSections.find(item => item.key === "server-stats");
  if (serverStatsItem) {
    AppSettingQueries.setBool("dashboard_server_stats_enabled", serverStatsItem.enabled !== false);
  }

  log.create("[Admin]").info(`Ordre global dashboard mis a jour par ${req.session.user.username}`);
  res.json({ success: true, items: savedItems });
});

router.get("/api/admin/dashboard-html", requireAuth, requireAdmin, (req, res) => {
  res.json({
    raw: getDashboardCustomHtmlRaw(),
    blocks: getDashboardCustomHtmlBlocksRaw(),
    rendered: getDashboardCustomHtml(),
    mode: getDashboardCustomHtmlMode()
  });
});

router.post("/api/admin/dashboard-html", requireAuth, requireAdmin, (req, res) => {
  const result = saveDashboardCustomHtml(req.body?.html || "", {
    mode: req.body?.mode || "safe",
    blocks: Array.isArray(req.body?.blocks) ? req.body.blocks : null
  });
  log.create("[Admin]").info(`HTML dashboard mis a jour par ${req.session.user.username}`);
  res.json({
    success: true,
    raw: result.raw,
    blocks: result.blocks || [],
    rendered: result.rendered,
    sanitized: result.sanitized,
    mode: result.mode
  });
});

router.get("/api/admin/config", requireAuth, requireAdmin, (req, res) => {
  res.json({
    sections: getConfigSections({ includeSecretValues: false }),
    values: getEditableConfigValues({ includeSecretValues: false })
  });
});

router.get("/api/admin/config/diagnostics", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const diagnostics = await runAdminConfigDiagnostics();
    res.json(diagnostics);
  } catch (err) {
    res.status(500).json({ error: err.message || "Diagnostics impossibles" });
  }
});

router.post("/api/admin/config", requireAuth, requireAdmin, async (req, res) => {
  try {
    saveEditableConfig(req.body || {});
    log.create("[Admin]").info(`Connexions mises à jour par ${req.session.user.username}`);
    const diagnostics = await runAdminConfigDiagnostics();
    res.json({
      success: true,
      sections: getConfigSections({ includeSecretValues: false }),
      values: getEditableConfigValues({ includeSecretValues: false }),
      diagnostics
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Impossible d'enregistrer les connexions" });
  }
});

router.get("/api/admin/dashboard-cards", requireAuth, requireAdmin, (req, res) => {
  const cards = DashboardCardQueries.list();
  const availableColorKeys = getAvailableColorKeys(cards);
  const availableColors = DASHBOARD_CARD_PALETTE.filter(c => availableColorKeys.includes(c.key));
  const ia = getIntegrationAvailability();
  const integrations = DASHBOARD_INTEGRATIONS.map(i => ({
    ...i,
    available:
      i.key === "komga_auto" ? ia.komgaConfigured :
      i.key === "jellyfin_auto" ? ia.jellyfinAutoConfigured :
      i.key === "romm_auto" ? ia.rommAutoConfigured :
      true
  }));
  res.json({ cards, availableColors, allColors: DASHBOARD_CARD_PALETTE, integrations });
});

router.post("/api/admin/dashboard-cards", requireAuth, requireAdmin, (req, res) => {
  const payload = req.body || {};
  const label = String(payload.label || "").trim();
  const title = String(payload.title || "").trim();
  const description = String(payload.description || "").trim();
  const url = String(payload.url || "").trim();
  const colorKey = String(payload.colorKey || "").trim();
  const openInIframe = !!payload.openInIframe;
  const openInNewTab = !!payload.openInNewTab;
  const integrationKey = String(payload.integrationKey || "custom").trim();
  const icon = String(payload.icon || "?").trim();

  const requiresUrl = integrationKey === "custom";
  if (!label || !title || !description || !colorKey || (requiresUrl && !url)) {
    return res.status(400).json({ error: "Champs obligatoires manquants" });
  }

  if (label.length > 40 || title.length > 60 || description.length > 120 || icon.length > 4) {
    return res.status(400).json({ error: "Un ou plusieurs champs sont trop longs" });
  }

  const isRelativeUrl = url.startsWith("/");
  const isAbsoluteUrl = /^https?:\/\//i.test(url);
  if (integrationKey === "custom" && !isRelativeUrl && !isAbsoluteUrl) {
    return res.status(400).json({ error: "Lien invalide (doit commencer par / ou http/https)" });
  }

  const integrationCheck = validateIntegrationForCreateOrUpdate(integrationKey, url);
  if (!integrationCheck.ok) {
    return res.status(400).json({ error: integrationCheck.error });
  }

  const cards = DashboardCardQueries.list();
  const slugCheck = validateCardSlugForTitle(cards, title);
  if (!slugCheck.ok) {
    return res.status(400).json({ error: slugCheck.error });
  }
  const availableColorKeys = new Set(getAvailableColorKeys(cards));
  if (!availableColorKeys.has(colorKey)) {
    return res.status(400).json({ error: "Couleur non disponible" });
  }

  DashboardCardQueries.create({ label, title, description, url, colorKey, openInIframe, openInNewTab, integrationKey, icon });
  log.create("[Admin]").info(`Carte dashboard ajoutée par ${req.session.user.username}: ${title} (${colorKey})`);
  res.json({ success: true });
});

router.put("/api/admin/dashboard-cards/:id", requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Id invalide" });
  }

  const payload = req.body || {};
  const label = String(payload.label || "").trim();
  const title = String(payload.title || "").trim();
  const description = String(payload.description || "").trim();
  const url = String(payload.url || "").trim();
  const colorKey = String(payload.colorKey || "").trim();
  const openInIframe = !!payload.openInIframe;
  const openInNewTab = !!payload.openInNewTab;
  const integrationKey = String(payload.integrationKey || "custom").trim();
  const icon = String(payload.icon || "?").trim();

  const requiresUrl = integrationKey === "custom";
  if (!label || !title || !description || !colorKey || (requiresUrl && !url)) {
    return res.status(400).json({ error: "Champs obligatoires manquants" });
  }

  if (label.length > 40 || title.length > 60 || description.length > 120 || icon.length > 4) {
    return res.status(400).json({ error: "Un ou plusieurs champs sont trop longs" });
  }

  const isRelativeUrl = url.startsWith("/");
  const isAbsoluteUrl = /^https?:\/\//i.test(url);
  if (integrationKey === "custom" && !isRelativeUrl && !isAbsoluteUrl) {
    return res.status(400).json({ error: "Lien invalide (doit commencer par / ou http/https)" });
  }

  const integrationCheck = validateIntegrationForCreateOrUpdate(integrationKey, url);
  if (!integrationCheck.ok) {
    return res.status(400).json({ error: integrationCheck.error });
  }

  const cards = DashboardCardQueries.list();
  const target = cards.find(c => Number(c.id) === id);
  if (!target) {
    return res.status(404).json({ error: "Carte introuvable" });
  }
  const slugCheck = validateCardSlugForTitle(cards, title, id);
  if (!slugCheck.ok) {
    return res.status(400).json({ error: slugCheck.error });
  }

  // Couleur autorisée si elle reste identique, sinon elle doit être libre.
  const colorUnchanged = target.colorKey === colorKey;
  if (!colorUnchanged) {
    const used = new Set([...DEFAULT_DASHBOARD_COLOR_KEYS]);
    cards.filter(c => Number(c.id) !== id).forEach(c => used.add(c.colorKey));
    if (used.has(colorKey)) {
      return res.status(400).json({ error: "Couleur non disponible" });
    }
  }

  DashboardCardQueries.update(id, { label, title, description, url, colorKey, openInIframe, openInNewTab, integrationKey, icon });
  log.create("[Admin]").info(`Carte dashboard modifiée par ${req.session.user.username}: id=${id}`);
  res.json({ success: true });
});

router.post("/api/admin/dashboard-cards/order", requireAuth, requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const cards = DashboardCardQueries.list();
  const existingIds = new Set(cards.map(card => Number(card.id)));
  const orderedIds = ids
    .map(id => Number(id))
    .filter(id => Number.isInteger(id) && existingIds.has(id));

  cards.forEach(card => {
    const id = Number(card.id);
    if (!orderedIds.includes(id)) orderedIds.push(id);
  });

  DashboardCardQueries.saveOrder(orderedIds);
  log.create("[Admin]").info(`Ordre des cartes custom mis a jour par ${req.session.user.username}`);
  res.json({ success: true, ids: orderedIds });
});

router.get("/app-card/:cardRef", requireAuth, async (req, res) => {
  const rawRef = String(req.params.cardRef || "").trim();
  let card = null;

  const strictId = parseInt(rawRef, 10);
  if (Number.isInteger(strictId) && strictId > 0 && String(strictId) === rawRef) {
    card = DashboardCardQueries.getById(strictId);
  }
  if (!card) {
    const idMatch = rawRef.match(/-(\d+)$/);
    const fallbackId = idMatch ? parseInt(idMatch[1], 10) : NaN;
    if (Number.isInteger(fallbackId) && fallbackId > 0) {
      card = DashboardCardQueries.getById(fallbackId);
    }
  }
  if (!card && rawRef) {
    card = findCardBySlug(rawRef);
  }
  if (!card) {
    return res.redirect(req.basePath + "/dashboard");
  }

  const integrationKey = String(card.integrationKey || "custom");
  if (integrationKey === "custom" && !card.openInIframe) {
    return res.redirect(req.basePath + "/dashboard");
  }
  return res.redirect(`${req.basePath || ""}/${getCardSlug(card)}`);
});

router.get("/:cardSlug", requireAuth, async (req, res, next) => {
  const slug = String(req.params.cardSlug || "").trim();
  if (!slug || RESERVED_CARD_SLUGS.has(slug)) return next();
  const card = findCardBySlug(slug);
  if (!card) return next();
  const integrationKey = String(card.integrationKey || "custom");
  if (integrationKey === "custom" && !card.openInIframe) return next();
  return openCardByModel(req, res, card);
});

router.delete("/api/admin/dashboard-cards/:id", requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Id invalide" });
  }
  DashboardCardQueries.remove(id);
  log.create("[Admin]").info(`Carte dashboard supprimée par ${req.session.user.username}: id=${id}`);
  res.json({ success: true });
});

/* ===============================
   ?? NOW PLAYING
=============================== */
router.get("/api/now-playing", requireAuth, async (req, res) => {
  const plexUrl   = String(getConfigValue("PLEX_URL", "") || "").replace(/\/$/, "");
  const plexToken = getEffectivePlexToken();
  const liveCacheKey = `now-playing-live:${req.session.user.id}`;
  const buildLastPlayedResponse = () => {
    const username = String(req.session.user.username || "");
    const last = getLastPlayedItem(username);
    if (!last) return { playing: false };
    const thumb = last.thumb
      ? (req.basePath || "") + "/api/plex-thumb?path=" + encodeURIComponent(last.thumb)
      : null;

    return {
      playing: false,
      lastPlayed: true,
      type: last.mediaType,
      title: last.title,
      grandTitle: last.grandTitle,
      year: last.year,
      thumb,
      stoppedAt: last.stoppedAt
    };
  };

  if (!plexUrl || !plexToken) return res.json(buildLastPlayedResponse());

  try {
    const r = await fetch(`${plexUrl}/status/sessions`, {
      headers: { "X-Plex-Token": plexToken, "Accept": "application/json" },
      timeout: PLEX_LIVE_TIMEOUT_MS
    });
    if (!r.ok) return res.json(buildLastPlayedResponse());
    const bodyText = await r.text();
    let sessions = [];
    try {
      const json = JSON.parse(bodyText);
      sessions = json?.MediaContainer?.Metadata || [];
    } catch (_) {
      sessions = parsePlexSessionsResponse(bodyText);
    }

    // Trouver la session de l'utilisateur connecté.
    // Plex peut remonter un userId cloud, un userId local PMS (= 1 pour le proprio),
    // ou un username avec casse/espaces différents.
    const username = normalizePlexIdentity(req.session.user.username || "");
    const userId   = String(req.session.user.id || "").trim();
    const isAdminSession = !!req.session.user.isAdmin;

    const mySession = sessions.find(s => {
      const su = normalizePlexIdentity(s.User?.title || "");
      const sid = String(s.User?.id || "");
      if (su && su === username) return true;
      if (sid && sid === userId) return true;
      if (isAdminSession && sid === "1" && su === username) return true;
      return false;
    });

    if (!mySession) {
      return res.json(buildLastPlayedResponse());
    }

    const duration    = mySession.duration || 0;
    const viewOffset  = mySession.viewOffset || 0;
    const progressPct = duration > 0 ? Math.round((viewOffset / duration) * 100) : 0;

    const thumb = mySession.thumb
      ? (req.basePath || "") + "/api/plex-thumb?path=" + encodeURIComponent(mySession.thumb)
      : null;

    const payload = {
      playing:      true,
      state:        mySession.Player?.state || "playing",   // playing | paused | buffering
      type:         mySession.type,                          // episode | movie | track
      title:        mySession.title || "",
      grandTitle:   mySession.grandparentTitle || "",        // Série ou artiste
      year:         mySession.year || null,
      thumb,
      progressPct,
      player:       mySession.Player?.title || "",           // nom de l'appareil
    };

    cache.set(liveCacheKey, payload, NOW_PLAYING_CACHE_TTL_MS);
    res.json(payload);
  } catch (e) {
    log.create('[NowPlaying]').warn(`${e.message} while trying to fetch ${plexUrl}/status/sessions (over ${PLEX_LIVE_TIMEOUT_MS}ms)`);
    const cachedLive = cache.get(liveCacheKey);
    if (cachedLive) return res.json(cachedLive);
    res.json(buildLastPlayedResponse());
  }
});

/* ===============================
   ??? PROXY MINIATURE PLEX
   Le browser ne peut pas accéder à l'URL interne plex:32400.
   On proxifie l'image côté serveur et on la renvoie au browser.
=============================== */
router.get("/api/plex-thumb", requireAuth, async (req, res) => {
  const plexUrl   = String(getConfigValue("PLEX_URL", "") || "").replace(/\/$/, "");
  const plexToken = getEffectivePlexToken();
  const thumbPath = req.query.path;
  if (!plexUrl || !plexToken || !thumbPath) return res.status(400).end();

  // Validation anti-SSRF : le chemin doit commencer par /library/, /photo/, ou /users/ (avatars)
  // et ne pas contenir de séquences de traversal
  const allowedPrefixes = ["/library/", "/photo/", "/users/"];
  const isAllowed = allowedPrefixes.some(p => thumbPath.startsWith(p));
  const hasTraversal = /(\.\.|%2e%2e|%252e)/i.test(thumbPath);
  if (!isAllowed || hasTraversal) {
    log.create('[Plex]').warn(`Thumb — chemin refusé: ${thumbPath}`);
    return res.status(400).end();
  }

  try {
    const r = await fetch(`${plexUrl}${thumbPath}`, {
      headers: { "X-Plex-Token": plexToken },
      timeout: 12000
    });
    if (!r.ok) return res.status(404).end();
    const ct = r.headers.get("content-type") || "";
    // N'accepter que des images en réponse
    if (!ct.startsWith("image/")) return res.status(400).end();
    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=60");
    r.body.pipe(res);
  } catch (e) {
    res.status(502).end();
  }
});

/* ===============================
   ?? STATS SERVEUR (librairies Tautulli)
=============================== */
const logSrv = log.create('[ServerStats]');

router.get('/api/server-stats', requireAuth, async (req, res) => {
  const cacheKey = 'server-library-stats';
  const staleCacheKey = 'server-library-stats:last-success';
  const komgaCacheKey = 'server-library-stats:komga-books';
  const komgaStaleCacheKey = 'server-library-stats:komga-books:last-success';
  const cached = cache.get(cacheKey);
  const cachedKomgaBooks = cache.get(komgaCacheKey);
  const staleKomgaBooks = cache.get(komgaStaleCacheKey);
  const withKomga = (payload) => {
    if (!payload || typeof payload !== 'object') return payload;
    return {
      ...payload,
      komgaBooks:
        Number.isFinite(cachedKomgaBooks) ? cachedKomgaBooks
        : Number.isFinite(staleKomgaBooks) ? staleKomgaBooks
        : payload.komgaBooks ?? null
    };
  };
  if (cached && Number.isFinite(cachedKomgaBooks)) return res.json(withKomga(cached));

  try {
    const result = getServerLibraryStats();
    const komgaBooks = await fetchKomgaBooksTotal(req.session.user);
    if (Number.isFinite(komgaBooks)) {
      cache.set(komgaCacheKey, komgaBooks, 10 * 60 * 1000);
      cache.set(komgaStaleCacheKey, komgaBooks, 60 * 60 * 1000);
    }
    if (!result?.available) {
      const stale = cache.get(staleCacheKey);
      if (stale) {
        logSrv.warn(`Lecture DB librairies indisponible (${result?.reason || 'unknown'}) — utilisation du dernier cache valide`);
        return res.json({ ...withKomga(stale), stale: true });
      }
      return res.json(withKomga(result || { available: false, reason: 'tautulli_db_unavailable' }));
    }
    const payload = {
      ...result,
      komgaBooks:
        Number.isFinite(komgaBooks) ? komgaBooks
        : Number.isFinite(cachedKomgaBooks) ? cachedKomgaBooks
        : Number.isFinite(staleKomgaBooks) ? staleKomgaBooks
        : null
    };
    cache.set(cacheKey, result, 10 * 60 * 1000); // 10 min
    cache.set(staleCacheKey, result, 60 * 60 * 1000); // 1 h fallback
    logSrv.debug(`Films:${result.movies} Séries:${result.shows} Épisodes:${result.episodes} Musiques:${result.musicTracks} Audiobooks:${result.audiobookCount} KomgaBooks:${payload.komgaBooks ?? 'n/a'}`);
    res.json(payload);
  } catch (err) {
    const stale = cache.get(staleCacheKey);
    if (stale) {
      logSrv.warn(`Erreur librairies: ${err.message} — utilisation du dernier cache valide`);
      return res.json({ ...withKomga(stale), stale: true });
    }

    logSrv.warn('Erreur librairies:', err.message);
    res.json(withKomga({ available: false, reason: err.message }));
  }
});

/* ===============================
   ?? MES STATISTIQUES
=============================== */
const logStats = log.create('[MesStats]');

router.get('/api/mes-stats', requireAuth, async (req, res) => {
  try {
    const username = req.session.user.username;
    const cacheKey = `mes_stats_${username}`;
    const cached   = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { getUserDetailedStats, isTautulliReady } = require('../utils/tautulli-direct');
    if (!isTautulliReady()) return res.json({ available: false, reason: 'tautulli_not_ready' });

    const data = getUserDetailedStats(username);
    if (!data) return res.json({ available: false, reason: 'no_data' });

    const result = { available: true, ...data };
    cache.set(cacheKey, result, 10 * 60 * 1000); // 10 min
    logStats.debug(`Stats générées pour ${username}`);
    res.json(result);
  } catch (err) {
    logStats.error('API mes-stats:', err.message);
    res.status(500).json({ error: 'mes-stats failed' });
  }
});

router.get('/api/mes-stats-global', requireAuth, async (req, res) => {
  try {
    const cacheKey = 'mes_stats_global';
    const cached   = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { getGlobalDetailedStats, isTautulliReady } = require('../utils/tautulli-direct');
    if (!isTautulliReady()) return res.json({ available: false, reason: 'tautulli_not_ready' });

    const data = getGlobalDetailedStats();
    if (!data) return res.json({ available: false, reason: 'no_data' });

    const result = { available: true, ...data };
    cache.set(cacheKey, result, 10 * 60 * 1000); // 10 min
    logStats.debug('Stats globales générées');
    res.json(result);
  } catch (err) {
    logStats.error('API mes-stats-global:', err.message);
    res.status(500).json({ error: 'mes-stats-global failed' });
  }
});

/* ===============================
   ?? CLASSEMENT (Leaderboard)
=============================== */
const logLB = log.create('[Classement]');

router.get('/api/classement', requireAuth, (req, res) => {
  try {
    // ? Récupérer les données pré-calculées du cache (mis à jour toutes les 5 min)
    const { getClassementCache } = require('../utils/cron-classement-refresh');
    const cacheData = getClassementCache();

    // Ajouter le timestamp du dernier refresh dans la réponse
    res.json({
      ...cacheData.data,
      lastRefresh: cacheData.lastRefresh,
      cacheTimestamp: cacheData.timestamp
    });
  } catch (err) {
    logLB.error('API classement:', err.message);
    res.status(500).json({ error: 'classement failed' });
  }
});

/* ===============================
   ?? API CALENDRIER (Radarr + Sonarr)
=============================== */

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function plusDaysISO(iso, n) {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

router.get("/api/calendar", requireAuth, async (req, res) => {
  const start = req.query.start || todayISO();
  const end   = req.query.end   || plusDaysISO(start, 30);
  const cacheKey = `calendar:${start}:${end}`;

  try {
    const data = await cache.getOrSet(cacheKey, async () => {
      const [movies, episodes] = await Promise.all([
        getRadarrCalendar(process.env.RADARR_URL, process.env.RADARR_API_KEY, start, end).catch(() => []),
        getSonarrCalendar(process.env.SONARR_URL, process.env.SONARR_API_KEY, start, end).catch(() => [])
      ]);
      return [...movies, ...episodes].sort((a, b) => a.date.localeCompare(b.date));
    }, 5 * 60 * 1000);  // cache 5 min

    res.json({ events: data, start, end });
  } catch (err) {
    log.create('[Calendrier]').error(err.message);
    res.status(500).json({ error: err.message, events: [] });
  }
});

/* ===============================
   ?? VERSION & CHANGELOG
=============================== */

router.get('/api/version', (req, res) => {
  try {
    const version = getLocalAppVersion();
    res.json({ version });
  } catch (err) {
    res.status(500).json({ error: 'Could not read version' });
  }
});

const VERSION_STATUS_CACHE_TTL_MS = 10 * 60 * 1000;
let versionStatusCache = {
  expiresAt: 0,
  currentVersion: null,
  data: null
};

function readPackageJsonFresh() {
  const fs = require("fs");
  const path = require("path");
  const packageJsonPath = path.join(__dirname, "../package.json");
  const raw = fs.readFileSync(packageJsonPath, "utf8");
  return JSON.parse(raw);
}

function getLocalAppVersion() {
  const pkg = readPackageJsonFresh();
  return String(pkg.version || "").trim();
}

function stripVersionPrefix(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

function parseVersion(value) {
  const match = stripVersionPrefix(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] || ""
  };
}

function compareVersions(current, latest) {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return null;
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  if (!a.pre && b.pre) return 1;
  if (a.pre && !b.pre) return -1;
  if (a.pre !== b.pre) return a.pre > b.pre ? 1 : -1;
  return 0;
}

function getGithubRepoSlug() {
  const envValue = String(process.env.GITHUB_REPO || "").trim();
  if (envValue) return envValue.replace(/\.git$/i, "");

  try {
    const pkg = readPackageJsonFresh();
    const repo = pkg.repository;
    const candidate = typeof repo === "string" ? repo : repo?.url;
    if (!candidate) return "iDrinkx/portall";

    const normalized = String(candidate)
      .replace(/^git\+/, "")
      .replace(/^github:/, "https://github.com/")
      .replace(/\.git$/i, "");
    const match = normalized.match(/github\.com[/:]([^/]+\/[^/]+)/i);
    return match ? match[1] : "iDrinkx/portall";
  } catch (_) {
    return "iDrinkx/portall";
  }
}

async function getVersionStatus() {
  const now = Date.now();
  const currentVersion = getLocalAppVersion();
  if (
    versionStatusCache.data &&
    versionStatusCache.currentVersion === currentVersion &&
    now < versionStatusCache.expiresAt
  ) {
    return versionStatusCache.data;
  }

  const repo = getGithubRepoSlug();
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;

  try {
    const response = await fetch(apiUrl, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": "portall-version-check"
      },
      timeout: 8000
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}`);
    }

    const data = await response.json();
    const latestVersion = stripVersionPrefix(data.tag_name || "");
    const comparison = compareVersions(currentVersion, latestVersion);
    const upToDate = comparison !== null ? comparison >= 0 : currentVersion === latestVersion;

    const payload = {
      currentVersion,
      latestVersion,
      upToDate,
      releaseUrl: data.html_url || null,
      repo
    };
    versionStatusCache = {
      expiresAt: now + VERSION_STATUS_CACHE_TTL_MS,
      currentVersion,
      data: payload
    };
    return payload;
  } catch (err) {
    return {
      currentVersion,
      latestVersion: null,
      upToDate: null,
      releaseUrl: null,
      repo,
      error: "Version status unavailable"
    };
  }
}

router.get('/api/version/status', async (_, res) => {
  try {
    const status = await getVersionStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: 'Could not read version status' });
  }
});

router.get('/api/changelog', (_, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const changelogPath = path.join(__dirname, '../CHANGELOG.md');
    const changelog = fs.readFileSync(changelogPath, 'utf8');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(changelog);
  } catch (err) {
    res.status(404).json({ error: 'Changelog not found' });
  }
});

router.get('/api/version-badge.svg', (_, res) => {
  try {
    const version = getLocalAppVersion();

    // SVG badge dynamique basé sur package.json
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="114" height="20" role="img" aria-label="Version: ${version}">
      <title>Version: ${version}</title>
      <linearGradient id="s" x2="0" y2="100%">
        <stop offset="0" stop-color="#bbb"/>
        <stop offset="1" stop-color="#999"/>
      </linearGradient>
      <clipPath id="r">
        <rect width="114" height="20" rx="3" fill="#fff"/>
      </clipPath>
      <g clip-path="url(#r)">
        <rect width="75" height="20" fill="#555"/>
        <rect x="75" width="39" height="20" fill="#34d399"/>
        <rect width="114" height="20" fill="url(#s)"/>
      </g>
      <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
        <text aria-hidden="true" x="385" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="650">Version</text>
        <text x="385" y="140" transform="scale(.1)" fill="#fff" textLength="650">Version</text>
        <text aria-hidden="true" x="935" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="290">${version}</text>
        <text x="935" y="140" transform="scale(.1)" fill="#fff" textLength="290">${version}</text>
      </g>
    </svg>`;

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(svg);
  } catch (err) {
    res.status(500).json({ error: 'Could not generate version badge' });
  }
});

/* ===============================
   ?? DATABASE MAINTENANCE
=============================== */

/**
 * POST /api/maintenance/database
 * Lance une maintenance manuelle de la base de données
 * (nettoyage des anciennes données, optimisation)
 */
router.post('/api/maintenance/database', requireAuth, async (req, res) => {
  try {
    const logMaint = log.create('[API-Maintenance]');
    logMaint.info('Maintenance manuelle lancée par', req.session.user?.username || 'unknown');

    const result = DatabaseMaintenance.runFullMaintenance();

    res.json({
      success: true,
      message: 'Maintenance complète exécutée avec succès',
      details: result
    });
  } catch (err) {
    log.create('[API-Maintenance]').error('Erreur maintenance:', err.message);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la maintenance: ' + err.message
    });
  }
});

module.exports = router;

