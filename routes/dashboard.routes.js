const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const log = require("../utils/logger");

const { computeSubscription } = require("../utils/wizarr");
const { getTautulliStats } = require("../utils/tautulli");
const { getSeerrStats } = require("../utils/seerr");
const { getPlexJoinDate } = require("../utils/plex");
const { getRadarrCalendar, getSonarrCalendar } = require("../utils/radarr-sonarr");
const { XP_SYSTEM } = require("../utils/xp-system");
const { ACHIEVEMENTS } = require("../utils/achievements");
const { UserAchievementQueries, UserQueries, AchievementProgressQueries } = require("../utils/database");
const { getAchievementUnlockDates, evaluateSecretAchievements, isTautulliReady, getLastPlayedItem } = require("../utils/tautulli-direct");
const CacheManager = require("../utils/cache");
const TautulliEvents = require("../utils/tautulli-events");  // 📢 Import EventEmitter
const { DatabaseMaintenance } = require("../utils/database");  // 🧹 Database maintenance

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

const logWizarr = log.create('[Wizarr]');

async function getWizarrSubscription(user) {
  try {
    const wizarrUrl = process.env.WIZARR_URL;
    const apiKey = process.env.WIZARR_API_KEY;

    if (!wizarrUrl || !apiKey) {
      logWizarr.warn('WIZARR_URL ou WIZARR_API_KEY manquant');
      return computeSubscription(null);
    }

    const resp = await fetch(`${wizarrUrl}/api/users`, {
      headers: { Accept: "application/json", "X-API-Key": apiKey }
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      logWizarr.error(`API HTTP ${resp.status} —`, errorText.slice(0, 120));
      throw new Error(`Wizarr API ${resp.status}`);
    }

    const payload = await resp.json();
    const list =
      Array.isArray(payload) ? payload :
      Array.isArray(payload?.users) ? payload.users :
      Array.isArray(payload?.data) ? payload.data :
      [];

    const norm = s => (s || "").toLowerCase().trim();
    const plexEmail = norm(user.email);

    if (!plexEmail) {
      logWizarr.warn('Email Plex manquant — abonnement ignoré');
      return computeSubscription(null);
    }

    const wizUser = list.find(u => norm(u.email) === plexEmail) || null;

    const result = computeSubscription(wizUser);
    logWizarr.info(`${user.username} — ${result.label}${result.expiresAt ? ` (expire ${result.expiresAt})` : ''}`);
    return result;

  } catch (err) {
    logWizarr.error('Erreur:', err.message);
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

    // Calculer le total XP des succès débloqués
    const totalAchievementsXp = unlockedAchievements.reduce((sum, ach) => sum + (ach.xp || 0), 0);

    res.render("profil/index", {
      user: req.session.user,
      basePath: req.basePath,
      XP_SYSTEM,
      unlockedBadgesCount: unlockedAchievements.length,
      totalBadgesCount: allAchievements.length,
      totalAchievementsXp
    });
  } catch (err) {
    log.create('[Profil]').error(err.message);
    res.render("profil/index", {
      user: req.session.user,
      basePath: req.basePath,
      XP_SYSTEM,
      unlockedBadgesCount: 0,
      totalBadgesCount: 0,
      totalAchievementsXp: 0
    });
  }
});

// Route /abonnement supprimée — infos intégrées dans /profil

router.get("/classement", requireAuth, (req, res) => {
  res.render("classement/index", { user: req.session.user, basePath: req.basePath });
});

router.get("/statistiques", requireAuth, (req, res) => {
  res.render("statistiques/index", { user: req.session.user, basePath: req.basePath });
});

router.get("/mes-stats", requireAuth, (req, res) => {
  res.render("statistiques/mes-stats", { user: req.session.user, basePath: req.basePath });
});

