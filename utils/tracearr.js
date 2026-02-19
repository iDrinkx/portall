const fetch = require("node-fetch");
const { getPlexJoinDate } = require("./plex");
const SessionStatsCache = require("./session-stats-cache");
const TracearrEvents = require("./tracearr-events");  // 📢 EventEmitter pour notifier clients

// 🚩 Charger le cache au démarrage (pour détection δelta intelligente)
const cachedDataAtBoot = SessionStatsCache.getAll();
console.log("[TRACEARR-BOOT] 💾 Cache chargé au démarrage avec", Object.keys(cachedDataAtBoot).length, 'utilisateurs');

// 🚩 Drapeau pour indiquer qu'un scan global est en cours
let GLOBAL_SCAN_IN_PROGRESS = false;

// 🚩 Validation robuste des durées
const DURATION_VALIDATION = {
  MAX_SESSION_DURATION_MS: 12 * 60 * 60 * 1000,  // 12 heures max par session
  MIN_SESSION_DURATION_MS: 0,                      // 0 ms minimum
  
  isValid: function(durationMs) {
    return isFinite(durationMs) && 
           durationMs >= this.MIN_SESSION_DURATION_MS && 
           durationMs <= this.MAX_SESSION_DURATION_MS;
  },
  
  sanitize: function(durationMs) {
    if (!this.isValid(durationMs)) {
      if (durationMs > this.MAX_SESSION_DURATION_MS) {
        console.warn("[TRACEARR-DURATION] ⚠️  Durée aberrante rejetée:", durationMs, "ms (>12h)");
      }
      return 0;  // Retourner 0 au lieu de rejeter la session
    }
    return durationMs;
  }
};

/**
 * Compte les sessions ET calcule les stats complètes (heures, films, épisodes)
 */
