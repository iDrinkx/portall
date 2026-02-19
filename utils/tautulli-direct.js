/**
 * 🗄️ TAUTULLI DIRECT DATABASE READER
 * Lit directement la DB Tautulli (lecture seule) pour éviter l'API
 * Path de la DB fourni via variable d'environnement
 */

const Database = require('better-sqlite3');
const path = require('path');

let tautulliDb = null;

/**
 * Initialiser la connexion à la DB Tautulli
 * En lecture seule pour éviter tout risque de corruption
 */
function initTautulliDatabase() {
  const TAUTULLI_DB_PATH = process.env.TAUTULLI_DB_PATH;
  
  console.log("[TAUTULLI-DB] 🔍 Vérification TAUTULLI_DB_PATH:", TAUTULLI_DB_PATH || "NON CONFIGURÉ");
  
  if (!TAUTULLI_DB_PATH) {
    console.warn("[TAUTULLI-DB] ⚠️  TAUTULLI_DB_PATH non configuré - fonctionnalités Tautulli désactivées");
    return false;
  }
  
  try {
    // Ouvrir en lecture seule
    tautulliDb = new Database(TAUTULLI_DB_PATH, { readonly: true });
    console.log("[TAUTULLI-DB] ✅ Connecté à la DB Tautulli:", TAUTULLI_DB_PATH);
    return true;
  } catch (err) {
    console.error("[TAUTULLI-DB] ❌ Erreur connexion Tautulli DB:", err.message);
    console.error("[TAUTULLI-DB] ❌ Vérifiez que le chemin existe et est accessible");
    return false;
  }
}

/**
 * Vérifier que la connexion est active
 */
function isTautulliReady() {
  return tautulliDb !== null;
}

/**
 * 📊 Récupérer les stats de visionnage pour UN utilisateur
 * Agrégation optimisée directement en SQL
 */
function getUserStatsFromTautulli(username) {
  if (!tautulliDb) {
    return null;
  }
  
  try {
    const normalizedUsername = username.toLowerCase();
    
    // 🎯 Requête SQL optimisée - agrégation directe
    // Tautulli stocke les historiques dans la table `session_history`
    // Durée = (stopped - started) en secondes
    const stmt = tautulliDb.prepare(`
      SELECT 
        u.user_id,
        u.username,
        COUNT(*) as session_count,
        SUM(CAST((sh.stopped - sh.started) AS INTEGER)) as total_duration_seconds,
        MAX(sh.date) as last_session_timestamp,
        SUM(CASE WHEN sh.media_type = 'movie' THEN 1 ELSE 0 END) as movie_count,
        SUM(CASE WHEN sh.media_type = 'movie' THEN CAST((sh.stopped - sh.started) AS INTEGER) ELSE 0 END) as movie_duration_seconds,
        SUM(CASE WHEN sh.media_type = 'episode' THEN 1 ELSE 0 END) as episode_count,
        SUM(CASE WHEN sh.media_type = 'episode' THEN CAST((sh.stopped - sh.started) AS INTEGER) ELSE 0 END) as episode_duration_seconds
      FROM users u
      LEFT JOIN session_history sh ON u.user_id = sh.user_id
      WHERE LOWER(u.username) = ?
      GROUP BY u.user_id, u.username
    `);
    
    const stats = stmt.get(normalizedUsername);
    
    if (!stats || !stats.session_count) {
      console.log("[TAUTULLI-DIRECT] ℹ️  Pas de sessions pour:", normalizedUsername);
      return null;
    }
    
    // Convertir en heures
    const totalHours = stats.total_duration_seconds ? Math.round(stats.total_duration_seconds / 3600 * 10) / 10 : 0;
    const movieHours = stats.movie_duration_seconds ? Math.round(stats.movie_duration_seconds / 3600 * 10) / 10 : 0;
    const episodeHours = stats.episode_duration_seconds ? Math.round(stats.episode_duration_seconds / 3600 * 10) / 10 : 0;
    
    console.log("[TAUTULLI-DIRECT] ✅ Stats pour" , normalizedUsername, "- sessions:", stats.session_count);
    
    return {
      userId: stats.user_id,
      username: stats.username,
      sessionCount: stats.session_count || 0,
      totalHours: totalHours,
      movieCount: stats.movie_count || 0,
      movieHours: movieHours,
      episodeCount: stats.episode_count || 0,
      episodeHours: episodeHours,
      lastSessionTimestamp: stats.last_session_timestamp,
      lastSessionDate: stats.last_session_timestamp ? new Date(stats.last_session_timestamp * 1000).toISOString() : null
    };
  } catch (err) {
    console.error("[TAUTULLI-DIRECT] ❌ Erreur requête utilisateur:", err.message);
    return null;
  }
}

