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
const { getPlexJoinDate, getServerOwnerId } = require("../utils/plex");
const { getRadarrCalendar, getSonarrCalendar } = require("../utils/radarr-sonarr");
const { XP_SYSTEM } = require("../utils/xp-system");
const { ACHIEVEMENTS, hydrateAchievementTexts, areCollectionAchievementsEnabled, getAchievementXp } = require("../utils/achievements");
const {
  UserAchievementQueries,
  UserQueries,
  AchievementProgressQueries,
  DatabaseMaintenance,
  AppSettingQueries,
  DashboardCardQueries,
  UserServiceCredentialQueries
} = require("../utils/database");
const { getAchievementUnlockDates, evaluateSecretAchievements, isTautulliReady, getLastPlayedItem, getUserStatsFromTautulli } = require("../utils/tautulli-direct");
const CacheManager = require("../utils/cache");
const TautulliEvents = require("../utils/tautulli-events");  // ?? Import EventEmitter
const { calculateUserXp } = require("../utils/xp-calculator");  // ?? Fonction centralisée XP
const { getConfigSections, getConfigValue, getEditableConfigValues, saveEditableConfig } = require("../utils/config");
const {
  getDashboardBuiltinAdminItems,
  saveDashboardBuiltinConfig,
  buildDashboardBuiltinCards
} = require("../utils/dashboard-builtins");
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

router.get("/dashboard", requireAuth, (req, res) => {
  const colorMap = getColorMap();
  const dashboardServerStatsEnabled = AppSettingQueries.getBool("dashboard_server_stats_enabled", true);
  const dashboardBuiltinCards = buildDashboardBuiltinCards(req.session.user, req.basePath || "", res.locals.t);
  const dashboardCustomCards = DashboardCardQueries.list()
    .map(card => {
      const color = colorMap.get(card.colorKey);
      if (!color) return null;
      return {
        ...card,
        color,
        openInIframe: !!card.openInIframe,
        openInNewTab: !!card.openInNewTab,
        integrationKey: card.integrationKey || "custom",
        href: toCardHref(card, req.basePath || ""),
        external: String(card.integrationKey || "custom") === "romm_auto" || !!card.openInNewTab
      };
    })
    .filter(Boolean);

  res.render("dashboard/index", {
    user: req.session.user,
    basePath: req.basePath,
    dashboardBuiltinCards,
    dashboardCustomCards,
    dashboardCustomHtmlBlocks: getDashboardCustomHtmlBlocks(),
    dashboardCustomHtml: getDashboardCustomHtml(),
    dashboardCustomHtmlMode: getDashboardCustomHtmlMode(),
    dashboardServerStatsEnabled
  });
});

