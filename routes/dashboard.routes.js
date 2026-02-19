const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");

const { computeSubscription } = require("../utils/wizarr");
const { getTautulliStats } = require("../utils/tautulli");
const { getOverseerrStats } = require("../utils/overseerr");
const { getPlexJoinDate } = require("../utils/plex");
const { XP_SYSTEM } = require("../utils/xp-system");
const { ACHIEVEMENTS } = require("../utils/achievements");
const { UserAchievementQueries, UserQueries } = require("../utils/database");
const { getAchievementUnlockDates, evaluateSecretAchievements, isTautulliReady } = require("../utils/tautulli-direct");
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

router.get("/profil", requireAuth, async (req, res) => {
  try {
    // Récupérer les stats de l'utilisateur
    const stats = await getTautulliStats(
      req.session.user.username,
      process.env.TAUTULLI_URL,
      process.env.TAUTULLI_API_KEY,
      req.session.user.id,
      process.env.PLEX_URL,
      process.env.PLEX_TOKEN,
      req.session.user.joinedAtTimestamp
    );

    // Préparer les données pour les achievements
    const data = {
      totalHours: stats.watchStats?.totalHours || 0,
      movieCount: stats.watchStats?.movieCount || 0,
      episodeCount: stats.watchStats?.episodeCount || 0,
      sessionCount: stats.sessionCount || 0,
      monthlyHours: stats.monthlyHours || 0,
      nightCount: stats.nightCount || 0,
      morningCount: stats.morningCount || 0,
      daysSince: Math.floor((Date.now() - (req.session.user.joinedAtTimestamp * 1000)) / (1000 * 60 * 60 * 24))
    };

    // Compter les badges débloqués (avec succ\u00e8s manuels depuis la DB)
    const dbUser = UserQueries.upsert(
      req.session.user.username,
      req.session.user.id || null,
      req.session.user.email || null,
      req.session.user.joinedAt || req.session.user.joinedAtTimestamp || null
    );
    const userUnlockedMap = dbUser ? UserAchievementQueries.getForUser(dbUser.id) : {};
    const unlockedAchievements = ACHIEVEMENTS.getUnlocked(data, userUnlockedMap);
    const allAchievements = ACHIEVEMENTS.getAll();

    res.render("profil/index", {
      user: req.session.user,
      basePath: req.basePath,
      XP_SYSTEM,
      unlockedBadgesCount: unlockedAchievements.length,
      totalBadgesCount: allAchievements.length
    });
  } catch (err) {
    console.error("[PROFIL] Erreur:", err.message);
    res.render("profil/index", {
      user: req.session.user,
      basePath: req.basePath,
      XP_SYSTEM,
      unlockedBadgesCount: 0,
      totalBadgesCount: 0
    });
  }
});

router.get("/abonnement", requireAuth, (req, res) => {
  res.render("abonnement/index", { user: req.session.user, basePath: req.basePath });
});

router.get("/statistiques", requireAuth, (req, res) => {
  res.render("statistiques/index", { user: req.session.user, basePath: req.basePath });
});

