const express = require("express");
const session = require("express-session");
const expressLayouts = require("express-ejs-layouts");
const path = require("path");

const authRoutes = require("./routes/auth.routes");
const dashboardRoutes = require("./routes/dashboard.routes");

const app = express();
const PORT = 3000;

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
   STATIC FILES
========================= */

app.use(express.static(path.join(__dirname, "public")));

/* =========================
   GLOBAL USER (IMPORTANT)
========================= */

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
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
    return res.redirect("/dashboard");
  }
  res.render("login");
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log("🚀 Server running on port 3000");
});
