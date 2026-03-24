const express = require("express");
const session = require("express-session");
const expressLayouts = require("express-ejs-layouts");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");

const authRoutes = require("./routes/auth.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const seeerrProxyRoutes = require("./routes/seerr-proxy.routes");
const reverseProxyMiddleware = require("./middleware/reverseproxy.middleware");
const { startDatabaseMaintenanceJob } = require("./utils/cron-maintenance-job");  // 🧹 Database maintenance
const { startRefreshOrchestrator } = require("./utils/refresh-orchestrator");
const { runHealthCheck } = require("./utils/health-check");  // 🏥 Health check au boot
const { initDatabase, DashboardCardQueries, AppSettingQueries } = require("./utils/database");  // 🗄️  Database initialization
const { applyRuntimeConfig, isSetupComplete, getConfigValue } = require("./utils/config");
const { initTautulliDatabase, getAllUserStatsFromTautulli } = require("./utils/tautulli-direct");  // 📊 Tautulli direct DB
const { buildDashboardNavItems } = require("./utils/dashboard-builtins");
const { getSiteLanguage, createTranslator, getRuntimeTextMap } = require("./utils/i18n");
const { getSiteBackgroundSettings } = require("./utils/site-background");
const { getPublicStatusPageSummary } = require("./utils/uptime-kuma");

const app = express();
const PORT = process.env.PORT || 3000;
let cachedPlexServerName = undefined;
let cachedPlexServerKey = null;

function getSiteTitle() {
  return String(AppSettingQueries.get("site_title", "portall") || "portall").trim() || "portall";
}

function getCustomFaviconAsset() {
  const candidates = [
    { file: "favicon.ico", href: "/favicon.ico", type: "image/x-icon" },
    { file: "favicon.png", href: "/favicon.png", type: "image/png" },
    { file: "favicon.svg", href: "/favicon.svg", type: "image/svg+xml" },
    { file: "favicon.webp", href: "/favicon.webp", type: "image/webp" },
    { file: "favicon.jpg", href: "/favicon.jpg", type: "image/jpeg" },
    { file: "favicon.jpeg", href: "/favicon.jpeg", type: "image/jpeg" }
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join("/config", candidate.file))) {
        return candidate;
      }
    } catch (_) {}
  }

  return { href: "/logo.png", type: "image/png" };
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

function getCardSlug(card) {
  return slugifyCardTitle(card?.title || card?.label || "");
}

async function getPlexServerName() {
  const plexUrl = String(getConfigValue("PLEX_URL", "") || "").replace(/\/$/, "");
  const plexToken = String(getConfigValue("PLEX_TOKEN", "") || "");
  const cacheKey = `${plexUrl}::${plexToken}`;
  if (cachedPlexServerKey === cacheKey && cachedPlexServerName !== undefined) {
    return cachedPlexServerName;
  }
  if (!plexUrl || !plexToken) {
    cachedPlexServerKey = cacheKey;
    cachedPlexServerName = null;
    return null;
  }

  try {
    const response = await fetch(`${plexUrl}/identity`, {
      headers: {
        "X-Plex-Token": plexToken,
        "Accept": "application/json"
      }
    });
    if (!response.ok) {
      cachedPlexServerKey = cacheKey;
      cachedPlexServerName = null;
      return null;
    }

    const data = await response.json();
    cachedPlexServerKey = cacheKey;
    cachedPlexServerName = String(data?.MediaContainer?.friendlyName || "").trim() || null;
    return cachedPlexServerName;
  } catch (_) {
    cachedPlexServerKey = cacheKey;
    cachedPlexServerName = null;
    return null;
  }
}

try {
  initDatabase();
  applyRuntimeConfig();
  console.log("[SETUP] ✅ Base de données SQLite initialisée");
} catch (err) {
  console.error("[SETUP] ❌ Erreur initialisation DB:", err.message);
  process.exit(1);
}

// Indispensable derrière un reverse proxy (NPM, Traefik, etc.)
// Permet à Express de faire confiance aux headers X-Forwarded-Proto/Host
// et de poser les cookies secure:true même si la connexion interne est HTTP
app.set('trust proxy', 1);

/* =========================
   MIDDLEWARE
========================= */

