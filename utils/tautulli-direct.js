/**
 * 🗄️ TAUTULLI DIRECT DATABASE READER
 * Lit directement la DB Tautulli (lecture seule) pour éviter l'API
 * Path de la DB fourni via variable d'environnement
 */

const Database = require('better-sqlite3');
const path = require('path');
const log = require('./logger').create('[Tautulli DB]');
const { getConfigValue } = require('./config');

let tautulliDb = null;

// ── Cache mémoire des rating_keys par collection (durée: 24h)
const traktListCache = {};
const tautulliSchemaCache = {};
const plexAvailabilityCache = {};
const plexLibraryIndexCache = { items: null, ts: 0, failedAt: 0 };
const COLLECTION_CACHE_TTL = 24 * 60 * 60 * 1000;
const COLLECTION_MOVIE_MIN_PERCENT = 50;

const TRAKT_LISTS = {
  'potter-head': 'https://app.trakt.tv/users/machadodg/lists/wizarding-world',
  'jurassic-survivor': 'https://app.trakt.tv/users/shaneleexcx1234/lists/jurassic-park-world-franchise',
  'marvel-fan': 'https://trakt.tv/users/donxy/lists/marvel-cinematic-universe',
  'black-knight': 'https://app.trakt.tv/users/feeltheduck/lists/star-wars-collection',
  'tolkiendil': 'https://app.trakt.tv/users/bobbymarshal/lists/middle-earth',
  'evolutionist': 'https://app.trakt.tv/lists/official/1531',
  'agent-007': 'https://app.trakt.tv/users/maiki01/lists/james-bond-collection',
  'fast-family': 'https://app.trakt.tv/users/babakhan23/lists/fast-furious-movie-collection',
  'star-trek-universe': 'https://trakt.tv/users/gratiskeder/lists/star-trek',
  'arrowverse': 'https://trakt.tv/users/dudeimtired/lists/arrowverse-collection',
  'monsterverse': 'https://trakt.tv/users/pullsa/lists/the-monsterverse'
};

function getTraktApiListUrl(traktListUrl) {
  if (!traktListUrl) return null;
  try {
    const parsed = new URL(traktListUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);

    if (parts[0] === 'users' && parts[2] === 'lists' && parts[1] && parts[3]) {
      return `https://api.trakt.tv/users/${parts[1]}/lists/${parts[3]}/items`;
    }

    if (parts[0] === 'lists' && parts[1] === 'official' && parts[2]) {
      return `https://api.trakt.tv/lists/${parts[2]}/items`;
    }

    if (parts[0] === 'lists' && parts[1]) {
      return `https://api.trakt.tv/lists/${parts[1]}/items`;
    }
  } catch (_) {}
  return null;
}

async function getTraktListItems(achievementId) {
  const traktClientId = String(getConfigValue('TRAKT_CLIENT_ID', '') || '').trim();
  const traktListUrl = TRAKT_LISTS[achievementId];
  if (!traktClientId || !traktListUrl) return null;

  const now = Date.now();
  const cached = traktListCache[achievementId];
  if (cached && (now - cached.ts) < COLLECTION_CACHE_TTL) {
    return cached.items;
  }

  const apiUrl = getTraktApiListUrl(traktListUrl);
  if (!apiUrl) return null;

  try {
    const items = [];
    let page = 1;
    const limit = 100;

    while (page <= 10) {
      const separator = apiUrl.includes('?') ? '&' : '?';
      const resp = await fetch(`${apiUrl}${separator}page=${page}&limit=${limit}`, {
        headers: {
          Accept: 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': traktClientId
        }
      });

      if (!resp.ok) throw new Error(`Trakt API HTTP ${resp.status}`);

      const payload = await resp.json();
      const pageItems = Array.isArray(payload) ? payload : [];
      if (!pageItems.length) break;

      items.push(...pageItems);
      if (pageItems.length < limit) break;
      page += 1;
    }

    const normalized = items
      .filter(isReleasedTraktItem)
      .map(item => {
        if (item?.type === 'movie' && item.movie?.title) {
          return { type: 'movie', title: item.movie.title, year: item.movie.year ?? null };
        }
        if (item?.type === 'show' && item.show?.title) {
          return { type: 'show', title: item.show.title, year: item.show.year ?? null };
        }
        return null;
      })
      .filter(Boolean);

    const availableItems = await filterItemsAvailableInPlex(normalized);

    traktListCache[achievementId] = { items: availableItems, ts: now };
    log.info(`Trakt ${achievementId}: ${availableItems.length}/${normalized.length} éléments disponibles sur Plex`);
    return availableItems;
  } catch (err) {
    log.warn(`Trakt ${achievementId}:`, err.message);
    return null;
  }
}

