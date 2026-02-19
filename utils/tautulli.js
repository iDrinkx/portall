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

    // 1️⃣ D'abord, vérifier la BASE DE DONNÉES (ultra-rapide)
    console.log("[TAUTULLI] Recherche stats pour:", username);
    const dbStats = getStatsFromDatabase(normalizedUsername);
    
    if (dbStats && dbStats.sessionCount > 0) {
      console.log("[TAUTULLI] ✅ Stats trouvées en DB - sessionCount:", dbStats.sessionCount);
      return {
        joinedAt: null,
        lastActivity: dbStats.lastSessionDate,
        sessionCount: dbStats.sessionCount,
        lastSessionTimestamp: dbStats.lastSessionDate,
        watchStats: {
          totalHours: dbStats.totalHours,
          movieHours: dbStats.movieHours,
          movieCount: dbStats.movieCount,
          episodeHours: dbStats.episodeHours,
          episodeCount: dbStats.episodeCount
        }
      };
    }
    
    // 2️⃣ Si DB vide, vérifier le cache SQLite
    const cached = SessionStatsCache.get(normalizedUsername);
    if (cached && cached.sessionCount > 0) {
      console.log("[TAUTULLI] Retour du CACHE - sessionCount:", cached.sessionCount);
      return {
        joinedAt: cached.joinedAt,
        lastActivity: cached.lastActivity,
        sessionCount: cached.sessionCount,
        cachedAt: cached.lastActivity,
        timeSince: "du scan"
      };
    }

    // 3️⃣ Si un scan global est en cours, retourner "computing"
    if (GLOBAL_SCAN_IN_PROGRESS) {
      console.log("[TAUTULLI] 🔄 Scan global en cours - retour status 'computing'");
      return {
        status: "computing",
        message: "Les données des sessions sont en cours de synchronisation... (rechargez dans quelques minutes)"
      };
    }

    // ⚠️ FALLBACK: Lancer un scan si la DB est vide
    console.log("[TAUTULLI] ⚠️  Pas de données en DB - lancement scan de secours");
    const allUserStats = await scanTautulliHistoryForAllUsers(TAUTULLI_URL, TAUTULLI_API_KEY);
    
    // Chercher cet user dans les résultats du scan global
    const sessionData = allUserStats[normalizedUsername];
    
    if (!sessionData) {
      console.log("[TAUTULLI] ⚠️  Utilisateur non trouvé après scan");
      return null;
    }

    console.log("[TAUTULLI] ✅ Utilisateur trouvé dans le scan:", username);
    
    const result = {
      joinedAt: null,
      lastActivity: sessionData.lastSessionTimestamp || null,
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
        console.log("[TAUTULLI-GET_USERS] Réponse brute:", typeof usersJson, "isArray:", Array.isArray(usersJson), "keys:", Object.keys(usersJson).slice(0, 5));
        
        // L'API Tautulli retourne directement un array pour get_users
        if (Array.isArray(usersJson)) {
          console.log("[TAUTULLI-GET_USERS] ✅ Format direct array - items:", usersJson.length);
          tautulliUsers.push(...usersJson);
        } else if (usersJson.response?.data) {
          console.log("[TAUTULLI-GET_USERS] ℹ️ Format response.data - items:", usersJson.response.data.length);
          tautulliUsers.push(...usersJson.response.data);
        } else {
          console.log("[TAUTULLI-GET_USERS] ⚠️ Format inconnu - contenu:", JSON.stringify(usersJson).substring(0, 200));
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
        
        // Structure Tautulli: { response: { result, message, data: { recordsFiltered, recordsTotal, data: [...sessions] } } }
        const tautulliData = histJson.response?.data?.data || histJson.response?.data || histJson.data || [];
        const sessions = Array.isArray(tautulliData) ? tautulliData : [];
        
        const recordsTotal = histJson.response?.data?.recordsTotal || histJson.recordsTotal || 0;
        console.log("[TAUTULLI-SCAN] Page " + pagesScanned + " - Sessions: " + sessions.length + "/" + recordsTotal);
        
        if (!sessions || sessions.length === 0) {
          console.log("[TAUTULLI-SCAN] ✅ Pas plus de sessions - fin du scan");
          break;
        }
        
        pagesScanned++;
        totalSessions += sessions.length;
        console.log("[TAUTULLI-SCAN] Page " + pagesScanned + " - Sessions trouvées: " + sessions.length + " (total: " + totalSessions + " sur " + recordsTotal + ")");
        
        // Arrêter si on a atteint le total
        if (totalSessions >= recordsTotal && recordsTotal > 0) {
          console.log("[TAUTULLI-SCAN] ✅ All records fetched - total: " + totalSessions);
          break;
        }
        
        // Safeguard contre les boucles infinies (max 20 pages = 2000 sessions)
        if (pagesScanned > 20 && totalSessions === 0) {
          console.log("[TAUTULLI-SCAN] ⚠️ Limite de pages atteinte avec 0 sessions");
          break;
        }
        
        // Traiter chaque session
        for (const session of sessions) {
          const username = session.username?.toLowerCase();
          if (!username || !userStats[username]) continue;
          
          userStats[username].sessionCount++;
          
          // Durée: play_duration selon l'API officielle Tautulli (en secondes)
          const durationSeconds = session.play_duration || session.duration || 0;
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

// ═══════════════════════════════════════════════════════════════════════════════
// 🚀 NOUVELLE ARCHITECTURE : SYNC TAUTULLI → SQLITE PUIS STATS DEPUIS DB
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sync complet de l'historique Tautulli vers SQLite
 * Fetche TOUT et insère dans watch_history table
 * À appeler : 1) au boot, 2) cron daily, 3) endpoint manuel
 */
