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

// Initialiser le cron job pour mettre en cache les sessions
console.log("[SETUP] Initialisation du cron job sessions...");
startSessionCronJob(
  process.env.TRACEARR_URL,
  process.env.TRACEARR_API_KEY,
  process.env.PLEX_URL,
  process.env.PLEX_TOKEN,
  [] // Liste vide au démarrage, sera remplie au fur et à mesure des logins
);

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
