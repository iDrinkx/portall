const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// 🗄️ Utiliser le dossier /config pour la persistance (volumes Docker/Unraid)
const defaultDbPath = '/config/portall.db';
const legacyDbName = ['plex', 'portal.db'].join('-');
const legacyDbPath = path.join('/config', legacyDbName);
const SQLITE_SIDECAR_SUFFIXES = ['-shm', '-wal'];

function moveFileIfPresent(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return;
  fs.renameSync(sourcePath, targetPath);
}

function removeFileIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return;
  fs.unlinkSync(filePath);
}

function migrateLegacyDatabaseFiles() {
  if (process.env.DB_PATH) return process.env.DB_PATH;

  if (!fs.existsSync(defaultDbPath) && fs.existsSync(legacyDbPath)) {
    try {
      fs.renameSync(legacyDbPath, defaultDbPath);
      for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
        moveFileIfPresent(`${legacyDbPath}${suffix}`, `${defaultDbPath}${suffix}`);
      }
      return defaultDbPath;
    } catch (_) {
      return legacyDbPath;
    }
  }

  if (fs.existsSync(defaultDbPath) && !fs.existsSync(legacyDbPath)) {
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      removeFileIfPresent(`${legacyDbPath}${suffix}`);
    }
  }

  return defaultDbPath;
}

let DB_PATH = process.env.DB_PATH || defaultDbPath;
if (DB_PATH === defaultDbPath) DB_PATH = migrateLegacyDatabaseFiles();
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
    
    require('./logger').create('[DB]').info('Base de données initialisée:', DB_PATH);
    
    // Exécuter les migrations
    runMigrations();
    
    return db;
  } catch (err) {
    require('./logger').create('[DB]').error('Erreur initialisation:', err.message);
    throw err;
  }
}

/**
 * Ajouter une colonne à une table existante (ne fait rien si elle existe déjà)
 */