// 1. Détection reverse proxy (définit req.basePath, req.appUrl)
app.use(reverseProxyMiddleware);

/* =========================
   SESSION
========================= */

// ⚠️  SESSION_SECRET check au démarrage
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET === "change-me-to-a-secure-key" || SESSION_SECRET === "monplex-secret-key") {
  console.warn("\n⚠️  [SÉCURITÉ] SESSION_SECRET non défini ou valeur par défaut détectée !");
  console.warn("   Définissez une clé aléatoire forte dans docker-compose.yml :\n");
  console.warn(`   SESSION_SECRET: \"${require('crypto').randomBytes(32).toString('hex')}\"\n`);
}

app.use((req, _res, next) => {
  const legacySessionCookieName = ["plex", "portal.sid"].join("-");
  const currentSessionCookieName = "portall.sid";
  const cookieHeader = String(req.headers.cookie || "");
  if (cookieHeader && !cookieHeader.includes(`${currentSessionCookieName}=`) && cookieHeader.includes(`${legacySessionCookieName}=`)) {
    req.headers.cookie = cookieHeader.replace(new RegExp(`(^|;\\s*)${legacySessionCookieName}=`, "i"), `$1${currentSessionCookieName}=`);
  }
  next();
});

app.use(session({
  name: "portall.sid", // Nom unique pour éviter le conflit avec connect.sid de Seerr
  secret: SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    // secure: contrôlé exclusivement par COOKIE_SECURE (true en prod derrière HTTPS, false en local)
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 // 24h
  }
}));

// 3. Body parsers
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));

app.use((err, req, res, next) => {
  if (!err) return next();

  if (err.type === "entity.too.large") {
    if ((req.path || "").startsWith("/api/")) {
      return res.status(413).json({
        error: "Payload too large",
        message: "The uploaded image is too large. Use a lighter file or an external image URL."
      });
    }
    return res.status(413).send("Payload too large");
  }

  return next(err);
});

/* =========================
   REVERSE PROXY DETECTION
========================= */

// (déjà appliqué en premier ci-dessus)

/* =========================
   STATIC FILES
========================= */

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static("/config"));

app.use((req, res, next) => {
  res.locals.setupComplete = isSetupComplete();

  if (res.locals.setupComplete) return next();
  if (req.path === "/setup" || req.path === "/api/setup") return next();

  return res.redirect((req.basePath || "") + "/setup");
});

/* =========================
   GLOBAL USER (IMPORTANT)
========================= */

app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.basePath = req.basePath || "";
  res.locals.locale = getSiteLanguage();
  res.locals.t = createTranslator(res.locals.locale);
  res.locals.runtimeTextMap = getRuntimeTextMap(res.locals.locale);
  res.locals.customNavCards = [];
  res.locals.dashboardNavItems = [];
  res.locals.contentClass = "";
  res.locals.navSubscriptionPillEnabled = AppSettingQueries.getBool("nav_subscription_pill_enabled", true);
  res.locals.siteBackground = getSiteBackgroundSettings();
  // Keep login unauthorized message aligned with admin-configured site name.
  res.locals.plexServerName = getSiteTitle();
  res.locals.siteTitle = getSiteTitle();
  res.locals.siteFavicon = getCustomFaviconAsset();

  if (req.session.user) {
    try {
      res.locals.dashboardNavItems = buildDashboardNavItems(req.basePath || "", res.locals.t);
      const cards = DashboardCardQueries.list();
      const basePath = req.basePath || "";
      const navColorMap = {
        teal:   { base: "rgba(45, 212, 191, 0.9)", hover: "#5eead4", accent: "#2dd4bf" },
        indigo: { base: "rgba(165, 180, 252, 0.9)", hover: "#c7d2fe", accent: "#818cf8" },
        pink:   { base: "rgba(249, 168, 212, 0.9)", hover: "#fbcfe8", accent: "#f472b6" },
        cyan:   { base: "rgba(103, 232, 249, 0.9)", hover: "#a5f3fc", accent: "#22d3ee" },
        lime:   { base: "rgba(190, 242, 100, 0.9)", hover: "#d9f99d", accent: "#a3e635" },
        orange: { base: "rgba(253, 186, 116, 0.9)", hover: "#fed7aa", accent: "#fb923c" }
      };

      res.locals.customNavCards = cards.map(card => {
        const openInIframe = !!card.openInIframe;
        const openInNewTab = !!card.openInNewTab;
        const integrationKey = String(card.integrationKey || "custom");
        const rawUrl = String(card.url || "");
        const navColors = navColorMap[card.colorKey] || { base: "rgba(226, 246, 255, 0.9)", hover: "#e8f6ff", accent: "#62b2ff" };
        let href = "";
        if (integrationKey !== "custom" || openInIframe) {
          href = `${basePath}/${getCardSlug(card)}`;
        } else {
          href = rawUrl.startsWith("/") ? `${basePath}${rawUrl}` : rawUrl;
        }
        return {
          id: card.id,
          label: card.label || card.title || `App ${card.id}`,
          icon: card.icon || "✨",
          integrationKey,
          href,
          external: integrationKey === "romm_auto" || openInNewTab || (integrationKey === "custom" && !openInIframe && /^https?:\/\//i.test(rawUrl)),
          navColorBase: navColors.base,
          navColorHover: navColors.hover,
          navColorAccent: navColors.accent
        };
      });
    } catch (_) {
      res.locals.customNavCards = [];
    }
  }
  next();
});

