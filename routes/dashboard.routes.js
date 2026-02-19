const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");

const { computeSubscription } = require("../utils/wizarr");
const { getTautulliStats } = require("../utils/tautulli");
const { getOverseerrStats } = require("../utils/overseerr");
const { getPlexJoinDate } = require("../utils/plex");
const { XP_SYSTEM } = require("../utils/xp-system");
const { ACHIEVEMENTS } = require("../utils/achievements");
const { UserAchievementQueries, UserQueries, AchievementProgressQueries } = require("../utils/database");
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

// Route /abonnement supprimée — infos intégrées dans /profil

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
      collections: { icon: "🎥", name: "Collections", achievements: ACHIEVEMENTS.collections },
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
    // ── 1b. Progression des badges collection (depuis dernière évaluation)
    const progressMap = dbUserId ? AchievementProgressQueries.getForUser(dbUserId) : {};

    // ── 2. Évaluer les succès NON-SECRETS (conditions sur data)
    const allAchievements = ACHIEVEMENTS.getAll();
    const computedDates = getAchievementUnlockDates(username, joinedAtTs);

    for (const a of allAchievements) {
      if (userUnlockedMap[a.id]) continue;          // déjà en cache → skip
      if (a.isSecret) continue;                     // secrets via Tautulli uniquement
      if (a.category === 'secrets') continue;       // secrets auto traités ci-dessous
      if (a.category === 'collections') continue;   // collections auto traités via Tautulli
      if (!a.condition(data)) continue;             // condition non remplie → skip
      const date = computedDates[a.id] || today;
      if (dbUserId) {
        try { UserAchievementQueries.unlock(dbUserId, a.id, date, 'auto'); } catch(e) {}
      }
      userUnlockedMap[a.id] = date;                 // toujours afficher même sans DB
    }

    // ── 3. Évaluer les succès secrets en ARRIÈRE-PLAN (ne bloque pas le rendu)
    // Les badges revocable (collection) sont TOUJOURS re-évalués même si déjà débloqués
    // Les badges événementiels (minuit, week-end...) ne sont évalués que s'ils ne sont pas encore débloqués
    const secretsToCheck = [...ACHIEVEMENTS.collections, ...ACHIEVEMENTS.secrets]
      .filter(a => !a.isSecret && (!userUnlockedMap[a.id] || a.revocable))
      .map(a => a.id);

    // IDs des badges revocable déjà débloqués (pour détecter les régressions)
    const revocableUnlocked = new Set(
      [...ACHIEVEMENTS.collections, ...ACHIEVEMENTS.secrets]
        .filter(a => a.revocable && userUnlockedMap[a.id])
        .map(a => a.id)
    );

    if (secretsToCheck.length > 0 && isTautulliReady()) {
      // Lancer sans await : rendu immédiat, unlock/revoke persisté pour la prochaine visite
      evaluateSecretAchievements(username, joinedAtTs, secretsToCheck, req.session.user.id)
        .then(({ unlocked: newSecrets, progress: newProgress }) => {
          // Débloquer les nouveaux succès
          for (const [id, date] of Object.entries(newSecrets)) {
            if (dbUserId) {
              try { UserAchievementQueries.unlock(dbUserId, id, date, 'auto'); } catch(e) {}
            }
          }
          // Révoquer les badges revocable qui ne sont plus remplis
          for (const id of revocableUnlocked) {
            if (!newSecrets[id] && dbUserId) {
              try {
                UserAchievementQueries.revoke(dbUserId, id);
                console.log(`[BADGES] 🔒 Badge "${id}" révoqué pour ${username} (condition non remplie)`);
              } catch(e) {}
            }
          }
          // Sauvegarder la progression des badges collection
          if (dbUserId && newProgress) {
            for (const [id, prog] of Object.entries(newProgress)) {
              try { AchievementProgressQueries.save(dbUserId, id, prog.current, prog.total); } catch(e) {}
            }
          }
          if (Object.keys(newSecrets).length > 0) {
            console.log(`[BADGES] 🔓 Secrets débloqués en background pour ${username}:`, Object.keys(newSecrets).join(', '));
          }
        })
        .catch(e => console.error('[BADGES] Erreur secrets background:', e.message));
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
      stats: stats_global,
      progressMap
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
   ️ CACHE INVALIDATION
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
    ADMIN: Révoquer un badge
=============================== */
router.delete("/api/admin/achievement/:achievementId", requireAuth, (req, res) => {
  const { UserAchievementQueries, UserQueries } = require('../utils/database');
  const username = req.session.user.username;
  const user = UserQueries.getByUsername(username);
  if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
  const { achievementId } = req.params;
  UserAchievementQueries.revoke(user.id, achievementId);
  console.log(`[ADMIN] 🗑️  Badge "${achievementId}" révoqué pour ${username}`);
  res.json({ success: true, revoked: achievementId });
});

module.exports = router;