async function countSessionsOptimized(username, TRACEARR_URL, TRACEARR_API_KEY) {
  try {
    console.log("[TRACEARR] Comptage OPTIMISE des sessions pour:", username);
    
    const cached = SessionStatsCache.get(username);
    const lastSessionTimestamp = cached?.lastSessionTimestamp || null;
    const previousCount = cached?.sessionCount || 0;
    
    console.log("[TRACEARR] Cache precedent - count:", previousCount, "lastSessionTimestamp:", lastSessionTimestamp);
    
    let historyPage = 1;
    let historyTotalPages = 1;
    let newSessionCount = 0;
    let latestSessionTime = lastSessionTimestamp;
    let pageSize = 100;
    
    // Compteurs pour les heures et types de contenu
    let totalDurationMs = 0;
    let movieDurationMs = 0;
    let episodeDurationMs = 0;
    let movieCount = 0;
    let episodeCount = 0;

    while (historyPage <= historyTotalPages) {
      const histRes = await fetch(
        `${TRACEARR_URL}/api/v1/public/history?page=${historyPage}&pageSize=${pageSize}`,
        {
          headers: {
            Authorization: `Bearer ${TRACEARR_API_KEY}`,
            Accept: "application/json"
          }
        }
      );

      if (!histRes.ok) {
        console.log("[TRACEARR] Erreur historique - status:", histRes.status);
        break;
      }

      const histJson = await histRes.json();
      if (!histJson?.data) break;

      historyTotalPages = Math.ceil((histJson.meta?.total || 0) / (histJson.meta?.pageSize || pageSize));

      const userSessions = histJson.data.filter(session => 
        session.user?.username?.toLowerCase() === username.toLowerCase()
      );

      for (const session of userSessions) {
        const sessionTime = session.startedAt || session.stoppedAt;
        
        // Valider que sessionTime est une date valide
        if (sessionTime) {
          const sessionDate = new Date(sessionTime);
          if (isNaN(sessionDate.getTime())) {
            console.warn("[TRACEARR] ⚠️  Date invalide pour session:", sessionTime);
            continue; // Skip cette session
          }
        }
        
        if (lastSessionTimestamp && sessionTime) {
          const lastDate = new Date(lastSessionTimestamp);
          const sessionDate = new Date(sessionTime);
          if (isNaN(lastDate.getTime()) || isNaN(sessionDate.getTime())) {
            continue; // Skip si dates invalides
          }
          if (sessionDate < lastDate) {
            console.log("[TRACEARR] Atteint la limite du cache - sessions plus vieilles que", lastSessionTimestamp);
            historyPage = historyTotalPages + 1;
            break;
          }
        }
        
        newSessionCount++;
        
        if (sessionTime) {
          const sessionDate = new Date(sessionTime);
          if (!isNaN(sessionDate.getTime())) {
            if (!latestSessionTime) {
              latestSessionTime = sessionTime;
            } else {
              const latestDate = new Date(latestSessionTime);
              if (!isNaN(latestDate.getTime()) && sessionDate > latestDate) {
                latestSessionTime = sessionTime;
              }
            }
          }
        }
        
        // Compter les heures et types
        const durationMs = session.totalDurationMs || 0;
        const sanitizedDuration = DURATION_VALIDATION.sanitize(durationMs);
        
        if (sanitizedDuration > 0) {
          totalDurationMs += sanitizedDuration;
        }
        
        // Valider la durée AVANT de l'accumuler (prevent corruption)
        const sanitizedDuration = DURATION_VALIDATION.sanitize(durationMs);
        
        if (sanitizedDuration > 0) {
          if (session.mediaType === "movie") {
            movieDurationMs += sanitizedDuration;
            movieCount++;
          } else if (session.mediaType === "episode") {
            episodeDurationMs += sanitizedDuration;
            episodeCount++;
          }
        }
      }

      console.log("[TRACEARR] [" + username + "] Page", historyPage, "/", historyTotalPages, "- Sessions trouvees:", userSessions.length);
      historyPage++
    }

    // Convertir ms en heures (avec vérification pour éviter Infinity)
    const totalHours = isFinite(totalDurationMs) ? Math.round(totalDurationMs / (1000 * 60 * 60) * 10) / 10 : 0;
    const movieHours = isFinite(movieDurationMs) ? Math.round(movieDurationMs / (1000 * 60 * 60) * 10) / 10 : 0;
    const episodeHours = isFinite(episodeDurationMs) ? Math.round(episodeDurationMs / (1000 * 60 * 60) * 10) / 10 : 0;

    let totalSessionCount = newSessionCount;
    if (lastSessionTimestamp && previousCount > 0) {
      totalSessionCount = previousCount + newSessionCount;
      console.log("[TRACEARR] Delta mode - precedent:", previousCount, "+ nouveau:", newSessionCount, "= total:", totalSessionCount);
    } else {
      totalSessionCount = newSessionCount;
      console.log("[TRACEARR] Full scan mode - count total:", totalSessionCount);
    }

    console.log("[TRACEARR] Total sessions pour", username, ":", totalSessionCount);
    console.log("[TRACEARR] Stats heures - Total:", totalHours, "h, Films:", movieHours, "h, Episodes:", episodeHours, "h");
    console.log("[TRACEARR] Stats contenu - Films:", movieCount, "Episode:", episodeCount);

    return {
      sessionCount: totalSessionCount,
      lastSessionTimestamp: latestSessionTime,
      stats: {
        totalHours,
        movieHours,
        movieCount,
        episodeHours,
        episodeCount
      }
    };

  } catch (err) {
    console.error("[TRACEARR] Erreur comptage optimise:", err.message);
    return { 
      sessionCount: 0, 
      lastSessionTimestamp: null,
      stats: { totalHours: 0, movieHours: 0, movieCount: 0, episodeHours: 0, episodeCount: 0 }
    };
  }
}