/**
 * 👥 Récupérer les stats pour TOUS les utilisateurs (à la fois)
 * Rapide: une seule requête SQL pour tous les users
 */
function getAllUserStatsFromTautulli() {
  if (!tautulliDb) {
    return [];
  }
  
  try {
    console.log("[TAUTULLI-DIRECT] 🚀 Récupération des stats pour TOUS les utilisateurs...");
    
    const stmt = tautulliDb.prepare(`
      SELECT 
        u.user_id,
        u.username,
        COUNT(*) as session_count,
        SUM(CAST((sh.stopped - sh.started) AS INTEGER)) as total_duration_seconds,
        MAX(sh.date) as last_session_timestamp,
        SUM(CASE WHEN sh.media_type = 'movie' THEN 1 ELSE 0 END) as movie_count,
        SUM(CASE WHEN sh.media_type = 'movie' THEN CAST((sh.stopped - sh.started) AS INTEGER) ELSE 0 END) as movie_duration_seconds,
        SUM(CASE WHEN sh.media_type = 'episode' THEN 1 ELSE 0 END) as episode_count,
        SUM(CASE WHEN sh.media_type = 'episode' THEN CAST((sh.stopped - sh.started) AS INTEGER) ELSE 0 END) as episode_duration_seconds
      FROM users u
      LEFT JOIN session_history sh ON u.user_id = sh.user_id
      GROUP BY u.user_id, u.username
      ORDER BY u.username
    `);
    
    const allStats = stmt.all();
    
    const results = allStats.map(stats => {
      const totalHours = stats.total_duration_seconds ? Math.round(stats.total_duration_seconds / 3600 * 10) / 10 : 0;
      const movieHours = stats.movie_duration_seconds ? Math.round(stats.movie_duration_seconds / 3600 * 10) / 10 : 0;
      const episodeHours = stats.episode_duration_seconds ? Math.round(stats.episode_duration_seconds / 3600 * 10) / 10 : 0;
      
      return {
        userId: stats.user_id,
        username: stats.username,
        sessionCount: stats.session_count || 0,
        totalHours: totalHours,
        movieCount: stats.movie_count || 0,
        movieHours: movieHours,
        episodeCount: stats.episode_count || 0,
        episodeHours: episodeHours,
        lastSessionTimestamp: stats.last_session_timestamp,
        lastSessionDate: stats.last_session_timestamp ? new Date(stats.last_session_timestamp * 1000).toISOString() : null
      };
    });
    
    console.log("[TAUTULLI-DIRECT] ✅ " + results.length + " utilisateurs traités en 1 requête");
    return results;
    
  } catch (err) {
    console.error("[TAUTULLI-DIRECT] ❌ Erreur requête tous users:", err.message);
    return [];
  }
}

/**
 * 🔍 Récupérer les utilisateurs actuellement en lecture (live sessions)
 */
function getLiveUsers() {
  if (!tautulliDb) {
    return [];
  }
  
  try {
    const stmt = tautulliDb.prepare(`
      SELECT DISTINCT
        u.user_id,
        u.username,
        s.started AS session_started,
        CAST((s.stopped - s.started) AS INTEGER) as watch_duration,
        m.title,
        m.media_type
      FROM users u
      JOIN session_history s ON u.user_id = s.user_id
      LEFT JOIN media_info m ON s.rating_key = m.rating_key
      WHERE s.stopped = 0 OR s.stopped IS NULL
      ORDER BY u.username
    `);
    
    const liveUsers = stmt.all();
    console.log("[TAUTULLI-DIRECT] 🔴 " + liveUsers.length + " utilisateurs en lecture");
    return liveUsers;
    
  } catch (err) {
    console.warn("[TAUTULLI-DIRECT] ⚠️  Erreur requête live users:", err.message);
    return [];
  }
}

/**
 * Fermer la connexion (au shutdown)
 */
function closeTautulliDatabase() {
  if (tautulliDb) {
    tautulliDb.close();
    tautulliDb = null;
    console.log("[TAUTULLI-DB] 🔌 Connexion fermée");
  }
}

module.exports = {
  initTautulliDatabase,
  isTautulliReady,
  getUserStatsFromTautulli,
  getAllUserStatsFromTautulli,
  getLiveUsers,
  closeTautulliDatabase
};
