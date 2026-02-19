const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// 🗄️ Utiliser le dossier /config pour la persistance (volumes Docker/Unraid)
const DB_PATH = process.env.DB_PATH || '/config/plex-portal.db';
const dataDir = path.dirname(DB_PATH);

// Créer le répertoire config s'il n'existe pas
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db = null;

/**
 * Initialiser la base de données et exécuter les migrations
 */
function initDatabase() {
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');  // Mode WAL pour meilleure concurrence
    
    console.log("[DB] 🗄️  Base de données initialisée:", DB_PATH);
    
    // Exécuter les migrations
    runMigrations();
    
    return db;
  } catch (err) {
    console.error("[DB] ❌ Erreur initialisation DB:", err.message);
    throw err;
  }
}

/**
 * Ajouter une colonne à une table existante (ne fait rien si elle existe déjà)
 */
function attemptAddColumn(tableName, columnName, columnDef) {
  try {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
    console.log(`[DB] ✅ Colonne ajoutée: ${tableName}.${columnName}`);
  } catch (err) {
    // Ignorer l'erreur si la colonne existe déjà (ou autre erreur table inexistante)
    if (!err.message.includes('duplicate column') && !err.message.includes('no such table')) {
      console.warn(`[DB] ⚠️  Impossible d'ajouter ${tableName}.${columnName}:`, err.message);
    }
  }
}

/**
 * Exécuter les migrations (créer les tables si elles n'existent pas)
 */
function runMigrations() {
  try {
    // 🔧 MIGRATIONS DE SCHÉMA - Ajouter les colonnes manquantes aux tables existantes
    attemptAddColumn('tautulli_sessions', 'session_timestamp', 'INTEGER NOT NULL DEFAULT 0');
    attemptAddColumn('tautulli_sessions', 'session_date', 'DATETIME');
    attemptAddColumn('tautulli_sessions', 'watched_status', 'REAL DEFAULT 0');
    attemptAddColumn('tautulli_sessions', 'rating_key', 'INTEGER');
    attemptAddColumn('tautulli_sessions', 'session_hash', 'TEXT');
    
    // Table: users
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        plexId INTEGER,
        email TEXT,
        joinedAt TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("[DB] ✅ Table 'users' vérifiée");
    
    // Table: watch_history - Historique des stats de visionnage
    db.exec(`
      CREATE TABLE IF NOT EXISTS watch_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        scannedAt DATETIME NOT NULL,
        movieCount INTEGER DEFAULT 0,
        movieHours REAL DEFAULT 0,
        episodeCount INTEGER DEFAULT 0,
        episodeHours REAL DEFAULT 0,
        totalHours REAL DEFAULT 0,
        sessionCount INTEGER DEFAULT 0,
        lastSessionTimestamp TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, scannedAt)
      )
    `);
    console.log("[DB] ✅ Table 'watch_history' vérifiée");
    
    // Table: session_cache - Cache des sessions (pour éviter double-counting)
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        sessionId TEXT UNIQUE NOT NULL,
        title TEXT,
        mediaType TEXT,
        startedAt DATETIME,
        totalDurationMs INTEGER,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    console.log("[DB] ✅ Table 'session_cache' vérifiée");
    
    // Table: tautulli_sessions - Historique complet des sessions Tautulli
    db.exec(`
      CREATE TABLE IF NOT EXISTS tautulli_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        media_type TEXT NOT NULL,
        title TEXT NOT NULL,
        duration_seconds INTEGER DEFAULT 0,
        session_timestamp INTEGER NOT NULL,
        session_date DATETIME NOT NULL,
        watched_status REAL DEFAULT 0,
        rating_key INTEGER,
        session_hash TEXT,
        synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    console.log("[DB] ✅ Table 'tautulli_sessions' vérifiée");
    
    // Table: user_watch_stats - Stats pré-calculées PAR UTILISATEUR
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_watch_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        username TEXT NOT NULL UNIQUE,
        
        -- Stats globales
        session_count INTEGER DEFAULT 0,
        total_duration_seconds INTEGER DEFAULT 0,
        last_session_date DATETIME,
        
        -- Stats films
        movie_count INTEGER DEFAULT 0,
        movie_duration_seconds INTEGER DEFAULT 0,
        
        -- Stats séries
        episode_count INTEGER DEFAULT 0,
        episode_duration_seconds INTEGER DEFAULT 0,
        
        -- Metadata
        last_sync_timestamp INTEGER,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    console.log("[DB] ✅ Table 'user_watch_stats' vérifiée");
    
    // Table: sync_metadata - Historique des syncs pour delta-sync intelligent
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_type TEXT NOT NULL,
        last_timestamp INTEGER,
        sessions_processed INTEGER DEFAULT 0,
        sync_duration_seconds INTEGER DEFAULT 0,
        synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("[DB] ✅ Table 'sync_metadata' vérifiée");
    
    // Table: user_achievements - Succès débloqués manuellement par utilisateur
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_achievements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        achievement_id TEXT NOT NULL,
        unlocked_date TEXT NOT NULL,
        granted_by TEXT DEFAULT 'admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, achievement_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    console.log("[DB] ✅ Table 'user_achievements' vérifiée");

    // Index pour perf
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_achievements_achievement ON user_achievements(achievement_id);
      CREATE INDEX IF NOT EXISTS idx_watch_history_user ON watch_history(user_id);
      CREATE INDEX IF NOT EXISTS idx_watch_history_scanned ON watch_history(scannedAt);
      CREATE INDEX IF NOT EXISTS idx_session_cache_user ON session_cache(user_id);
      CREATE INDEX IF NOT EXISTS idx_tautulli_sessions_user ON tautulli_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_tautulli_sessions_username ON tautulli_sessions(username);
      CREATE INDEX IF NOT EXISTS idx_tautulli_sessions_timestamp ON tautulli_sessions(session_timestamp);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tautulli_sessions_hash ON tautulli_sessions(session_hash) WHERE session_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_user_watch_stats_user ON user_watch_stats(user_id);
      CREATE INDEX IF NOT EXISTS idx_sync_metadata_type ON sync_metadata(sync_type);
    `);
    console.log("[DB] ✅ Indexes créés");
    
  } catch (err) {
    console.error("[DB] ❌ Erreur migrations:", err.message);
    throw err;
  }
}

