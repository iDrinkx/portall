const fetch = require("node-fetch");
const { getPlexJoinDate } = require("./plex");
const SessionStatsCache = require("./session-stats-cache-db");  // 🗄️ Utiliser SQLite
const TautulliEvents = require("./tautulli-events");  // 📢 EventEmitter pour notifier clients

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
        console.warn("[TAUTULLI-DURATION] ⚠️  Durée aberrante rejetée:", durationMs, "ms (>12h)");
      }
      return 0;  // Retourner 0 au lieu de rejeter la session
    }
    return durationMs;
  }
};

console.log("[TAUTULLI-BOOT] 💾 Cache DB initialisé (SQLite persistant)");

/**
 * 🚀 Obtenir les stats de visionnage pour un utilisateur via l'API Tautulli
 */
async function getTautulliStats(username, TAUTULLI_URL, TAUTULLI_API_KEY, plexUserId, PLEX_URL, PLEX_TOKEN, joinedAtTimestamp = null) {
  try {
    if (!TAUTULLI_URL || !TAUTULLI_API_KEY) {
      console.log("[TAUTULLI] Config manquante");
      return null;
    }

    console.log("[TAUTULLI] Recherche stats pour:", username);

    // Normaliser le username en minuscules pour cohérence
    const normalizedUsername = username.toLowerCase();

    // D'abord, vérifier le cache
    const cached = SessionStatsCache.getWithTimestamp(normalizedUsername);
    if (cached && cached.sessionCount > 0) {
      // Retourner le cache SEULEMENT s'il contient des données valides
      console.log("[TAUTULLI] Retour du CACHE - sessionCount:", cached.sessionCount, "Mis a jour", cached.timeSince);
      return {
        joinedAt: cached.joinedAt,
        lastActivity: cached.lastActivity,
        sessionCount: cached.sessionCount,
        cachedAt: cached.lastActivity,
        timeSince: cached.timeSince
      };
    }
    
    // ⚠️ Si cache est vide (sessionCount = 0), forcer un nouveau scan
    if (cached && cached.sessionCount === 0) {
      console.log("[TAUTULLI] ⚠️  Cache contient 0 sessions - forçage d'un nouveau scan pour " + normalizedUsername);
    }

    // ⚠️ Si un scan global est en cours et le cache est vide, retourner "computing"
    if (GLOBAL_SCAN_IN_PROGRESS) {
      console.log("[TAUTULLI] 🔄 Scan global en cours - retour status 'computing' pour", username);
      return {
        status: "computing",
        message: "Les données des sessions sont en cours de calcul global... (rechargez dans quelques minutes)"
      };
    }

    console.log("[TAUTULLI] 🚀 Pas de cache récent - lancement SCAN INTELLIGENT global");

    // 🚀 APPELER LE SCAN GLOBAL INTELLIGENT
    const allUserStats = await scanTautulliHistoryForAllUsers(TAUTULLI_URL, TAUTULLI_API_KEY);
    
    // Chercher cet user dans les résultats du scan global (username déjà normalisé plus haut)
    const sessionData = allUserStats[normalizedUsername];
    
    if (!sessionData) {
      console.log("[TAUTULLI] ⚠️  Utilisateur non trouvé dans le scan global");
      // Fallback au cache
      const fallbackCache = SessionStatsCache.get(normalizedUsername);
      if (fallbackCache) {
        console.log("[TAUTULLI] ✅ Fallback: données du cache trouvées pour", normalizedUsername);
        return {
          joinedAt: fallbackCache.joinedAt,
          lastActivity: fallbackCache.lastActivity,
          sessionCount: fallbackCache.sessionCount || 0,
          cachedAt: fallbackCache.lastActivity,
          timeSince: "du scan actuel"
        };
      }
      return null;
    }

    console.log("[TAUTULLI] ✅ Utilisateur trouvé dans le scan global:", username);
    
    // Récupérer les infos utilisateur
    const userInfo = await getTautulliUserInfo(username, TAUTULLI_URL, TAUTULLI_API_KEY);
    
    let joinedAt = null;
    
    if (plexUserId && PLEX_URL && PLEX_TOKEN) {
      const plexJoinDate = await getPlexJoinDate(plexUserId, PLEX_URL, PLEX_TOKEN, joinedAtTimestamp);
      joinedAt = plexJoinDate ? plexJoinDate.toISOString() : null;
    }
    
    if (!joinedAt && userInfo) {
      joinedAt = userInfo.user_thumb ? new Date(userInfo.user_thumb).toISOString() : null;
    }

    const result = {
      joinedAt,
      lastActivity: userInfo?.last_seen ? new Date(userInfo.last_seen * 1000).toISOString() : null,
      sessionCount: sessionData.sessionCount,
      lastSessionTimestamp: sessionData.lastSessionTimestamp,
      watchStats: sessionData.watchStats
    };

    // 💾 SAUVEGARDER DANS LE CACHE
    SessionStatsCache.set(normalizedUsername, result);
    
    return result;

  } catch (err) {
    console.error("[TAUTULLI] Erreur:", err.message);
    return null;
  }
}

