/**
 * 🗄️ TAUTULLI DIRECT DATABASE READER
 * Lit directement la DB Tautulli (lecture seule) pour éviter l'API
 * Path de la DB fourni via variable d'environnement
 */

const Database = require('better-sqlite3');
const path = require('path');
const log = require('./logger').create('[Tautulli DB]');

let tautulliDb = null;

// ── Cache mémoire des rating_keys par collection (durée: 24h)
const collectionCache = {};
const COLLECTION_CACHE_TTL = 24 * 60 * 60 * 1000;

/**
 * 🗂️ Registry des collections Tautulli par achievement ID
 * rating_key = identifiant Tautulli de la collection (visible dans l'URL /info?rating_key=...)
 */
const COLLECTION_KEYS = {
  'potter-head':  { ratingKey: 10292 },  // Harry Potter - Saga
  'jurassic-survivor': { ratingKey: 12634 },  // Jurassic Park - Saga
  'marvel-fan':   { ratingKey: 306781 }, // Marvel Cinematic Universe
  'black-knight': { ratingKey: 14715 },  // Star Wars (7 films min)
  'tolkiendil':   { ratingKey: 17699 },  // Le Seigneur des Anneaux
  'evolutionist': { ratingKey: 15344 },  // La Planète des Singes
};

// Seuil minimum pour black-knight sur la collection Star Wars
const COLLECTION_MIN = {
  'black-knight': 7,
};

/**
 * Récupère les films d'une collection Plex sous forme {title, year}.
 * title+year est stable même si le rating_key ou le GUID change après ré-indexation.
 * Résultat mis en cache 24h.
 */
async function getCollectionItems(collectionRatingKey) {
  const now = Date.now();
  const cached = collectionCache[collectionRatingKey];
  if (cached && (now - cached.ts) < COLLECTION_CACHE_TTL) {
    return cached.movies;
  }

  const PLEX_URL = process.env.PLEX_URL;
  const PLEX_TOKEN = process.env.PLEX_TOKEN;

  if (!PLEX_URL || !PLEX_TOKEN) {
    return null;
  }

  try {
    const url = `${PLEX_URL}/library/collections/${collectionRatingKey}/children?X-Plex-Token=${PLEX_TOKEN}`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    const json = await resp.json();
    const items = json?.MediaContainer?.Metadata || [];
    // Extraire titre + année (stables, indépendants des re-scans de métadonnées)
    const movies = items.map(item => ({
      title: item.title,
      year: item.year ?? null,
    })).filter(m => m.title);
    collectionCache[collectionRatingKey] = { movies, ts: now };
    log.debug(`Collection ${collectionRatingKey}: ${movies.length} films en cache`);
    return movies;
  } catch(e) {
    log.warn(`Collection ${collectionRatingKey}:`, e.message);
    return null;
  }
}

/**
 * Initialiser la connexion à la DB Tautulli
 * En lecture seule pour éviter tout risque de corruption
 */