function getTableColumns(tableName) {
  if (!tautulliDb) return [];
  if (tautulliSchemaCache[tableName]) return tautulliSchemaCache[tableName];
  try {
    const rows = tautulliDb.prepare(`PRAGMA table_info(${tableName})`).all();
    const columns = rows.map(row => row.name);
    tautulliSchemaCache[tableName] = columns;
    return columns;
  } catch (_) {
    tautulliSchemaCache[tableName] = [];
    return [];
  }
}

function hasTableColumn(tableName, columnName) {
  return getTableColumns(tableName).includes(columnName);
}

function getPlexAvailabilityCacheKey(item) {
  return `${item.type || 'unknown'}:${String(item.title || '').toLowerCase()}::${item.year || ''}`;
}

function getPreferredPlexServerToken() {
  try {
    const { AppSettingQueries } = require('./database');
    const runtimeToken = String(AppSettingQueries.get('runtime_plex_cloud_token', '') || '').trim();
    if (runtimeToken) return runtimeToken;
  } catch (_) {}
  return String(getConfigValue('PLEX_TOKEN', '') || '').trim();
}

function normalizeCollectionTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|le|la|les|un|une|des|du|de)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectionTitleMatches(a, b, yearA = null, yearB = null) {
  const rawA = String(a || '').trim().toLowerCase();
  const rawB = String(b || '').trim().toLowerCase();
  if (!rawA || !rawB) return false;

  const hasYears = Number.isFinite(Number(yearA)) && Number.isFinite(Number(yearB));
  if (hasYears && Number(yearA) !== Number(yearB)) {
    return false;
  }

  if (rawA === rawB) return true;

  const normA = normalizeCollectionTitle(rawA);
  const normB = normalizeCollectionTitle(rawB);
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  if (normA.includes(normB) || normB.includes(normA)) {
    return true;
  }

  return false;
}

function isReleasedTraktItem(item) {
  const rawDate = item?.type === 'movie'
    ? item?.movie?.released
    : item?.show?.first_aired;

  if (!rawDate) return true;

  const releaseTs = Date.parse(rawDate);
  if (Number.isNaN(releaseTs)) return true;

  return releaseTs <= Date.now();
}

async function getPlexLibraryIndex() {
  const now = Date.now();
  if (plexLibraryIndexCache.items && (now - plexLibraryIndexCache.ts) < COLLECTION_CACHE_TTL) {
    return plexLibraryIndexCache.items;
  }
  if (plexLibraryIndexCache.failedAt && (now - plexLibraryIndexCache.failedAt) < 5 * 60 * 1000) {
    return null;
  }

  const plexUrl = String(getConfigValue('PLEX_URL', '') || '').trim();
  const plexToken = getPreferredPlexServerToken();
  if (!plexUrl || !plexToken) return null;

  try {
    const sectionsUrl = `${plexUrl}/library/sections?X-Plex-Token=${plexToken}`;
    const sectionsResp = await fetch(sectionsUrl, { headers: { Accept: 'application/json' } });
    if (!sectionsResp.ok) throw new Error(`sections HTTP ${sectionsResp.status}`);

    const sections = (await sectionsResp.json())?.MediaContainer?.Directory || [];
    const targetSections = sections.filter(section => section?.type === 'movie' || section?.type === 'show');
    const indexedItems = new Set();

    for (const section of targetSections) {
      const type = section.type === 'show' ? 2 : 1;
      let start = 0;
      const size = 200;

      while (true) {
        const url = new URL(`${plexUrl}/library/sections/${section.key}/all`);
        url.searchParams.set('type', String(type));
        url.searchParams.set('X-Plex-Container-Start', String(start));
        url.searchParams.set('X-Plex-Container-Size', String(size));
        url.searchParams.set('X-Plex-Token', plexToken);

        const resp = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
        if (!resp.ok) throw new Error(`section ${section.key} HTTP ${resp.status}`);

        const metadata = (await resp.json())?.MediaContainer?.Metadata || [];
        for (const entry of metadata) {
          const title = String(entry?.title || '').trim();
          if (!title) continue;
          const cacheKey = getPlexAvailabilityCacheKey({
            type: section.type === 'show' ? 'show' : 'movie',
            title,
            year: entry?.year ?? null
          });
          indexedItems.add(cacheKey);
        }

        if (metadata.length < size) break;
        start += size;
      }
    }

    plexLibraryIndexCache.items = indexedItems;
    plexLibraryIndexCache.ts = now;
    plexLibraryIndexCache.failedAt = 0;
    log.info(`Index Plex collections: ${indexedItems.size} éléments référencés`);
    return indexedItems;
  } catch (err) {
    plexLibraryIndexCache.failedAt = now;
    log.warn(`Index Plex collections: ${err.message}`);
    return null;
  }
}

