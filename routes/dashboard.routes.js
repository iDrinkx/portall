const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");

const { computeSubscription } = require("../utils/wizarr");
const { getTracearrStats } = require("../utils/tracearr");

/* ===============================
   🔐 AUTH
=============================== */

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/");
  next();
}

/* ===============================
   ⚙️ CACHE CONFIG
=============================== */

const CACHE_DURATION = 60 * 1000; // 60 secondes

/* ===============================
   🔎 WIZARR
=============================== */

async function getWizarrSubscription(user) {
  try {
    const wizarrUrl = process.env.WIZARR_URL;
    const apiKey = process.env.WIZARR_API_KEY;

    if (!wizarrUrl || !apiKey) {
      return computeSubscription(null);
    }

    const resp = await fetch(`${wizarrUrl}/api/users`, {
      headers: {
        Accept: "application/json",
        "X-API-Key": apiKey
      }
    });

    if (!resp.ok) throw new Error("Wizarr error");

    const payload = await resp.json();

    const list =
      Array.isArray(payload) ? payload :
      Array.isArray(payload?.users) ? payload.users :
      Array.isArray(payload?.data) ? payload.data :
      [];

    const norm = s => (s || "").toLowerCase().trim();
    const plexEmail = norm(user.email);

    if (!plexEmail) return computeSubscription(null);

    const wizUser = list.find(u => norm(u.email) === plexEmail) || null;

    return computeSubscription(wizUser);

  } catch (err) {
    console.error("Wizarr error:", err.message);
    return computeSubscription(null);
  }
}

/* ===============================
   📄 PAGES
=============================== */

router.get("/dashboard", requireAuth, (req, res) => {
  res.render("dashboard/index", { user: req.session.user });
});

router.get("/abonnement", requireAuth, (req, res) => {
  res.render("abonnement/index", { user: req.session.user });
});

router.get("/statistiques", requireAuth, (req, res) => {
  res.render("statistiques/index", { user: req.session.user });
});

/* ===============================
   🔄 API SUBSCRIPTION (avec cache)
=============================== */

router.get("/api/subscription", requireAuth, async (req, res) => {

  const now = Date.now();

  if (
    req.session.subscriptionCache &&
    now - req.session.subscriptionCache.timestamp < CACHE_DURATION
  ) {
    return res.json(req.session.subscriptionCache.data);
  }

  const subscription = await getWizarrSubscription(req.session.user);

  req.session.subscriptionCache = {
    data: subscription,
    timestamp: now
  };

  res.json(subscription);
});

/* ===============================
   🔄 API STATS (TRACEARR ONLY)
=============================== */

router.get("/api/stats", requireAuth, async (req, res) => {
  const now = Date.now();

  // ✅ Cache session
  if (
    req.session.statsCache &&
    now - req.session.statsCache.timestamp < CACHE_DURATION
  ) {
    return res.json(req.session.statsCache.data);
  }

  const stats = await getTracearrStats(
    req.session.user.username,
    process.env.TRACEARR_URL,
    process.env.TRACEARR_API_KEY
  );

  // (Optionnel) log seulement si pas cache
  console.log("Tracearr stats:", stats);

  req.session.statsCache = {
    data: stats,
    timestamp: now
  };

  res.json(stats);
});

module.exports = router;
