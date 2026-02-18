const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");

const { computeSubscription } = require("../utils/wizarr");
const { getTracearrStats } = require("../utils/tracearr");
const { getOverseerrStats } = require("../utils/overseerr");
const { getPlexJoinDate } = require("../utils/plex");
const CacheManager = require("../utils/cache");

/* ===============================
   🔐 AUTH
=============================== */

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect(req.basePath + "/");
  next();
}

/* ===============================
   💾 CACHE MANAGER
=============================== */

// Instance centralisée de cache (60 secondes par défaut)
const cache = new CacheManager(60 * 1000);

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
   🔄 API SUBSCRIPTION
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
    console.error("Subscription API error:", err.message);
    res.status(500).json({ error: "Failed to fetch subscription" });
  }
});

/* ===============================
   🔄 API STATS
=============================== */

router.get("/api/stats", requireAuth, async (req, res) => {
  try {
    const cacheKey = `stats:${req.session.user.id}`;
    
    const stats = await cache.getOrSet(
      cacheKey,
      () => getTracearrStats(
        req.session.user.username,
        process.env.TRACEARR_URL,
        process.env.TRACEARR_API_KEY,
        req.session.user.id,        // plexUserId
        process.env.PLEX_URL,       // PLEX_URL (pour fallback joinDate)
        process.env.PLEX_TOKEN      // PLEX_TOKEN
      ),
      60 * 1000 // 60 secondes
    );

    res.json(stats);
  } catch (err) {
    console.error("Stats API error:", err.message);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

/* ===============================
   🎬 API OVERSEERR
=============================== */

router.get("/api/overseerr", requireAuth, async (req, res) => {
  try {
    const userEmail = req.session.user?.email;
    const username = req.session.user?.username;
    
    if (!userEmail) {
      return res.status(400).json({ error: "No user email in session" });
    }

    const cacheKey = `overseerr:${userEmail}`;
    
    const overseerr = await cache.getOrSet(
      cacheKey,
      () => getOverseerrStats(
        userEmail,
        username,
        process.env.OVERSEERR_URL,
        process.env.OVERSEERR_API_KEY
      ),
      60 * 1000 // 60 secondes
    );

    res.json(overseerr || {});
  } catch (err) {
    console.error("Overseerr API error:", err.message);
    res.status(500).json({ error: "Failed to fetch overseerr data" });
  }
});

/* ===============================
   🔍 API OVERSEERR DEBUG (Test endpoints)
=============================== */

router.get("/api/overseerr-debug", requireAuth, async (req, res) => {
  try {
    const baseUrl = process.env.OVERSEERR_URL;
    const apiKey = process.env.OVERSEERR_API_KEY;

    const tests = [];

    // Test 1: GET /user (list all users)
    try {
      const r1 = await fetch(`${baseUrl}/api/v1/user`, {
        headers: { "X-API-Key": apiKey, "Accept": "application/json" }
      });
      const d1 = await r1.json();
      const users = Array.isArray(d1) ? d1 : (d1.results || d1.data || []);
      tests.push({
        name: "GET /user",
        status: r1.status,
        ok: r1.ok,
        user_count: users.length
      });
    } catch (e) {
      tests.push({ name: "GET /user", error: e.message });
    }

    // Test 2: GET /user/39/requests sans paramètres
    try {
      const r2 = await fetch(`${baseUrl}/api/v1/user/39/requests`, {
        headers: { "X-API-Key": apiKey, "Accept": "application/json" }
      });
      const d2 = await r2.text();
      tests.push({
        name: "GET /user/39/requests (no params)",
        status: r2.status,
        ok: r2.ok,
        response_preview: d2.substring(0, 300)
      });
    } catch (e) {
      tests.push({ name: "GET /user/39/requests", error: e.message });
    }

    // Test 3: GET /user/39/requests?skip=0&take=50
    try {
      const r3 = await fetch(`${baseUrl}/api/v1/user/39/requests?skip=0&take=50`, {
        headers: { "X-API-Key": apiKey, "Accept": "application/json" }
      });
      const d3 = await r3.text();
      tests.push({
        name: "GET /user/39/requests?skip=0&take=50",
        status: r3.status,
        ok: r3.ok,
        response_preview: d3.substring(0, 300)
      });
    } catch (e) {
      tests.push({ name: "GET /user/39/requests?skip=0&take=50", error: e.message });
    }

    // Test 4: GET /request (all requests)
    try {
      const r4 = await fetch(`${baseUrl}/api/v1/request`, {
        headers: { "X-API-Key": apiKey, "Accept": "application/json" }
      });
      const d4 = await r4.text();
      tests.push({
        name: "GET /request (all requests)",
        status: r4.status,
        ok: r4.ok,
        response_preview: d4.substring(0, 300)
      });
    } catch (e) {
      tests.push({ name: "GET /request", error: e.message });
    }

    res.json({ tests });
  } catch (err) {
    console.error("Debug error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ===============================
   🗑️ CACHE INVALIDATION
=============================== */

router.post("/api/cache/invalidate", requireAuth, (req, res) => {
  try {
    const userId = req.session.user.id;
    
    // Invalide tous les caches de l'utilisateur
    cache.invalidate(`subscription:${userId}`);
    cache.invalidate(`stats:${userId}`);
    cache.invalidate(`overseerr:${userId}`);
    
    res.json({ 
      message: "Cache invalidated", 
      stats: cache.stats() 
    });
  } catch (err) {
    console.error("Cache invalidation error:", err.message);
    res.status(500).json({ error: "Failed to invalidate cache" });
  }
});

module.exports = router;