async function getTracearrStats(username, TRACEARR_URL, TRACEARR_API_KEY, plexUserId, PLEX_URL, PLEX_TOKEN, joinedAtTimestamp = null) {
  try {
    if (!TRACEARR_URL || !TRACEARR_API_KEY) {
      console.log("[TRACEARR] Config manquante");
      return null;
    }

    console.log("[TRACEARR] Recherche stats pour:", username);

    // D'abord, vérifier le cache
    const cached = SessionStatsCache.getWithTimestamp(username);
    if (cached) {
      console.log("[TRACEARR] Retour du CACHE - sessionCount:", cached.sessionCount, "Mis a jour", cached.timeSince);
      return {
        joinedAt: cached.joinedAt,
        lastActivity: cached.lastActivity,
        sessionCount: cached.sessionCount,
        cachedAt: cached.lastUpdated,
        timeSince: cached.timeSince
      };
    }

    // ⚠️ Si un scan global est en cours et le cache est vide, retourner "computing"
    // Cela évite de lancer un scan individuel qui doublerait les requêtes
    if (GLOBAL_SCAN_IN_PROGRESS) {
      console.log("[TRACEARR] 🔄 Scan global en cours - retour status 'computing' pour", username);
      return {
        status: "computing",
        message: "Les données des sessions sont en cours de calcul global... (rechargez dans quelques minutes)"
      };
    }

    console.log("[TRACEARR] Pas de cache - appel SCAN INTELLIGENT global");

    // 🚀 APPELER LE SCAN GLOBAL INTELLIGENT au lieu de refaire un per-user!
    const allUserStats = await scanTracearrHistoryForAllUsers(TRACEARR_URL, TRACEARR_API_KEY);
    
    // Chercher cet user dans les résultats du scan global
    const sessionData = allUserStats[username];
    
    if (!sessionData) {
      console.log("[TRACEARR] Utilisateur non trouvé dans le scan global");
      return null;
    }

    console.log("[TRACEARR] Utilisateur trouve dans scan global:", username);
    
    // Récupérer les infos de base de l'utilisateur (joinedAt, etc)
    let page = 1;
    let totalPages = 1;
    let userInfo = null;

    while (page <= totalPages && !userInfo) {
      const res = await fetch(
        `${TRACEARR_URL}/api/v1/public/users?page=${page}&pageSize=50`,
        {
          headers: {
            Authorization: `Bearer ${TRACEARR_API_KEY}`,
            Accept: "application/json"
          }
        }
      );

      if (!res.ok) return null;

      const json = await res.json();
      if (!json?.data) return null;

      totalPages = Math.ceil(json.meta.total / json.meta.pageSize);
      userInfo = json.data.find(u => u.username?.toLowerCase() === username.toLowerCase());
      page++;
    }

    if (!userInfo) {
      console.log("[TRACEARR] Infos de base non trouvées");
      // On a quand même les stats du scan global, on continue
    }

    // Prioriser Plex pour une date plus fiable
    let joinedAt = null;
    
    if (plexUserId && PLEX_URL && PLEX_TOKEN) {
      const plexJoinDate = await getPlexJoinDate(plexUserId, PLEX_URL, PLEX_TOKEN, joinedAtTimestamp);
      joinedAt = plexJoinDate ? plexJoinDate.toISOString() : null;
    }
    
    if (!joinedAt) {
      joinedAt = userInfo.createdAt || null;
    }

    const result = {
      joinedAt,
      lastActivity: userInfo?.lastActivityAt || null,
      sessionCount: sessionData.sessionCount,
      lastSessionTimestamp: sessionData.lastSessionTimestamp,
      watchStats: sessionData.watchStats // watchStats du scan global
    };
    
    // Sauvegarder en cache
    SessionStatsCache.set(username, result);
    
    console.log("[TRACEARR] Resultat final:", result);
    return result;

  } catch (err) {
    console.error("[TRACEARR] Erreur:", err.message);
    return null;
  }
}

/**
 * Mettre à jour le cache pour un utilisateur spécifique (pour job cron)
 */
async function updateUserSessionCache(username, TRACEARR_URL, TRACEARR_API_KEY, plexUserId, PLEX_URL, PLEX_TOKEN, joinedAtTimestamp = null) {
  console.log("[TRACEARR-JOB] Mise a jour cache pour:", username);
  const stats = await getTracearrStats(username, TRACEARR_URL, TRACEARR_API_KEY, plexUserId, PLEX_URL, PLEX_TOKEN, joinedAtTimestamp);
  if (stats) {
    console.log("[TRACEARR-JOB] Cache mis a jour pour", username, "- sessionCount:", stats.sessionCount);
  } else {
    console.log("[TRACEARR-JOB] Echec maj cache pour", username);
  }
  return stats;
}

/**
 * 🚀 SCAN INTELLIGENT: Scanne L'HISTORIQUE jusqu'à atteindre les sessions déjà connues
 * S'arrête automatiquement quand il détecte les données en cache (smart delta scan)
 * BEAUCOUP plus rapide à chaque exécution!
 */
