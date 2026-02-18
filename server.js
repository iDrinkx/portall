const express = require("express");
const session = require("express-session");
const expressLayouts = require("express-ejs-layouts");
const path = require("path");

const authRoutes = require("./routes/auth.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const reverseProxyMiddleware = require("./middleware/reverseproxy.middleware");
const { startSessionCronJob } = require("./utils/cron-session-job");

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   SESSION
========================= */

app.use(session({
  secret: process.env.SESSION_SECRET || "monplex-secret-key",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false, // ⚠️ mettre true si HTTPS plus tard
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 // 24h
  }
}));

/* =========================
   REVERSE PROXY DETECTION
========================= */

app.use(reverseProxyMiddleware);

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
  res.render("login");
});

/* =========================
   START
========================= */

// Fonction pour récupérer tous les utilisateurs Overseerr au démarrage
async function initializeAllUsersForCron() {
  try {
    const baseUrl = process.env.OVERSEERR_URL || "http://localhost:5055";
    const apiKey = process.env.OVERSEERR_API_KEY;
    
    if (!apiKey) {
      console.warn("[SETUP] ⚠️  Pas d'OVERSEERR_API_KEY configurée, cron job sans utilisateurs");
      return [];
    }

    const users = [];
    let page = 1;
    let pageSize = 50;
    let totalPages = 1;
    let retries = 3;

    while (page <= totalPages && retries > 0) {
      try {
        const resp = await fetch(
          `${baseUrl}/api/v1/user?skip=${(page - 1) * pageSize}&take=${pageSize}`,
          {
            headers: {
              "X-API-Key": apiKey,
              "Accept": "application/json"
            }
          }
        );

        if (!resp.ok) {
          console.warn(`[SETUP] Erreur Overseerr ${resp.status}, retry...`);
          retries--;
          continue;
        }

        const json = await resp.json();
        const pageInfo = json.pageInfo || {};
        totalPages = Math.ceil((pageInfo.results || 0) / pageSize);

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
        console.warn(`[SETUP] Erreur fetch page ${page}:`, err.message);
        retries--;
      }
    }

    console.log(`[SETUP] ✅ Récupéré ${users.length} utilisateurs pour le cron job`);
    return users;
  } catch (err) {
    console.error("[SETUP] Erreur initializeAllUsersForCron:", err.message);
    return [];
  }
}

// Démarrer le serveur et initialiser le cron job
app.listen(PORT, async () => {
  console.log("🚀 Server running on port", PORT);
  
  // Initialiser le cron job avec tous les utilisateurs Overseerr
  console.log("[SETUP] Initialisation du cron job sessions...");
  const allUsers = await initializeAllUsersForCron();
  
  startSessionCronJob(
    process.env.TRACEARR_URL,
    process.env.TRACEARR_API_KEY,
    process.env.PLEX_URL,
    process.env.PLEX_TOKEN,
    allUsers // ✅ Liste réelle de tous les utilisateurs
  );
});