router.get("/profil", requireAuth, async (req, res) => {
  try {
    // ? Rendu ultra-rapide: on ne bloque plus la page profil sur les appels stats.
    // Les données dynamiques sont hydratées côté client via /api/stats, /api/xp-snapshot, etc.
    // Pour l'entête profil, on utilise uniquement l'état DB des succès déjà débloqués.
    const dbUser = UserQueries.upsert(
      req.session.user.username,
      req.session.user.id || null,
      req.session.user.email || null,
      req.session.user.joinedAt || req.session.user.joinedAtTimestamp || null
    );
    const userUnlockedMap = dbUser ? UserAchievementQueries.getForUser(dbUser.id) : {};
    const progressMap = dbUser ? AchievementProgressQueries.getForUser(dbUser.id) : {};
    const allAchievements = ACHIEVEMENTS.getAll();
    const unlockedAchievementIds = new Set(Object.keys(userUnlockedMap || {}));
    const unlockedAchievements = allAchievements.filter(a => unlockedAchievementIds.has(a.id));
    const totalAchievementsXp = unlockedAchievements.reduce((sum, ach) => sum + getAchievementXp(ach, progressMap[ach.id]), 0);

    res.render("profil/index", {
      user: req.session.user,
      basePath: req.basePath,
      XP_SYSTEM,
      unlockedBadgesCount: unlockedAchievements.length,
      totalBadgesCount: allAchievements.length,
      totalAchievementsXp
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
    // ? Rendu instantané depuis la DB uniquement — l'évaluation Tautulli
    //    se fait en arrière-plan via /api/badges-eval (appelé par le client)
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

    const username   = req.session.user.username;
    const joinedAtTs = req.session.user.joinedAtTimestamp;

    // Upsert utilisateur en DB (silencieux)
    let dbUserId = null;
    try {
      const dbUser = UserQueries.upsert(
        username,
        req.session.user.id    || null,
        req.session.user.email || null,
        req.session.user.joinedAt || joinedAtTs || null
      );
      dbUserId = dbUser?.id || null;
    } catch(e) {
      try { dbUserId = UserQueries.getByUsername(username)?.id || null; } catch(_) {}
    }

    // Lecture DB uniquement (< 5 ms)
    const userUnlockedMap = dbUserId ? UserAchievementQueries.getForUser(dbUserId) : {};
    const progressMap     = dbUserId ? AchievementProgressQueries.getForUser(dbUserId) : {};

    // Construire les cards depuis l'état DB courant
    for (const category in achievementsByCategory) {
      achievementsByCategory[category].achievements = achievementsByCategory[category].achievements.map(a => ({
        ...hydrateAchievementTexts(a, res.locals.siteTitle),
        xp: getAchievementXp(a, progressMap[a.id]),
        unlocked:     !!userUnlockedMap[a.id],
        unlockedDate: userUnlockedMap[a.id] || null
      }));
    }

    // Stats basées sur la DB (sans recalcul Tautulli)
    const emptyData = { totalHours: 0, movieCount: 0, episodeCount: 0, sessionCount: 0, monthlyHours: 0, nightCount: 0, morningCount: 0, daysSince: 0 };
    const stats_global = ACHIEVEMENTS.getStats(emptyData, userUnlockedMap);

    res.render("succes", {
      user: req.session.user,
      basePath: req.basePath,
      XP_SYSTEM,
      ACHIEVEMENTS: achievementsByCategory,
      stats: stats_global,
      progressMap,
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
  const dashboardServerStatsEnabled = AppSettingQueries.getBool("dashboard_server_stats_enabled", true);
  const navSubscriptionPillEnabled = AppSettingQueries.getBool("nav_subscription_pill_enabled", true);
  const dashboardBuiltinItems = getDashboardBuiltinAdminItems(res.locals.t);
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

  res.render("parametres/index", {
    user: req.session.user,
    basePath: req.basePath,
    leaderboardBlurEnabled,
    dashboardServerStatsEnabled,
    navSubscriptionPillEnabled,
    siteBackground,
    backgroundPresets: BACKGROUND_PRESETS,
    supportedLocales: SUPPORTED_LOCALES,
    siteLanguage: getSiteLanguage(),
    dashboardBuiltinItems,
    dashboardCustomHtmlRaw: getDashboardCustomHtmlRaw(),
    dashboardCustomHtmlBlocks: getDashboardCustomHtmlBlocksRaw(),
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
    const collectionsEnabled = areCollectionAchievementsEnabled();
    const username   = req.session.user.username;
    const joinedAtTs = req.session.user.joinedAtTimestamp;
    const today      = new Date().toLocaleDateString('fr-FR');

    let dbUserId = null;
    try {
      const dbUser = UserQueries.upsert(username, req.session.user.id||null, req.session.user.email||null, req.session.user.joinedAt||joinedAtTs||null);
      dbUserId = dbUser?.id || null;
    } catch(e) {
      try { dbUserId = UserQueries.getByUsername(username)?.id || null; } catch(_) {}
    }

    const userUnlockedMap = dbUserId ? UserAchievementQueries.getForUser(dbUserId) : {};

    // 1. Stats Tautulli (rapide si DB directe prête)
    const stats = await getTautulliStats(
        username, getConfigValue("TAUTULLI_URL", ""), getConfigValue("TAUTULLI_API_KEY", ""),
        req.session.user.id, getConfigValue("PLEX_URL", ""), getConfigValue("PLEX_TOKEN", ""), joinedAtTs
    );
    const data = {
      totalHours:   stats.watchStats?.totalHours   || 0,
      movieCount:   stats.watchStats?.movieCount   || 0,
      episodeCount: stats.watchStats?.episodeCount || 0,
      sessionCount: stats.sessionCount   || 0,
      monthlyHours: stats.monthlyHours   || 0,
      nightCount:   stats.nightCount     || 0,
      morningCount: stats.morningCount   || 0,
      daysSince: Math.floor((Date.now() - (joinedAtTs * 1000)) / (1000 * 60 * 60 * 24))
    };

    const computedDates = getAchievementUnlockDates(username, joinedAtTs);
    const allAchievements = ACHIEVEMENTS.getAll();
    const newlyUnlocked = {};

    // 2. Succès non-secrets
    for (const a of allAchievements) {
      if (userUnlockedMap[a.id])    continue;
      if (a.isSecret)               continue;
      if (a.category === 'secrets') continue;
      if (a.category === 'collections') continue;
      if (!a.condition(data))       continue;
      const date = computedDates[a.id] || today;
      if (dbUserId) try { UserAchievementQueries.unlock(dbUserId, a.id, date, 'auto'); } catch(e) {}
      newlyUnlocked[a.id] = date;
    }

    // 3. Collections + secrets Tautulli
    const collectionsToCheck = collectionsEnabled ? ACHIEVEMENTS.collections : [];
    const secretsToCheck = [...collectionsToCheck, ...ACHIEVEMENTS.secrets]
      .filter(a => !a.isSecret && (!userUnlockedMap[a.id] || a.revocable)).map(a => a.id);
    const revocableUnlocked = new Set(
      [...collectionsToCheck, ...ACHIEVEMENTS.secrets]
        .filter(a => a.revocable && userUnlockedMap[a.id]).map(a => a.id)
    );
    const newProgress = {};
    const revoked = [];

    if (secretsToCheck.length > 0 && isTautulliReady()) {
      try {
        const evalResult = await evaluateSecretAchievements(username, joinedAtTs, secretsToCheck, req.session.user.id);
        const { unlocked: evalUnlocked, progress: evalProgress } = evalResult;
        for (const [id, date] of Object.entries(evalUnlocked)) {
          if (dbUserId) try { UserAchievementQueries.unlock(dbUserId, id, date, 'auto'); } catch(e) {}
          newlyUnlocked[id] = date;
        }
        for (const id of revocableUnlocked) {
          if (!evalUnlocked[id]) {
            if (dbUserId) try { UserAchievementQueries.revoke(dbUserId, id); } catch(e) {}
            revoked.push(id);
          }
        }
        if (evalProgress) {
          for (const [id, prog] of Object.entries(evalProgress)) {
            if (dbUserId) try { AchievementProgressQueries.save(dbUserId, id, prog.current, prog.total); } catch(e) {}
            newProgress[id] = prog;
          }
        }
        if (dbUserId) {
          for (const id of secretsToCheck) {
            if (evalProgress?.[id]) continue;
            try { AchievementProgressQueries.remove(dbUserId, id); } catch(e) {}
          }
        }
        if (Object.keys(newlyUnlocked).length > 0)
          logBadges.info(`Débloqués pour ${username}:`, Object.keys(newlyUnlocked).join(', '));
      } catch (err) {
        logBadges.error('badges-eval:', err.message);
      }
    }

    res.json({ unlocked: newlyUnlocked, progress: newProgress, revoked, data });
  } catch (err) {
    logBadges.error('badges-eval crash:', err.message);
    res.status(500).json({ unlocked: {}, progress: {}, revoked: [], data: {} });
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
    const user         = req.session.user;
    const joinedAtTs   = user.joinedAtTimestamp || 0;

    // ? Heures depuis DB directe (synchrone, pas d'appel HTTP lent)
    const directStats  = getUserStatsFromTautulli(user.username);
    const hoursHint    = directStats?.totalHours ?? null;
    const statsHint    = directStats ? {
      totalHours: directStats.totalHours || 0,
      sessionCount: directStats.sessionCount || 0,
      movieCount: directStats.movieCount || 0,
      episodeCount: directStats.episodeCount || 0,
      monthlyHours: 0,
      nightCount: 0,
      morningCount: 0
    } : null;

    // ?? Utiliser la fonction centralisée pour GARANTIR la cohérence avec le classement
    const xpData = await calculateUserXp(user.username, joinedAtTs, hoursHint, statsHint);

    res.json({
      rank: { color: xpData.rank.color, name: xpData.rank.name, icon: xpData.rank.icon, bgColor: xpData.rank.bgColor, borderColor: xpData.rank.borderColor },
      level: xpData.level,
      totalXp: xpData.totalXp,
      badgeCount: xpData.badgeCount,
      progressPercent: xpData.progressPercent,
      xpNeeded: xpData.xpNeeded
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
    
    if (!userEmail) {
      return res.status(400).json({ error: "No user email in session" });
    }

    // Clé de cache utilisant l'ID Plex pour plus de certitude
    const cacheKey = `seerr:${plexUserId}`;
    
    const seerr = await cache.getOrSet(
      cacheKey,
      () => getSeerrStats(
        userEmail,
        username,
        process.env.SEERR_URL,
        process.env.SEERR_API_KEY
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

      if (json.data) {
        users.push(...json.data.map(u => ({
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

router.post("/api/admin/config", requireAuth, requireAdmin, (req, res) => {
  saveEditableConfig(req.body || {});
  log.create("[Admin]").info(`Connexions mises à jour par ${req.session.user.username}`);
  res.json({
    success: true,
    sections: getConfigSections({ includeSecretValues: false }),
    values: getEditableConfigValues({ includeSecretValues: false })
  });
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
  const plexToken = String(getConfigValue("PLEX_TOKEN", "") || "");
  if (!plexUrl || !plexToken) return res.json({ playing: false });

  try {
    const r = await fetch(`${plexUrl}/status/sessions`, {
      headers: { "X-Plex-Token": plexToken, "Accept": "application/json" },
      timeout: 5000
    });
    if (!r.ok) return res.json({ playing: false });
    const json = await r.json();
    const sessions = json?.MediaContainer?.Metadata || [];

    // Trouver la session de l'utilisateur connecté (par username ou titre)
    const username = (req.session.user.username || "").toLowerCase();
    const userId   = req.session.user.id;

    const mySession = sessions.find(s => {
      const su = (s.User?.title || "").toLowerCase();
      const sid = String(s.User?.id || "");
      return su === username || sid === String(userId);
    });

    if (!mySession) {
      // Fallback : dernier contenu regardé
      const username = (req.session.user.username || "");
      const last = getLastPlayedItem(username);
      if (!last) return res.json({ playing: false });

      const thumbUrl = last.thumb
        ? (req.basePath || "") + "/api/plex-thumb?path=" + encodeURIComponent(last.thumb)
        : null;

      return res.json({
        playing:      false,
        lastPlayed:   true,
        type:         last.mediaType,
        title:        last.title,
        grandTitle:   last.grandTitle,
        year:         last.year,
        thumb:        thumbUrl,
        stoppedAt:    last.stoppedAt,
      });
    }

    const duration    = mySession.duration || 0;
    const viewOffset  = mySession.viewOffset || 0;
    const progressPct = duration > 0 ? Math.round((viewOffset / duration) * 100) : 0;

    const thumb = mySession.thumb
      ? (req.basePath || "") + "/api/plex-thumb?path=" + encodeURIComponent(mySession.thumb)
      : null;

    res.json({
      playing:      true,
      state:        mySession.Player?.state || "playing",   // playing | paused | buffering
      type:         mySession.type,                          // episode | movie | track
      title:        mySession.title || "",
      grandTitle:   mySession.grandparentTitle || "",        // Série ou artiste
      year:         mySession.year || null,
      thumb,
      progressPct,
      player:       mySession.Player?.title || "",           // nom de l'appareil
    });
  } catch (e) {
    log.create('[NowPlaying]').warn(e.message);
    res.json({ playing: false });
  }
});

/* ===============================
   ??? PROXY MINIATURE PLEX
   Le browser ne peut pas accéder à l'URL interne plex:32400.
   On proxifie l'image côté serveur et on la renvoie au browser.
=============================== */
router.get("/api/plex-thumb", requireAuth, async (req, res) => {
  const plexUrl   = String(getConfigValue("PLEX_URL", "") || "").replace(/\/$/, "");
  const plexToken = String(getConfigValue("PLEX_TOKEN", "") || "");
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
    const r = await fetch(`${plexUrl}${thumbPath}?X-Plex-Token=${plexToken}`, { timeout: 8000 });
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
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  const tautulliUrl = (process.env.TAUTULLI_URL || '').replace(/\/$/, '');
  const apiKey      = process.env.TAUTULLI_API_KEY || '';

  if (!tautulliUrl || !apiKey) {
    return res.json({ available: false, reason: 'Tautulli non configuré' });
  }

  try {
    const r = await fetch(`${tautulliUrl}/api/v2?apikey=${apiKey}&cmd=get_libraries`, { timeout: 8000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    const libs = json?.response?.data || [];

    if (!Array.isArray(libs) || libs.length === 0) {
      return res.json({ available: false, reason: 'Aucune librairie Tautulli' });
    }

    const AUDIOBOOK_KEYWORDS = ['audio', 'livre', 'audiobook', 'podcast'];
    const isAudiobook = name => AUDIOBOOK_KEYWORDS.some(k => name.toLowerCase().includes(k));

    let movies = 0, shows = 0, episodes = 0, musicTracks = 0, audiobookCount = 0;

    for (const lib of libs) {
      const type  = lib.section_type;
      const count = parseInt(lib.count, 10)  || 0;
      const child = parseInt(lib.child_count, 10) || 0;

      if (type === 'movie') {
        movies += count;
      } else if (type === 'show') {
        shows    += count;
        episodes += child;
      } else if (type === 'artist') {
        if (isAudiobook(lib.section_name || '')) {
          audiobookCount += child || count;  // child = tracks (chapters)
        } else {
          musicTracks += child || count;     // child = tracks
        }
      }
    }

    const result = { available: true, movies, shows, episodes, musicTracks, audiobookCount };
    cache.set(cacheKey, result, 10 * 60 * 1000); // 10 min
    logSrv.debug(`Films:${movies} Séries:${shows} Épisodes:${episodes} Musiques:${musicTracks} Audiobooks:${audiobookCount}`);
    res.json(result);
  } catch (err) {
    logSrv.warn('Erreur librairies:', err.message);
    res.json({ available: false, reason: err.message });
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