/* =========================
   VIEW ENGINE
========================= */

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(expressLayouts);
app.set("layout", "layout");

/* =========================
   ROUTES
========================= */

app.use("/", seeerrProxyRoutes);
app.use("/", authRoutes);
app.use("/", dashboardRoutes);

app.get("/", async (req, res) => {
  if (!isSetupComplete()) {
    return res.redirect((req.basePath || "") + "/setup");
  }
  if (req.session.user) {
    const redirectUrl = req.basePath ? `${req.basePath}/dashboard` : "/dashboard";
    return res.redirect(redirectUrl);
  }

  const uptimeKumaUrl = String(getConfigValue("UPTIME_KUMA_URL", "") || "").trim();
  const uptimeKumaUsername = String(getConfigValue("UPTIME_KUMA_USERNAME", "") || "").trim();
  const uptimeKumaPassword = String(getConfigValue("UPTIME_KUMA_PASSWORD", "") || "").trim();

  let uptimeKuma = null;
  if (uptimeKumaUrl && uptimeKumaUsername && uptimeKumaPassword) {
    try {
      uptimeKuma = await getPublicStatusPageSummary({
        baseUrl: uptimeKumaUrl,
        username: uptimeKumaUsername,
        password: uptimeKumaPassword
      });
    } catch (_) {
      uptimeKuma = null;
    }
  }

  res.render("login", {
    error: req.query.error || null,
    uptimeKuma
  });
});

app.use((err, req, res, _next) => {
  const isMalformedUrl =
    err instanceof URIError ||
    String(err?.message || "").includes("Failed to decode param");

  if (isMalformedUrl) {
    console.warn("[HTTP] ⚠️  Malformed URL rejected", {
      method: req.method,
      path: req.originalUrl || req.url,
      message: err && err.message
    });

    if (res.headersSent) return;

    if (String(req.originalUrl || req.url || "").startsWith("/api/")) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Malformed URL"
      });
    }

    return res.status(400).send("Bad Request");
  }

  console.error("[HTTP] ❌ Unhandled error", {
    method: req.method,
    path: req.originalUrl || req.url,
    message: err && err.message,
    stack: err && err.stack
  });

  if (res.headersSent) return;

  if ((req.path || "").startsWith("/api/")) {
    return res.status(500).json({
      error: "Internal Server Error"
    });
  }

  return res.status(500).send("Internal Server Error");
});

/* =========================
   START
========================= */

/**
 * 📊 Charger les stats de TOUS les utilisateurs depuis Tautulli
 */
async function loadAllUserStatsFromTautulli() {
  try {
    const stats = getAllUserStatsFromTautulli();
    
    if (!stats || stats.length === 0) {
      console.warn("[SETUP] ⚠️  Aucune stat trouvée dans Tautulli");
      return [];
    }
    
    console.log("[SETUP] ✅ Récupéré stats de " + stats.length + " utilisateurs depuis Tautulli");
    return stats;
  } catch (err) {
    console.error("[SETUP] ❌ Erreur chargement Tautulli:", err.message);
    return [];
  }
}