function initTautulliDatabase() {
  const TAUTULLI_DB_PATH = process.env.TAUTULLI_DB_PATH;
  
  if (!TAUTULLI_DB_PATH) {
    log.warn('TAUTULLI_DB_PATH non configuré — fonctionnalités désactivées');
    return false;
  }
  
  try {
    tautulliDb = new Database(TAUTULLI_DB_PATH, { readonly: true });
    log.info('Connecté:', TAUTULLI_DB_PATH);
    return true;
  } catch (err) {
    log.error('Connexion DB:', err.message);
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
        MAX(sh.stopped) as last_session_timestamp,
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
    
    if (!stats || !stats.session_count) { return null; }
    
    // Convertir en heures
    const totalHours = stats.total_duration_seconds ? Math.round(stats.total_duration_seconds / 3600 * 10) / 10 : 0;
    const movieHours = stats.movie_duration_seconds ? Math.round(stats.movie_duration_seconds / 3600 * 10) / 10 : 0;
    const episodeHours = stats.episode_duration_seconds ? Math.round(stats.episode_duration_seconds / 3600 * 10) / 10 : 0;
    
    log.debug(`${normalizedUsername} — ${stats.session_count} sessions`);
    
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
    log.error('getUserStats:', err.message);
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
    
    const stmt = tautulliDb.prepare(`
      SELECT 
        u.user_id,
        u.username,
        COUNT(*) as session_count,
        SUM(CAST((sh.stopped - sh.started) AS INTEGER)) as total_duration_seconds,
        MAX(sh.stopped) as last_session_timestamp,
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
    
    log.debug(`${results.length} utilisateurs traités`);
    return results;
    
  } catch (err) {
    log.error('getAllUserStats:', err.message);
    return [];
  }
}

/**
 * � Récupérer les heures de visionnage du mois en cours pour un utilisateur
 */
function getMonthlyHoursFromTautulli(username) {
  if (!tautulliDb) return 0;

  try {
    const normalizedUsername = username.toLowerCase();
    // Début du mois courant en timestamp Unix
    const stmt = tautulliDb.prepare(`
      SELECT SUM(CAST((sh.stopped - sh.started) AS INTEGER)) as monthly_seconds
      FROM users u
      JOIN session_history sh ON u.user_id = sh.user_id
      WHERE LOWER(u.username) = ?
        AND sh.started >= CAST(strftime('%s', date('now', 'start of month')) AS INTEGER)
        AND sh.stopped > sh.started
    `);

    const row = stmt.get(normalizedUsername);
    if (!row || !row.monthly_seconds) return 0;
    return Math.round(row.monthly_seconds / 3600 * 10) / 10;
  } catch (err) {
    log.warn('heures mensuelles:', err.message);
    return 0;
  }
}

/** * ⏰ Compter les sessions par tranche horaire (Oiseau de Nuit / Lève-Tôt)
 */
function getTimeBasedSessionCounts(username) {
  if (!tautulliDb) return { nightCount: 0, morningCount: 0 };

  try {
    const norm = username.toLowerCase();
    // Nuit : 22h-6h (heure locale)
    const nightStmt = tautulliDb.prepare(`
      SELECT COUNT(*) as cnt
      FROM session_history sh
      WHERE LOWER(sh.user) = ?
        AND sh.stopped > sh.started
        AND (
          CAST(strftime('%H', sh.started, 'unixepoch', 'localtime') AS INTEGER) >= 22
          OR CAST(strftime('%H', sh.started, 'unixepoch', 'localtime') AS INTEGER) < 6
        )
    `);
    // Matin : 6h-9h (heure locale)
    const morningStmt = tautulliDb.prepare(`
      SELECT COUNT(*) as cnt
      FROM session_history sh
      WHERE LOWER(sh.user) = ?
        AND sh.stopped > sh.started
        AND CAST(strftime('%H', sh.started, 'unixepoch', 'localtime') AS INTEGER) BETWEEN 6 AND 8
    `);

    const nightRow = nightStmt.get(norm);
    const morningRow = morningStmt.get(norm);
    return {
      nightCount: nightRow?.cnt || 0,
      morningCount: morningRow?.cnt || 0
    };
  } catch (err) {
    log.warn('horaires:', err.message);
    return { nightCount: 0, morningCount: 0 };
  }
}

/**
 * 📅 Calculer les dates de déblocage de chaque achievement depuis l'historique Tautulli
 */
function getAchievementUnlockDates(username, joinedAtTimestamp) {
  const dates = {};
  const fmt = (ts) => ts ? new Date(ts * 1000).toLocaleDateString('fr-FR') : null;
  const fmtMs = (ms) => ms ? new Date(ms).toLocaleDateString('fr-FR') : null;

  // --- Temporels (calculés depuis joinedAt) ---
  if (joinedAtTimestamp) {
    const joinMs = joinedAtTimestamp * 1000;
    const now = Date.now();
    const d365 = joinMs + 365 * 86400000;
    const d730 = joinMs + 730 * 86400000;
    const d1825 = joinMs + 1825 * 86400000;
    if (now >= d365)  dates['first-anniversary'] = fmtMs(d365);
    if (now >= d730)  dates['veteran']           = fmtMs(d730);
    if (now >= d1825) dates['old-timer']          = fmtMs(d1825);
  }

  if (!tautulliDb) return dates;

  try {
    const norm = username.toLowerCase();

    // Helper : date de la Nème session (tous types)
    const nthSession = (n, mediaType = null) => {
      try {
        const typeCond = mediaType ? `AND sh.media_type = '${mediaType}'` : '';
        const stmt = tautulliDb.prepare(`
          SELECT sh.started
          FROM session_history sh
          WHERE LOWER(sh.user) = ? AND sh.stopped > sh.started ${typeCond}
          ORDER BY sh.started ASC
          LIMIT 1 OFFSET ?
        `);
        const row = stmt.get(norm, n - 1);
        return row?.started ? fmt(row.started) : null;
      } catch(e) { return null; }
    };

    // Helper : date où les heures cumulées ont dépassé le seuil
    const hoursThreshold = (targetHours) => {
      try {
        const stmt = tautulliDb.prepare(`
          SELECT stopped FROM (
            SELECT stopped, SUM(CAST((stopped - started) AS REAL) / 3600)
              OVER (ORDER BY started ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) as cum_hours
            FROM session_history sh
            WHERE LOWER(sh.user) = ? AND sh.stopped > sh.started
            ORDER BY started
          ) WHERE cum_hours >= ?
          LIMIT 1
        `);
        const row = stmt.get(norm, targetHours);
        return row?.stopped ? fmt(row.stopped) : null;
      } catch(e) { return null; }
    };

    // Helper : date de la Nème session nocturne (22h-6h) ou matinale (6h-9h)
    const nthTimeSession = (n, hourStart, hourEnd) => {
      try {
        let whereCond;
        if (hourStart < hourEnd) {
          whereCond = `strftime('%H', sh.started, 'unixepoch', 'localtime') BETWEEN '${String(hourStart).padStart(2,'0')}' AND '${String(hourEnd - 1).padStart(2,'0')}'`;
        } else {
          // Wrap autour de minuit (ex: 22h-6h : heure >= 22 OU heure < 6)
          whereCond = `(CAST(strftime('%H', sh.started, 'unixepoch', 'localtime') AS INTEGER) >= ${hourStart} OR CAST(strftime('%H', sh.started, 'unixepoch', 'localtime') AS INTEGER) < ${hourEnd})`;
        }
        const stmt = tautulliDb.prepare(`
          SELECT sh.started
          FROM session_history sh
          WHERE LOWER(sh.user) = ? AND sh.stopped > sh.started AND ${whereCond}
          ORDER BY sh.started ASC
          LIMIT 1 OFFSET ?
        `);
        const row = stmt.get(norm, n - 1);
        return row?.started ? fmt(row.started) : null;
      } catch(e) { return null; }
    };

    // Activités
    dates['first-watch'] = nthSession(1);
    dates['regular']     = nthSession(7);
    dates['night-owl']   = nthTimeSession(30, 22, 6);   // 30ème session nocturne (22h-6h)
    dates['early-bird']  = nthTimeSession(50, 6,  9);   // 50ème session matinale (6h-9h)
    dates['centurion']   = hoursThreshold(100);
    dates['marathoner']  = hoursThreshold(500);

    // Helper : premier mois où les heures mensuelles ont dépassé un seuil
    const firstMonthOver = (targetHours) => {
      try {
        const stmt = tautulliDb.prepare(`
          SELECT strftime('%d/%m/%Y', MAX(sh.stopped), 'unixepoch') as unlock_date
          FROM session_history sh
          WHERE LOWER(sh.user) = ? AND sh.stopped > sh.started
          GROUP BY strftime('%Y-%m', sh.started, 'unixepoch')
          HAVING SUM(CAST((sh.stopped - sh.started) AS REAL) / 3600) >= ?
          ORDER BY strftime('%Y-%m', sh.started, 'unixepoch') ASC
          LIMIT 1
        `);
        const row = stmt.get(norm, targetHours);
        return row?.unlock_date || null;
      } catch(e) { return null; }
    };

    // Mensuels
    dates['busy-month']    = firstMonthOver(50);
    dates['intense-month'] = firstMonthOver(100);

    // Films
    dates['cinema-marathon']   = nthSession(5,   'movie');
    dates['cinephile']         = nthSession(50,  'movie');
    dates['film-critic']       = nthSession(100, 'movie');
    dates['hollywood-legend']  = nthSession(500, 'movie');
    dates['cinema-god']        = nthSession(1000,'movie');
    dates['cinema-universe']   = nthSession(2000,'movie');

    // Séries
    dates['binge-watcher']        = nthSession(10,   'episode');
    dates['series-addict']        = nthSession(100,  'episode');
    dates['series-master']        = nthSession(500,  'episode');
    dates['serial-killer-legend'] = nthSession(1000, 'episode');
    dates['series-overlord']      = nthSession(2000, 'episode');
    dates['series-titan']         = nthSession(5000, 'episode');

  } catch (err) {
    log.warn('unlock dates:', err.message);
  }

  return dates;
}

/**
 * 🔍 Évaluer les succès secrets auto-détectables depuis l'historique Tautulli
 */
async function evaluateSecretAchievements(username, joinedAtTimestamp, toCheckIds = [], plexUserId = null) {
  const results = {};
  const progress = {};
  if (!tautulliDb || toCheckIds.length === 0) return { unlocked: results, progress };

  const norm = username.toLowerCase();
  const fmt  = (ts) => ts ? new Date(ts * 1000).toLocaleDateString('fr-FR') : null;
  const today = new Date().toLocaleDateString('fr-FR');

  // Préférer le filtrage par user_id numérique (stable même si le username change)
  // car un même utilisateur Plex peut apparaître sous plusieurs noms dans Tautulli
  const userFilter = plexUserId
    ? { clause: 'sh.user_id = ?', param: plexUserId }
    : { clause: 'LOWER(sh.user) = ?', param: norm };

  /**
   * Compte les films regardés par l'utilisateur via le titre (LIKE patterns).
   * session_history_metadata = lookup rating_key, session_history = sessions user.
   */
  const countMoviesByLike = (patterns) => {
    try {
      const orClauses = patterns.map(() => 'LOWER(shm.title) LIKE ?').join(' OR ');
      const keys = tautulliDb.prepare(`
        SELECT DISTINCT rating_key FROM session_history_metadata shm WHERE ${orClauses}
      `).all(...patterns.map(p => p.toLowerCase()));
      if (!keys.length) return { cnt: 0, last_stopped: null };
      const ratingKeys = keys.map(k => k.rating_key);
      const ph = ratingKeys.map(() => '?').join(', ');
      const row = tautulliDb.prepare(`
        SELECT COUNT(DISTINCT sh.rating_key) as cnt, MAX(sh.stopped) as last_stopped
        FROM session_history sh
        WHERE ${userFilter.clause} AND sh.stopped > sh.started
          AND sh.media_type = 'movie' AND sh.rating_key IN (${ph})
      `).get(userFilter.param, ...ratingKeys);
      return row || { cnt: 0, last_stopped: null };
    } catch(e) {
      log.warn('countMoviesByLike:', e.message);
      return { cnt: 0, last_stopped: null };
    }
  };

  /**
   * Compte les films regardés par l'utilisateur via une liste de {title, year}.
   * Le matching par titre+année est robuste aux re-scans Plex qui changent les GUIDs.
   */
  const countMoviesByTitleYear = (movies) => {
    if (!movies || !movies.length) return { cnt: 0, last_stopped: null };
    try {
      const orClauses = movies.map(() => '(LOWER(shm.title) = ? AND shm.year = ?)').join(' OR ');
      const params = [userFilter.param, ...movies.flatMap(m => [m.title.toLowerCase(), m.year])];
      const row = tautulliDb.prepare(`
        SELECT COUNT(DISTINCT LOWER(shm.title) || COALESCE(shm.year,'')) as cnt,
               MAX(sh.stopped) as last_stopped
        FROM session_history sh
        JOIN session_history_metadata shm ON sh.id = shm.id
        WHERE ${userFilter.clause}
          AND sh.stopped > sh.started
          AND sh.media_type = 'movie'
          AND (${orClauses})
      `).get(...params);
      return row || { cnt: 0, last_stopped: null };
    } catch(e) {
      log.warn('countMoviesByTitleYear:', e.message);
      return { cnt: 0, last_stopped: null };
    }
  };

  /**
   * Évalue un succès de type "toute la collection regardée".
   * Priorité : API Tautulli (collection rating_key) → fallback titres LIKE.
   */
  const checkCollection = async (id, fallbackPatterns, minRequired = null) => {
    const conf = COLLECTION_KEYS[id];
    // Essai via API Plex (titre+année, stable même après re-scans)
    if (conf?.ratingKey) {
      const movies = await getCollectionItems(conf.ratingKey);
      if (movies && movies.length > 0) {
        const row = countMoviesByTitleYear(movies);
        const required = minRequired ?? movies.length;
        const current = Math.min(row.cnt, required);
        log.debug(`${id} (collection): ${current}/${required}`);
        if (current >= required) return { date: fmt(row.last_stopped) || today, current, total: required };
        return { date: null, current, total: required };
      }
    }
    // Fallback : matching par titre LIKE
    if (fallbackPatterns && minRequired) {
      const row = countMoviesByLike(fallbackPatterns);
      const current = Math.min(row.cnt, minRequired);
      log.debug(`${id} (fallback titre): ${current}/${minRequired}`);
      if (current >= minRequired) return { date: fmt(row.last_stopped) || today, current, total: minRequired };
      return { date: null, current, total: minRequired };
    }
    return { date: null, current: 0, total: 0 };
  };

  log.debug(`Évaluation secrets pour ${norm}: [${toCheckIds.join(', ')}]`);

  try {
    for (const id of toCheckIds) {
      switch (id) {

        // 🦕 Survivant du Parc — Toute la saga Jurassic
        case 'jurassic-survivor': {
          const r = await checkCollection(id, ['%jurassic%'], 7);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // ⚡ Potterhead — Les 8 films Harry Potter
        case 'potter-head': {
          const r = await checkCollection(id, ['harry potter%'], 8);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // 🦸 Marvel Fan — Toute la collection MCU
        case 'marvel-fan': {
          const r = await checkCollection(id, ['%marvel%', '%avengers%']);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // 🧑‍⚖️ Maître Jedi — 7 films Star Wars minimum
        case 'black-knight': {
          const r = await checkCollection(id, ['%star wars%'], COLLECTION_MIN['black-knight']);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // 👑 Tolkiendil — Trilogie Seigneur des Anneaux
        case 'tolkiendil': {
          const r = await checkCollection(id, ['%lord of the rings%', '%seigneur des anneaux%'], 3);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // 🐵 Évolutionniste — Trilogie Planète des Singes
        case 'evolutionist': {
          const r = await checkCollection(id, ['%planet of the apes%', '%planète des singes%'], 3);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // 🌙 Spectateur de Minuit — Session commencée entre 00h et 01h
        case 'midnight-watcher': {
          try {
            const r = tautulliDb.prepare(`
              SELECT sh.started FROM session_history sh
              WHERE ${userFilter.clause} AND sh.stopped > sh.started
                AND CAST(strftime('%H', datetime(sh.started, 'unixepoch', 'localtime')) AS INTEGER) = 0
              ORDER BY sh.started ASC LIMIT 1
            `).get(userFilter.param);
            if (r) results[id] = fmt(r.started) || today;
          } catch(e) { log.warn('midnight-watcher:', e.message); }
          break;
        }

        // ⚔️ Guerrier du Week-end — 20h+ regardées un seul week-end (Sam+Dim)
        case 'weekend-warrior': {
          try {
            const r = tautulliDb.prepare(`
              SELECT
                strftime('%Y-%W', datetime(sh.started, 'unixepoch', 'localtime')) as week,
                SUM(CAST(sh.stopped - sh.started AS REAL) / 3600) as hours,
                MAX(sh.stopped) as last_stopped
              FROM session_history sh
              WHERE ${userFilter.clause} AND sh.stopped > sh.started
                AND CAST(strftime('%w', datetime(sh.started, 'unixepoch', 'localtime')) AS INTEGER) IN (0, 6)
              GROUP BY week HAVING hours >= 20
              ORDER BY week ASC LIMIT 1
            `).get(userFilter.param);
            if (r) results[id] = fmt(r.last_stopped) || today;
          } catch(e) { log.warn('weekend-warrior:', e.message); }
          break;
        }

        // 🛌 Countdown en Pyjama — Regarder quelque chose le 31 décembre
        case 'countdown-pajama': {
          try {
            const r = tautulliDb.prepare(`
              SELECT sh.started FROM session_history sh
              WHERE ${userFilter.clause} AND sh.stopped > sh.started
                AND strftime('%m-%d', datetime(sh.started, 'unixepoch', 'localtime')) = '12-31'
              ORDER BY sh.started ASC LIMIT 1
            `).get(userFilter.param);
            if (r) results[id] = fmt(r.started) || today;
          } catch(e) { log.warn('countdown-pajama:', e.message); }
          break;
        }

        default:
          break;
      }
    }
  } catch (err) {
    log.error('évaluation secrets:', err.message);
  }

  if (Object.keys(results).length > 0) {
    log.info(`Secrets débloqués pour ${norm}: ${Object.keys(results).join(', ')}`);
  }
  return { unlocked: results, progress };
}

/** * 🔍 Récupérer les utilisateurs actuellement en lecture (live sessions)
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
    log.debug(`${liveUsers.length} utilisateurs en lecture`);
    return liveUsers;
    
  } catch (err) {
    log.warn('live users:', err.message);
    return [];
  }
}

/**
 * 🎬 Récupérer le dernier contenu regardé par un utilisateur (pour fallback widget)
 */
function getLastPlayedItem(username) {
  if (!tautulliDb) return null;
  try {
    const norm = username.toLowerCase();
    // Passe par la table users pour matcher le bon user_id (même logique que getUserStatsFromTautulli)
    const stmt = tautulliDb.prepare(`
      SELECT
        sh.media_type,
        sh.stopped,
        shm.title,
        shm.grandparent_title,
        shm.parent_title,
        shm.year,
        shm.thumb
      FROM users u
      JOIN session_history sh ON u.user_id = sh.user_id
      JOIN session_history_metadata shm ON sh.id = shm.id
      WHERE LOWER(u.username) = ?
        AND sh.stopped > sh.started
        AND sh.media_type IN ('movie', 'episode')
      ORDER BY sh.stopped DESC
      LIMIT 1
    `);
    const row = stmt.get(norm);
    if (!row) {
      log.debug('getLastPlayedItem: aucun résultat pour', norm);
      return null;
    }
    log.debug('getLastPlayedItem:', norm, '->', row.title);
    return {
      mediaType:  row.media_type,
      title:      row.title              || '',
      grandTitle: row.grandparent_title  || '',
      parentTitle:row.parent_title       || '',
      year:       row.year               || null,
      thumb:      row.thumb              || null,
      stoppedAt:  row.stopped            || null,
    };
  } catch (err) {
    log.warn('getLastPlayedItem:', err.message);
    return null;
  }
}

/**
 * 📊 Statistiques détaillées d'un utilisateur pour la page "Mes Statistiques"
 * Top contenu, genres, activité par heure/jour
 */
function getUserDetailedStats(username) {
  if (!tautulliDb) return null;
  const norm = username.toLowerCase();
  const result = {};

  // ── Top 10 contenu (heures cumulées) ──────────────────────────────
  try {
    const rows = tautulliDb.prepare(`
      SELECT
        CASE
          WHEN sh.media_type = 'episode' THEN shm.grandparent_title
          ELSE shm.title
        END as title,
        sh.media_type,
        SUM(CAST((sh.stopped - sh.started) AS REAL) / 3600) as hours
      FROM users u
      JOIN session_history sh ON u.user_id = sh.user_id
      JOIN session_history_metadata shm ON sh.id = shm.id
      WHERE LOWER(u.username) = ?
        AND sh.stopped > sh.started
        AND sh.media_type IN ('movie', 'episode')
        AND (shm.title IS NOT NULL OR shm.grandparent_title IS NOT NULL)
      GROUP BY 1
      ORDER BY hours DESC
      LIMIT 10
    `).all(norm);
    if (rows.length > 0) {
      result.topContent = rows.map(r => ({
        title: r.title || '?',
        type: r.media_type,
        hours: Math.round(r.hours * 10) / 10
      }));
    } else {
      // Fallback : utiliser les colonnes directes de session_history (sans metadata)
      const fallback = tautulliDb.prepare(`
        SELECT
          sh.title as title,
          sh.media_type,
          SUM(CAST((sh.stopped - sh.started) AS REAL) / 3600) as hours
        FROM users u
        JOIN session_history sh ON u.user_id = sh.user_id
        WHERE LOWER(u.username) = ?
          AND sh.stopped > sh.started
          AND sh.media_type IN ('movie', 'episode')
        GROUP BY sh.title
        ORDER BY hours DESC
        LIMIT 10
      `).all(norm);
      result.topContent = fallback
        .filter(r => r.title)
        .map(r => ({
          title: r.title,
          type: r.media_type,
          hours: Math.round(r.hours * 10) / 10
        }));
    }
  } catch (e) {
    log.warn('getUserDetailedStats topContent:', e.message);
    // Dernier recours : colonnes directes de session_history
    try {
      const fallback = tautulliDb.prepare(`
        SELECT
          sh.title as title,
          sh.media_type,
          SUM(CAST((sh.stopped - sh.started) AS REAL) / 3600) as hours
        FROM users u
        JOIN session_history sh ON u.user_id = sh.user_id
        WHERE LOWER(u.username) = ?
          AND sh.stopped > sh.started
          AND sh.media_type IN ('movie', 'episode')
        GROUP BY sh.title
        ORDER BY hours DESC
        LIMIT 10
      `).all(norm);
      result.topContent = fallback
        .filter(r => r.title)
        .map(r => ({
          title: r.title,
          type: r.media_type,
          hours: Math.round(r.hours * 10) / 10
        }));
    } catch (e2) {
      log.warn('getUserDetailedStats topContent fallback:', e2.message);
      result.topContent = [];
    }
  }

  // ── Répartition par type de contenu ───────────────────────────────
  try {
    const rows = tautulliDb.prepare(`
      SELECT sh.media_type,
        SUM(CAST((sh.stopped - sh.started) AS REAL) / 3600) as hours
      FROM users u
      JOIN session_history sh ON u.user_id = sh.user_id
      WHERE LOWER(u.username) = ? AND sh.stopped > sh.started
      GROUP BY sh.media_type
    `).all(norm);
    result.contentTypes = rows.map(r => ({
      type: r.media_type,
      hours: Math.round(r.hours * 10) / 10
    }));
  } catch (e) { result.contentTypes = []; }

  // ── Genres films ───────────────────────────────────────────────────
  try {
    const rows = tautulliDb.prepare(`
      SELECT shm.genres,
        SUM(CAST((sh.stopped - sh.started) AS REAL) / 3600) as hours
      FROM users u
      JOIN session_history sh ON u.user_id = sh.user_id
      JOIN session_history_metadata shm ON sh.id = shm.id
      WHERE LOWER(u.username) = ? AND sh.stopped > sh.started
        AND sh.media_type = 'movie'
        AND shm.genres IS NOT NULL AND shm.genres != ''
      GROUP BY shm.genres
      ORDER BY hours DESC
    `).all(norm);
    const map = {};
    for (const r of rows) {
      for (const g of r.genres.split(/[;,]/).map(s => s.trim()).filter(Boolean)) {
        map[g] = (map[g] || 0) + r.hours;
      }
    }
    result.movieGenres = Object.entries(map)
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([name, hours]) => ({ name, hours: Math.round(hours * 10) / 10 }));
  } catch (e) { log.warn('getUserDetailedStats movieGenres:', e.message); result.movieGenres = []; }

  // ── Genres séries ─────────────────────────────────────────────────
  try {
    const rows = tautulliDb.prepare(`
      SELECT shm.genres,
        SUM(CAST((sh.stopped - sh.started) AS REAL) / 3600) as hours
      FROM users u
      JOIN session_history sh ON u.user_id = sh.user_id
      JOIN session_history_metadata shm ON sh.id = shm.id
      WHERE LOWER(u.username) = ? AND sh.stopped > sh.started
        AND sh.media_type = 'episode'
        AND shm.genres IS NOT NULL AND shm.genres != ''
      GROUP BY shm.genres
      ORDER BY hours DESC
    `).all(norm);
    const map = {};
    for (const r of rows) {
      for (const g of r.genres.split(/[;,]/).map(s => s.trim()).filter(Boolean)) {
        map[g] = (map[g] || 0) + r.hours;
      }
    }
    result.seriesGenres = Object.entries(map)
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([name, hours]) => ({ name, hours: Math.round(hours * 10) / 10 }));
  } catch (e) { log.warn('getUserDetailedStats seriesGenres:', e.message); result.seriesGenres = []; }

  // ── Nombre de jours actifs (pour normaliser l'heure du jour) ──────
  let activeDaysCount = 1;
  try {
    const row = tautulliDb.prepare(`
      SELECT COUNT(DISTINCT date(sh.started, 'unixepoch', 'localtime')) as cnt
      FROM users u
      JOIN session_history sh ON u.user_id = sh.user_id
      WHERE LOWER(u.username) = ? AND sh.stopped > sh.started
        AND sh.media_type IN ('movie', 'episode')
    `).get(norm);
    activeDaysCount = Math.max(1, row?.cnt || 1);
  } catch (e) {}

  // ── Activité par heure du jour (moyenne par jour actif) ───────────
  try {
    const rows = tautulliDb.prepare(`
      SELECT
        CAST(strftime('%H', sh.started, 'unixepoch', 'localtime') AS INTEGER) as hour,
        sh.media_type,
        SUM(CAST((sh.stopped - sh.started) AS REAL) / 3600) as hours
      FROM users u
      JOIN session_history sh ON u.user_id = sh.user_id
      WHERE LOWER(u.username) = ? AND sh.stopped > sh.started
        AND sh.media_type IN ('movie', 'episode')
      GROUP BY hour, sh.media_type
      ORDER BY hour
    `).all(norm);
    result.hourActivity = rows.map(r => ({
      hour: r.hour,
      type: r.media_type,
      hours: Math.round((r.hours / activeDaysCount) * 100) / 100
    }));
    result.activeDaysCount = activeDaysCount;
  } catch (e) { result.hourActivity = []; }

  // ── Activité par jour de la semaine (moyenne par occurrence) ──────
  try {
    // Nombre d'occurrences de chaque jour de semaine entre la 1ère et dernière session
    const rangeRow = tautulliDb.prepare(`
      SELECT MIN(sh.started) as first_ts, MAX(sh.started) as last_ts
      FROM users u
      JOIN session_history sh ON u.user_id = sh.user_id
      WHERE LOWER(u.username) = ? AND sh.stopped > sh.started
    `).get(norm);

    // Calcul JS du nombre d'occurrences de chaque DOW dans la période
    const dowCounts = Array(7).fill(1);
    if (rangeRow?.first_ts && rangeRow?.last_ts) {
      const start = new Date(rangeRow.first_ts * 1000);
      const end   = new Date(rangeRow.last_ts  * 1000);
      const totalDays = Math.max(1, Math.round((end - start) / 86400000));
      const fullWeeks = Math.floor(totalDays / 7);
      for (let d = 0; d < 7; d++) {
        let count = fullWeeks;
        // Jours supplémentaires dans la semaine partielle
        for (let i = 0; i < (totalDays % 7); i++) {
          const dayOfWeek = (start.getDay() + i) % 7;
          if (dayOfWeek === d) count++;
        }
        dowCounts[d] = Math.max(1, count);
      }
    }

    const rows = tautulliDb.prepare(`
      SELECT
        CAST(strftime('%w', sh.started, 'unixepoch', 'localtime') AS INTEGER) as dow,
        sh.media_type,
        SUM(CAST((sh.stopped - sh.started) AS REAL) / 3600) as hours
      FROM users u
      JOIN session_history sh ON u.user_id = sh.user_id
      WHERE LOWER(u.username) = ? AND sh.stopped > sh.started
        AND sh.media_type IN ('movie', 'episode')
      GROUP BY dow, sh.media_type
      ORDER BY dow
    `).all(norm);
    result.dayActivity = rows.map(r => ({
      dow: r.dow,
      type: r.media_type,
      hours: Math.round((r.hours / dowCounts[r.dow]) * 100) / 100
    }));
  } catch (e) { result.dayActivity = []; }

  return result;
}

/**
 * Fermer la connexion (au shutdown)
 */
function closeTautulliDatabase() {
  if (tautulliDb) {
    tautulliDb.close();
    tautulliDb = null;
    log.info('Connexion fermée');
  }
}

module.exports = {
  initTautulliDatabase,
  isTautulliReady,
  getUserStatsFromTautulli,
  getAllUserStatsFromTautulli,
  getMonthlyHoursFromTautulli,
  getTimeBasedSessionCounts,
  getAchievementUnlockDates,
  evaluateSecretAchievements,
  getLiveUsers,
  getLastPlayedItem,
  getUserDetailedStats,
  closeTautulliDatabase
};
