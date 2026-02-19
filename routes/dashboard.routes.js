const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");

const { computeSubscription } = require("../utils/wizarr");
const { getTautulliStats, syncTautulliHistoryToDatabase } = require("../utils/tautulli");
const { getOverseerrStats } = require("../utils/overseerr");
const { getPlexJoinDate } = require("../utils/plex");
const { XP_SYSTEM } = require("../utils/xp-system");
const CacheManager = require("../utils/cache");
const TautulliEvents = require("../utils/tautulli-events");  // 📢 Import EventEmitter

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

    console.log("[WIZARR] Fetch subscription pour:", user?.username || user?.email);
    console.log("[WIZARR] URL:", wizarrUrl, "API Key present:", !!apiKey);

    if (!wizarrUrl || !apiKey) {
      console.log("[WIZARR] ❌ WIZARR_URL ou WIZARR_API_KEY manquant");
      return computeSubscription(null);
    }

    const resp = await fetch(`${wizarrUrl}/api/users`, {
      headers: {
        Accept: "application/json",
        "X-API-Key": apiKey
      }
    });

    console.log("[WIZARR] Response status:", resp.status);

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error("[WIZARR] ❌ API error:", resp.status, errorText);
      throw new Error(`Wizarr API ${resp.status}`);
    }

    const payload = await resp.json();
    console.log("[WIZARR] Payload reçu:", JSON.stringify(payload).substring(0, 200));

    const list =
      Array.isArray(payload) ? payload :
      Array.isArray(payload?.users) ? payload.users :
      Array.isArray(payload?.data) ? payload.data :
      [];

    console.log("[WIZARR] Nombre d'utilisateurs:", list.length);

    const norm = s => (s || "").toLowerCase().trim();
    const plexEmail = norm(user.email);

    console.log("[WIZARR] Cherche email:", plexEmail);

    if (!plexEmail) {
      console.log("[WIZARR] ❌ Email utilisateur Plex manquant");
      return computeSubscription(null);
    }

    const wizUser = list.find(u => {
      const uEmail = norm(u.email);
      console.log("[WIZARR]   Comparaison:", uEmail, "===", plexEmail, "?", uEmail === plexEmail);
      return uEmail === plexEmail;
    }) || null;

    console.log("[WIZARR] Utilisateur trouvé:", !!wizUser);
    if (wizUser) {
      console.log("[WIZARR]   Données:", JSON.stringify(wizUser).substring(0, 200));
    }

    const result = computeSubscription(wizUser);
    console.log("[WIZARR] ✅ Résultat computeSubscription:", result);
    return result;

  } catch (err) {
    console.error("[WIZARR] ❌ Erreur catch:", err.message);
    return computeSubscription(null);
  }
}

/* ===============================
   📄 PAGES
=============================== */

router.get("/dashboard", requireAuth, (req, res) => {
  res.render("dashboard/index", { user: req.session.user, basePath: req.basePath });
});

router.get("/profil", requireAuth, (req, res) => {
  res.render("profil/index", { user: req.session.user, basePath: req.basePath, XP_SYSTEM });
});

router.get("/abonnement", requireAuth, (req, res) => {
  res.render("abonnement/index", { user: req.session.user, basePath: req.basePath });
});

router.get("/statistiques", requireAuth, (req, res) => {
  res.render("statistiques/index", { user: req.session.user, basePath: req.basePath });
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
    res.status(500).json({ error: "Failed to fetch subscription" });
  }
});

/* ===============================
   🔄 API STATS
=============================== */

/* ===============================
   🔄 API STATS (avec timeout)
=============================== */

router.get("/api/stats", requireAuth, async (req, res) => {
  try {
    console.log("[API/STATS] Requête de stats pour user:", req.session.user.username);
    
    // Wrapper pour ajouter un timeout
    const statsWithTimeout = await Promise.race([
      getTautulliStats(
        req.session.user.username,
        process.env.TAUTULLI_URL,
        process.env.TAUTULLI_API_KEY,
        req.session.user.id,
        process.env.PLEX_URL,
        process.env.PLEX_TOKEN,
        req.session.user.joinedAtTimestamp
      ),
      // Timeout après 10 secondes (au lieu de 30s)
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error("TIMEOUT_10S")), 10000)
      )
    ]);

    console.log("[API/STATS] Resultat final:", statsWithTimeout);
    res.json(statsWithTimeout);
    
  } catch (err) {
    if (err.message === "TIMEOUT_10S") {
      console.warn("[API/STATS] Timeout 10s - le cron job mettra a jour en arriere-plan");
      // Retourner un objet par défaut pendant que le cron job travaille
      res.json({
        joinedAt: req.session.user.joinedAtTimestamp ? new Date(req.session.user.joinedAtTimestamp * 1000).toISOString() : null,
        lastActivity: null,
        sessionCount: 0,
        status: "computing",
        message: "Les données des sessions sont en cours de calcul... (rechargez dans quelques minutes)"
      });
    } else {
      console.error("[API/STATS] Erreur:", err.message);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  }
});