router.get("/badges", requireAuth, async (req, res) => {
  try {
    // Récupérer les stats de l'utilisateur
    const stats = await getTautulliStats(
      req.session.user.username,
      process.env.TAUTULLI_URL,
      process.env.TAUTULLI_API_KEY,
      req.session.user.id,
      process.env.PLEX_URL,
      process.env.PLEX_TOKEN,
      req.session.user.joinedAtTimestamp
    );

    // Préparer les données pour les achievements
    const data = {
      totalHours: stats.watchStats?.totalHours || 0,
      movieCount: stats.watchStats?.movieCount || 0,
      episodeCount: stats.watchStats?.episodeCount || 0,
      sessionCount: stats.sessionCount || 0,
      monthlyHours: stats.monthlyHours || 0,
      nightCount: stats.nightCount || 0,
      morningCount: stats.morningCount || 0,
      daysSince: Math.floor((Date.now() - (req.session.user.joinedAtTimestamp * 1000)) / (1000 * 60 * 60 * 24))
    };

    // Structurer les achievements par catégorie
    const achievementsByCategory = {
      temporels: { icon: "🎁", name: "Temporels", achievements: ACHIEVEMENTS.temporels },
      activites: { icon: "🔥", name: "Activité", achievements: ACHIEVEMENTS.activites },
      films: { icon: "🎬", name: "Films", achievements: ACHIEVEMENTS.films },
      series: { icon: "📺", name: "Séries", achievements: ACHIEVEMENTS.series },
      mensuels: { icon: "📅", name: "Mensuels", achievements: ACHIEVEMENTS.mensuels },
      secrets: { icon: "🔒", name: "Secrets", achievements: ACHIEVEMENTS.secrets }
    };

    const userId = req.session.user.id;
    const username = req.session.user.username;
    const joinedAtTs = req.session.user.joinedAtTimestamp;
    const today = new Date().toLocaleDateString('fr-FR');

    // S'assurer que l'utilisateur existe dans notre DB (upsert silencieux)
    let dbUserId = null;
    try {
      const dbUser = UserQueries.upsert(
        username,
        req.session.user.id || null,
        req.session.user.email || null,
        req.session.user.joinedAt || joinedAtTs || null
      );
      dbUserId = dbUser ? dbUser.id : null;
    } catch(e) {
      // Fallback: lecture seule si upsert échoue
      try { dbUserId = UserQueries.getByUsername(username)?.id || null; } catch(_) {}
    }

    // ── 1. Unlocks déjà en cache DB (rapide, aucune requête Tautulli)
    const userUnlockedMap = dbUserId ? UserAchievementQueries.getForUser(dbUserId) : {};

    // ── 2. Évaluer les succès NON-SECRETS (conditions sur data)
    const allAchievements = ACHIEVEMENTS.getAll();
    const computedDates = getAchievementUnlockDates(username, joinedAtTs);

    for (const a of allAchievements) {
      if (userUnlockedMap[a.id]) continue;          // déjà en cache → skip
      if (a.isSecret) continue;                     // secrets via Tautulli uniquement
      if (a.category === 'secrets') continue;       // secrets auto traités ci-dessous
      if (!a.condition(data)) continue;             // condition non remplie → skip
      const date = computedDates[a.id] || today;
      if (dbUserId) {
        try { UserAchievementQueries.unlock(dbUserId, a.id, date, 'auto'); } catch(e) {}
      }
      userUnlockedMap[a.id] = date;                 // toujours afficher même sans DB
    }

    // ── 3. Évaluer les succès secrets auto-détectables non encore en DB
    const secretsToCheck = ACHIEVEMENTS.secrets
      .filter(a => !a.isSecret && !userUnlockedMap[a.id])
      .map(a => a.id);

    if (secretsToCheck.length > 0 && isTautulliReady()) {
      const newSecrets = evaluateSecretAchievements(username, joinedAtTs, secretsToCheck);
      for (const [id, date] of Object.entries(newSecrets)) {
        if (dbUserId) {
          try { UserAchievementQueries.unlock(dbUserId, id, date, 'auto'); } catch(e) {}
        }
        userUnlockedMap[id] = date;                 // toujours afficher même sans DB
      }
    }

    // ── 4. Construire les cards avec statut et date
    for (const category in achievementsByCategory) {
      achievementsByCategory[category].achievements = achievementsByCategory[category].achievements.map(achievement => ({
        ...achievement,
        unlocked: !!userUnlockedMap[achievement.id],
        unlockedDate: userUnlockedMap[achievement.id] || null
      }));
    }

    // Obtenir les stats globales
    const stats_global = ACHIEVEMENTS.getStats(data, userUnlockedMap);

    res.render("badges", {
      user: req.session.user,
      basePath: req.basePath,
      XP_SYSTEM,
      ACHIEVEMENTS: achievementsByCategory,
      stats: stats_global
    });
  } catch (err) {
    console.error("[BADGES] Erreur:", err.message);
    res.render("badges", {
      user: req.session.user,
      basePath: req.basePath,
      XP_SYSTEM,
      ACHIEVEMENTS: {},
      stats: { total: 0, unlocked: 0, locked: 0, progress: 0 },
      error: "Erreur lors du chargement des achievements"
    });
  }
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
 * Recharge les données depuis la DB Tautulli directe
 */
router.post("/api/sync-tautulli-history", requireAuth, async (req, res) => {
  try {
    console.log("[API/SYNC] 🚀 Rechargement des données Tautulli par:", req.session.user?.username);
    
    const { getAllUserStatsFromTautulli, isTautulliReady } = require("../utils/tautulli-direct");
    
    if (!isTautulliReady()) {
      return res.status(503).json({
        success: false,
        message: "Tautulli DB non disponible - vérifiez TAUTULLI_DB_PATH"
      });
    }
    
    const startTime = Date.now();
    const allStats = getAllUserStatsFromTautulli();
    const durationMs = Date.now() - startTime;
    
    if (!allStats || allStats.length === 0) {
      return res.status(500).json({
        success: false,
        message: "Aucune stat trouvée dans Tautulli"
      });
    }
    
    res.json({
      success: true,
      message: "Données rechargées depuis Tautulli DB",
      data: {
        usersCount: allStats.length,
        durationMs: durationMs,
        stats: allStats
      }
    });
  } catch (err) {
    console.error("[API/SYNC] ❌ Erreur:", err.message);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

/* ===============================
   🔍 DEBUG SECRETS (dev only)
=============================== */
router.get("/api/debug/secrets", requireAuth, (req, res) => {
  const { isTautulliReady } = require("../utils/tautulli-direct");
  const { getDb } = require("../utils/database");
  if (!isTautulliReady()) return res.json({ error: 'Tautulli DB non disponible' });

  const Database = require('better-sqlite3');
  const tDb = new Database(process.env.TAUTULLI_DB_PATH, { readonly: true });
  const norm = (req.session.user.username || '').toLowerCase();
  const out = {};

  // Test 1 : session_history_metadata existe ?
  try {
    const sample = tDb.prepare(`SELECT id, title FROM session_history_metadata LIMIT 5`).all();
    out.metadata_sample = sample;
  } catch(e) { out.metadata_error = e.message; }

  // Test 2 : Films regardés par cet utilisateur (via metadata)
  try {
    const movies = tDb.prepare(`
      SELECT shm.title, sh.media_type, sh.stopped
      FROM session_history sh
      JOIN users u ON sh.user_id = u.user_id
      JOIN session_history_metadata shm ON sh.id = shm.id
      WHERE LOWER(u.username) = ? AND sh.media_type = 'movie'
      ORDER BY sh.stopped DESC LIMIT 20
    `).all(norm);
    out.movies_via_metadata = movies;
  } catch(e) { out.movies_via_metadata_error = e.message; }

  // Test 3 : Films regardés via rating_key (fallback)
  try {
    const movies2 = tDb.prepare(`
      SELECT sh.rating_key, sh.media_type, sh.stopped
      FROM session_history sh
      JOIN users u ON sh.user_id = u.user_id
      WHERE LOWER(u.username) = ? AND sh.media_type = 'movie'
      ORDER BY sh.stopped DESC LIMIT 20
    `).all(norm);
    out.movies_via_session_history = movies2;
  } catch(e) { out.movies_session_error = e.message; }

  // Test 4 : Chercher Harry Potter spécifiquement
  try {
    const hp = tDb.prepare(`
      SELECT shm.title, sh.stopped
      FROM session_history sh
      JOIN users u ON sh.user_id = u.user_id
      JOIN session_history_metadata shm ON sh.id = shm.id
      WHERE LOWER(u.username) = ? AND LOWER(shm.title) LIKE 'harry potter%'
    `).all(norm);
    out.harry_potter = hp;
  } catch(e) { out.harry_potter_error = e.message; }

  // Test 5 : Tables disponibles dans la DB Tautulli
  try {
    const tables = tDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
    out.tables = tables.map(t => t.name);
  } catch(e) { out.tables_error = e.message; }

  tDb.close();
  res.json(out);
});

module.exports = router;