// Démarrer le serveur et initialiser le cron job
app.listen(PORT, async () => {
  console.log("\n🚀 Server running on port", PORT);
  
  // 📊 INITIALISER LA CONNEXION TAUTULLI DIRECTE
  const tautulliReady = initTautulliDatabase();
  if (tautulliReady) {
    console.log("[SETUP] 📊 Chargement des stats de Tautulli pour TOUS les utilisateurs...");
    try {
      const allStats = await loadAllUserStatsFromTautulli();
      console.log("[SETUP] ✅ Données Tautulli prêtes pour " + (allStats?.length || 0) + " utilisateurs");
    } catch (err) {
      console.warn("[SETUP] ⚠️  Impossible de charger les stats Tautulli:", err.message);
    }
  } else {
    console.warn("[SETUP] ⚠️  Tautulli DB non configuré - configure TAUTULLI_DB_PATH pour activer");
  }
  
  // 🏥 HEALTH CHECK au démarrage
  await runHealthCheck();
  
  // 🧹 Démarrer le job de maintenance de la base de données
  startDatabaseMaintenanceJob();

  // 📋 IMPORT AUTOMATIQUE depuis Wizarr au démarrage
  // Cela garantit que le classement est complet même après suppression DB
  // Source de vérité: Wizarr pour la liste des users, Plex pour joinedAt
  console.log("[SETUP] 📋 Import automatique des users Wizarr en DB...");
  try {
    const { getAllWizarrUsersDetailed, delay } = require("./utils/wizarr");
    const { UserQueries } = require("./utils/database");
    const wizarrUrl = getConfigValue("WIZARR_URL");
    const wizarrApiKey = getConfigValue("WIZARR_API_KEY");
    if (!wizarrUrl || !wizarrApiKey) {
      console.log("[SETUP] ℹ️  Wizarr désactivé — import ignoré");
    } else {
      let wizarrUsers = [];
      let lastWizarrResult = null;
      const maxAttempts = 3;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        lastWizarrResult = await getAllWizarrUsersDetailed(wizarrUrl, wizarrApiKey);
        wizarrUsers = lastWizarrResult.users || [];

        if (wizarrUsers.length > 0) {
          console.log(`[SETUP] ✅ Wizarr prêt (tentative ${attempt}/${maxAttempts}) via ${lastWizarrResult.source}`);
          break;
        }

        console.warn(`[SETUP] ⚠️  Wizarr indisponible/vide (tentative ${attempt}/${maxAttempts}) — ${lastWizarrResult?.reason || "raison inconnue"}`);
        if (attempt < maxAttempts) {
          console.log("[SETUP] ⏳ Nouvelle tentative Wizarr dans 5 secondes...");
          await delay(5000);
        }
      }
      if (wizarrUsers.length > 0) {
      let upserted = 0;
      for (const wUser of wizarrUsers) {
        try {
          if (wUser.username) {
            UserQueries.upsert(wUser.username, wUser.plexUserId, wUser.email, null);
            upserted++;
          }
        } catch (_) {}
      }
        console.log(`[SETUP] ✅ Import Wizarr: ${upserted}/${wizarrUsers.length} users synchronisés en DB`);
      } else {
        console.warn(`[SETUP] ⚠️  Import Wizarr ignoré après ${maxAttempts} tentatives — ${lastWizarrResult?.reason || "Wizarr non configuré ou inaccessible"}`);
      }
    }
  } catch (err) {
    console.warn(`[SETUP] ⚠️  Erreur import Wizarr: ${err.message}`);
  }

  startRefreshOrchestrator({
    TAUTULLI_URL: getConfigValue("TAUTULLI_URL"),
    TAUTULLI_API_KEY: getConfigValue("TAUTULLI_API_KEY"),
    backgroundInitialRefresh: true,
    initialDelayMs: 60000
  }).catch(err => {
    console.warn("[SETUP] ⚠️  Impossible de démarrer l'orchestrateur des refresh:", err.message);
  });
});