function attemptAddColumn(tableName, columnName, columnDef) {
  try {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
    require('./logger').create('[DB]').debug(`Colonne ajoutée: ${tableName}.${columnName}`);
  } catch (err) {
    // Ignorer l'erreur si la colonne existe déjà (ou autre erreur table inexistante)
    if (!err.message.includes('duplicate column') && !err.message.includes('no such table')) {
      require('./logger').create('[DB]').warn(`Impossible d'ajouter ${tableName}.${columnName}:`, err.message);
    }
  }
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function mergeUsersCaseInsensitive() {
  const log = require('./logger').create('[DB]');
  const groups = db.prepare(`
    SELECT LOWER(TRIM(username)) AS normalized_username, COUNT(*) AS duplicate_count
    FROM users
    GROUP BY LOWER(TRIM(username))
    HAVING COUNT(*) > 1
  `).all();

  if (!groups.length) {
    const normalized = db.prepare(`
      UPDATE users
      SET username = LOWER(TRIM(username)), updatedAt = CURRENT_TIMESTAMP
      WHERE username != LOWER(TRIM(username))
    `).run();
    if (normalized.changes > 0) {
      log.info(`Migration usernames normalises: ${normalized.changes} utilisateur(s)`);
    }
    return;
  }

  const mergeOneGroup = db.transaction((normalizedUsername) => {
    const rows = db.prepare(`
      SELECT *
      FROM users
      WHERE LOWER(TRIM(username)) = ?
      ORDER BY id ASC
    `).all(normalizedUsername);

    if (rows.length < 2) return 0;

    const canonical = rows[0];
    const duplicates = rows.slice(1);
    const mergedPlexId = canonical.plexId || rows.find((row) => row.plexId)?.plexId || null;
    const mergedEmail = canonical.email || rows.find((row) => row.email)?.email || null;
    const mergedJoinedAt = canonical.joinedAt || rows.find((row) => row.joinedAt)?.joinedAt || null;

    for (const duplicate of duplicates) {
      db.prepare(`
        INSERT INTO watch_history (
          user_id, scannedAt, movieCount, movieHours, episodeCount, episodeHours, totalHours, sessionCount, lastSessionTimestamp
        )
        SELECT ?, scannedAt, movieCount, movieHours, episodeCount, episodeHours, totalHours, sessionCount, lastSessionTimestamp
        FROM watch_history
        WHERE user_id = ?
        ON CONFLICT(user_id, scannedAt) DO UPDATE SET
          movieCount = MAX(watch_history.movieCount, excluded.movieCount),
          movieHours = MAX(watch_history.movieHours, excluded.movieHours),
          episodeCount = MAX(watch_history.episodeCount, excluded.episodeCount),
          episodeHours = MAX(watch_history.episodeHours, excluded.episodeHours),
          totalHours = MAX(
            watch_history.totalHours,
            excluded.totalHours,
            ROUND(COALESCE(watch_history.movieHours, 0) + COALESCE(watch_history.episodeHours, 0), 1),
            ROUND(COALESCE(excluded.movieHours, 0) + COALESCE(excluded.episodeHours, 0), 1)
          ),
          sessionCount = MAX(watch_history.sessionCount, excluded.sessionCount),
          lastSessionTimestamp = CASE
            WHEN excluded.lastSessionTimestamp IS NULL THEN watch_history.lastSessionTimestamp
            WHEN watch_history.lastSessionTimestamp IS NULL THEN excluded.lastSessionTimestamp
            WHEN excluded.lastSessionTimestamp > watch_history.lastSessionTimestamp THEN excluded.lastSessionTimestamp
            ELSE watch_history.lastSessionTimestamp
          END
      `).run(canonical.id, duplicate.id);
      db.prepare(`DELETE FROM watch_history WHERE user_id = ?`).run(duplicate.id);

      db.prepare(`UPDATE session_cache SET user_id = ? WHERE user_id = ?`).run(canonical.id, duplicate.id);
      db.prepare(`UPDATE tautulli_sessions SET user_id = ?, username = ? WHERE user_id = ?`).run(canonical.id, normalizedUsername, duplicate.id);

      db.prepare(`
        INSERT INTO user_watch_stats (
          user_id, username, session_count, total_duration_seconds, last_session_date,
          movie_count, movie_duration_seconds, episode_count, episode_duration_seconds, last_sync_timestamp, updated_at
        )
        SELECT ?, ?, session_count, total_duration_seconds, last_session_date,
               movie_count, movie_duration_seconds, episode_count, episode_duration_seconds, last_sync_timestamp, updated_at
        FROM user_watch_stats
        WHERE user_id = ?
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username,
          session_count = MAX(user_watch_stats.session_count, excluded.session_count),
          total_duration_seconds = MAX(user_watch_stats.total_duration_seconds, excluded.total_duration_seconds),
          last_session_date = CASE
            WHEN excluded.last_session_date IS NULL THEN user_watch_stats.last_session_date
            WHEN user_watch_stats.last_session_date IS NULL THEN excluded.last_session_date
            WHEN excluded.last_session_date > user_watch_stats.last_session_date THEN excluded.last_session_date
            ELSE user_watch_stats.last_session_date
          END,
          movie_count = MAX(user_watch_stats.movie_count, excluded.movie_count),
          movie_duration_seconds = MAX(user_watch_stats.movie_duration_seconds, excluded.movie_duration_seconds),
          episode_count = MAX(user_watch_stats.episode_count, excluded.episode_count),
          episode_duration_seconds = MAX(user_watch_stats.episode_duration_seconds, excluded.episode_duration_seconds),
          last_sync_timestamp = MAX(user_watch_stats.last_sync_timestamp, excluded.last_sync_timestamp),
          updated_at = CURRENT_TIMESTAMP
      `).run(canonical.id, normalizedUsername, duplicate.id);
      db.prepare(`DELETE FROM user_watch_stats WHERE user_id = ?`).run(duplicate.id);

      db.prepare(`
        INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, unlocked_date, granted_by, created_at)
        SELECT ?, achievement_id, unlocked_date, granted_by, created_at
        FROM user_achievements
        WHERE user_id = ?
      `).run(canonical.id, duplicate.id);
      db.prepare(`DELETE FROM user_achievements WHERE user_id = ?`).run(duplicate.id);

      db.prepare(`
        INSERT INTO achievement_progress (user_id, achievement_id, current, total, updated_at)
        SELECT ?, achievement_id, current, total, updated_at
        FROM achievement_progress
        WHERE user_id = ?
        ON CONFLICT(user_id, achievement_id) DO UPDATE SET
          current = MAX(achievement_progress.current, excluded.current),
          total = MAX(achievement_progress.total, excluded.total),
          updated_at = CURRENT_TIMESTAMP
      `).run(canonical.id, duplicate.id);
      db.prepare(`DELETE FROM achievement_progress WHERE user_id = ?`).run(duplicate.id);

      db.prepare(`
        INSERT INTO achievement_snapshots (
          user_id, total_hours, movie_count, episode_count, session_count, monthly_hours, night_count, morning_count,
          days_joined, badge_count, total_xp, level, rank_name, rank_icon, rank_color, rank_bg_color, rank_border_color,
          progress_percent, xp_needed, full_evaluated_at, updated_at
        )
        SELECT ?, total_hours, movie_count, episode_count, session_count, monthly_hours, night_count, morning_count,
          days_joined, badge_count, total_xp, level, rank_name, rank_icon, rank_color, rank_bg_color, rank_border_color,
          progress_percent, xp_needed, full_evaluated_at, updated_at
        FROM achievement_snapshots
        WHERE user_id = ?
        ON CONFLICT(user_id) DO UPDATE SET
          total_hours = MAX(achievement_snapshots.total_hours, excluded.total_hours),
          movie_count = MAX(achievement_snapshots.movie_count, excluded.movie_count),
          episode_count = MAX(achievement_snapshots.episode_count, excluded.episode_count),
          session_count = MAX(achievement_snapshots.session_count, excluded.session_count),
          monthly_hours = MAX(achievement_snapshots.monthly_hours, excluded.monthly_hours),
          night_count = MAX(achievement_snapshots.night_count, excluded.night_count),
          morning_count = MAX(achievement_snapshots.morning_count, excluded.morning_count),
          days_joined = MAX(achievement_snapshots.days_joined, excluded.days_joined),
          badge_count = MAX(achievement_snapshots.badge_count, excluded.badge_count),
          total_xp = MAX(achievement_snapshots.total_xp, excluded.total_xp),
          level = MAX(achievement_snapshots.level, excluded.level),
          rank_name = CASE WHEN excluded.total_xp >= achievement_snapshots.total_xp THEN excluded.rank_name ELSE achievement_snapshots.rank_name END,
          rank_icon = CASE WHEN excluded.total_xp >= achievement_snapshots.total_xp THEN excluded.rank_icon ELSE achievement_snapshots.rank_icon END,
          rank_color = CASE WHEN excluded.total_xp >= achievement_snapshots.total_xp THEN excluded.rank_color ELSE achievement_snapshots.rank_color END,
          rank_bg_color = CASE WHEN excluded.total_xp >= achievement_snapshots.total_xp THEN excluded.rank_bg_color ELSE achievement_snapshots.rank_bg_color END,
          rank_border_color = CASE WHEN excluded.total_xp >= achievement_snapshots.total_xp THEN excluded.rank_border_color ELSE achievement_snapshots.rank_border_color END,
          progress_percent = CASE WHEN excluded.total_xp >= achievement_snapshots.total_xp THEN excluded.progress_percent ELSE achievement_snapshots.progress_percent END,
          xp_needed = CASE WHEN excluded.total_xp >= achievement_snapshots.total_xp THEN excluded.xp_needed ELSE achievement_snapshots.xp_needed END,
          full_evaluated_at = COALESCE(excluded.full_evaluated_at, achievement_snapshots.full_evaluated_at),
          updated_at = CURRENT_TIMESTAMP
      `).run(canonical.id, duplicate.id);
      db.prepare(`DELETE FROM achievement_snapshots WHERE user_id = ?`).run(duplicate.id);

      db.prepare(`
        INSERT INTO user_service_credentials (user_id, service_key, username, secret_encrypted, meta_json, updated_at)
        SELECT ?, service_key, username, secret_encrypted, meta_json, updated_at
        FROM user_service_credentials
        WHERE user_id = ?
        ON CONFLICT(user_id, service_key) DO UPDATE SET
          username = COALESCE(NULLIF(user_service_credentials.username, ''), excluded.username),
          secret_encrypted = COALESCE(NULLIF(user_service_credentials.secret_encrypted, ''), excluded.secret_encrypted),
          meta_json = COALESCE(user_service_credentials.meta_json, excluded.meta_json),
          updated_at = CURRENT_TIMESTAMP
      `).run(canonical.id, duplicate.id);
      db.prepare(`DELETE FROM user_service_credentials WHERE user_id = ?`).run(duplicate.id);

      db.prepare(`DELETE FROM users WHERE id = ?`).run(duplicate.id);
    }

    db.prepare(`
      UPDATE users
      SET username = ?, plexId = ?, email = ?, joinedAt = ?, updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(normalizedUsername, mergedPlexId, mergedEmail, mergedJoinedAt, canonical.id);

    return duplicates.length;
  });

  let mergedUsers = 0;
  for (const group of groups) {
    mergedUsers += mergeOneGroup(group.normalized_username);
  }

  const normalized = db.prepare(`
    UPDATE users
    SET username = LOWER(TRIM(username)), updatedAt = CURRENT_TIMESTAMP
    WHERE username != LOWER(TRIM(username))
  `).run();

  log.warn(`Migration usernames fusionnes: ${mergedUsers} doublon(s) rattache(s), ${normalized.changes} username(s) normalise(s)`);
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
    attemptAddColumn('dashboard_custom_cards', 'open_in_iframe', 'INTEGER NOT NULL DEFAULT 1');
    attemptAddColumn('dashboard_custom_cards', 'integration_key', "TEXT NOT NULL DEFAULT 'custom'");
    attemptAddColumn('dashboard_custom_cards', 'open_in_new_tab', 'INTEGER NOT NULL DEFAULT 0');
    attemptAddColumn('achievement_snapshots', 'days_joined', 'INTEGER DEFAULT 0');
    attemptAddColumn('achievement_snapshots', 'badge_count', 'INTEGER DEFAULT 0');
    attemptAddColumn('achievement_snapshots', 'total_xp', 'INTEGER DEFAULT 0');
    attemptAddColumn('achievement_snapshots', 'level', 'INTEGER DEFAULT 1');
    attemptAddColumn('achievement_snapshots', 'rank_name', "TEXT DEFAULT ''");
    attemptAddColumn('achievement_snapshots', 'rank_icon', "TEXT DEFAULT ''");
    attemptAddColumn('achievement_snapshots', 'rank_color', "TEXT DEFAULT ''");
    attemptAddColumn('achievement_snapshots', 'rank_bg_color', "TEXT DEFAULT ''");
    attemptAddColumn('achievement_snapshots', 'rank_border_color', "TEXT DEFAULT ''");
    attemptAddColumn('achievement_snapshots', 'progress_percent', 'REAL DEFAULT 0');
    attemptAddColumn('achievement_snapshots', 'xp_needed', 'INTEGER DEFAULT 0');
    attemptAddColumn('achievement_snapshots', 'full_evaluated_at', 'DATETIME');
    
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
    `);  // users

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
    `);  // watch_history

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
    `);  // session_cache

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
    `);  // tautulli_sessions

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
    `);  // user_watch_stats

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
    `);  // sync_metadata

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
    `);  // user_achievements

    // Table: achievement_progress - Progression des badges collection par utilisateur
    db.exec(`
      CREATE TABLE IF NOT EXISTS achievement_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        achievement_id TEXT NOT NULL,
        current INTEGER DEFAULT 0,
        total INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, achievement_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);  // achievement_progress

    db.exec(`
      CREATE TABLE IF NOT EXISTS achievement_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        total_hours REAL DEFAULT 0,
        movie_count INTEGER DEFAULT 0,
        episode_count INTEGER DEFAULT 0,
        session_count INTEGER DEFAULT 0,
        monthly_hours REAL DEFAULT 0,
        night_count INTEGER DEFAULT 0,
        morning_count INTEGER DEFAULT 0,
        days_joined INTEGER DEFAULT 0,
        badge_count INTEGER DEFAULT 0,
        total_xp INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        rank_name TEXT DEFAULT '',
        rank_icon TEXT DEFAULT '',
        rank_color TEXT DEFAULT '',
        rank_bg_color TEXT DEFAULT '',
        rank_border_color TEXT DEFAULT '',
        progress_percent REAL DEFAULT 0,
        xp_needed INTEGER DEFAULT 0,
        full_evaluated_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);  // achievement_snapshots

    db.exec(`
      CREATE TABLE IF NOT EXISTS collection_item_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        achievement_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        trakt_key TEXT NOT NULL,
        trakt_title TEXT,
        trakt_year INTEGER,
        matched_title TEXT,
        matched_year INTEGER,
        matched_guid TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(achievement_id, media_type, trakt_key)
      )
    `);  // collection_item_mappings

    // Table: app_settings - Réglages globaux administrateur
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);  // app_settings

    // Table: dashboard_custom_cards - Cartes supplémentaires configurées par l'admin
    db.exec(`
      CREATE TABLE IF NOT EXISTS dashboard_custom_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        url TEXT NOT NULL,
        color_key TEXT NOT NULL,
        open_in_iframe INTEGER NOT NULL DEFAULT 1,
        integration_key TEXT NOT NULL DEFAULT 'custom',
        icon TEXT DEFAULT '✨',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);  // dashboard_custom_cards
    attemptAddColumn('dashboard_custom_cards', 'open_in_new_tab', 'INTEGER NOT NULL DEFAULT 0');

    // Table: user_service_credentials - Credentials chiffrés par utilisateur/service
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_service_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        service_key TEXT NOT NULL,
        username TEXT NOT NULL,
        secret_encrypted TEXT NOT NULL,
        meta_json TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, service_key),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);  // user_service_credentials

    // Valeur par défaut: blur des pseudos activé
    db.prepare(`
      INSERT OR IGNORE INTO app_settings (key, value)
      VALUES ('leaderboard_blur_enabled', '1')
    `).run();
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_achievements_achievement ON user_achievements(achievement_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_achievement_snapshots_user ON achievement_snapshots(user_id);
      CREATE INDEX IF NOT EXISTS idx_watch_history_user ON watch_history(user_id);
      CREATE INDEX IF NOT EXISTS idx_watch_history_scanned ON watch_history(scannedAt);
      CREATE INDEX IF NOT EXISTS idx_session_cache_user ON session_cache(user_id);
      CREATE INDEX IF NOT EXISTS idx_tautulli_sessions_user ON tautulli_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_tautulli_sessions_username ON tautulli_sessions(username);
      CREATE INDEX IF NOT EXISTS idx_tautulli_sessions_timestamp ON tautulli_sessions(session_timestamp);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tautulli_sessions_hash ON tautulli_sessions(session_hash) WHERE session_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_user_watch_stats_user ON user_watch_stats(user_id);
      CREATE INDEX IF NOT EXISTS idx_sync_metadata_type ON sync_metadata(sync_type);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_service_credentials_user_service ON user_service_credentials(user_id, service_key);
    `);  // indexes

    mergeUsersCaseInsensitive();
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci ON users(LOWER(username));
    `);

    // 🔄 Migration données : renommage d'IDs de badges
    try {
      const renamed = db.prepare(`UPDATE user_achievements SET achievement_id = ? WHERE achievement_id = ?`);
      const renamedProgress = db.prepare(`UPDATE achievement_progress SET achievement_id = ? WHERE achievement_id = ?`);
      const r1 = renamed.run('jurassic-survivor', 'clever-girl');
      const r2 = renamedProgress.run('jurassic-survivor', 'clever-girl');
      if (r1.changes > 0 || r2.changes > 0) {
        require('./logger').create('[DB]').info(`Migration: "clever-girl" → "jurassic-survivor" (${r1.changes + r2.changes} entrées)`);
      }
      // Supprimer le badge og (retiré de l'application)
      db.prepare(`DELETE FROM user_achievements WHERE achievement_id = ?`).run('og');
      db.prepare(`DELETE FROM achievement_progress WHERE achievement_id = ?`).run('og');
      // Supprimer cinema-master (remplacé par cinema-universe 2000 films)
      db.prepare(`DELETE FROM user_achievements WHERE achievement_id = ?`).run('cinema-master');
      db.prepare(`DELETE FROM achievement_progress WHERE achievement_id = ?`).run('cinema-master');
      // Supprimer le badge dark-knight (remplacé par black-knight uniquement)
      const d1 = db.prepare(`DELETE FROM user_achievements WHERE achievement_id = ?`).run('dark-knight');
      const d2 = db.prepare(`DELETE FROM achievement_progress WHERE achievement_id = ?`).run('dark-knight');
      if (d1.changes > 0 || d2.changes > 0) {
        require('./logger').create('[DB]').info(`Migration: badge "dark-knight" supprimé (${d1.changes + d2.changes} entrées)`);
      }
    } catch(e) { /* tables pas encore créées au premier boot */ }

  } catch (err) {
    require('./logger').create('[DB]').error('Migrations:', err.message);
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
    require('./logger').create('[DB]').info('Base de données fermée');
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
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) return null;
    const stmt = db.prepare(`
      INSERT INTO users (username, plexId, email, joinedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        plexId = COALESCE(excluded.plexId, users.plexId),
        email = COALESCE(excluded.email, users.email),
        joinedAt = COALESCE(excluded.joinedAt, users.joinedAt),
        updatedAt = CURRENT_TIMESTAMP
      RETURNING *
    `);
    return stmt.get(normalizedUsername, plexId || null, email || null, joinedAt || null);
  },
  
  /**
   * Obtenir un utilisateur par username
   */
  getByUsername(username) {
    const db = getDb();
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) return null;
    return db.prepare('SELECT * FROM users WHERE username = ?').get(normalizedUsername);
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
  },

  /**
   * Reparer les lignes incoherentes ou totalHours < movieHours + episodeHours.
   * Ce correctif est conservateur: il ne modifie que les totaux manifestement faux.
   */
  repairInconsistentTotals() {
    const db = getDb();
    return db.prepare(`
      UPDATE watch_history
      SET totalHours = ROUND(COALESCE(movieHours, 0) + COALESCE(episodeHours, 0), 1)
      WHERE ROUND(COALESCE(totalHours, 0), 1) < ROUND(COALESCE(movieHours, 0) + COALESCE(episodeHours, 0), 1)
    `).run();
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
    require('./logger').create('[DB]').info('Nettoyage sessions:', result.changes, 'supprimées');
    return result.changes;
  }
};

/**
 * 🧹 Database Maintenance - Nettoyage automatique de la base de données
 */
const DatabaseMaintenance = {
  /**
   * 🗑️ Supprimer les sessions Tautulli de plus de 365 jours (1 an)
   * C'est la table la plus volumineuse
   */
  cleanOldTautulliSessions(days = 365) {
    const db = getDb();
    const beforeDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare('DELETE FROM tautulli_sessions WHERE session_date < ?');
    const result = stmt.run(beforeDate);
    require('./logger').create('[DB-Maintenance]').info(`✂️ tautulli_sessions: ${result.changes} sessions supprimées (>${days} jours)`);
    return result.changes;
  },

  /**
   * 🗑️ Supprimer le cache de session ancien (> 90 jours)
   */
  cleanOldSessionCache(days = 90) {
    const db = getDb();
    const beforeDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare('DELETE FROM session_cache WHERE startedAt < ?');
    const result = stmt.run(beforeDate);
    require('./logger').create('[DB-Maintenance]').info(`✂️ session_cache: ${result.changes} entrées supprimées (>${days} jours)`);
    return result.changes;
  },

  /**
   * 🗑️ Garder seulement 2 ans d'historique watch_history
   */
  cleanOldWatchHistory(days = 730) {  // 2 ans
    const db = getDb();
    const beforeDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare('DELETE FROM watch_history WHERE scannedAt < ?');
    const result = stmt.run(beforeDate);
    require('./logger').create('[DB-Maintenance]').info(`✂️ watch_history: ${result.changes} entrées supprimées (>${days} jours)`);
    return result.changes;
  },

  /**
   * 🗑️ Nettoyer les métadonnées de sync anciennes
   */
  cleanOldSyncMetadata(days = 180) {  // 6 mois
    const db = getDb();
    const beforeDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare('DELETE FROM sync_metadata WHERE synced_at < ?');
    const result = stmt.run(beforeDate);
    require('./logger').create('[DB-Maintenance]').info(`✂️ sync_metadata: ${result.changes} entrées supprimées (>${days} jours)`);
    return result.changes;
  },

  /**
   * 💾 Optimiser la base de données (VACUUM)
   * Récupère l'espace disque après les suppressions
   */
  vacuumDatabase() {
    try {
      const db = getDb();
      db.exec('VACUUM');
      require('./logger').create('[DB-Maintenance]').info('💾 VACUUM terminé - base de données optimisée');
      return true;
    } catch (err) {
      require('./logger').create('[DB-Maintenance]').error('VACUUM échoué:', err.message);
      return false;
    }
  },

  /**
   * 🧹 MAINTENANCE COMPLÈTE - à exécuter une fois par semaine
   * Nettoie tous les anciens enregistrements et optimise la DB
   */
  runFullMaintenance() {
    const log = require('./logger').create('[DB-Maintenance]');
    const startTime = Date.now();

    log.info('═══════════════════════════════════════════════════');
    log.info('🧹 DÉBUT MAINTENANCE COMPLÈTE DE LA BASE DE DONNÉES');
    log.info('═══════════════════════════════════════════════════');

    const results = {
      tautulliSessions: 0,
      sessionCache: 0,
      watchHistory: 0,
      syncMetadata: 0,
      vacuumSuccess: false,
      duration: 0
    };

    try {
      // Exécuter tous les nettoyages
      results.tautulliSessions = this.cleanOldTautulliSessions(365);  // 1 an
      results.sessionCache = this.cleanOldSessionCache(90);           // 3 mois
      results.watchHistory = this.cleanOldWatchHistory(730);          // 2 ans
      results.syncMetadata = this.cleanOldSyncMetadata(180);          // 6 mois

      // Optimiser
      results.vacuumSuccess = this.vacuumDatabase();

      results.duration = Math.round((Date.now() - startTime) / 1000);

      // Résumé
      const totalDeleted =
        results.tautulliSessions +
        results.sessionCache +
        results.watchHistory +
        results.syncMetadata;

      log.info('─────────────────────────────────────────────────');
      log.info(`📊 RÉSUMÉ NETTOYAGE:`);
      log.info(`   • tautulli_sessions:  ${results.tautulliSessions} supprimées`);
      log.info(`   • session_cache:      ${results.sessionCache} supprimées`);
      log.info(`   • watch_history:      ${results.watchHistory} supprimées`);
      log.info(`   • sync_metadata:      ${results.syncMetadata} supprimées`);
      log.info(`   • VACUUM:             ${results.vacuumSuccess ? '✅ OK' : '❌ ÉCHOUÉ'}`);
      log.info(`   • TOTAL SUPPRIMÉ:     ${totalDeleted} enregistrements`);
      log.info(`   • DURÉE:              ${results.duration}s`);
      log.info('═══════════════════════════════════════════════════');

      return results;
    } catch (err) {
      log.error('❌ ERREUR MAINTENANCE:', err.message);
      log.error(err.stack);
      throw err;
    }
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
 * Achievement progress queries (progression des badges collection)
 */
const AchievementProgressQueries = {
  save(userId, achievementId, current, total) {
    const db = getDb();
    return db.prepare(`
      INSERT OR REPLACE INTO achievement_progress (user_id, achievement_id, current, total, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(userId, achievementId, current, total);
  },

  remove(userId, achievementId) {
    const db = getDb();
    return db.prepare(`
      DELETE FROM achievement_progress WHERE user_id = ? AND achievement_id = ?
    `).run(userId, achievementId);
  },

  getForUser(userId) {
    const db = getDb();
    const rows = db.prepare(`
      SELECT achievement_id, current, total FROM achievement_progress WHERE user_id = ?
    `).all(userId);
    return Object.fromEntries(rows.map(r => [r.achievement_id, { current: r.current, total: r.total }]));
  }
};