/**
 * Obtenir la connexion DB
 */
function getDb() {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

/**
 * Fermer la base de données
 */
function closeDatabase() {
  if (db) {
    db.close();
    db = null;
    console.log("[DB] 🔌 Base de données fermée");
  }
}

/**
 * User queries
 */
const UserQueries = {
  /**
   * Créer ou obtenir un utilisateur
   */
  upsert(username, plexId, email, joinedAt) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO users (username, plexId, email, joinedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        email = excluded.email,
        joinedAt = excluded.joinedAt,
        updatedAt = CURRENT_TIMESTAMP
      RETURNING *
    `);
    return stmt.get(username, plexId || null, email || null, joinedAt || null);
  },
  
  /**
   * Obtenir un utilisateur par username
   */
  getByUsername(username) {
    const db = getDb();
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  },
  
  /**
   * Obtenir tous les utilisateurs
   */
  getAll() {
    const db = getDb();
    return db.prepare('SELECT * FROM users ORDER BY username').all();
  }
};

/**
 * Watch history queries
 */
const WatchHistoryQueries = {
  /**
   * Insérer une nouvelle entrée d'historique
   */
  insert(userId, scannedAt, stats) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO watch_history (
        user_id,
        scannedAt,
        movieCount,
        movieHours,
        episodeCount,
        episodeHours,
        totalHours,
        sessionCount,
        lastSessionTimestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    return stmt.run(
      userId,
      scannedAt,
      stats.movieCount || 0,
      stats.movieHours || 0,
      stats.episodeCount || 0,
      stats.episodeHours || 0,
      stats.totalHours || 0,
      stats.sessionCount || 0,
      stats.lastSessionTimestamp || null
    );
  },
  
  /**
   * Obtenir le dernier enregistrement pour un utilisateur
   */
  getLatestForUser(userId) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM watch_history 
      WHERE user_id = ? 
      ORDER BY scannedAt DESC 
      LIMIT 1
    `).get(userId);
  },
  
  /**
   * Obtenir l'historique d'un utilisateur (derniers N jours)
   */
  getHistoryForUser(userId, days = 30) {
    const db = getDb();
    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return db.prepare(`
      SELECT * FROM watch_history 
      WHERE user_id = ? AND scannedAt >= ? 
      ORDER BY scannedAt DESC
    `).all(userId, fromDate);
  },
  
  /**
   * Obtenir l'historique complet d'un utilisateur
   */
  getAllForUser(userId) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM watch_history 
      WHERE user_id = ? 
      ORDER BY scannedAt DESC
    `).all(userId);
  },
  
  /**
   * Obtenir le dernier scan timestamp pour tous les utilisateurs
   */
  getLastScansForAllUsers() {
    const db = getDb();
    return db.prepare(`
      SELECT DISTINCT ON (user_id) 
        user_id, 
        scannedAt, 
        movieCount, 
        movieHours,
        episodeCount,
        episodeHours,
        totalHours,
        sessionCount,
        lastSessionTimestamp
      FROM watch_history 
      ORDER BY user_id, scannedAt DESC
    `).all();
  }
};

/**
 * Session cache queries
 */
const SessionCacheQueries = {
  /**
   * Insérer une session en cache
   */
  insert(userId, sessionId, title, mediaType, startedAt, totalDurationMs) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO session_cache (
        user_id,
        sessionId,
        title,
        mediaType,
        startedAt,
        totalDurationMs
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(userId, sessionId, title, mediaType, startedAt, totalDurationMs);
  },
  
  /**
   * Vérifier si une session est déjà en cache
   */
  exists(userId, sessionId) {
    const db = getDb();
    return db.prepare('SELECT 1 FROM session_cache WHERE user_id = ? AND sessionId = ?').get(userId, sessionId) !== undefined;
  },
  
  /**
   * Obtenir le dernier timestamp de session pour un utilisateur
   */
  getLastSessionTimestamp(userId) {
    const db = getDb();
    return db.prepare(`
      SELECT MAX(startedAt) as lastTimestamp 
      FROM session_cache 
      WHERE user_id = ?
    `).get(userId)?.lastTimestamp;
  },
  
  /**
   * Nettoyer les vieilles sessions (> X jours)
   */
  cleanOldSessions(days = 90) {
    const db = getDb();
    const beforeDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare('DELETE FROM session_cache WHERE startedAt < ?');
    const result = stmt.run(beforeDate);
    console.log("[DB] 🧹 Sessions nettoyées:", result.changes, "supprimées");
    return result.changes;
  }
};

/**
 * User achievements queries (succès secrets débloqués manuellement)
 */
const UserAchievementQueries = {
  /**
   * Débloquer un succès pour un utilisateur
   */
  unlock(userId, achievementId, unlockedDate, grantedBy = 'admin') {
    const db = getDb();
    return db.prepare(`
      INSERT OR REPLACE INTO user_achievements (user_id, achievement_id, unlocked_date, granted_by)
      VALUES (?, ?, ?, ?)
    `).run(userId, achievementId, unlockedDate, grantedBy);
  },

  /**
   * Obtenir tous les succès débloqués pour un utilisateur
   * Retourne un objet { achievementId: unlockedDate }
   */
  getForUser(userId) {
    const db = getDb();
    const rows = db.prepare(`
      SELECT achievement_id, unlocked_date FROM user_achievements WHERE user_id = ?
    `).all(userId);
    return Object.fromEntries(rows.map(r => [r.achievement_id, r.unlocked_date]));
  },

  /**
   * Vérifier si un succès est débloqué pour un utilisateur
   */
  isUnlocked(userId, achievementId) {
    const db = getDb();
    return !!db.prepare(`
      SELECT 1 FROM user_achievements WHERE user_id = ? AND achievement_id = ?
    `).get(userId, achievementId);
  },

  /**
   * Révoquer un succès pour un utilisateur
   */
  revoke(userId, achievementId) {
    const db = getDb();
    return db.prepare(`
      DELETE FROM user_achievements WHERE user_id = ? AND achievement_id = ?
    `).run(userId, achievementId);
  }
};

/**
 * Transactions helper
 */
function transaction(callback) {
  const db = getDb();
  const trans = db.transaction(callback);
  return trans();
}

module.exports = {
  initDatabase,
  closeDatabase,
  getDb,
  transaction,
  UserQueries,
  WatchHistoryQueries,
  SessionCacheQueries,
  UserAchievementQueries,
  DB_PATH
};