async function isItemAvailableInPlex(item) {
  const title = String(item?.title || '').trim();
  if (!title) return false;

  const cacheKey = getPlexAvailabilityCacheKey(item);
  const now = Date.now();
  const cached = plexAvailabilityCache[cacheKey];
  if (cached && (now - cached.ts) < COLLECTION_CACHE_TTL) {
    return cached.available;
  }

  const plexUrl = String(getConfigValue('PLEX_URL', '') || '').trim();
  const plexToken = getPreferredPlexServerToken();
  if (!plexUrl || !plexToken) return false;

  try {
    const index = await getPlexLibraryIndex();
    if (!index) return false;

    const available = index.has(cacheKey);

    plexAvailabilityCache[cacheKey] = { available, ts: now };
    return available;
  } catch (err) {
    log.warn(`Plex disponibilité ${title}:`, err.message);
    return false;
  }
}

async function filterItemsAvailableInPlex(items) {
  if (!Array.isArray(items) || !items.length) return [];

  const availableItems = [];
  for (const item of items) {
    if (await isItemAvailableInPlex(item)) {
      availableItems.push(item);
    }
  }
  return availableItems;
}

function getMovieCompletionSql(historyAlias = 'sh', metadataAlias = 'shm') {
  if (hasTableColumn('session_history', 'percent_complete')) {
    return `COALESCE(${historyAlias}.percent_complete, 0) >= ${COLLECTION_MOVIE_MIN_PERCENT}`;
  }

  if (hasTableColumn('session_history', 'watched_status')) {
    return `(
      COALESCE(${historyAlias}.watched_status, 0) = 1
      OR COALESCE(${historyAlias}.watched_status, 0) >= ${COLLECTION_MOVIE_MIN_PERCENT}
      OR (
        COALESCE(${historyAlias}.watched_status, 0) > 0
        AND COALESCE(${historyAlias}.watched_status, 0) < 1
        AND COALESCE(${historyAlias}.watched_status, 0) >= ${COLLECTION_MOVIE_MIN_PERCENT / 100}
      )
    )`;
  }

  if (hasTableColumn('session_history_metadata', 'duration')) {
    return `CAST((${historyAlias}.stopped - ${historyAlias}.started) AS REAL) >= (
      CASE
        WHEN COALESCE(${metadataAlias}.duration, 0) > 100000 THEN ${metadataAlias}.duration / 1000.0
        ELSE ${metadataAlias}.duration
      END
    ) * ${COLLECTION_MOVIE_MIN_PERCENT / 100}`;
  }

  return `${historyAlias}.stopped > ${historyAlias}.started`;
}

/**
 * Initialiser la connexion à la DB Tautulli
 * En lecture seule pour éviter tout risque de corruption
 */