const AchievementSnapshotQueries = {
  save(userId, stats = {}) {
    const db = getDb();
    return db.prepare(`
      INSERT INTO achievement_snapshots (
        user_id, total_hours, movie_count, episode_count, session_count, monthly_hours, night_count, morning_count,
        days_joined, badge_count, total_xp, level, rank_name, rank_icon, rank_color, rank_bg_color, rank_border_color,
        progress_percent, xp_needed, full_evaluated_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        total_hours = excluded.total_hours,
        movie_count = excluded.movie_count,
        episode_count = excluded.episode_count,
        session_count = excluded.session_count,
        monthly_hours = excluded.monthly_hours,
        night_count = excluded.night_count,
        morning_count = excluded.morning_count,
        days_joined = excluded.days_joined,
        badge_count = excluded.badge_count,
        total_xp = excluded.total_xp,
        level = excluded.level,
        rank_name = excluded.rank_name,
        rank_icon = excluded.rank_icon,
        rank_color = excluded.rank_color,
        rank_bg_color = excluded.rank_bg_color,
        rank_border_color = excluded.rank_border_color,
        progress_percent = excluded.progress_percent,
        xp_needed = excluded.xp_needed,
        full_evaluated_at = excluded.full_evaluated_at,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      userId,
      Number(stats.totalHours || 0),
      Number(stats.movieCount || 0),
      Number(stats.episodeCount || 0),
      Number(stats.sessionCount || 0),
      Number(stats.monthlyHours || 0),
      Number(stats.nightCount || 0),
      Number(stats.morningCount || 0),
      Number(stats.daysJoined || 0),
      Number(stats.badgeCount || 0),
      Number(stats.totalXp || 0),
      Math.max(1, Number(stats.level || 1)),
      String(stats.rank?.name || stats.rankName || ""),
      String(stats.rank?.icon || stats.rankIcon || ""),
      String(stats.rank?.color || stats.rankColor || ""),
      String(stats.rank?.bgColor || stats.rankBgColor || ""),
      String(stats.rank?.borderColor || stats.rankBorderColor || ""),
      Number(stats.progressPercent || 0),
      Number(stats.xpNeeded || 0),
      stats.fullEvaluatedAt || null
    );
  },

  getForUser(userId) {
    const db = getDb();
    return db.prepare(`
      SELECT
        total_hours as totalHours,
        movie_count as movieCount,
        episode_count as episodeCount,
        session_count as sessionCount,
        monthly_hours as monthlyHours,
        night_count as nightCount,
        morning_count as morningCount,
        days_joined as daysJoined,
        badge_count as badgeCount,
        total_xp as totalXp,
        level,
        rank_name as rankName,
        rank_icon as rankIcon,
        rank_color as rankColor,
        rank_bg_color as rankBgColor,
        rank_border_color as rankBorderColor,
        progress_percent as progressPercent,
        xp_needed as xpNeeded,
        strftime('%Y-%m-%dT%H:%M:%SZ', full_evaluated_at) as fullEvaluatedAt,
        strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) as updatedAt
      FROM achievement_snapshots
      WHERE user_id = ?
    `).get(userId) || null;
  }
};

const CollectionItemMappingQueries = {
  upsert({ achievementId, mediaType, traktKey, traktTitle = null, traktYear = null, matchedTitle = null, matchedYear = null, matchedGuid = null }) {
    const db = getDb();
    return db.prepare(`
      INSERT INTO collection_item_mappings (
        achievement_id, media_type, trakt_key, trakt_title, trakt_year, matched_title, matched_year, matched_guid, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(achievement_id, media_type, trakt_key) DO UPDATE SET
        trakt_title = excluded.trakt_title,
        trakt_year = excluded.trakt_year,
        matched_title = excluded.matched_title,
        matched_year = excluded.matched_year,
        matched_guid = excluded.matched_guid,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      achievementId,
      mediaType,
      traktKey,
      traktTitle,
      traktYear,
      matchedTitle,
      matchedYear,
      matchedGuid
    );
  },

  getForAchievement(achievementId, mediaType = null) {
    const db = getDb();
    const rows = mediaType
      ? db.prepare(`
          SELECT *
          FROM collection_item_mappings
          WHERE achievement_id = ? AND media_type = ?
          ORDER BY trakt_key ASC
        `).all(achievementId, mediaType)
      : db.prepare(`
          SELECT *
          FROM collection_item_mappings
          WHERE achievement_id = ?
          ORDER BY media_type ASC, trakt_key ASC
        `).all(achievementId);

    return new Map(rows.map(row => [`${row.media_type}:${row.trakt_key}`, row]));
  }
};

