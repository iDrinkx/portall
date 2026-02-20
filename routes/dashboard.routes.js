const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");

const { computeSubscription } = require("../utils/wizarr");
const { getTautulliStats } = require("../utils/tautulli");
const { getSeerrStats } = require("../utils/seerr");
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

    // ── 3. Évaluer les collections + secrets avec timeout 4 s
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
      // Await avec timeout de 4 s : si Tautulli répond, on a les données fraîches pour le rendu.
      // Si timeout dépassé, on tombe sur le progressMap DB (comportement précédent).
      try {
        const evalResult = await Promise.race([
          evaluateSecretAchievements(username, joinedAtTs, secretsToCheck, req.session.user.id),
          new Promise((_, reject) => setTimeout(() => reject(new Error('EVAL_TIMEOUT')), 4000))
        ]);

        const { unlocked: newSecrets, progress: newProgress } = evalResult;

        // Débloquer / révoquer en DB
        for (const [id, date] of Object.entries(newSecrets)) {
          if (dbUserId) try { UserAchievementQueries.unlock(dbUserId, id, date, 'auto'); } catch(e) {}
          userUnlockedMap[id] = date; // visible immédiatement dans le rendu
        }
        for (const id of revocableUnlocked) {
          if (!newSecrets[id] && dbUserId) {
            try { UserAchievementQueries.revoke(dbUserId, id); } catch(e) {}
            delete userUnlockedMap[id];
          }
        }
        // Sauvegarder la progression et fusionner dans progressMap pour le rendu
        if (newProgress) {
          for (const [id, prog] of Object.entries(newProgress)) {
            if (dbUserId) try { AchievementProgressQueries.save(dbUserId, id, prog.current, prog.total); } catch(e) {}
            progressMap[id] = { current: prog.current, total: prog.total }; // merge dans le rendu
          }
        }
        if (Object.keys(newSecrets).length > 0) {
          console.log(`[BADGES] 🔓 Secrets débloqués pour ${username}:`, Object.keys(newSecrets).join(', '));
        }
      } catch (evalErr) {
        if (evalErr.message === 'EVAL_TIMEOUT') {
          console.warn(`[BADGES] ⏱ Timeout évaluation collections pour ${username} — rendu avec cache DB`);
        } else {
          console.error('[BADGES] Erreur évaluation secrets:', evalErr.message);
        }
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
   🎬 API SEERR
=============================== */

router.get("/api/seerr", requireAuth, async (req, res) => {
  try {
    const userEmail = req.session.user?.email;
    const username = req.session.user?.username;
    const plexUserId = req.session.user?.id;
    
    if (!userEmail) {
      return res.status(400).json({ error: "No user email in session" });
    }

    // Clé de cache utilisant l'ID Plex pour plus de certitude
    const cacheKey = `seerr:${plexUserId}`;
    
    const seerr = await cache.getOrSet(
      cacheKey,
      () => getSeerrStats(
        userEmail,
        username,
        process.env.SEERR_URL,
        process.env.SEERR_API_KEY
      ),
      60 * 1000 // 60 secondes
    );

    res.json(seerr || {});
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch seerr data" });
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
    cache.invalidate(`seerr:${userId}`);
    
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
    const baseUrl = process.env.SEERR_URL || "http://localhost:5055";
    const apiKey = process.env.SEERR_API_KEY;
    
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

/* ===============================
   🎵 NOW PLAYING
=============================== */
router.get("/api/now-playing", requireAuth, async (req, res) => {
  const plexUrl   = (process.env.PLEX_URL   || "").replace(/\/$/, "");
  const plexToken = process.env.PLEX_TOKEN || "";
  if (!plexUrl || !plexToken) return res.json({ playing: false });

  try {
    const r = await fetch(`${plexUrl}/status/sessions`, {
      headers: { "X-Plex-Token": plexToken, "Accept": "application/json" },
      timeout: 5000
    });
    if (!r.ok) return res.json({ playing: false });
    const json = await r.json();
    const sessions = json?.MediaContainer?.Metadata || [];

    // Trouver la session de l'utilisateur connecté (par username ou titre)
    const username = (req.session.user.username || "").toLowerCase();
    const userId   = req.session.user.id;

    const mySession = sessions.find(s => {
      const su = (s.User?.title || "").toLowerCase();
      const sid = String(s.User?.id || "");
      return su === username || sid === String(userId);
    });

    if (!mySession) return res.json({ playing: false });

    const duration    = mySession.duration || 0;
    const viewOffset  = mySession.viewOffset || 0;
    const progressPct = duration > 0 ? Math.round((viewOffset / duration) * 100) : 0;

    const thumb = mySession.thumb
      ? (req.basePath || "") + "/api/plex-thumb?path=" + encodeURIComponent(mySession.thumb)
      : null;

    res.json({
      playing:      true,
      state:        mySession.Player?.state || "playing",   // playing | paused | buffering
      type:         mySession.type,                          // episode | movie | track
      title:        mySession.title || "",
      grandTitle:   mySession.grandparentTitle || "",        // Série ou artiste
      year:         mySession.year || null,
      thumb,
      progressPct,
      player:       mySession.Player?.title || "",           // nom de l'appareil
    });
  } catch (e) {
    console.warn("[NowPlaying] Erreur:", e.message);
    res.json({ playing: false });
  }
});

/* ===============================
   🖼️ PROXY MINIATURE PLEX
   Le browser ne peut pas accéder à l'URL interne plex:32400.
   On proxifie l'image côté serveur et on la renvoie au browser.
=============================== */
router.get("/api/plex-thumb", requireAuth, async (req, res) => {
  const plexUrl   = (process.env.PLEX_URL   || "").replace(/\/$/, "");
  const plexToken = process.env.PLEX_TOKEN  || "";
  const thumbPath = req.query.path;
  if (!plexUrl || !plexToken || !thumbPath) return res.status(400).end();

  // Validation anti-SSRF : le chemin doit commencer par /library/ ou /photo/
  // et ne pas contenir de séquences de traversal
  const allowedPrefixes = ["/library/", "/photo/"];
  const isAllowed = allowedPrefixes.some(p => thumbPath.startsWith(p));
  const hasTraversal = /(\.\.|%2e%2e|%252e)/i.test(thumbPath);
  if (!isAllowed || hasTraversal) {
    console.warn(`[Plex-Thumb] ⛔ Chemin refusé: ${thumbPath}`);
    return res.status(400).end();
  }

  try {
    const r = await fetch(`${plexUrl}${thumbPath}?X-Plex-Token=${plexToken}`, { timeout: 8000 });
    if (!r.ok) return res.status(404).end();
    const ct = r.headers.get("content-type") || "";
    // N'accepter que des images en réponse
    if (!ct.startsWith("image/")) return res.status(400).end();
    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=60");
    r.body.pipe(res);
  } catch (e) {
    res.status(502).end();
  }
});

module.exports = router;