router.get("/succes", requireAuth, async (req, res) => {
  try {
    // ⚡ Rendu instantané depuis la DB uniquement — l'évaluation Tautulli
    //    se fait en arrière-plan via /api/badges-eval (appelé par le client)
    const achievementsByCategory = {
      temporels:   { icon: "🎁", name: "Temporels",   achievements: ACHIEVEMENTS.temporels },
      activites:   { icon: "🔥", name: "Activité",    achievements: ACHIEVEMENTS.activites },
      films:       { icon: "🎬", name: "Films",        achievements: ACHIEVEMENTS.films },
      series:      { icon: "📺", name: "Séries",       achievements: ACHIEVEMENTS.series },
      mensuels:    { icon: "📅", name: "Mensuels",     achievements: ACHIEVEMENTS.mensuels },
      collections: { icon: "🎥", name: "Collections", achievements: ACHIEVEMENTS.collections },
      secrets:     { icon: "🔒", name: "Secrets",     achievements: ACHIEVEMENTS.secrets }
    };

    const username   = req.session.user.username;
    const joinedAtTs = req.session.user.joinedAtTimestamp;

    // Upsert utilisateur en DB (silencieux)
    let dbUserId = null;
    try {
      const dbUser = UserQueries.upsert(
        username,
        req.session.user.id    || null,
        req.session.user.email || null,
        req.session.user.joinedAt || joinedAtTs || null
      );
      dbUserId = dbUser?.id || null;
    } catch(e) {
      try { dbUserId = UserQueries.getByUsername(username)?.id || null; } catch(_) {}
    }

    // Lecture DB uniquement (< 5 ms)
    const userUnlockedMap = dbUserId ? UserAchievementQueries.getForUser(dbUserId) : {};
    const progressMap     = dbUserId ? AchievementProgressQueries.getForUser(dbUserId) : {};

    // Construire les cards depuis l'état DB courant
    for (const category in achievementsByCategory) {
      achievementsByCategory[category].achievements = achievementsByCategory[category].achievements.map(a => ({
        ...a,
        unlocked:     !!userUnlockedMap[a.id],
        unlockedDate: userUnlockedMap[a.id] || null
      }));
    }

    // Stats basées sur la DB (sans recalcul Tautulli)
    const emptyData = { totalHours: 0, movieCount: 0, episodeCount: 0, sessionCount: 0, monthlyHours: 0, nightCount: 0, morningCount: 0, daysSince: 0 };
    const stats_global = ACHIEVEMENTS.getStats(emptyData, userUnlockedMap);

    res.render("succes", {
      user: req.session.user,
      basePath: req.basePath,
      XP_SYSTEM,
      ACHIEVEMENTS: achievementsByCategory,
      stats: stats_global,
      progressMap,
      layout: req.query.embed === '1' ? false : 'layout',
      embed: req.query.embed === '1'
    });
  } catch (err) {
    log.create('[Badges]').error(err.message);
    res.render("succes", {
      user: req.session.user,
      basePath: req.basePath,
      XP_SYSTEM,
      ACHIEVEMENTS: {},
      stats: { total: 0, unlocked: 0, locked: 0, progress: 0 },
      progressMap: {},
      error: "Erreur lors du chargement des achievements",
      layout: req.query.embed === '1' ? false : 'layout',
      embed: req.query.embed === '1'
    });
  }
});

/* ===============================
   📅 CALENDRIER
=============================== */

router.get("/calendrier", requireAuth, (req, res) => {
  res.render("calendrier/index", { user: req.session.user, basePath: req.basePath });
});

/* ===============================
   🏆 API BADGES EVAL (arrière-plan)
   Appellé par le browser après rendu de /succes.
   Fait le vrai calcul Tautulli + retourne les mises à jour.
=============================== */
const logBadges = log.create('[Badges]');