async function scanTracearrHistoryForAllUsers(TRACEARR_URL, TRACEARR_API_KEY) {
  try {
    GLOBAL_SCAN_IN_PROGRESS = true;  // 🚩 Activer le drapeau
    
    console.log("\n[TRACEARR-SCAN] 🚀 DÉBUT SCAN INTELLIGENT - Scan delta avec arrêt smart");
    const scanStartTime = Date.now();
    
    // Charger les timestamps du cache pour chaque utilisateur
    const cachedUsers = SessionStatsCache.getAll();
    const userCacheLimits = {};
    for (const [username, userData] of Object.entries(cachedUsers)) {
      if (userData?.lastSessionTimestamp) {
        userCacheLimits[username] = new Date(userData.lastSessionTimestamp);
      }
    }
    console.log("[TRACEARR-SCAN] Utilisateurs en cache avec limite:", Object.keys(userCacheLimits).length);
    
    // Objet pour accumuler les stats par utilisateur
    const userStats = {};
    
    // Tracker quels users ont "atteint leur limite de cache" (on a scanné jusqu'aux vieilles données)
    const usersReachedCacheLimit = {};
    
    let historyPage = 1;
    let historyTotalPages = 1;
    const pageSize = 100;
    let totalSessionsScanned = 0;
    let pagesScannedIntelligently = 0;
    
    // BOUCLE INTELLIGENTE - S'ARRÊTE quand on atteint les données du cache
    while (historyPage <= historyTotalPages) {
      const histRes = await fetch(
        `${TRACEARR_URL}/api/v1/public/history?page=${historyPage}&pageSize=${pageSize}`,
        {
          headers: {
            Authorization: `Bearer ${TRACEARR_API_KEY}`,
            Accept: "application/json"
          }
        }
      );

      if (!histRes.ok) {
        console.error("[TRACEARR-SCAN] ❌ Erreur API historique:", histRes.status);
        break;
      }

      const histJson = await histRes.json();
      if (!histJson?.data) break;

      historyTotalPages = Math.ceil((histJson.meta?.total || 0) / (histJson.meta?.pageSize || pageSize));
      
      pagesScannedIntelligently++;
      
      let pageHasNewSessions = false;  // Si cette page contient UNIQUEMENT des sessions déjà scannées
      
      console.log("[TRACEARR-SCAN] Page", historyPage, '/', historyTotalPages, '-', (histJson.data || []).length, 'sessions');

      // POUR CHAQUE SESSION, compter pour l'utilisateur associé
      for (const session of (histJson.data || [])) {
        const username = session.user?.username;
        if (!username) continue;

        const sessionTime = session.startedAt || session.stoppedAt;
        const durationMs = session.totalDurationMs || 0;
        
        // Vérifier si c'est une sessions déjà connue pour l'utilisateur
        if (userCacheLimits[username] && sessionTime) {
          const sessionDate = new Date(sessionTime);
          if (!isNaN(sessionDate.getTime()) && sessionDate <= userCacheLimits[username]) {
            // Cette session est plus vieille que ce qu'on a en cache = limite atteinte pour cet user
            usersReachedCacheLimit[username] = true;
            continue; // Skip - déjà scanné avant
          }
        }
        
        // C'est une NOUVELLE session (pas en cache)
        pageHasNewSessions = true;
        totalSessionsScanned++;

        // Initialiser si premier utilisateur
        if (!userStats[username]) {
          userStats[username] = {
            sessionCount: 0,
            latestSessionTime: null,
            totalDurationMs: 0,
            movieDurationMs: 0,
            episodeDurationMs: 0,
            movieCount: 0,
            episodeCount: 0
          };
        }

        // TOUJOURS compter la session
        userStats[username].sessionCount++;

        // Valider la durée de la session (robuste contre les erreurs d'API)
        const sanitizedDuration = DURATION_VALIDATION.sanitize(durationMs);
        
        if (sanitizedDuration > 0) {
          // Durée valide - accumuler
          userStats[username].totalDurationMs += sanitizedDuration;
        }

        // Mettre à jour la session la plus récente
        if (sessionTime) {
          const sessionDate = new Date(sessionTime);
          if (!isNaN(sessionDate.getTime())) {
            if (!userStats[username].latestSessionTime) {
              userStats[username].latestSessionTime = sessionTime;
            } else {
              const latestDate = new Date(userStats[username].latestSessionTime);
              if (!isNaN(latestDate.getTime()) && sessionDate > latestDate) {
                userStats[username].latestSessionTime = sessionTime;
              }
            }
          }
        }

        // Compter par type de contenu (SEULEMENT si durée valide)
        if (sanitizedDuration > 0) {
          if (session.mediaType === "movie") {
            userStats[username].movieDurationMs += sanitizedDuration;
            userStats[username].movieCount++;
          } else if (session.mediaType === "episode") {
            userStats[username].episodeDurationMs += sanitizedDuration;
            userStats[username].episodeCount++;
          }
        }
      }

      // ARRÊT INTELLIGENT: Si pas de nouvelles sessions ET tous les users connus ont atteint leur limite
      if (!pageHasNewSessions && Object.keys(usersReachedCacheLimit).length >= Object.keys(userCacheLimits).length) {
        console.log("[TRACEARR-SCAN] ✋ ARRÊT INTELLIGENT - Toutes les données en cache ont été atteintes");
        console.log("[TRACEARR-SCAN]   Limite de cache trouvée pour tous les utilisateurs connus");
        break;
      }

      historyPage++;
    }

    // Convertir les données brutes en stats finales
    const finalStats = {};
    for (const [username, stats] of Object.entries(userStats)) {
      const totalHours = isFinite(stats.totalDurationMs) ? Math.round(stats.totalDurationMs / (1000 * 60 * 60) * 10) / 10 : 0;
      const movieHours = isFinite(stats.movieDurationMs) ? Math.round(stats.movieDurationMs / (1000 * 60 * 60) * 10) / 10 : 0;
      const episodeHours = isFinite(stats.episodeDurationMs) ? Math.round(stats.episodeDurationMs / (1000 * 60 * 60) * 10) / 10 : 0;

      finalStats[username] = {
        sessionCount: stats.sessionCount,
        lastSessionTimestamp: stats.latestSessionTime,
        watchStats: {
          totalHours,
          movieHours,
          movieCount: stats.movieCount,
          episodeHours,
          episodeCount: stats.episodeCount
        }
      };
      
      // 💾 METTRE EN CACHE IMMÉDIATEMENT pour cet user
      SessionStatsCache.set(username, finalStats[username]);
    }

    const duration = Math.round((Date.now() - scanStartTime) / 1000);
    const pagesSkipped = historyTotalPages - pagesScannedIntelligently;
    const percentageOfOptimization = Math.round((pagesSkipped / historyTotalPages) * 100);
    
    console.log("[TRACEARR-SCAN] ✅ SCAN INTELLIGENT TERMINÉ");
    console.log("[TRACEARR-SCAN]   🆕 Nouvelles sessions trouvées:", totalSessionsScanned);
    console.log("[TRACEARR-SCAN]   📊 Utilisateurs mis à jour:", Object.keys(finalStats).length, '(cachés)');
    console.log("[TRACEARR-SCAN]   📄 Pages scannées:", pagesScannedIntelligently, '/', historyTotalPages, `(${percentageOfOptimization}% skippées)`);
    console.log("[TRACEARR-SCAN]   ⚡ Optimisation delta:", pagesSkipped > 0 ? 'ACTIF' : 'CACHE VIDE');
    console.log("[TRACEARR-SCAN]   ⏱️  Durée totale:", duration, 'secondes');
    console.log("[TRACEARR-SCAN]   💾 Utilisateurs en cache avant scan:", Object.keys(userCacheLimits).length);
    
    // 🏁 Fin du scan - toujours exécuter le cleanup
    GLOBAL_SCAN_IN_PROGRESS = false;  // 🚩 Désactiver le drapeau (=IMPORTANT)
    
    // 📢 NOTIFIER LES CLIENTS QUE LE SCAN EST TERMINÉ (listeners de /api/stats-wait vont continuer)
    try {
      TracearrEvents.emitScanComplete();
      console.log("[TRACEARR-SCAN] 📢 Événement scan-complete émis aux clients");
    } catch (eventErr) {
      console.error("[TRACEARR-SCAN] ⚠️  Erreur émission événement:", eventErr.message);
    }
    
    return finalStats;
  } catch (err) {
    console.error("[TRACEARR-SCAN] ❌ Erreur globale:", err.message);
    console.error("[TRACEARR-SCAN] Stack trace:", err.stack);
    
    // S'assurer que le flag est désactivé même en cas d'erreur
    GLOBAL_SCAN_IN_PROGRESS = false;  // 🚩 Désactiver toujours
    
    // Émettre l'événement même en cas d'erreur (pour que les clients ne restent pas bloqués)
    try {
      TracearrEvents.emitScanComplete();
      console.log("[TRACEARR-SCAN] 📢 Événement scan-complete émis (mode erreur)");
    } catch (eventErr) {
      console.error("[TRACEARR-SCAN] ⚠️  Erreur émission événement (erreur):", eventErr.message);
    }
    
    return {};  // Retourner un objet vide (les données du cache seront toujours utilisées)
  }
}

