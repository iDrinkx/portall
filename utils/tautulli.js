const fetch = require("node-fetch");
const { getPlexJoinDate } = require("./plex");
const SessionStatsCache = require("./session-stats-cache-db");  // 🗄️ Utiliser SQLite
const TautulliEvents = require("./tautulli-events");  // 📢 EventEmitter pour notifier clients
const { getDb } = require("./database");  // 📥 Accès direct à la DB SQLite
const log = require("./logger");
const logT = log.create('[Tautulli]');

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
          logT.debug('Durée aberrante rejetée:', durationMs, 'ms (>12h)');
        }
        return 0;
      }
      return durationMs;
    }
  };
 * Utilise la DB Tautulli directe en priorité
 */
async function getTautulliStats(username, TAUTULLI_URL, TAUTULLI_API_KEY, plexUserId, PLEX_URL, PLEX_TOKEN, joinedAtTimestamp = null) {
  try {
    const normalizedUsername = username.toLowerCase();
    
    // 1️⃣ Essayer de lire depuis la DB Tautulli directe (rapide)
    try {
      const { getUserStatsFromTautulli, isTautulliReady } = require("./tautulli-direct");
      
      if (isTautulliReady()) {
        const directStats = getUserStatsFromTautulli(normalizedUsername);
        if (directStats && directStats.sessionCount > 0) {
          logT.debug(`${normalizedUsername} — ${directStats.sessionCount} sessions (DB directe)`);
          const { getMonthlyHoursFromTautulli, getTimeBasedSessionCounts } = require("./tautulli-direct");
          const monthlyHours = getMonthlyHoursFromTautulli(normalizedUsername);
          const { nightCount, morningCount } = getTimeBasedSessionCounts(normalizedUsername);
          return {
            joinedAt: joinedAtTimestamp ? new Date(joinedAtTimestamp * 1000).toISOString() : null,
            lastActivity: directStats.lastSessionDate,
            sessionCount: directStats.sessionCount,
            lastSessionTimestamp: directStats.lastSessionDate,
            monthlyHours: monthlyHours,
            nightCount: nightCount,
            morningCount: morningCount,
            watchStats: {
              totalHours: directStats.totalHours,
              movieHours: directStats.movieHours,
              movieCount: directStats.movieCount,
              episodeHours: directStats.episodeHours,
              episodeCount: directStats.episodeCount
            }
          };
        }
      }
    } catch (err) {
      logT.warn('DB directe indisponible:', err.message);
    }
    
    // 2️⃣ Fallback: vérifier la BASE DE DONNÉES locale
    const dbStats = getStatsFromDatabase(normalizedUsername);
    
    if (dbStats && dbStats.sessionCount > 0) {
      logT.debug(`${normalizedUsername} — ${dbStats.sessionCount} sessions (cache DB)`);
      return {
        joinedAt: joinedAtTimestamp ? new Date(joinedAtTimestamp * 1000).toISOString() : null,
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
    
    // 3️⃣ Fallback: vérifier le cache SQLite
    const cached = SessionStatsCache.get(normalizedUsername);
    if (cached && cached.sessionCount > 0) {
      logT.debug(`${normalizedUsername} — ${cached.sessionCount} sessions (cache SQLite)`);
      return {
        joinedAt: cached.joinedAt,
        lastActivity: cached.lastActivity,
        sessionCount: cached.sessionCount,
        cachedAt: cached.lastActivity,
        timeSince: "du scan"
      };
    }

    // ⚠️ Pas de données trouvées
    logT.debug(`${normalizedUsername} — aucune donnée trouvée`);
    return null;

  } catch (err) {
    logT.error(err.message);
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
    logT.error('getTautulliUserInfo:', err.message);
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
    const logScan = require('./logger').create('[Tautulli Scan]');
    logScan.info('Début du scan historique...');
    const scanStartTime = Date.now();
    
    // 1️⃣ Récupérer TOUS les utilisateurs Tautulli via get_users
    const tautulliUsers = [];
    
    try {
      const usersRes = await fetch(
        `${TAUTULLI_URL}/api/v2?apikey=${TAUTULLI_API_KEY}&cmd=get_users`,
        { headers: { Accept: "application/json" } }
      );
      
      if (usersRes.ok) {
        const usersJson = await usersRes.json();
        // L'API Tautulli retourne directement un array pour get_users
        if (Array.isArray(usersJson)) {
          tautulliUsers.push(...usersJson);
        } else if (usersJson.response?.data) {
          tautulliUsers.push(...usersJson.response.data);
        } else {
          logScan.warn('Format réponse get_users inconnu:', JSON.stringify(usersJson).substring(0, 100));
        }
      }
    } catch (err) {
      logScan.error('Récupération utilisateurs:', err.message);
    }
    
    logScan.info(`${tautulliUsers.length} utilisateurs trouvés`);
    
    // Charger les timestamps du cache
    const cachedUsers = SessionStatsCache.getAll();
    const userCacheLimits = {};
    for (const [username, userData] of Object.entries(cachedUsers)) {
      if (userData?.lastSessionTimestamp) {
        userCacheLimits[username] = new Date(userData.lastSessionTimestamp);
      }
    }
    logScan.debug(`Cache: ${Object.keys(userCacheLimits).length} utilisateurs`);
    
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
    logScan.debug(`/${Object.keys(userStats).length} utilisateurs initialisés`);
    
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
          logScan.warn('Erreur API HTTP', histRes.status);
          break;
        }
        
        const histJson = await histRes.json();
        
        // Structure Tautulli: { response: { result, message, data: { recordsFiltered, recordsTotal, data: [...sessions] } } }
        const tautulliData = histJson.response?.data?.data || histJson.response?.data || histJson.data || [];
        const sessions = Array.isArray(tautulliData) ? tautulliData : [];
        
        const recordsTotal = histJson.response?.data?.recordsTotal || histJson.recordsTotal || 0;
        if (!sessions || sessions.length === 0) {
          logScan.debug('Fin de pagination (plus de sessions)');
          break;
        }
        
        pagesScanned++;
        totalSessions += sessions.length;
        
        // Arrêter si on a atteint le total
        if (totalSessions >= recordsTotal && recordsTotal > 0) {
          logScan.debug(`Toutes les sessions récupérées: ${totalSessions}`);
          break;
        }
        
        if (pagesScanned > 20 && totalSessions === 0) {
          logScan.warn('Limite de pages atteinte sans sessions');
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
        logScan.warn('Erreur historique page', pagesScanned, ':', err.message);
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
    
    logScan.debug(`${Object.keys(finalStats).length} utilisateurs sauvegardés en cache`);

    const duration = Math.round((Date.now() - scanStartTime) / 1000);
    logScan.info(`Scan terminé — ${totalSessions} sessions, ${Object.keys(finalStats).length} utilisateurs, ${duration}s`);
    
    GLOBAL_SCAN_IN_PROGRESS = false;
    
    try {
      TautulliEvents.emitScanComplete();
    } catch (eventErr) {
      logScan.warn('Erreur émission événement scan-complete:', eventErr.message);
    }
    
    return finalStats;
    
  } catch (err) {
    logScan.error('Erreur globale:', err.message);
    GLOBAL_SCAN_IN_PROGRESS = false;
    try {
      TautulliEvents.emitScanComplete();
    } catch (eventErr) {
      logScan.warn('Erreur émission événement (mode erreur):', eventErr.message);
    }
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🚀 SYSTÈME DE SYNC INTELLIGENT AVEC DELTA-SYNC ET STATS PRÉ-CALCULÉES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Générer un hash unique pour une session (pour éviter les doublons)
 */
function generateSessionHash(session) {
  const crypto = require('crypto');
  const key = `${session.user_id}:${session.rating_key}:${session.date}:${session.play_duration || session.duration}`;
  return crypto.createHash('md5').update(key).digest('hex');
}

/**
 * Obtenir le dernier timestamp synced depuis sync_metadata
 */
function getLastSyncTimestamp(db) {
  try {
    const result = db.prepare(`
      SELECT last_timestamp 
      FROM sync_metadata 
      WHERE sync_type = 'tautulli_full_sync'
      ORDER BY synced_at DESC 
      LIMIT 1
    `).get();
    
    return result?.last_timestamp || 0;
  } catch (err) {
    // Pas de dernier sync enregistré — premier sync complet
    return 0;
  }
}

/**
 * Enregistrer le timestamp du sync en metadata
 */
function recordSyncMetadata(db, sessionsProcessed, durationSecs) {
  try {
    db.prepare(`
      INSERT INTO sync_metadata (sync_type, last_timestamp, sessions_processed, sync_duration_seconds)
      VALUES ('tautulli_full_sync', strftime('%s', 'now'), ?, ?)
    `).run(sessionsProcessed, durationSecs);
  } catch (err) {
    logT.warn('sync metadata:', err.message);
  }
}

/**
 * Recalculer et sauvegarder les stats agrégées pour un utilisateur
 */
function updateUserWatchStats(db, userId, username) {
  try {
    // Récupérer toutes les stats depuis tautulli_sessions
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as sessionCount,
        SUM(duration_seconds) as totalDurationSecs,
        SUM(CASE WHEN media_type = 'movie' THEN 1 ELSE 0 END) as movieCount,
        SUM(CASE WHEN media_type = 'movie' THEN duration_seconds ELSE 0 END) as movieDurationSecs,
        SUM(CASE WHEN media_type = 'episode' THEN 1 ELSE 0 END) as episodeCount,
        SUM(CASE WHEN media_type = 'episode' THEN duration_seconds ELSE 0 END) as episodeDurationSecs,
        MAX(session_date) as lastSessionDate
      FROM tautulli_sessions 
      WHERE user_id = ?
    `).get(userId);
    
    // Insérer ou mettre à jour les stats agrégées
    db.prepare(`
      INSERT INTO user_watch_stats 
      (user_id, username, session_count, total_duration_seconds, last_session_date, 
       movie_count, movie_duration_seconds, episode_count, episode_duration_seconds, last_sync_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(user_id) DO UPDATE SET
        session_count = excluded.session_count,
        total_duration_seconds = excluded.total_duration_seconds,
        last_session_date = excluded.last_session_date,
        movie_count = excluded.movie_count,
        movie_duration_seconds = excluded.movie_duration_seconds,
        episode_count = excluded.episode_count,
        episode_duration_seconds = excluded.episode_duration_seconds,
        last_sync_timestamp = excluded.last_sync_timestamp,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      userId,
      username,
      stats?.sessionCount || 0,
      stats?.totalDurationSecs || 0,
      stats?.lastSessionDate || null,
      stats?.movieCount || 0,
      stats?.movieDurationSecs || 0,
      stats?.episodeCount || 0,
      stats?.episodeDurationSecs || 0
    );
    
    logT.debug(`Stats recalculées pour ${username} — ${stats?.sessionCount || 0} sessions`);
    
  } catch (err) {
    logT.error(`recalcul stats ${username}:`, err.message);
  }
}

/**
 * Sync INTELLIGENT avec DELTA-SYNC
 * - Récupère uniquement les sessions DEPUIS le dernier sync
 * - Détecte et ignore les doublons via hash
 * - Pré-calcule et sauvegarde les stats agrégées
 * - Très rapide après le premier sync (~5k sessions = 2-3 min, puis ~100 per day = ~10sec)
 * 
 * @param {number} maxSessions - Limite (0 = pas de limite)
 * @param {boolean} forceFullSync - Forcer un refresh complet (ignorer last_timestamp)
 */
async function syncTautulliHistoryToDatabase(maxSessions = 5000, forceFullSync = false) {
  const TAUTULLI_URL = process.env.TAUTULLI_URL;
  const TAUTULLI_API_KEY = process.env.TAUTULLI_API_KEY;
  const pageSize = 500;
  const db = getDb();
  const startTime = Date.now();
  
  try {
    // 1️⃣ Déterminer stratégie de sync
    let lastSyncTimestamp = 0;
    if (!forceFullSync) {
      lastSyncTimestamp = getLastSyncTimestamp(db);
    }
    
    const logSync = require('./logger').create('[Tautulli Sync]');
    const syncMode = lastSyncTimestamp === 0 ? "FULL" : "DELTA";
    logSync.info(`${syncMode} — depuis ${lastSyncTimestamp ? new Date(lastSyncTimestamp * 1000).toISOString().slice(0, 10) : 'début'}`);
    
    // 2️⃣ Récupérer les utilisateurs
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
    logSync.info(`${tautulliUsers.length} utilisateurs`);
    
    // 3️⃣ Préparer les statements SQL
    const insertStmt = db.prepare(`
      INSERT INTO tautulli_sessions 
      (user_id, username, media_type, title, duration_seconds, session_timestamp, session_date, watched_status, rating_key, session_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const insertMany = db.transaction((sessions) => {
      for (const session of sessions) {
        const hash = generateSessionHash(session);
        
        try {
          insertStmt.run(
            session.user_id || 0,
            session.username?.toLowerCase() || 'unknown',
            session.media_type || 'unknown',
            session.full_title || session.title || 'Unknown',
            session.play_duration || session.duration || 0,
            session.date || 0,  // Timestamp Unix
            new Date((session.date || 0) * 1000).toISOString(),
            session.watched_status || 0,
            session.rating_key || 0,
            hash
          );
        } catch (err) {
          if (err.message.includes('UNIQUE constraint')) {
            // Doublon détecté via hash - skip silencieusement
            return;
          }
          throw err;
        }
      }
    });
    
    // 4️⃣ Fetcher l'historique avec delta-sync
    let pageIndex = 0;
    let totalInserted = 0;
    let totalSkipped = 0;
    let pagesScanned = 0;
    let recordsTotal = 0;
    
    while (true) {
      try {
        const histRes = await fetch(
          `${TAUTULLI_URL}/api/v2?apikey=${TAUTULLI_API_KEY}&cmd=get_history&start=${pageIndex}&length=${pageSize}`,
          { headers: { Accept: "application/json" } }
        );
        
        if (!histRes.ok) break;
        
        const histJson = await histRes.json();
        const sessions = histJson.response?.data?.data || histJson.data?.data || [];
        recordsTotal = histJson.response?.data?.recordsTotal || 0;
        
        if (!Array.isArray(sessions) || sessions.length === 0) break;
        
        pagesScanned++;
        
        // IMPORTANT: Filtrer uniquement les nouvelles sessions (delta-sync)
        const newSessions = sessions.filter(s => {
          if (lastSyncTimestamp === 0) return true;  // Premier sync = tout
          return (s.date || 0) > lastSyncTimestamp;   // Sinon = sessions > dernier timestamp
        });
        
        if (newSessions.length > 0) {
          insertMany(newSessions);
          totalInserted += newSessions.length;
        }
        
        totalSkipped += (sessions.length - newSessions.length);
        
        if (maxSessions > 0 && totalInserted >= maxSessions) {
          logSync.warn('Limite', maxSessions, 'sessions atteinte');
          break;
        }
        
        // Arrêter si fin
        if (totalInserted >= recordsTotal && recordsTotal > 0) {
          break;
        }
        
        pageIndex += pageSize;
        await new Promise(r => setTimeout(r, 50));  // Petit délai
        
      } catch (err) {
        logSync.error('fetch page:', err.message);
        break;
      }
    }
    
    // 5️⃣ Recalculer les stats pour TOUS les utilisateurs (une seule fois)
    logSync.debug(`Recalcul stats pour ${tautulliUsers.length} utilisateurs...`);
    for (const user of tautulliUsers) {
      updateUserWatchStats(db, user.id, user.username?.toLowerCase() || 'unknown');
    }
    
    // 6️⃣ Enregistrer metadata du sync
    const elapsedSecs = Math.round((Date.now() - startTime) / 1000);
    recordSyncMetadata(db, totalInserted, elapsedSecs);
    
    logSync.info(`${syncMode} terminé — ${totalInserted} insérées, ${totalSkipped} doublons, ${tautulliUsers.length} users, ${elapsedSecs}s`);
    
    return {
      success: true,
      sessionsInerted: totalInserted,
      sessionsSkipped: totalSkipped,
      usersCount: tautulliUsers.length,
      durationSeconds: elapsedSecs,
      syncMode: syncMode
    };
    
  } catch (err) {
    logT.error('syncTautulliHistoryToDatabase:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Obtenir les stats d'un utilisateur depuis la DB (ultra-rapide)
 * Lit depuis la table user_watch_stats pré-calculée
 */
function getStatsFromDatabase(username) {
  if (!username) return null;
  
  const db = getDb();
  const usernameLower = username.toLowerCase();
  
  try {
    // Lecture simple depuis la table des stats pré-calculées (1 query ultra-rapide)
    const stats = db.prepare(`
      SELECT 
        user_id,
        session_count,
        total_duration_seconds,
        last_session_date,
        movie_count,
        movie_duration_seconds,
        episode_count,
        episode_duration_seconds,
        last_sync_timestamp
      FROM user_watch_stats 
      WHERE username = ?
    `).get(usernameLower);
    
    if (!stats || stats.session_count === 0) {
      return null;
    }
    
    // Convertir en heures
    const totalHours = stats.total_duration_seconds ? Math.round(stats.total_duration_seconds / 3600 * 10) / 10 : 0;
    const movieHours = stats.movie_duration_seconds ? Math.round(stats.movie_duration_seconds / 3600 * 10) / 10 : 0;
    const episodeHours = stats.episode_duration_seconds ? Math.round(stats.episode_duration_seconds / 3600 * 10) / 10 : 0;
    
    return {
      sessionCount: stats.session_count,
      totalHours: totalHours,
      movieCount: stats.movie_count,
      movieHours: movieHours,
      episodeCount: stats.episode_count,
      episodeHours: episodeHours,
      lastSessionDate: stats.last_session_date,
      userId: stats.user_id,
      lastSyncTimestamp: stats.last_sync_timestamp
    };
    
  } catch (err) {
  } catch (err) {
    logT.error('getStatsFromDatabase:', err.message);
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