router.get('/api/badges-eval', requireAuth, async (req, res) => {
  try {
    const username   = req.session.user.username;
    const joinedAtTs = req.session.user.joinedAtTimestamp;
    const today      = new Date().toLocaleDateString('fr-FR');

    let dbUserId = null;
    try {
      const dbUser = UserQueries.upsert(username, req.session.user.id||null, req.session.user.email||null, req.session.user.joinedAt||joinedAtTs||null);
      dbUserId = dbUser?.id || null;
    } catch(e) {
      try { dbUserId = UserQueries.getByUsername(username)?.id || null; } catch(_) {}
    }

    const userUnlockedMap = dbUserId ? UserAchievementQueries.getForUser(dbUserId) : {};

    // 1. Stats Tautulli (rapide si DB directe prête)
    const stats = await getTautulliStats(
      username, process.env.TAUTULLI_URL, process.env.TAUTULLI_API_KEY,
      req.session.user.id, process.env.PLEX_URL, process.env.PLEX_TOKEN, joinedAtTs
    );
    const data = {
      totalHours:   stats.watchStats?.totalHours   || 0,
      movieCount:   stats.watchStats?.movieCount   || 0,
      episodeCount: stats.watchStats?.episodeCount || 0,
      sessionCount: stats.sessionCount   || 0,
      monthlyHours: stats.monthlyHours   || 0,
      nightCount:   stats.nightCount     || 0,
      morningCount: stats.morningCount   || 0,
      daysSince: Math.floor((Date.now() - (joinedAtTs * 1000)) / (1000 * 60 * 60 * 24))
    };

    const computedDates = getAchievementUnlockDates(username, joinedAtTs);
    const allAchievements = ACHIEVEMENTS.getAll();
    const newlyUnlocked = {};

    // 2. Succès non-secrets
    for (const a of allAchievements) {
      if (userUnlockedMap[a.id])    continue;
      if (a.isSecret)               continue;
      if (a.category === 'secrets') continue;
      if (a.category === 'collections') continue;
      if (!a.condition(data))       continue;
      const date = computedDates[a.id] || today;
      if (dbUserId) try { UserAchievementQueries.unlock(dbUserId, a.id, date, 'auto'); } catch(e) {}
      newlyUnlocked[a.id] = date;
    }

    // 3. Collections + secrets Tautulli
    const secretsToCheck = [...ACHIEVEMENTS.collections, ...ACHIEVEMENTS.secrets]
      .filter(a => !a.isSecret && (!userUnlockedMap[a.id] || a.revocable)).map(a => a.id);
    const revocableUnlocked = new Set(
      [...ACHIEVEMENTS.collections, ...ACHIEVEMENTS.secrets]
        .filter(a => a.revocable && userUnlockedMap[a.id]).map(a => a.id)
    );
    const newProgress = {};
    const revoked = [];

    if (secretsToCheck.length > 0 && isTautulliReady()) {
      try {
        const evalResult = await Promise.race([
          evaluateSecretAchievements(username, joinedAtTs, secretsToCheck, req.session.user.id),
          new Promise((_, reject) => setTimeout(() => reject(new Error('EVAL_TIMEOUT')), 5000))
        ]);
        const { unlocked: evalUnlocked, progress: evalProgress } = evalResult;
        for (const [id, date] of Object.entries(evalUnlocked)) {
          if (dbUserId) try { UserAchievementQueries.unlock(dbUserId, id, date, 'auto'); } catch(e) {}
          newlyUnlocked[id] = date;
        }
        for (const id of revocableUnlocked) {
          if (!evalUnlocked[id]) {
            if (dbUserId) try { UserAchievementQueries.revoke(dbUserId, id); } catch(e) {}
            revoked.push(id);
          }
        }
        if (evalProgress) {
          for (const [id, prog] of Object.entries(evalProgress)) {
            if (dbUserId) try { AchievementProgressQueries.save(dbUserId, id, prog.current, prog.total); } catch(e) {}
            newProgress[id] = prog;
          }
        }
        if (Object.keys(newlyUnlocked).length > 0)
          logBadges.info(`Débloqués pour ${username}:`, Object.keys(newlyUnlocked).join(', '));
      } catch (err) {
        if (err.message === 'EVAL_TIMEOUT') logBadges.warn(`Timeout eval ${username}`);
        else logBadges.error('badges-eval:', err.message);
      }
    }

    res.json({ unlocked: newlyUnlocked, progress: newProgress, revoked, data });
  } catch (err) {
    logBadges.error('badges-eval crash:', err.message);
    res.status(500).json({ unlocked: {}, progress: {}, revoked: [], data: {} });
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
    log.create('[Stats]').debug('Requête pour:', req.session.user.username);
    
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

    log.create('[Stats]').debug('Résultat:', JSON.stringify(statsWithTimeout));
    res.json(statsWithTimeout);
    
  } catch (err) {
    if (err.message === "TIMEOUT_10S") {
      log.create('[Stats]').warn('Timeout 10s — cron job mettra à jour en arrière-plan');
      // Retourner un objet par défaut pendant que le cron job travaille
      res.json({
        joinedAt: req.session.user.joinedAtTimestamp ? new Date(req.session.user.joinedAtTimestamp * 1000).toISOString() : null,
        lastActivity: null,
        sessionCount: 0,
        status: "computing",
        message: "Les données des sessions sont en cours de calcul... (rechargez dans quelques minutes)"
      });
    } else {
      log.create('[Stats]').error('Erreur:', err.message);
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
    log.create('[Stats]').info('Long-poll démarré pour:', username);
    
    // Attendre que le scan finisse (avec timeout de 5 min)
    const startWait = Date.now();
    await TautulliEvents.waitForScanComplete(300000);  // 5 min max
    const waitDuration = Math.round((Date.now() - startWait) / 1000);
    log.create('[Stats]').info(`Scan terminé après ${waitDuration}s — récupération des données`);
    
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
      log.create('[Stats]').warn('Aucune donnée trouvée après attente pour:', username);
      return res.status(404).json({ error: "User stats not found" });
    }
    
    log.create('[Stats]').debug('Données retournées pour:', username);
    res.json(stats);
    
  } catch (err) {
    log.create('[Stats]').error('Long-poll erreur:', err.message);
    res.status(500).json({ error: "Failed to wait for stats", details: err.message });
  }
});