/**
 * Obtenir les infos d'un utilisateur Tautulli
 */
async function getTautulliUserInfo(username, TAUTULLI_URL, TAUTULLI_API_KEY) {
  try {
    const res = await fetch(
      `${TAUTULLI_URL}/api/v2?apikey=${TAUTULLI_API_KEY}&cmd=get_user&user=${encodeURIComponent(username)}`,
      { headers: { Accept: "application/json" } }
    );

    if (!res.ok) return null;

    const json = await res.json();
    return json.response?.data || null;
  } catch (err) {
    console.error("[TAUTULLI] Erreur getTautulliUserInfo:", err.message);
    return null;
  }
}

/**
 * 🚀 SCAN INTELLIGENT: Récupère l'historique de toutes les sessions Tautulli
 * S'arrête automatiquement quand il détecte les données en cache (smart delta scan)
 */
async function scanTautulliHistoryForAllUsers(TAUTULLI_URL, TAUTULLI_API_KEY) {
  try {
    GLOBAL_SCAN_IN_PROGRESS = true;
    
    console.log("\n[TAUTULLI-SCAN] 🚀 DÉBUT SCAN INTELLIGENT - Historique des sessions");
    const scanStartTime = Date.now();
    
    // 1️⃣ Récupérer TOUS les utilisateurs Tautulli via get_users
    console.log("[TAUTULLI-SCAN] 📥 Récupération des utilisateurs Tautulli...");
    const tautulliUsers = [];
    
    try {
      const usersRes = await fetch(
        `${TAUTULLI_URL}/api/v2?apikey=${TAUTULLI_API_KEY}&cmd=get_users`,
        { headers: { Accept: "application/json" } }
      );
      
      if (usersRes.ok) {
        const usersJson = await usersRes.json();
        if (usersJson.response?.data) {
          tautulliUsers.push(...usersJson.response.data);
        }
      }
    } catch (err) {
      console.error("[TAUTULLI-SCAN] ❌ Erreur récupération utilisateurs:", err.message);
    }
    
    console.log("[TAUTULLI-SCAN] ✅ Utilisateurs Tautulli trouvés:", tautulliUsers.length);
    
    // Charger les timestamps du cache
    const cachedUsers = SessionStatsCache.getAll();
    const userCacheLimits = {};
    for (const [username, userData] of Object.entries(cachedUsers)) {
      if (userData?.lastSessionTimestamp) {
        userCacheLimits[username] = new Date(userData.lastSessionTimestamp);
      }
    }
    console.log("[TAUTULLI-SCAN] Utilisateurs en cache:", Object.keys(userCacheLimits).length);
    
    // Initialiser stats pour tous les utilisateurs
    const userStats = {};
    for (const user of tautulliUsers) {
      const username = user.username?.toLowerCase();
      if (username) {
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
    }
    console.log("[TAUTULLI-SCAN] Stats initialisées pour:", Object.keys(userStats).length, 'utilisateurs');
    
    // 2️⃣ Récupérer l'historique des sessions (get_history)
    let pageIndex = 0;
    let totalSessions = 0;
    let pagesScanned = 0;
    const pageSize = 100;
    
    while (true) {
      try {
        const histRes = await fetch(
          `${TAUTULLI_URL}/api/v2?apikey=${TAUTULLI_API_KEY}&cmd=get_history&start=${pageIndex}&length=${pageSize}`,
          { headers: { Accept: "application/json" } }
        );
        
        if (!histRes.ok) {
          console.log("[TAUTULLI-SCAN] ⚠️  Erreur API - status:", histRes.status);
          break;
        }
        
        const histJson = await histRes.json();
        console.log("[TAUTULLI-SCAN] Réponse API page", pagesScanned, "- structure:", JSON.stringify(histJson, null, 2).substring(0, 200));
        
        const sessions = histJson.response?.data || [];
        
        if (!sessions || sessions.length === 0) {
          console.log("[TAUTULLI-SCAN] ✅ Pas plus de sessions - fin du scan");
          break;
        }
        
        pagesScanned++;
        totalSessions += sessions.length;
        console.log("[TAUTULLI-SCAN] Page", pagesScanned, '-', sessions.length, 'sessions (total:', totalSessions, ')');
        
        // Traiter chaque session
        for (const session of sessions) {
          const username = session.username?.toLowerCase();
          if (!username || !userStats[username]) continue;
          
          userStats[username].sessionCount++;
          
          // Durée en secondes → convertir en millisecondes
          const durationSeconds = session.duration || 0;
          const durationMs = durationSeconds * 1000;
          const sanitizedDuration = DURATION_VALIDATION.sanitize(durationMs);
          
          if (sanitizedDuration > 0) {
            userStats[username].totalDurationMs += sanitizedDuration;
          }
          
          // Mettre à jour la session la plus récente
          if (session.date) {
            const sessionDate = new Date(session.date);
            if (!isNaN(sessionDate.getTime())) {
              if (!userStats[username].latestSessionTime) {
                userStats[username].latestSessionTime = session.date;
              } else {
                const latestDate = new Date(userStats[username].latestSessionTime);
                if (sessionDate > latestDate) {
                  userStats[username].latestSessionTime = session.date;
                }
              }
            }
          }
          
          // Compter par type de contenu
          if (sanitizedDuration > 0) {
            if (session.media_type === "movie") {
              userStats[username].movieDurationMs += sanitizedDuration;
              userStats[username].movieCount++;
            } else if (session.media_type === "episode") {
              userStats[username].episodeDurationMs += sanitizedDuration;
              userStats[username].episodeCount++;
            }
          }
        }
        
        pageIndex += pageSize;
      } catch (err) {
        console.error("[TAUTULLI-SCAN] ❌ Erreur historique:", err.message);
        break;
      }
    }
    
    // Convertir les stats finales
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
      
      SessionStatsCache.set(username, finalStats[username]);
    }
    
    console.log("[TAUTULLI-SCAN] 💾 Utilisateurs sauvegardés en cache:", Object.keys(finalStats).length);

    const duration = Math.round((Date.now() - scanStartTime) / 1000);
    
    console.log("[TAUTULLI-SCAN] ✅ SCAN INTELLIGENT TERMINÉ");
    console.log("[TAUTULLI-SCAN]   📊 Sessions traitées:", totalSessions);
    console.log("[TAUTULLI-SCAN]   👥 Utilisateurs mis à jour:", Object.keys(finalStats).length);
    console.log("[TAUTULLI-SCAN]   ⏱️  Durée totale:", duration, 'secondes');
    
    GLOBAL_SCAN_IN_PROGRESS = false;
    
    try {
      TautulliEvents.emitScanComplete();
      console.log("[TAUTULLI-SCAN] 📢 Événement scan-complete émis aux clients");
    } catch (eventErr) {
      console.error("[TAUTULLI-SCAN] ⚠️  Erreur émission événement:", eventErr.message);
    }
    
    return finalStats;
    
  } catch (err) {
    console.error("[TAUTULLI-SCAN] ❌ Erreur globale:", err.message);
    console.error("[TAUTULLI-SCAN] Stack trace:", err.stack);
    
    GLOBAL_SCAN_IN_PROGRESS = false;
    
    try {
      TautulliEvents.emitScanComplete();
      console.log("[TAUTULLI-SCAN] 📢 Événement scan-complete émis (mode erreur)");
    } catch (eventErr) {
      console.error("[TAUTULLI-SCAN] ⚠️  Erreur émission événement (erreur):", eventErr.message);
    }
    
    return {};
  }
}

module.exports = {
  getTautulliStats,
  scanTautulliHistoryForAllUsers,
  DURATION_VALIDATION
};
