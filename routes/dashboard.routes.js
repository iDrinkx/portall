const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");

const { computeSubscription } = require("../utils/wizarr");
const { getTracearrStats } = require("../utils/tracearr");
const { getOverseerrStats } = require("../utils/overseerr");
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
        process.env.TRACEARR_API_KEY
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
    const cacheKey = `overseerr:${req.session.user.id}`;
    
    console.log(`[Overseerr] Fetching for user ${req.session.user.id}`, {
      url: process.env.OVERSEERR_URL,
      hasKey: !!process.env.OVERSEERR_API_KEY
    });
    
    const overseerr = await cache.getOrSet(
      cacheKey,
      () => getOverseerrStats(
        req.session.user.id,
        process.env.OVERSEERR_URL,
        process.env.OVERSEERR_API_KEY
      ),
      60 * 1000 // 60 secondes
    );

    console.log(`[Overseerr] Result:`, overseerr);

    res.json(overseerr || {});
  } catch (err) {
    console.error("Overseerr API error:", err.message);
    res.status(500).json({ error: "Failed to fetch overseerr data" });
  }
});

/* ===============================
   🔍 API OVERSEERR DEBUG
=============================== */

router.get("/api/overseerr-debug", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const url = `${process.env.OVERSEERR_URL}/api/v1/user/${userId}/requests`;
    
    console.log(`[Debug] Overseerr request to: ${url}`);

    const rawRes = await fetch(url, {
      headers: {
        "X-API-Key": process.env.OVERSEERR_API_KEY,
        "Accept": "application/json"
      }
    });

    const text = await rawRes.text();

    res.json({
      status: rawRes.status,
      ok: rawRes.ok,
      headers: Object.fromEntries(rawRes.headers),
      body: text ? (text.startsWith("{") ? JSON.parse(text) : text) : null,
      config: {
        url,
        userId,
        hasUrl: !!process.env.OVERSEERR_URL,
        hasKey: !!process.env.OVERSEERR_API_KEY
      }
    });
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