async function syncTautulliHistoryToDatabase() {
  console.log("[TAUTULLI-SYNC] 🚀 DÉBUT FULL SYNC - Historique → SQLite");
  
  const TAUTULLI_URL = process.env.TAUTULLI_URL;
  const TAUTULLI_API_KEY = process.env.TAUTULLI_API_KEY;
  const pageSize = 500; // Fetcher par 500 pour être plus rapide
  
  let pageIndex = 0;
  let totalInserted = 0;
  let pagesScanned = 0;
  let recordsTotal = 0;
  const startTime = Date.now();
  
  try {
    // Étape 1 : Récupérer les utilisateurs
    console.log("[TAUTULLI-SYNC] 📥 Récupération des utilisateurs...");
    const usersRes = await fetch(
      `${TAUTULLI_URL}/api/v2?apikey=${TAUTULLI_API_KEY}&cmd=get_users`,
      { headers: { Accept: "application/json" } }
    );
    
    let tautulliUsers = [];
    if (usersRes.ok) {
      const usersJson = await usersRes.json();
      if (Array.isArray(usersJson)) {
        tautulliUsers = usersJson;
      } else if (usersJson.response?.data) {
        tautulliUsers = usersJson.response.data;
      }
    }
    console.log("[TAUTULLI-SYNC] ✅ " + tautulliUsers.length + " utilisateurs trouvés");
    
    // Étape 2 : Créer un map username → user_id pour lookup rapide
    const userMap = {};
    for (const user of tautulliUsers) {
      userMap[user.username?.toLowerCase()] = user;
    }
    
    // Étape 3 : Fetcher et insérer tout l'historique par chunks
    console.log("[TAUTULLI-SYNC] 📚 Début fetch historique complet...");
    
    // Prépare les statements SQL
    const db = SessionStatsCache.getDb();
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO tautulli_sessions 
      (user_id, username, media_type, title, duration_seconds, session_date, watched_status, rating_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const insertMany = db.transaction((sessions) => {
      for (const session of sessions) {
        insertStmt.run(
          session.user_id || 0,
          session.username?.toLowerCase() || 'unknown',
          session.media_type || 'unknown',
          session.full_title || session.title || 'Unknown',
          session.play_duration || session.duration || 0,
          new Date((session.date || 0) * 1000).toISOString(),
          session.watched_status || 0,
          session.rating_key || 0
        );
      }
    });
    
    // Boucle de pagination
    while (true) {
      try {
        const histRes = await fetch(
          `${TAUTULLI_URL}/api/v2?apikey=${TAUTULLI_API_KEY}&cmd=get_history&start=${pageIndex}&length=${pageSize}`,
          { headers: { Accept: "application/json" } }
        );
        
        if (!histRes.ok) {
          console.log("[TAUTULLI-SYNC] ⚠️  Erreur API status:", histRes.status);
          break;
        }
        
        const histJson = await histRes.json();
        const sessions = histJson.response?.data?.data || histJson.data?.data || [];
        recordsTotal = histJson.response?.data?.recordsTotal || histJson.recordsTotal || 0;
        
        if (!Array.isArray(sessions) || sessions.length === 0) {
          console.log("[TAUTULLI-SYNC] ✅ Fin historique - " + totalInserted + " sessions insérées");
          break;
        }
        
        pagesScanned++;
        totalInserted += sessions.length;
        
        // Insert batch
        insertMany(sessions);
        
        console.log("[TAUTULLI-SYNC] Page " + pagesScanned + " - Inséré " + sessions.length + " sessions (total: " + totalInserted + "/" + recordsTotal + ")");
        
        // Arrêter si on a tout
        if (totalInserted >= recordsTotal && recordsTotal > 0) {
          console.log("[TAUTULLI-SYNC] ✅ Tous les records fetched");
          break;
        }
        
        // Safety limit
        if (pagesScanned > 500) {
          console.log("[TAUTULLI-SYNC] ⚠️  Limite max pages (500) atteinte");
          break;
        }
        
        pageIndex += pageSize;
        
        // Petit délai pour ne pas surcharger l'API
        await new Promise(r => setTimeout(r, 100));
        
      } catch (err) {
        console.error("[TAUTULLI-SYNC] ❌ Erreur pagination:", err.message);
        break;
      }
    }
    
    const elapsedSecs = Math.round((Date.now() - startTime) / 1000);
    console.log("[TAUTULLI-SYNC] ✅ SYNC COMPLETE - " + totalInserted + " sessions en " + elapsedSecs + "s");
    
    return {
      success: true,
      sessionsInerted: totalInserted,
      usersCount: tautulliUsers.length,
      durationSeconds: elapsedSecs
    };
    
  } catch (err) {
    console.error("[TAUTULLI-SYNC] ❌ Erreur sync:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Calcule les stats d'un utilisateur depuis la base tautulli_sessions
 * ULTRA RAPIDE - requête SQL directe
 */
function getStatsFromDatabase(username) {
  if (!username) return null;
  
  const db = SessionStatsCache.getDb();
  const usernameLower = username.toLowerCase();
  
  try {
    // Requête SQL pour récupérer toutes les stats en une seule query
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as sessionCount,
        SUM(duration_seconds) as totalDurationSecs,
        SUM(CASE WHEN media_type = 'movie' THEN duration_seconds ELSE 0 END) as movieDurationSecs,
        SUM(CASE WHEN media_type = 'episode' THEN duration_seconds ELSE 0 END) as episodeDurationSecs,
        SUM(CASE WHEN media_type = 'movie' THEN 1 ELSE 0 END) as movieCount,
        SUM(CASE WHEN media_type = 'episode' THEN 1 ELSE 0 END) as episodeCount,
        MAX(session_date) as lastSessionDate,
        user_id
      FROM tautulli_sessions 
      WHERE username = ?
      GROUP BY user_id
    `).get(usernameLower);
    
    if (!stats || stats.sessionCount === 0) {
      return null;
    }
    
    // Convertir en heures
    const totalHours = stats.totalDurationSecs ? Math.round(stats.totalDurationSecs / 3600 * 10) / 10 : 0;
    const movieHours = stats.movieDurationSecs ? Math.round(stats.movieDurationSecs / 3600 * 10) / 10 : 0;
    const episodeHours = stats.episodeDurationSecs ? Math.round(stats.episodeDurationSecs / 3600 * 10) / 10 : 0;
    
    return {
      sessionCount: stats.sessionCount || 0,
      totalHours: totalHours,
      movieCount: stats.movieCount || 0,
      movieHours: movieHours,
      episodeCount: stats.episodeCount || 0,
      episodeHours: episodeHours,
      lastSessionDate: stats.lastSessionDate || null,
      userId: stats.user_id || 0
    };
    
  } catch (err) {
    console.error("[TAUTULLI-DB] ❌ Erreur lecture DB pour " + usernameLower + ":", err.message);
    return null;
  }
}

module.exports = {
  getTautulliStats,
  scanTautulliHistoryForAllUsers,
  syncTautulliHistoryToDatabase,
  getStatsFromDatabase,
  DURATION_VALIDATION
};