/**
 * Fetche TOUS les utilisateurs Tracearr et pré-calcule leurs stats
 * (Indépendant - ne dépend pas d'une liste passée en paramètre)
 */
async function updateTracearrAllUsers(TRACEARR_URL, TRACEARR_API_KEY, PLEX_URL, PLEX_TOKEN) {
  try {
    const totalStartTime = Date.now();  // 🚩 Ajouter ici
    
    console.log("[TRACEARR-PRECOMPUTE] 🚀 Début - Fetch tous les utilisateurs Tracearr");
    
    const users = [];
    let page = 1;
    let totalPages = 1;
    const pageSize = 50;
    
    // Fetcher tous les utilisateurs Tracearr
    while (page <= totalPages) {
      try {
        const resp = await fetch(
          `${TRACEARR_URL}/api/v1/public/users?page=${page}&pageSize=${pageSize}`,
          {
            headers: {
              Authorization: `Bearer ${TRACEARR_API_KEY}`,
              Accept: "application/json"
            }
          }
        );
        
        if (!resp.ok) {
          console.error("[TRACEARR-PRECOMPUTE] ❌ Erreur fetch page", page, ":", resp.status);
          break;
        }
        
        const json = await resp.json();
        const meta = json.meta || {};
        totalPages = Math.ceil((meta.total || 0) / pageSize);
        
        if (json.data && Array.isArray(json.data)) {
          users.push(...json.data);
          console.log("[TRACEARR-PRECOMPUTE] Page", page, ':', json.data.length, 'utilisateurs');
        }
        
        page++;
      } catch (err) {
        console.error("[TRACEARR-PRECOMPUTE] Erreur fetch page", page, ":", err.message);
        break;
      }
    }
    
    console.log("[TRACEARR-PRECOMPUTE] ✅ Total:", users.length, "utilisateurs trouvés");
    
    // ÉTAPE 2: SCAN OPTIMISÉ - Une seule passe pour TOUS les utilisateurs!
    console.log("[TRACEARR-PRECOMPUTE] Lancement du scan optimisé de l'historique...");
    const scanResults = await scanTracearrHistoryForAllUsers(TRACEARR_URL, TRACEARR_API_KEY);
    const scanResultsCount = Object.keys(scanResults).length;
    console.log("[TRACEARR-PRECOMPUTE] ✅ Scan complété -", scanResultsCount, "utilisateurs avec sessions");
    
    // ÉTAPE 3: Mapper les résultats du scan avec les infos Plex et sauvegarder en cache
    console.log("[TRACEARR-PRECOMPUTE] Sauvegarde en cache...");
    let successCount = 0;
    let failureCount = 0;
    
    // Créer un map username -> user pour recherche rapide
    const usersByUsername = {};
    for (const user of users) {
      const username = user.username || user.title || user.email;
      usersByUsername[username] = user;
    }
    
    // Traiter chaque utilisateur trouvé dans le scan
    for (const [username, stats] of Object.entries(scanResults)) {
      try {
        const user = usersByUsername[username];
        
        // Obtenir joinedAt de Plex (optionnel - pas critique)
        let joinedAt = null;
        if (user && user.email) {
          try {
            const plexUserId = user.id || user.plexUserId || user.plexId;
            joinedAt = await getPlexJoinDate(user.email, PLEX_URL, PLEX_TOKEN, plexUserId);
          } catch (e) {
            // Silencieux - pas grave si on peut pas obtenir joinedAt
          }
        }
        
        // Sauvegarder en cache
        SessionStatsCache.set(username, {
          joinedAt: joinedAt || null,
          lastActivity: stats.lastSessionTimestamp ? new Date(stats.lastSessionTimestamp).toISOString() : null,
          sessionCount: stats.sessionCount,
          watchStats: stats.watchStats,
          lastSessionTimestamp: stats.lastSessionTimestamp,
          lastUpdated: Date.now()
        });
        
        console.log("[TRACEARR-PRECOMPUTE] ✅", username, '-', stats.sessionCount, 'sessions');
        successCount++;
      } catch (err) {
        console.error("[TRACEARR-PRECOMPUTE] ❌ Erreur pour", username, ":", err.message);
        failureCount++;
      }
    }
    
    const totalDuration = Math.round((Date.now() - totalStartTime) / 1000);
    console.log("\n[TRACEARR-PRECOMPUTE] 🎉 PRÉ-CALCUL TERMINÉ");
    console.log("[TRACEARR-PRECOMPUTE]   Utilisateurs Tracearr:", users.length);
    console.log("[TRACEARR-PRECOMPUTE]   Mis en cache:", successCount);
    console.log("[TRACEARR-PRECOMPUTE]   Erreurs:", failureCount);
    console.log("[TRACEARR-PRECOMPUTE]   Durée totale:", totalDuration, 'secondes\n');
    
    return { successCount, failureCount, totalUsers: users.length, duration: totalDuration };
  } catch (err) {
    console.error("[TRACEARR-PRECOMPUTE] ❌ Erreur globale:", err.message);
    return { successCount: 0, failureCount: 0, totalUsers: 0, duration: 0 };
  }
}

