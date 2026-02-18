const fetch = require("node-fetch");
const { getPlexJoinDate } = require("./plex");
const SessionStatsCache = require("./session-stats-cache");

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
        
        if (lastSessionTimestamp && sessionTime && new Date(sessionTime) < new Date(lastSessionTimestamp)) {
          console.log("[TRACEARR] Atteint la limite du cache - sessions plus vieilles que", lastSessionTimestamp);
          historyPage = historyTotalPages + 1;
          break;
        }
        
        newSessionCount++;
        
        if (!latestSessionTime || (sessionTime && new Date(sessionTime) > new Date(latestSessionTime))) {
          latestSessionTime = sessionTime;
        }
        
        // Compter les heures et types
        const durationMs = session.totalDurationMs || 0;
        totalDurationMs += durationMs;
        
        if (session.mediaType === "movie") {
          movieDurationMs += durationMs;
          movieCount++;
        } else if (session.mediaType === "episode") {
          episodeDurationMs += durationMs;
          episodeCount++;
        }
      }

      console.log("[TRACEARR] Page", historyPage, "/", historyTotalPages, "- Sessions trouvees:", userSessions.length);
      historyPage++;
    }

    // Convertir ms en heures
    const totalHours = Math.round(totalDurationMs / (1000 * 60 * 60) * 10) / 10;
    const movieHours = Math.round(movieDurationMs / (1000 * 60 * 60) * 10) / 10;
    const episodeHours = Math.round(episodeDurationMs / (1000 * 60 * 60) * 10) / 10;

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

    console.log("[TRACEARR] Pas de cache - fetch depuis API");

    // Récupérer l'utilisateur pour ses infos de base
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
      console.log("[TRACEARR] Utilisateur non trouve");
      return null;
    }

    console.log("[TRACEARR] Utilisateur trouve:", userInfo.username);

    // Compter les sessions (optimisé avec delta)
    const sessionData = await countSessionsOptimized(username, TRACEARR_URL, TRACEARR_API_KEY);

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
      lastActivity: userInfo.lastActivityAt || null,
      sessionCount: sessionData.sessionCount,
      lastSessionTimestamp: sessionData.lastSessionTimestamp,
      watchStats: sessionData.stats // { totalHours, movieHours, movieCount, episodeHours, episodeCount }
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
 * Fetche TOUS les utilisateurs Tracearr et pré-calcule leurs stats
 * (Indépendant - ne dépend pas d'une liste passée en paramètre)
 */
async function updateTracearrAllUsers(TRACEARR_URL, TRACEARR_API_KEY, PLEX_URL, PLEX_TOKEN) {
  try {
    console.log("[TRACEARR-PRECOMPUTE] Début - Fetch tous les utilisateurs Tracearr");
    
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
    
    // Mettre en cache les stats de chaque utilisateur
    const startTime = Date.now();
    let successCount = 0;
    let failureCount = 0;
    
    for (const user of users) {
      try {
        const username = user.username || user.title || user.email;
        console.log("[TRACEARR-PRECOMPUTE] Traitement:", username);
        
        const sessionData = await countSessionsOptimized(username, TRACEARR_URL, TRACEARR_API_KEY);
        
        // Obtenir la date d'inscription Plex
        let joinedAt = null;
        try {
          joinedAt = await getPlexJoinDate(user.email, PLEX_URL, PLEX_TOKEN);
        } catch (e) {
          console.warn("[TRACEARR-PRECOMPUTE] Impossible obtenir joinedAt pour", username);
        }
        
        // Sauvegarder en cache
        SessionStatsCache.set(username, {
          joinedAt,
          lastActivity: sessionData.lastSessionTimestamp ? new Date(sessionData.lastSessionTimestamp * 1000).toISOString() : null,
          sessionCount: sessionData.sessionCount,
          watchStats: sessionData.stats,
          lastSessionTimestamp: sessionData.lastSessionTimestamp,
          lastUpdated: Date.now()
        });
        
        console.log("[TRACEARR-PRECOMPUTE] ✅", username, '-', sessionData.sessionCount, 'sessions');
        successCount++;
      } catch (err) {
        console.error("[TRACEARR-PRECOMPUTE] ❌ Erreur pour user:", err.message);
        failureCount++;
      }
    }
    
    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log("[TRACEARR-PRECOMPUTE] FIN - Succès:", successCount, "Échecs:", failureCount, "Durée:", duration, 's');
    
    return { successCount, failureCount, totalUsers: users.length, duration };
  } catch (err) {
    console.error("[TRACEARR-PRECOMPUTE] ❌ Erreur globale:", err.message);
    return { successCount: 0, failureCount: 0, totalUsers: 0, duration: 0 };
  }
}

/**
 * Mettre à jour les stats pour TOUS les utilisateurs du serveur
 * @param {Array} userList - Liste des utilisateurs avec {username, id, joinedAtTimestamp}
 */
async function updateAllUsersSessionCache(TRACEARR_URL, TRACEARR_API_KEY, PLEX_URL, PLEX_TOKEN, userList) {
  console.log("[TRACEARR-BATCH] Debut MAJ cache pour", userList.length, "utilisateurs");
  
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

module.exports = { getTracearrStats, countSessionsOptimized, updateUserSessionCache, updateAllUsersSessionCache, updateTracearrAllUsers };
