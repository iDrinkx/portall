const fetch = require("node-fetch");
const { getPlexJoinDate } = require("./plex");
const SessionStatsCache = require("./session-stats-cache");

/**
 * Compte les sessions en parcourant l'historique complet (utilise un delta pour optimiser)
 * @param {string} username - Nom d'utilisateur Plex
 * @param {string} TRACEARR_URL - URL du serveur Tracearr
 * @param {string} TRACEARR_API_KEY - Clé API Tracearr
 * @returns {Promise<number>} Nombre total de sessions
 */
async function countSessionsOptimized(username, TRACEARR_URL, TRACEARR_API_KEY) {
  try {
    console.log("[TRACEARR] Comptage OPTIMISE des sessions pour:", username);
    
    // Recuperer le cache existant pour avoir le delta
    const cached = SessionStatsCache.get(username);
    const lastSessionTimestamp = cached?.lastSessionTimestamp || null;
    const previousCount = cached?.sessionCount || 0;
    
    console.log("[TRACEARR] Cache precedent - count:", previousCount, "lastSessionTimestamp:", lastSessionTimestamp);
    
    let historyPage = 1;
    let historyTotalPages = 1;
    let newSessionCount = 0;
    let latestSessionTime = lastSessionTimestamp;
    let pageSize = 100;

    // Premier passage: compter seulement les NOUVELLES sessions après lastSessionTimestamp
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

      // Compter les sessions de cet utilisateur
      const userSessions = histJson.data.filter(session => 
        session.user?.username?.toLowerCase() === username.toLowerCase()
      );

      for (const session of userSessions) {
        const sessionTime = session.startedAt || session.stoppedAt;
        
        // Si on a un timestamp référence et cette session est plus vieille, on peut arrêter
        if (lastSessionTimestamp && sessionTime && new Date(sessionTime) < new Date(lastSessionTimestamp)) {
          console.log("[TRACEARR] Atteint la limite du cache - sessions plus vieilles que", lastSessionTimestamp);
          historyPage = historyTotalPages + 1; // Force la sortie de la boucle
          break;
        }
        
        newSessionCount++;
        
        // Garder la date la plus récente
        if (!latestSessionTime || (sessionTime && new Date(sessionTime) > new Date(latestSessionTime))) {
          latestSessionTime = sessionTime;
        }
      }

      console.log("[TRACEARR] Page", historyPage, "/" , historyTotalPages, "- Sessions trouvees:", userSessions.length, "Count cumulatif:", newSessionCount);

      historyPage++;
    }

    // Combiner avec le cache précédent si on a fait delta
    let totalSessionCount = newSessionCount;
    if (lastSessionTimestamp && previousCount > 0) {
      // On a trouvé uniquement les NOUVELLES
      totalSessionCount = previousCount + newSessionCount;
      console.log("[TRACEARR] Delta mode - precedent:', previousCount, '+ nouveau:', newSessionCount, '= total:', totalSessionCount);
    } else {
      // Premier passage ou cache expiré - c'est le vrai count
      totalSessionCount = newSessionCount;
      console.log("[TRACEARR] Full scan mode - count total:', totalSessionCount);
    }

    console.log("[TRACEARR] Total sessions pour", username, ":", totalSessionCount);

    return {
      sessionCount: totalSessionCount,
      lastSessionTimestamp: latestSessionTime
    };

  } catch (err) {
    console.error("[TRACEARR] Erreur comptage optimise:", err.message);
    return { sessionCount: 0, lastSessionTimestamp: null };
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
      lastSessionTimestamp: sessionData.lastSessionTimestamp
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

module.exports = { getTracearrStats, countSessionsOptimized, updateUserSessionCache };