/**
 * Mettre à jour les stats pour TOUS les utilisateurs du serveur (fallback - rarement utilisé maintenant)
 * @param {Array} userList - Liste des utilisateurs avec {username, id, joinedAtTimestamp}
 */
async function updateAllUsersSessionCache(TRACEARR_URL, TRACEARR_API_KEY, PLEX_URL, PLEX_TOKEN, userList) {
  if (!userList || userList.length === 0) {
    console.log("[TRACEARR-BATCH] Pas d'utilisateurs à mettre à jour");
    return { successCount: 0, failureCount: 0, totalUsers: 0, duration: 0 };
  }
  
  console.log("[TRACEARR-BATCH] Debut MAJ cache pour", userList.length, "utilisateurs (fallback)");
  
  const startTime = Date.now();
  let successCount = 0;
  let failureCount = 0;
  
  for (const user of userList) {
    try {
      await updateUserSessionCache(
        user.username,
        TRACEARR_URL,
        TRACEARR_API_KEY,
        user.id || user.plexUserId,
        PLEX_URL,
        PLEX_TOKEN,
        user.joinedAtTimestamp
      );
      successCount++;
    } catch (err) {
      console.error("[TRACEARR-BATCH] Erreur pour", user.username, ":", err.message);
      failureCount++;
    }
  }
  
  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log("[TRACEARR-BATCH] Fin - Succes:", successCount, "Echecs:", failureCount, "Durée:", duration, "sec");
  
  return { successCount, failureCount, duration };
}

/**
 * ⚠️ LEGACY - Ne plus utiliser
 * Les données n'ont plus besoin d'être pré-scannées au démarrage
 * Le cache persiste et est rechargé automatiquement
 */
async function initTracearrPreScan(TRACEARR_URL, TRACEARR_API_KEY) {
  console.log("[TRACEARR-PRESCAN] ⚙️  Fonction legacy - non utilisée");
  // Non-op
}

module.exports = { 
  getTracearrStats, 
  countSessionsOptimized, 
  updateUserSessionCache, 
  updateAllUsersSessionCache, 
  updateTracearrAllUsers,
  scanTracearrHistoryForAllUsers,  // 🚀 Scan intelligent (utilisé par cron)
  initTracearrPreScan
};