/**
 * 📢 ENDPOINT SMART WAIT - Long-polling: Attendre que les données soient prêtes
 * Au lieu de faire 30 polls avec 5 sec chacun, on attend l'événement du serveur
 * TIMEOUT: 5 minutes max (longue requête HTTP)
 */
router.get("/api/stats-wait", requireAuth, async (req, res) => {
  try {
    const username = req.session.user.username;
    console.log("[API/STATS-WAIT] 📢 Demande long-poll pour:", username);
    
    // Attendre que le scan finisse (avec timeout de 5 min)
    const startWait = Date.now();
    await TautulliEvents.waitForScanComplete(300000);  // 5 min max
    const waitDuration = Math.round((Date.now() - startWait) / 1000);
    console.log("[API/STATS-WAIT] ✅ Scan terminé après", waitDuration, 'secondes - Récupération des données...');
    
    // Maintenant récupérer les stats (doivent être en cache)
    const stats = await getTautulliStats(
      username,
      process.env.TAUTULLI_URL,
      process.env.TAUTULLI_API_KEY,
      req.session.user.id,
      process.env.PLEX_URL,
      process.env.PLEX_TOKEN,
      req.session.user.joinedAtTimestamp
    );
    
    if (!stats) {
      console.warn("[API/STATS-WAIT] ⚠️  Aucune donnée trouvée après attente pour:", username);
      return res.status(404).json({ error: "User stats not found" });
    }
    
    console.log("[API/STATS-WAIT] ✅ Données retournées pour:", username);
    res.json(stats);
    
  } catch (err) {
    console.error("[API/STATS-WAIT] ❌ Erreur:", err.message);
    res.status(500).json({ error: "Failed to wait for stats", details: err.message });
  }
});

/* ===============================
   🔄 API FORCE SCAN - Force un scan immédiat de Tautulli
=============================== */

router.post("/api/force-scan", requireAuth, async (req, res) => {
  try {
    console.log("[API/FORCE-SCAN] 🚀 Scan forcé demandé par:", req.session.user.username);
    
    const { scanTautulliHistoryForAllUsers } = require("../utils/tautulli");
    
    const scanStartTime = Date.now();
    const result = await scanTautulliHistoryForAllUsers(
      process.env.TAUTULLI_URL,
      process.env.TAUTULLI_API_KEY
    );
    
    const duration = Math.round((Date.now() - scanStartTime) / 1000);
    
    console.log("[API/FORCE-SCAN] ✅ Scan forcé terminé en", duration, 'secondes');
    
    res.json({
      success: true,
      message: `Scan lancé avec succès - ${Object.keys(result).length} utilisateurs traités en ${duration}s`,
      usersScanned: Object.keys(result).length,
      duration
    });
    
  } catch (err) {
    console.error("[API/FORCE-SCAN] ❌ Erreur:", err.message);
    res.status(500).json({ error: "Failed to force scan", details: err.message });
  }
});

/* ===============================
   🎬 API OVERSEERR
=============================== */

router.get("/api/overseerr", requireAuth, async (req, res) => {
  try {
    const userEmail = req.session.user?.email;
    const username = req.session.user?.username;
    const plexUserId = req.session.user?.id;
    
    if (!userEmail) {
      return res.status(400).json({ error: "No user email in session" });
    }

    // Clé de cache utilisant l'ID Plex pour plus de certitude
    const cacheKey = `overseerr:${plexUserId}`;
    
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
    res.status(500).json({ error: "Failed to invalidate cache" });
  }
});

/* ===============================
   🔄 API GET ALL USERS (pour cron job)
=============================== */

// Endpoint pour récupérer tous les utilisateurs (utilisé par cron job au démarrage)
router.get("/api/all-users", async (req, res) => {
  try {
    const baseUrl = process.env.OVERSEERR_URL || "http://localhost:5055";
    const apiKey = process.env.OVERSEERR_API_KEY;
    
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

    console.log("[API] GET /api/all-users retourne", users.length, "utilisateurs");
    res.json(users);
  } catch (err) {
    console.error("[API] Erreur fetch users:", err.message);
    res.json([]);
  }
});

/* ===============================
   🔄 TAUTULLI SYNC ENDPOINT
=============================== */

/**
 * POST /api/sync-tautulli-history
 * Déclenche un sync de l'historique Tautulli vers SQLite
 * Body optionnel: { limit: 5000 } (0 = pas de limite)
 */
router.post("/api/sync-tautulli-history", requireAuth, async (req, res) => {
  try {
    console.log("[API/SYNC] 🚀 Sync Tautulli démarrée par:", req.session.user?.username);
    
    const limit = req.body?.limit || 5000;  // Par défaut 5000, customisable
    
    // Lancer le sync en background
    const result = await syncTautulliHistoryToDatabase(limit);
    
    if (result.success) {
      res.json({
        success: true,
        message: "Sync Tautulli complétée",
        data: result
      });
    } else {
      res.status(500).json({
        success: false,
        message: "Erreur lors du sync",
        error: result.error
      });
    }
  } catch (err) {
    console.error("[API/SYNC] ❌ Erreur:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

module.exports = router;