/**
 * App settings queries (réglages globaux admin)
 */
const AppSettingQueries = {
  get(key, defaultValue = null) {
    const db = getDb();
    const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key);
    return row ? row.value : defaultValue;
  },

  listPrefix(prefix) {
    const db = getDb();
    return db.prepare(`
      SELECT key, value
      FROM app_settings
      WHERE key LIKE ?
      ORDER BY key ASC
    `).all(`${prefix}%`);
  },

  set(key, value) {
    const db = getDb();
    return db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).run(key, String(value));
  },

  getBool(key, defaultValue = false) {
    const value = this.get(key, defaultValue ? "1" : "0");
    return value === "1" || value === "true";
  },

  remove(key) {
    const db = getDb();
    return db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(key);
  },

  setBool(key, enabled) {
    return this.set(key, enabled ? "1" : "0");
  }
};

/**
 * Dashboard custom cards queries (admin configurable)
 */
const DashboardCardQueries = {
  list() {
    const db = getDb();
    const cards = db.prepare(`
      SELECT
        id, label, title, description, url,
        color_key as colorKey,
        open_in_iframe as openInIframe,
        integration_key as integrationKey,
        open_in_new_tab as openInNewTab,
        icon,
        created_at as createdAt
      FROM dashboard_custom_cards
      ORDER BY id ASC
    `).all();

    let orderedIds = [];
    try {
      orderedIds = JSON.parse(AppSettingQueries.get("dashboard_custom_card_order", "[]") || "[]");
    } catch (_) {
      orderedIds = [];
    }

    const rankById = new Map();
    orderedIds.forEach((id, index) => {
      const num = Number(id);
      if (Number.isInteger(num) && num > 0) {
        rankById.set(num, index);
      }
    });

    return cards.sort((a, b) => {
      const aRank = rankById.has(Number(a.id)) ? rankById.get(Number(a.id)) : Number.MAX_SAFE_INTEGER;
      const bRank = rankById.has(Number(b.id)) ? rankById.get(Number(b.id)) : Number.MAX_SAFE_INTEGER;
      if (aRank !== bRank) return aRank - bRank;
      return Number(a.id) - Number(b.id);
    });
  },

  getById(id) {
    const db = getDb();
    return db.prepare(`
      SELECT
        id, label, title, description, url,
        color_key as colorKey,
        open_in_iframe as openInIframe,
        integration_key as integrationKey,
        open_in_new_tab as openInNewTab,
        icon,
        created_at as createdAt
      FROM dashboard_custom_cards
      WHERE id = ?
    `).get(id);
  },

  create({ label, title, description, url, colorKey, openInIframe, openInNewTab, integrationKey, icon }) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO dashboard_custom_cards (label, title, description, url, color_key, open_in_iframe, integration_key, open_in_new_tab, icon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      String(label || "").trim(),
      String(title || "").trim(),
      String(description || "").trim(),
      String(url || "").trim(),
      String(colorKey || "").trim(),
      openInIframe ? 1 : 0,
      String(integrationKey || "custom").trim(),
      openInNewTab ? 1 : 0,
      String(icon || "✨").trim()
    );
    return result.lastInsertRowid;
  },

  update(id, { label, title, description, url, colorKey, openInIframe, openInNewTab, integrationKey, icon }) {
    const db = getDb();
    return db.prepare(`
      UPDATE dashboard_custom_cards
      SET
        label = ?,
        title = ?,
        description = ?,
        url = ?,
        color_key = ?,
        open_in_iframe = ?,
        integration_key = ?,
        icon = ?,
        open_in_new_tab = ?
      WHERE id = ?
    `).run(
      String(label || "").trim(),
      String(title || "").trim(),
      String(description || "").trim(),
      String(url || "").trim(),
      String(colorKey || "").trim(),
      openInIframe ? 1 : 0,
      String(integrationKey || "custom").trim(),
      String(icon || "✨").trim(),
      openInNewTab ? 1 : 0,
      id
    );
  },

  remove(id) {
    const db = getDb();
    const result = db.prepare(`DELETE FROM dashboard_custom_cards WHERE id = ?`).run(id);
    try {
      const raw = AppSettingQueries.get("dashboard_custom_card_order", "[]") || "[]";
      const ids = JSON.parse(raw);
      if (Array.isArray(ids)) {
        AppSettingQueries.set(
          "dashboard_custom_card_order",
          JSON.stringify(ids.filter(entry => Number(entry) !== Number(id)))
        );
      }
    } catch (_) {}
    return result;
  },

  saveOrder(ids = []) {
    const normalized = ids
      .map(id => Number(id))
      .filter(id => Number.isInteger(id) && id > 0);
    AppSettingQueries.set("dashboard_custom_card_order", JSON.stringify(normalized));
    return normalized;
  }
};