function initTautulliDatabase() {
  const TAUTULLI_DB_PATH = getConfigValue('TAUTULLI_DB_PATH');
  
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
        SUM(CASE WHEN sh.media_type = 'episode' THEN CAST((sh.stopped - sh.started) AS INTEGER) ELSE 0 END) as episode_duration_seconds,
        SUM(CASE WHEN sh.media_type = 'track' THEN 1 ELSE 0 END) as music_count,
        SUM(CASE WHEN sh.media_type = 'track' THEN CAST((sh.stopped - sh.started) AS INTEGER) ELSE 0 END) as music_duration_seconds
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
    const musicHours = stats.music_duration_seconds ? Math.round(stats.music_duration_seconds / 3600 * 10) / 10 : 0;
    
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
      musicCount: stats.music_count || 0,
      musicHours: musicHours,
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
        SUM(CASE WHEN sh.media_type = 'episode' THEN CAST((sh.stopped - sh.started) AS INTEGER) ELSE 0 END) as episode_duration_seconds,
        SUM(CASE WHEN sh.media_type = 'track' THEN 1 ELSE 0 END) as music_count,
        SUM(CASE WHEN sh.media_type = 'track' THEN CAST((sh.stopped - sh.started) AS INTEGER) ELSE 0 END) as music_duration_seconds
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
      const musicHours = stats.music_duration_seconds ? Math.round(stats.music_duration_seconds / 3600 * 10) / 10 : 0;
      
      return {
        userId: stats.user_id,
        username: stats.username,
        sessionCount: stats.session_count || 0,
        totalHours: totalHours,
        movieCount: stats.movie_count || 0,
        movieHours: movieHours,
        episodeCount: stats.episode_count || 0,
        episodeHours: episodeHours,
        musicCount: stats.music_count || 0,
        musicHours: musicHours,
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
   * Compte les films regardés par l'utilisateur via une liste de {title, year}.
   * Le matching par titre+année est robuste aux re-scans Plex qui changent les GUIDs.
   */
  const countMoviesByTitleYear = (movies) => {
    if (!movies || !movies.length) return { cnt: 0, last_stopped: null };
    try {
      const completionSql = getMovieCompletionSql('sh', 'shm');
      const watchedRows = tautulliDb.prepare(`
        SELECT LOWER(shm.title) as title,
               shm.title as raw_title,
               shm.year as year,
               MAX(sh.stopped) as last_stopped
        FROM session_history sh
        JOIN session_history_metadata shm ON sh.id = shm.id
        WHERE ${userFilter.clause}
          AND sh.stopped > sh.started
          AND sh.media_type = 'movie'
          AND ${completionSql}
        GROUP BY LOWER(shm.title), shm.year
      `).all(userFilter.param);

      let cnt = 0;
      let lastStopped = 0;
      for (const movie of movies) {
        const matched = watchedRows.find(row =>
          collectionTitleMatches(row.raw_title || row.title, movie.plexTitle || movie.title, row.year, movie.year)
          || collectionTitleMatches(row.raw_title || row.title, movie.title, row.year, movie.year)
        );
        if (matched) {
          cnt += 1;
          lastStopped = Math.max(lastStopped, Number(matched.last_stopped || 0));
        }
      }
      return { cnt, last_stopped: lastStopped || null };
    } catch(e) {
      log.warn('countMoviesByTitleYear:', e.message);
      return { cnt: 0, last_stopped: null };
    }
  };

  /**
   * Compte les séries regardées par l'utilisateur via leurs titres (grandparent_title).
   * La règle est "au moins un épisode vu" par série.
   */
  const countShowsByTitle = (shows) => {
    if (!shows || !shows.length) return { cnt: 0, last_stopped: null };
    try {
      const watchedRows = tautulliDb.prepare(`
        SELECT LOWER(shm.grandparent_title) as title,
               shm.grandparent_title as raw_title,
               MAX(sh.stopped) as last_stopped
        FROM session_history sh
        JOIN session_history_metadata shm ON sh.id = shm.id
        WHERE ${userFilter.clause}
          AND sh.stopped > sh.started
          AND sh.media_type = 'episode'
        GROUP BY LOWER(shm.grandparent_title)
      `).all(userFilter.param);

      let cnt = 0;
      let lastStopped = 0;
      for (const show of shows) {
        const matched = watchedRows.find(row =>
          collectionTitleMatches(row.raw_title || row.title, show.plexTitle || show.title)
          || collectionTitleMatches(row.raw_title || row.title, show.title)
        );
        if (matched) {
          cnt += 1;
          lastStopped = Math.max(lastStopped, Number(matched.last_stopped || 0));
        }
      }
      return { cnt, last_stopped: lastStopped || null };
    } catch(e) {
      log.warn('countShowsByTitle:', e.message);
      return { cnt: 0, last_stopped: null };
    }
  };

  /**
   * Évalue un succès de type "toute la collection regardée".
   * Source unique : liste Trakt.
   */
  const checkCollection = async (id) => {
    const traktItems = await getTraktListItems(id);
    if (traktItems && traktItems.length > 0) {
      const traktMovies = traktItems.filter(item => item.type === 'movie');
      if (traktMovies.length > 0) {
        const row = countMoviesByTitleYear(traktMovies);
        const required = traktMovies.length;
        const current = Math.min(row.cnt, required);
        log.debug(`${id} (trakt films): ${current}/${required}`);
        if (current >= required) return { date: fmt(row.last_stopped) || today, current, total: required };
        return { date: null, current, total: required };
      }
    }
    return { date: null, current: 0, total: 0 };
  };

  /**
   * Évalue un succès collection mixte films + séries.
   * Condition: films requis + séries requises (au moins un épisode/série).
   * Source unique : liste Trakt.
   */
  const checkMixedCollection = async (id, minMovies = null, minShows = null) => {
    let movieItems = [];
    let showItems = [];

    const traktItems = await getTraktListItems(id);
    if (traktItems && traktItems.length > 0) {
      movieItems = traktItems.filter(i => i.type === 'movie');
      showItems = traktItems.filter(i => i.type === 'show');
    }

    const requiredMovies = minMovies ?? movieItems.length;
    const requiredShows = minShows ?? showItems.length;

    let movieRow = { cnt: 0, last_stopped: null };
    let showRow = { cnt: 0, last_stopped: null };

    if (movieItems.length > 0) movieRow = countMoviesByTitleYear(movieItems);

    if (showItems.length > 0) {
      showRow = countShowsByTitle(showItems);
    }

    const currentMovies = Math.min(movieRow.cnt || 0, requiredMovies);
    const currentShows = Math.min(showRow.cnt || 0, requiredShows);
    const totalCurrent = currentMovies + currentShows;
    const totalRequired = requiredMovies + requiredShows;
    const maxStopped = Math.max(movieRow.last_stopped || 0, showRow.last_stopped || 0);

    log.debug(`${id} (mixte): films ${currentMovies}/${requiredMovies}, séries ${currentShows}/${requiredShows}`);

    if (totalRequired > 0 && currentMovies >= requiredMovies && currentShows >= requiredShows) {
      return { date: fmt(maxStopped) || today, current: totalCurrent, total: totalRequired };
    }
    return { date: null, current: totalCurrent, total: totalRequired };
  };

  log.debug(`Évaluation secrets pour ${norm}: [${toCheckIds.join(', ')}]`);

  try {
    for (const id of toCheckIds) {
      switch (id) {

        // 🦕 Survivant du Parc — Toute la saga Jurassic
        case 'jurassic-survivor': {
          const r = await checkCollection(id);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // ⚡ Wizarding World — Collection Wizarding World
        case 'potter-head': {
          const r = await checkCollection(id);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // 🦸 Marvel Fan — Toute la collection MCU
        case 'marvel-fan': {
          const r = await checkCollection(id);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // 🧑‍⚖️ Maître Jedi — 7 films Star Wars minimum
        case 'black-knight': {
          const r = await checkMixedCollection(id, 7, 0);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // 👑 Middle Earth — Collection Middle Earth
        case 'tolkiendil': {
          const r = await checkCollection(id);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // 🐵 Évolutionniste — Trilogie Planète des Singes
        case 'evolutionist': {
          const r = await checkCollection(id);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // 🦖 MonsterVerse — Collections films + séries
        case 'monsterverse': {
          const r = await checkMixedCollection(id);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // 🕴️ Agent 007 — Toute la collection James Bond 007
        case 'agent-007': {
          const r = await checkCollection(id);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // 🏎️ Fast Family — Toute la collection Fast and Furious
        case 'fast-family': {
          const r = await checkCollection(id);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // 🖖 Star Trek Universe — Toutes les séries de la collection
        case 'star-trek-universe': {
          const r = await checkMixedCollection(id, 0);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // 🏹 Arrowverse — Toutes les séries de la collection
        case 'arrowverse': {
          const r = await checkMixedCollection(id, 0);
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

        // ⚡ Maître du Direct Play — 1000 lectures en direct play
        case 'direct-play-master': {
          try {
            const decisionSql = `
              CASE
                WHEN LOWER(COALESCE(shm.transcode_decision, '')) IN ('direct play', 'directplay', 'copy', 'transcode')
                  THEN LOWER(shm.transcode_decision)
                WHEN shm.stream_video_decision = 'transcode' OR shm.stream_audio_decision = 'transcode'
                  THEN 'transcode'
                WHEN shm.stream_video_decision = 'copy' OR shm.stream_audio_decision = 'copy'
                  THEN 'copy'
                ELSE 'direct play'
              END
            `;

            const countRow = tautulliDb.prepare(`
              SELECT COUNT(*) as cnt
              FROM (
                SELECT sh.started as started, ${decisionSql} as decision
                FROM session_history sh
                LEFT JOIN session_history_media_info shm ON sh.id = shm.id
                WHERE ${userFilter.clause}
                  AND sh.stopped > sh.started
                  AND sh.media_type IN ('movie', 'episode')
              ) x
              WHERE x.decision IN ('direct play', 'directplay')
            `).get(userFilter.param);

            const current = countRow?.cnt || 0;
            progress[id] = { current: Math.min(current, 1000), total: 1000 };

            if (current >= 1000) {
              const unlockRow = tautulliDb.prepare(`
                SELECT x.started
                FROM (
                  SELECT sh.started as started, ${decisionSql} as decision
                  FROM session_history sh
                  LEFT JOIN session_history_media_info shm ON sh.id = shm.id
                  WHERE ${userFilter.clause}
                    AND sh.stopped > sh.started
                    AND sh.media_type IN ('movie', 'episode')
                ) x
                WHERE x.decision IN ('direct play', 'directplay')
                ORDER BY x.started ASC
                LIMIT 1 OFFSET 999
              `).get(userFilter.param);

              if (unlockRow?.started) {
                results[id] = fmt(unlockRow.started) || today;
              } else {
                results[id] = today;
              }
            }
          } catch(e) { log.warn('direct-play-master:', e.message); }
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

  // ── Mode de lecture (direct play / copy / transcode) ───────────────
  try {
    let rows = null;

    // Tentative 1 : transcode_decision depuis session_history_media_info (correctement jointé)
    try {
      rows = tautulliDb.prepare(`
        SELECT
          COALESCE(shm.transcode_decision, 'direct play') as decision,
          COUNT(*) as cnt
        FROM users u
        JOIN session_history sh ON u.user_id = sh.user_id
        JOIN session_history_media_info shm ON sh.id = shm.id
        WHERE LOWER(u.username) = ?
          AND sh.stopped > sh.started
          AND sh.media_type IN ('movie', 'episode')
        GROUP BY shm.transcode_decision
      `).all(norm);
      if (rows && rows.length > 0) {
        log.debug('[playMethod] ✓ Query 1 (transcode_decision from media_info) success');
      }
    } catch (e1) {
      log.debug(`[playMethod] Query 1 failed: ${e1.message}`);

      // Fallback 2 : stream_video_decision + stream_audio_decision depuis media_info
      try {
        rows = tautulliDb.prepare(`
          SELECT
            CASE
              WHEN shm.stream_video_decision = 'transcode' OR shm.stream_audio_decision = 'transcode' THEN 'transcode'
              WHEN shm.stream_video_decision = 'copy' OR shm.stream_audio_decision = 'copy' THEN 'copy'
              ELSE 'direct play'
            END as decision,
            COUNT(*) as cnt
          FROM users u
          JOIN session_history sh ON u.user_id = sh.user_id
          JOIN session_history_media_info shm ON sh.id = shm.id
          WHERE LOWER(u.username) = ?
            AND sh.stopped > sh.started
            AND sh.media_type IN ('movie', 'episode')
          GROUP BY decision
        `).all(norm);
        if (rows && rows.length > 0) {
          log.debug('[playMethod] ✓ Query 2 (stream_*_decision) success');
        }
      } catch (e2) {
        log.debug(`[playMethod] Query 2 failed: ${e2.message}`);

        // Fallback 3 : Fallback simple - tout compter comme direct play
        rows = tautulliDb.prepare(`
          SELECT 'direct play' as decision, COUNT(*) as cnt
          FROM users u
          JOIN session_history sh ON u.user_id = sh.user_id
          WHERE LOWER(u.username) = ?
            AND sh.stopped > sh.started
            AND sh.media_type IN ('movie', 'episode')
        `).all(norm);
        log.warn('[playMethod] ⚠ Using fallback: all sessions as "direct play"');
      }
    }

    if (rows && rows.length > 0) {
      const total = rows.reduce((s, r) => s + r.cnt, 0);
      const safeTotal = total || 1;
      const map = { 'direct play': 0, 'copy': 0, 'transcode': 0 };
      for (const r of rows) {
        const key = (r.decision || '').toLowerCase().replace(/\s+/g, ' ');
        if (key === 'direct play' || key === 'directplay')  map['direct play'] += r.cnt;
        else if (key === 'copy')                            map['copy']       += r.cnt;
        else                                                map['transcode']  += r.cnt;
      }
      result.playMethod = {
        directPlay:   { count: map['direct play'], pct: Math.round(map['direct play']  / safeTotal * 100) },
        directStream: { count: map['copy'],        pct: Math.round(map['copy']         / safeTotal * 100) },
        transcode:    { count: map['transcode'],   pct: Math.round(map['transcode']    / safeTotal * 100) },
        total
      };
    } else {
      result.playMethod = null;
    }
  } catch (e) { log.error('[playMethod] Erreur finale:', e.message); result.playMethod = null; }

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
 * 📊 Statistiques détaillées globales (tous utilisateurs confondus)
 * Retourne le même format que getUserDetailedStats pour réutiliser le même rendu front.
 */
function getGlobalDetailedStats() {
  if (!tautulliDb) return null;
  const result = {};

  // Top 10 contenu global
  try {
    const rows = tautulliDb.prepare(`
      SELECT
        CASE
          WHEN sh.media_type = 'episode' THEN shm.grandparent_title
          ELSE shm.title
        END as title,
        sh.media_type,
        SUM(CAST((sh.stopped - sh.started) AS REAL) / 3600) as hours
      FROM session_history sh
      JOIN session_history_metadata shm ON sh.id = shm.id
      WHERE sh.stopped > sh.started
        AND sh.media_type IN ('movie', 'episode')
        AND (shm.title IS NOT NULL OR shm.grandparent_title IS NOT NULL)
      GROUP BY 1
      ORDER BY hours DESC
      LIMIT 10
    `).all();
    result.topContent = rows.map(r => ({
      title: r.title || '?',
      type: r.media_type,
      hours: Math.round(r.hours * 10) / 10
    }));
  } catch (e) {
    log.warn('getGlobalDetailedStats topContent:', e.message);
    result.topContent = [];
  }

  // Répartition par type de contenu
  try {
    const rows = tautulliDb.prepare(`
      SELECT sh.media_type, SUM(CAST((sh.stopped - sh.started) AS REAL) / 3600) as hours
      FROM session_history sh
      WHERE sh.stopped > sh.started
      GROUP BY sh.media_type
    `).all();
    result.contentTypes = rows.map(r => ({
      type: r.media_type,
      hours: Math.round(r.hours * 10) / 10
    }));
  } catch (e) {
    result.contentTypes = [];
  }

  // Genres films globaux
  try {
    const rows = tautulliDb.prepare(`
      SELECT shm.genres, SUM(CAST((sh.stopped - sh.started) AS REAL) / 3600) as hours
      FROM session_history sh
      JOIN session_history_metadata shm ON sh.id = shm.id
      WHERE sh.stopped > sh.started
        AND sh.media_type = 'movie'
        AND shm.genres IS NOT NULL AND shm.genres != ''
      GROUP BY shm.genres
      ORDER BY hours DESC
    `).all();
    const map = {};
    for (const r of rows) {
      for (const g of r.genres.split(/[;,]/).map(s => s.trim()).filter(Boolean)) {
        map[g] = (map[g] || 0) + r.hours;
      }
    }
    result.movieGenres = Object.entries(map)
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([name, hours]) => ({ name, hours: Math.round(hours * 10) / 10 }));
  } catch (e) {
    result.movieGenres = [];
  }

  // Genres séries globaux
  try {
    const rows = tautulliDb.prepare(`
      SELECT shm.genres, SUM(CAST((sh.stopped - sh.started) AS REAL) / 3600) as hours
      FROM session_history sh
      JOIN session_history_metadata shm ON sh.id = shm.id
      WHERE sh.stopped > sh.started
        AND sh.media_type = 'episode'
        AND shm.genres IS NOT NULL AND shm.genres != ''
      GROUP BY shm.genres
      ORDER BY hours DESC
    `).all();
    const map = {};
    for (const r of rows) {
      for (const g of r.genres.split(/[;,]/).map(s => s.trim()).filter(Boolean)) {
        map[g] = (map[g] || 0) + r.hours;
      }
    }
    result.seriesGenres = Object.entries(map)
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([name, hours]) => ({ name, hours: Math.round(hours * 10) / 10 }));
  } catch (e) {
    result.seriesGenres = [];
  }

  // Mode de lecture global
  try {
    const rows = tautulliDb.prepare(`
      SELECT
        COALESCE(shm.transcode_decision, 'direct play') as decision,
        COUNT(*) as cnt
      FROM session_history sh
      JOIN session_history_media_info shm ON sh.id = shm.id
      WHERE sh.stopped > sh.started
        AND sh.media_type IN ('movie', 'episode')
      GROUP BY shm.transcode_decision
    `).all();

    if (rows && rows.length > 0) {
      const total = rows.reduce((s, r) => s + r.cnt, 0);
      const safeTotal = total || 1;
      const map = { 'direct play': 0, 'copy': 0, 'transcode': 0 };
      for (const r of rows) {
        const key = (r.decision || '').toLowerCase().replace(/\s+/g, ' ');
        if (key === 'direct play' || key === 'directplay') map['direct play'] += r.cnt;
        else if (key === 'copy') map['copy'] += r.cnt;
        else map['transcode'] += r.cnt;
      }
      result.playMethod = {
        directPlay:   { count: map['direct play'], pct: Math.round(map['direct play'] / safeTotal * 100) },
        directStream: { count: map['copy'], pct: Math.round(map['copy'] / safeTotal * 100) },
        transcode:    { count: map['transcode'], pct: Math.round(map['transcode'] / safeTotal * 100) },
        total
      };
    } else {
      result.playMethod = null;
    }
  } catch (e) {
    result.playMethod = null;
  }

  // Nombre de jours actifs globaux
  let activeDaysCount = 1;
  try {
    const row = tautulliDb.prepare(`
      SELECT COUNT(DISTINCT date(sh.started, 'unixepoch', 'localtime')) as cnt
      FROM session_history sh
      WHERE sh.stopped > sh.started
        AND sh.media_type IN ('movie', 'episode')
    `).get();
    activeDaysCount = Math.max(1, row?.cnt || 1);
  } catch (_) {}

  // Activité par heure (moyenne/jour actif global)
  try {
    const rows = tautulliDb.prepare(`
      SELECT
        CAST(strftime('%H', sh.started, 'unixepoch', 'localtime') AS INTEGER) as hour,
        sh.media_type,
        SUM(CAST((sh.stopped - sh.started) AS REAL) / 3600) as hours
      FROM session_history sh
      WHERE sh.stopped > sh.started
        AND sh.media_type IN ('movie', 'episode')
      GROUP BY hour, sh.media_type
      ORDER BY hour
    `).all();
    result.hourActivity = rows.map(r => ({
      hour: r.hour,
      type: r.media_type,
      hours: Math.round((r.hours / activeDaysCount) * 100) / 100
    }));
    result.activeDaysCount = activeDaysCount;
  } catch (e) {
    result.hourActivity = [];
  }

  // Activité par jour de semaine (moyenne/occurrence globale)
  try {
    const rangeRow = tautulliDb.prepare(`
      SELECT MIN(sh.started) as first_ts, MAX(sh.started) as last_ts
      FROM session_history sh
      WHERE sh.stopped > sh.started
    `).get();

    const dowCounts = Array(7).fill(1);
    if (rangeRow?.first_ts && rangeRow?.last_ts) {
      const start = new Date(rangeRow.first_ts * 1000);
      const end = new Date(rangeRow.last_ts * 1000);
      const totalDays = Math.max(1, Math.round((end - start) / 86400000));
      const fullWeeks = Math.floor(totalDays / 7);
      for (let d = 0; d < 7; d++) {
        let count = fullWeeks;
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
      FROM session_history sh
      WHERE sh.stopped > sh.started
        AND sh.media_type IN ('movie', 'episode')
      GROUP BY dow, sh.media_type
      ORDER BY dow
    `).all();
    result.dayActivity = rows.map(r => ({
      dow: r.dow,
      type: r.media_type,
      hours: Math.round((r.hours / dowCounts[r.dow]) * 100) / 100
    }));
  } catch (e) {
    result.dayActivity = [];
  }

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
  getGlobalDetailedStats,
  closeTautulliDatabase
};
