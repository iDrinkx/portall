const express = require("express");
const session = require("express-session");
const expressLayouts = require("express-ejs-layouts");
const path = require("path");

const authRoutes = require("./routes/auth.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const seeerrProxyRoutes = require("./routes/seerr-proxy.routes");
const reverseProxyMiddleware = require("./middleware/reverseproxy.middleware");
const { startSessionCronJob } = require("./utils/cron-session-job");
const { startDatabaseMaintenanceJob } = require("./utils/cron-maintenance-job");  // 🧹 Database maintenance
const { runHealthCheck } = require("./utils/health-check");  // 🏥 Health check au boot
const { initDatabase } = require("./utils/database");  // 🗄️  Database initialization
const { initTautulliDatabase, getAllUserStatsFromTautulli } = require("./utils/tautulli-direct");  // 📊 Tautulli direct DB

const app = express();
const PORT = process.env.PORT || 3000;

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

app.use(session({
  name: "plex-portal.sid", // Nom unique pour éviter le conflit avec connect.sid de Seerr
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

// 2. Route Seerr (iframe SSO Organizr-style — simple GET, pas de proxy)
app.use("/", seeerrProxyRoutes);

// 3. Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   REVERSE PROXY DETECTION
========================= */

// (déjà appliqué en premier ci-dessus)

/* =========================
   STATIC FILES
========================= */

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static("/config"));

/* =========================
   GLOBAL USER (IMPORTANT)
========================= */

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.basePath = req.basePath || "";
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

app.use("/", authRoutes);
app.use("/", dashboardRoutes);

app.get("/", (req, res) => {
  if (req.session.user) {
    const redirectUrl = req.basePath ? `${req.basePath}/dashboard` : "/dashboard";
    return res.redirect(redirectUrl);
  }
  res.render("login", { error: req.query.error || null });
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

/**
 * 👥 Récupérer la liste des utilisateurs pour le cron job
 * (depuis Seerr ou Tautulli)
 */
async function initializeAllUsersForCron() {
  try {
    const baseUrl = process.env.SEERR_URL || "http://localhost:5055";
    const apiKey = process.env.SEERR_API_KEY;
    
    if (!apiKey) {
      console.warn("[SETUP] ⚠️  Pas d'SEERR_API_KEY configurée, cron job sans utilisateurs");
      return [];
    }

    console.log("[SETUP] Tentative de fetch des utilisateurs Seerr depuis:", baseUrl);

    const users = [];
    let page = 1;
    let pageSize = 50;
    let totalPages = 1;
    let retries = 3;

    while (page <= totalPages && retries > 0) {
      try {
        console.log(`[SETUP]   Fetch page ${page}...`);
        
        const resp = await fetch(
          `${baseUrl}/api/v1/user?skip=${(page - 1) * pageSize}&take=${pageSize}`,
          {
            headers: {
              "X-API-Key": apiKey,
              "Accept": "application/json"
            }
          }
        );

        console.log(`[SETUP]   Status: ${resp.status}`);

        if (!resp.ok) {
          console.warn(`[SETUP]   ⚠️  Seerr ${resp.status}, retry...`);
          retries--;
          await new Promise(r => setTimeout(r, 500)); // attendre 500ms avant retry
          continue;
        }

        const json = await resp.json();
        const pageInfo = json.pageInfo || {};
        totalPages = Math.ceil((pageInfo.results || 0) / pageSize);

        console.log(`[SETUP]   Page ${page}: ${json.data?.length || 0} utilisateurs trouvés`);

        if (json.data) {
          users.push(...json.data.map(u => ({
            id: u.id,
            username: u.username || u.plexUsername,
            plexUserId: u.plexId,
            joinedAtTimestamp: u.createdAt ? Math.floor(new Date(u.createdAt).getTime() / 1000) : null
          })));
        }

        page++;
      } catch (err) {
        console.warn(`[SETUP]   ⚠️  Erreur fetch page ${page}:`, err.message);
        retries--;
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log(`[SETUP] ✅ Récupéré ${users.length} utilisateurs pour le cron job`);
    return users;
  } catch (err) {
    console.error("[SETUP] ❌ Erreur initializeAllUsersForCron:", err.message);
    return [];
  }
}

// Démarrer le serveur et initialiser le cron job
app.listen(PORT, async () => {
  console.log("\n🚀 Server running on port", PORT);
  
  // 🗄️  INITIALISER LA BASE DE DONNÉES LOCALE
  try {
    initDatabase();
    console.log("[SETUP] ✅ Base de données SQLite initialisée");
  } catch (err) {
    console.error("[SETUP] ❌ Erreur initialisation DB:", err.message);
    process.exit(1);
  }
  
  // 📊 INITIALISER LA CONNEXION TAUTULLI DIRECTE
  const tautulliReady = initTautulliDatabase();
  if (tautulliReady) {
    console.log("[SETUP] 📊 Chargement des stats de Tautulli pour TOUS les utilisateurs...");
    try {
      const allStats = await loadAllUserStatsFromTautulli();
      console.log("[SETUP] ✅ Données Tautulli prêtes pour " + (allStats?.length || 0) + " utilisateurs");
      if (allStats && allStats.length > 0) {
        console.log("[SETUP]   Sample utilisateur:", allStats[0]?.username, "- sessions:", allStats[0]?.sessionCount);
      }
    } catch (err) {
      console.warn("[SETUP] ⚠️  Impossible de charger les stats Tautulli:", err.message);
    }
  } else {
    console.warn("[SETUP] ⚠️  Tautulli DB non configuré - configure TAUTULLI_DB_PATH pour activer");
  }
  
  // 🏥 HEALTH CHECK au démarrage
  await runHealthCheck();
  
  // Initialiser le cron job avec tous les utilisateurs Seerr
  console.log("[SETUP] Initialisation du cron job sessions...");
  const allUsers = await initializeAllUsersForCron();
  
  startSessionCronJob(
    process.env.TAUTULLI_URL,
    process.env.TAUTULLI_API_KEY,
    process.env.PLEX_URL,
    process.env.PLEX_TOKEN,
    allUsers // ✅ Liste réelle de tous les utilisateurs
  );

  // 🧹 Démarrer le job de maintenance de la base de données
  startDatabaseMaintenanceJob();
});