/**
 * User service credentials queries (credentials chiffrés)
 */
const UserServiceCredentialQueries = {
  getByUserAndService(userId, serviceKey) {
    const db = getDb();
    return db.prepare(`
      SELECT
        id,
        user_id as userId,
        service_key as serviceKey,
        username,
        secret_encrypted as secretEncrypted,
        meta_json as metaJson,
        updated_at as updatedAt
      FROM user_service_credentials
      WHERE user_id = ? AND service_key = ?
    `).get(userId, String(serviceKey || "").trim());
  },

  upsert(userId, serviceKey, username, secretEncrypted, metaJson = null) {
    const db = getDb();
    return db.prepare(`
      INSERT INTO user_service_credentials (user_id, service_key, username, secret_encrypted, meta_json, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, service_key) DO UPDATE SET
        username = excluded.username,
        secret_encrypted = excluded.secret_encrypted,
        meta_json = excluded.meta_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      userId,
      String(serviceKey || "").trim(),
      String(username || "").trim(),
      String(secretEncrypted || ""),
      metaJson ? String(metaJson) : null
    );
  },

  remove(userId, serviceKey) {
    const db = getDb();
    return db.prepare(`
      DELETE FROM user_service_credentials
      WHERE user_id = ? AND service_key = ?
    `).run(userId, String(serviceKey || "").trim());
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
  DatabaseMaintenance,
  UserAchievementQueries,
  AchievementProgressQueries,
  AchievementSnapshotQueries,
  CollectionItemMappingQueries,
  AppSettingQueries,
  DashboardCardQueries,
  UserServiceCredentialQueries,
  DB_PATH
};