/* ===============================
   ⭐ API XP-SNAPSHOT (prefetch glow)
   Retourne le rang/niveau calculé de l'user courant.
   Utilisé par layout.ejs pour alimenter le localStorage
   dès la connexion — sans attendre la page Profil.
=============================== */

router.get("/api/xp-snapshot", requireAuth, async (req, res) => {
  try {
    const user         = req.session.user;
    const joinedAtTs   = user.joinedAtTimestamp || 0;
    const daysJoined   = Math.floor((Date.now() - (joinedAtTs * 1000)) / (1000 * 60 * 60 * 24));

    // Stats Tautulli (depuis le cache serveur si déjà calculé, sinon rapide)
    let totalHours = 0;
    try {
      const stats = await Promise.race([
        getTautulliStats(
          user.username, process.env.TAUTULLI_URL, process.env.TAUTULLI_API_KEY,
          user.id, process.env.PLEX_URL, process.env.PLEX_TOKEN, joinedAtTs
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error('XP_TIMEOUT')), 4000))
      ]);
      totalHours = stats?.watchStats?.totalHours || 0;
    } catch (_) {}

    // Badges débloqués et XP (lecture DB ultra-rapide)
    let achievementsXp = 0;
    try {
      const dbUser = UserQueries.getByUsername(user.username);
      if (dbUser) {
        const unlockedMap = UserAchievementQueries.getForUser(dbUser.id);
        const allAchievements = ACHIEVEMENTS.getAll();
        const achievementXpMap = Object.fromEntries(allAchievements.map(a => [a.id, a.xp || 0]));
        achievementsXp = Object.keys(unlockedMap).reduce((sum, id) => sum + (achievementXpMap[id] || 0), 0);
      }
    } catch (err) {
      log.create('[XP-PROFILE-ERROR]').error(`Error getting achievements: ${err.message}`);
    }

    // Calcul XP (même formule que la page Profil) — v1.13: système ultra-optimisé
    const XP_MULTIPLIERS = { HOURS: 10, ANCIENNETE: 1.5 };
    const totalXp      = Math.round(totalHours * XP_MULTIPLIERS.HOURS)
                       + achievementsXp
                       + Math.round(daysJoined * XP_MULTIPLIERS.ANCIENNETE);
    const level    = XP_SYSTEM.getLevel(totalXp);
    const rank     = XP_SYSTEM.getRankByLevel(level);
    const progress = XP_SYSTEM.getProgressToNextLevel(totalXp);

    res.json({
      rank: { color: rank.color, name: rank.name, icon: rank.icon, bgColor: rank.bgColor, borderColor: rank.borderColor },
      level, totalXp,
      progressPercent: progress.progressPercent,
      xpNeeded: progress.xpNeeded
    });
  } catch (err) {
    res.status(500).json({ error: 'xp-snapshot failed' });
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

    log.create('[API]').debug('all-users:', users.length, 'utilisateurs');
    res.json(users);
  } catch (err) {
    log.create('[API]').error('fetch users:', err.message);
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
  log.create('[Admin]').info(`Badge "${achievementId}" révoqué pour ${username}`);
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

    if (!mySession) {
      // Fallback : dernier contenu regardé
      const username = (req.session.user.username || "");
      const last = getLastPlayedItem(username);
      if (!last) return res.json({ playing: false });

      const thumbUrl = last.thumb
        ? (req.basePath || "") + "/api/plex-thumb?path=" + encodeURIComponent(last.thumb)
        : null;

      return res.json({
        playing:      false,
        lastPlayed:   true,
        type:         last.mediaType,
        title:        last.title,
        grandTitle:   last.grandTitle,
        year:         last.year,
        thumb:        thumbUrl,
        stoppedAt:    last.stoppedAt,
      });
    }

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
    log.create('[NowPlaying]').warn(e.message);
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
    log.create('[Plex]').warn(`Thumb — chemin refusé: ${thumbPath}`);
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

/* ===============================
   📚 STATS SERVEUR (librairies Tautulli)
=============================== */
const logSrv = log.create('[ServerStats]');

router.get('/api/server-stats', requireAuth, async (req, res) => {
  const cacheKey = 'server-library-stats';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  const tautulliUrl = (process.env.TAUTULLI_URL || '').replace(/\/$/, '');
  const apiKey      = process.env.TAUTULLI_API_KEY || '';

  if (!tautulliUrl || !apiKey) {
    return res.json({ available: false, reason: 'Tautulli non configuré' });
  }

  try {
    const r = await fetch(`${tautulliUrl}/api/v2?apikey=${apiKey}&cmd=get_libraries`, { timeout: 8000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    const libs = json?.response?.data || [];

    if (!Array.isArray(libs) || libs.length === 0) {
      return res.json({ available: false, reason: 'Aucune librairie Tautulli' });
    }

    const AUDIOBOOK_KEYWORDS = ['audio', 'livre', 'audiobook', 'podcast'];
    const isAudiobook = name => AUDIOBOOK_KEYWORDS.some(k => name.toLowerCase().includes(k));

    let movies = 0, shows = 0, episodes = 0, musicTracks = 0, audiobookCount = 0;

    for (const lib of libs) {
      const type  = lib.section_type;
      const count = parseInt(lib.count, 10)  || 0;
      const child = parseInt(lib.child_count, 10) || 0;

      if (type === 'movie') {
        movies += count;
      } else if (type === 'show') {
        shows    += count;
        episodes += child;
      } else if (type === 'artist') {
        if (isAudiobook(lib.section_name || '')) {
          audiobookCount += child || count;  // child = tracks (chapters)
        } else {
          musicTracks += child || count;     // child = tracks
        }
      }
    }

    const result = { available: true, movies, shows, episodes, musicTracks, audiobookCount };
    cache.set(cacheKey, result, 10 * 60 * 1000); // 10 min
    logSrv.debug(`Films:${movies} Séries:${shows} Épisodes:${episodes} Musiques:${musicTracks} Audiobooks:${audiobookCount}`);
    res.json(result);
  } catch (err) {
    logSrv.warn('Erreur librairies:', err.message);
    res.json({ available: false, reason: err.message });
  }
});

/* ===============================
   📊 MES STATISTIQUES
=============================== */
const logStats = log.create('[MesStats]');

router.get('/api/mes-stats', requireAuth, async (req, res) => {
  try {
    const username = req.session.user.username;
    const cacheKey = `mes_stats_${username}`;
    const cached   = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { getUserDetailedStats, isTautulliReady } = require('../utils/tautulli-direct');
    if (!isTautulliReady()) return res.json({ available: false, reason: 'tautulli_not_ready' });

    const data = getUserDetailedStats(username);
    if (!data) return res.json({ available: false, reason: 'no_data' });

    const result = { available: true, ...data };
    cache.set(cacheKey, result, 10 * 60 * 1000); // 10 min
    logStats.debug(`Stats générées pour ${username}`);
    res.json(result);
  } catch (err) {
    logStats.error('API mes-stats:', err.message);
    res.status(500).json({ error: 'mes-stats failed' });
  }
});

/* ===============================
   🏆 CLASSEMENT (Leaderboard)
=============================== */
const logLB = log.create('[Classement]');

router.get('/api/classement', requireAuth, async (req, res) => {
  try {
    const cacheKey = 'classement_data';
    // 🔍 DEBUG: Forcer le recalcul (ignorer le cache)
    const cached   = req.query.skipCache ? null : cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { getAllUserStatsFromTautulli, isTautulliReady } = require('../utils/tautulli-direct');
    const tautulliStats = isTautulliReady() ? getAllUserStatsFromTautulli() : [];

    // Thumbs Plex via XML plex.tv/api/users (admin token)
    const plexToken = process.env.PLEX_TOKEN || '';
    const thumbMap  = {}; // username.lower → thumb URL

    try {
      // owner thumb
      const ownerResp = await fetch('https://plex.tv/api/v2/user', {
        headers: { 'X-Plex-Token': plexToken, 'Accept': 'application/json' },
        timeout: 6000
      });
      if (ownerResp.ok) {
        const od = await ownerResp.json();
        if (od.username && od.thumb) thumbMap[od.username.toLowerCase()] = od.thumb;
      }
    } catch (_) {}

    try {
      const xmlResp = await fetch('https://plex.tv/api/users', {
        headers: { 'X-Plex-Token': plexToken, 'Accept': 'application/xml' },
        timeout: 6000
      });
      if (xmlResp.ok) {
        const xml = await xmlResp.text();
        const blockRe = /<User\s[\s\S]*?(?:\/>|<\/User>)/g;
        const attrRe  = /(\w+)="([^"]*)"/g;
        let bm;
        while ((bm = blockRe.exec(xml)) !== null) {
          const openTag = bm[0].match(/<User\s([^>]+)/);
          if (!openTag) continue;
          const attrs = {};
          let am;
          attrRe.lastIndex = 0;
          while ((am = attrRe.exec(openTag[1])) !== null) attrs[am[1]] = am[2];
          const name = (attrs.title || attrs.username || '').toLowerCase();
          if (name && attrs.thumb) thumbMap[name] = attrs.thumb;
        }
      }
    } catch (_) {}

    const XP_M = { HOURS: 10, ANCIENNETE: 1.5 }; // v1.13: système ultra-optimisé
    const now  = Date.now();
    const allAchievements = ACHIEVEMENTS.getAll();
    const achievementXpMap = Object.fromEntries(allAchievements.map(a => [a.id, a.xp || 0]));

    const users = tautulliStats.map(stats => {
      const key    = (stats.username || '').toLowerCase();
      // FIX: Use UserQueries.getByUsername() instead of dbMap to ensure consistency with profile route
      const dbUser = UserQueries.getByUsername(stats.username) || null;

      let badgeCount = 0;
      let achievementsXp = 0;
      if (dbUser) {
        try {
          const unlockedMap = UserAchievementQueries.getForUser(dbUser.id);
          badgeCount = Object.keys(unlockedMap).length;
          achievementsXp = Object.keys(unlockedMap).reduce((sum, id) => sum + (achievementXpMap[id] || 0), 0);
        } catch (err) {
          logLB.error(`Error getting achievements for ${key}: ${err.message}`);
        }
      }

      // 🔧 FIX: Calculer daysJoined de manière cohérente avec le profil
      // Source: dbUser.joinedAt (stocké via user.joinedAt de Plex lors de la connexion)
      let daysJoined = 0;
      if (dbUser && dbUser.joinedAt) {
        // joinedAt peut être un timestamp (en secondes) ou une ISO string
        const ts = Number(dbUser.joinedAt);
        const ms = !isNaN(ts) && ts > 1e8 ? ts * 1000 : new Date(dbUser.joinedAt).getTime();
        if (!isNaN(ms)) daysJoined = Math.max(0, Math.floor((now - ms) / 86400000));
      }

      const totalHours = stats.totalHours || 0;
      const totalXp    = Math.round(totalHours * XP_M.HOURS) + achievementsXp + Math.round(daysJoined * XP_M.ANCIENNETE);
      const level      = XP_SYSTEM.getLevel(totalXp);
      const rank       = XP_SYSTEM.getRankByLevel(level);
      const thumb      = thumbMap[key] || null;

      return { username: stats.username, thumb, totalHours, totalXp, level,
               rank: { name: rank.name, icon: rank.icon, color: rank.color, bgColor: rank.bgColor, borderColor: rank.borderColor },
               badgeCount };
    });

    const byHours = [...users].sort((a, b) => b.totalHours - a.totalHours);
    const byLevel = [...users].sort((a, b) => b.level - a.level || b.totalXp - a.totalXp);

    const result = { byHours, byLevel };
    cache.set(cacheKey, result, 30 * 1000); // 30 secondes (synchro avec profil)
    logLB.debug(`Classement généré: ${users.length} users`);
    res.json(result);
  } catch (err) {
    logLB.error('API classement:', err.message);
    res.status(500).json({ error: 'classement failed' });
  }
});

/* ===============================
   📅 API CALENDRIER (Radarr + Sonarr)
=============================== */

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function plusDaysISO(iso, n) {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

router.get("/api/calendar", requireAuth, async (req, res) => {
  const start = req.query.start || todayISO();
  const end   = req.query.end   || plusDaysISO(start, 30);
  const cacheKey = `calendar:${start}:${end}`;

  try {
    const data = await cache.getOrSet(cacheKey, async () => {
      const [movies, episodes] = await Promise.all([
        getRadarrCalendar(process.env.RADARR_URL, process.env.RADARR_API_KEY, start, end).catch(() => []),
        getSonarrCalendar(process.env.SONARR_URL, process.env.SONARR_API_KEY, start, end).catch(() => [])
      ]);
      return [...movies, ...episodes].sort((a, b) => a.date.localeCompare(b.date));
    }, 5 * 60 * 1000);  // cache 5 min

    res.json({ events: data, start, end });
  } catch (err) {
    log.create('[Calendrier]').error(err.message);
    res.status(500).json({ error: err.message, events: [] });
  }
});

/* ===============================
   📦 VERSION & CHANGELOG
=============================== */

router.get('/api/version', (req, res) => {
  try {
    const { version } = require('../package.json');
    res.json({ version });
  } catch (err) {
    res.status(500).json({ error: 'Could not read version' });
  }
});

router.get('/api/changelog', (_, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const changelogPath = path.join(__dirname, '../CHANGELOG.md');
    const changelog = fs.readFileSync(changelogPath, 'utf8');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(changelog);
  } catch (err) {
    res.status(404).json({ error: 'Changelog not found' });
  }
});

router.get('/api/version-badge.svg', (_, res) => {
  try {
    const { version } = require('../package.json');

    // SVG badge dynamique basé sur package.json
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="114" height="20" role="img" aria-label="Version: ${version}">
      <title>Version: ${version}</title>
      <linearGradient id="s" x2="0" y2="100%">
        <stop offset="0" stop-color="#bbb"/>
        <stop offset="1" stop-color="#999"/>
      </linearGradient>
      <clipPath id="r">
        <rect width="114" height="20" rx="3" fill="#fff"/>
      </clipPath>
      <g clip-path="url(#r)">
        <rect width="75" height="20" fill="#555"/>
        <rect x="75" width="39" height="20" fill="#34d399"/>
        <rect width="114" height="20" fill="url(#s)"/>
      </g>
      <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
        <text aria-hidden="true" x="385" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="650">Version</text>
        <text x="385" y="140" transform="scale(.1)" fill="#fff" textLength="650">Version</text>
        <text aria-hidden="true" x="935" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="290">${version}</text>
        <text x="935" y="140" transform="scale(.1)" fill="#fff" textLength="290">${version}</text>
      </g>
    </svg>`;

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(svg);
  } catch (err) {
    res.status(500).json({ error: 'Could not generate version badge' });
  }
});

/* ===============================
   🧹 DATABASE MAINTENANCE
=============================== */

/**
 * POST /api/maintenance/database
 * Lance une maintenance manuelle de la base de données
 * (nettoyage des anciennes données, optimisation)
 */
router.post('/api/maintenance/database', requireAuth, async (req, res) => {
  try {
    const logMaint = log.create('[API-Maintenance]');
    logMaint.info('Maintenance manuelle lancée par', req.session.user?.username || 'unknown');

    const result = DatabaseMaintenance.runFullMaintenance();

    res.json({
      success: true,
      message: 'Maintenance complète exécutée avec succès',
      details: result
    });
  } catch (err) {
    log.create('[API-Maintenance]').error('Erreur maintenance:', err.message);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la maintenance: ' + err.message
    });
  }
});

module.exports = router;
