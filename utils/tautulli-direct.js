/**
 * 🗄️ TAUTULLI DIRECT DATABASE READER
 * Lit directement la DB Tautulli (lecture seule) pour éviter l'API
 * Path de la DB fourni via variable d'environnement
 */

const Database = require('better-sqlite3');
const path = require('path');
const log = require('./logger').create('[Tautulli DB]');
const { getConfigValue } = require('./config');
const { CollectionItemMappingQueries } = require('./database');

let tautulliDb = null;

// ── Cache mémoire des rating_keys par collection (durée: 24h)
const traktListCache = {};
const tautulliSchemaCache = {};
const plexAvailabilityCache = {};
const traktListInflight = {};
const traktOfficialListIdCache = {};
const plexLibraryIndexCache = { items: null, ts: 0, failedAt: 0, promise: null };
const tautulliLibraryIndexCache = { items: null, ts: 0 };
const COLLECTION_CACHE_TTL = 24 * 60 * 60 * 1000;
const COLLECTION_MOVIE_MIN_PERCENT = 50;
const TRAKT_USER_AGENT = 'portall/1.0 (+https://github.com/iDrinkx/plex-portal)';

const TRAKT_LISTS = {
  'potter-head': 'https://app.trakt.tv/users/arachn0id/lists/wizarding-world',
  'jurassic-survivor': 'https://app.trakt.tv/users/shaneleexcx1234/lists/jurassic-park-world-franchise',
  'marvel-fan': 'https://app.trakt.tv/users/pygospa/lists/mcu-chronological-order',
  'black-knight': 'https://app.trakt.tv/users/sonicwarrior/lists/star-wars-canon-timeline',
  'tolkiendil': 'https://app.trakt.tv/users/bobbymarshal/lists/middle-earth',
  'evolutionist': 'https://app.trakt.tv/lists/official/1531',
  'agent-007': 'https://app.trakt.tv/users/maiki01/lists/james-bond-collection',
  'fast-family': 'https://app.trakt.tv/lists/official/the-fast-and-the-furious-collection',
  'star-trek-universe': 'https://app.trakt.tv/users/dgw/lists/star-trek-canon',
  'arrowverse': 'https://trakt.tv/users/dudeimtired/lists/arrowverse-collection',
  'monsterverse': 'https://trakt.tv/users/pullsa/lists/the-monsterverse'
};

async function resolveTraktOfficialListId(traktListUrl) {
  if (!traktListUrl) return null;
  const cached = traktOfficialListIdCache[traktListUrl];
  const now = Date.now();
  if (cached && (now - cached.ts) < COLLECTION_CACHE_TTL) {
    return cached.id;
  }

  try {
    const response = await fetch(traktListUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': TRAKT_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml'
      }
    });
    if (!response.ok) {
      throw new Error(`Trakt page HTTP ${response.status}`);
    }

    const redirectedUrl = new URL(response.url);
    const redirectedParts = redirectedUrl.pathname.split('/').filter(Boolean);
    if (redirectedParts[0] === 'lists' && /^\d+$/.test(redirectedParts[1] || '')) {
      const id = redirectedParts[1];
      traktOfficialListIdCache[traktListUrl] = { id, ts: now };
      return id;
    }

    const html = await response.text();
    const patterns = [
      /"list"\s*:\s*\{[\s\S]*?"ids"\s*:\s*\{[\s\S]*?"trakt"\s*:\s*(\d+)/i,
      /"ids"\s*:\s*\{[\s\S]*?"trakt"\s*:\s*(\d+)[\s\S]*?"slug"\s*:\s*"[^"]+"/i,
      /https?:\/\/(?:app\.)?trakt\.tv\/lists\/(\d+)(?:[/?"]|$)/i,
      /\/lists\/(\d+)(?:[/?"]|$)/i
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (!match?.[1]) continue;
      const id = match[1];
      traktOfficialListIdCache[traktListUrl] = { id, ts: now };
      return id;
    }
  } catch (err) {
    log.warn(`Trakt official resolve: ${err.message}`);
  }

  traktOfficialListIdCache[traktListUrl] = { id: null, ts: now };
  return null;
}

async function getTraktApiListUrls(traktListUrl) {
  if (!traktListUrl) return [];

  try {
    const parsed = new URL(traktListUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);

    if (parts[0] === 'users' && parts[2] === 'lists' && parts[1] && parts[3]) {
      return [`https://api.trakt.tv/users/${parts[1]}/lists/${parts[3]}/items`];
    }

    if (parts[0] === 'lists' && parts[1] === 'official' && parts[2]) {
      const slugOrId = parts[2];
      const urls = [];
      if (/^\d+$/.test(slugOrId)) {
        urls.push(`https://api.trakt.tv/lists/${slugOrId}/items`);
      } else {
        const resolvedId = await resolveTraktOfficialListId(traktListUrl);
        if (resolvedId) {
          urls.push(`https://api.trakt.tv/lists/${resolvedId}/items`);
        }
        urls.push(`https://api.trakt.tv/users/official/lists/${slugOrId}/items`);
        urls.push(`https://api.trakt.tv/lists/${slugOrId}/items`);
      }
      return [...new Set(urls)];
    }

    if (parts[0] === 'lists' && parts[1]) {
      return [`https://api.trakt.tv/lists/${parts[1]}/items`];
    }
  } catch (_) {}

  return [];
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
  if (traktListInflight[achievementId]) {
    return traktListInflight[achievementId];
  }

  const apiUrls = await getTraktApiListUrls(traktListUrl);
  if (!apiUrls.length) return null;

  const loadPromise = (async () => {
    try {
    let items = [];
    let lastError = null;

    for (const apiUrl of apiUrls) {
      const collectedItems = [];
      let page = 1;
      const limit = 100;

      try {
        while (page <= 10) {
          const separator = apiUrl.includes('?') ? '&' : '?';
          const resp = await fetch(`${apiUrl}${separator}page=${page}&limit=${limit}`, {
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'User-Agent': TRAKT_USER_AGENT,
              'trakt-api-version': '2',
              'trakt-api-key': traktClientId
            }
          });

          if (!resp.ok) throw new Error(`Trakt API HTTP ${resp.status}`);

          const payload = await resp.json();
          const pageItems = Array.isArray(payload) ? payload : [];
          if (!pageItems.length) break;

          collectedItems.push(...pageItems);
          if (pageItems.length < limit) break;
          page += 1;
        }

        items = collectedItems;
        if (items.length > 0) break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!items.length && lastError) {
      throw lastError;
    }

    const normalized = items
      .filter(isReleasedTraktItem)
      .map(item => {
        if (item?.type === 'movie' && item.movie?.title) {
          return {
            type: 'movie',
            title: item.movie.title,
            year: item.movie.year ?? null,
            ids: buildExternalIds(item.movie.ids || {})
          };
        }
        if (item?.type === 'show' && item.show?.title) {
          return {
            type: 'show',
            title: item.show.title,
            year: item.show.year ?? null,
            ids: buildExternalIds(item.show.ids || {})
          };
        }
        return null;
      })
      .filter(Boolean);

    const availableItems = await filterItemsAvailableInPlex(normalized);
    if (availableItems === null) {
      if (cached?.items?.length) {
        log.warn(`Trakt ${achievementId}: inventaire local indisponible, reutilisation du dernier cache (${cached.items.length} elements)`);
        return cached.items;
      }
      log.warn(`Trakt ${achievementId}: inventaire local indisponible, liste collection ignoree pour ce calcul`);
      return null;
    }
    traktListCache[achievementId] = { items: availableItems, ts: now };
    log.info(`Trakt ${achievementId}: ${availableItems.length}/${normalized.length} éléments disponibles sur Plex`);
    return availableItems;
    } catch (err) {
    log.warn(`Trakt ${achievementId}: ${err.message}`);
    if (cached?.items?.length) {
      log.warn(`Trakt ${achievementId}: reutilisation du cache stale (${cached.items.length} elements)`);
      return cached.items;
    }
    return null;
  } finally {
    delete traktListInflight[achievementId];
  }
  })();

  traktListInflight[achievementId] = loadPromise;
  return loadPromise;
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

function buildExternalIds(itemIds = {}) {
  const ids = new Set();
  const imdb = String(itemIds?.imdb || '').trim();
  const tmdb = itemIds?.tmdb;
  const tvdb = itemIds?.tvdb;
  const trakt = itemIds?.trakt;
  if (imdb) ids.add(`imdb:${imdb.toLowerCase()}`);
  if (tmdb !== undefined && tmdb !== null && `${tmdb}` !== '') ids.add(`tmdb:${tmdb}`);
  if (tvdb !== undefined && tvdb !== null && `${tvdb}` !== '') ids.add(`tvdb:${tvdb}`);
  if (trakt !== undefined && trakt !== null && `${trakt}` !== '') ids.add(`trakt:${trakt}`);
  return ids;
}

function getTraktItemKey(item = {}) {
  const ids = buildExternalIds(item.ids || {});
  if (ids.size > 0) {
    return [...ids].sort()[0];
  }
  return `${item.type || 'unknown'}:${item.year || 'na'}:${normalizeCollectionTitle(item.title || '')}`;
}

function extractPlexGuidIds(guidEntries = []) {
  const ids = new Set();
  const entries = Array.isArray(guidEntries) ? guidEntries : [guidEntries];
  for (const entry of entries) {
    const raw = String(entry?.id || entry || '').trim();
    const match = raw.match(/^(imdb|tmdb|tvdb):\/\/(.+)$/i);
    if (!match) continue;
    ids.add(`${match[1].toLowerCase()}:${String(match[2]).toLowerCase()}`);
  }
  return ids;
}

function extractIdsFromRawGuidValue(rawValue) {
  const ids = new Set();
  const text = String(rawValue || '');
  if (!text) return ids;

  const patterns = [
    /\b(imdb|tmdb|tvdb):\/\/([^"',|\s\]}]+)/gi,
    /\b(imdb|tmdb|tvdb):([^"',|\s\]}]+)/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      ids.add(`${String(match[1]).toLowerCase()}:${String(match[2]).toLowerCase()}`);
    }
  }

  return ids;
}

function mergeIdSets(...sets) {
  const merged = new Set();
  for (const set of sets) {
    if (!set) continue;
    for (const value of set) merged.add(value);
  }
  return merged;
}

function extractRowGuidIds(row = {}) {
  return mergeIdSets(
    extractIdsFromRawGuidValue(row.guid),
    extractIdsFromRawGuidValue(row.guids),
    extractIdsFromRawGuidValue(row.parent_guid),
    extractIdsFromRawGuidValue(row.parent_guids),
    extractIdsFromRawGuidValue(row.grandparent_guid),
    extractIdsFromRawGuidValue(row.grandparent_guids)
  );
}

function normalizeRatingKey(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function isLikelyPlexServerToken(token) {
  const value = String(token || '').trim();
  return value.length >= 16;
}

function getTautulliServerTokenFallback() {
  if (!tautulliDb) return '';
  try {
    const adminRow = tautulliDb.prepare(`
      SELECT server_token
      FROM users
      WHERE server_token IS NOT NULL
        AND TRIM(server_token) <> ''
      ORDER BY is_admin DESC, CASE WHEN user_id = 0 THEN 1 ELSE 0 END ASC, username ASC
      LIMIT 1
    `).get();
    return String(adminRow?.server_token || '').trim();
  } catch (_) {
    return '';
  }
}

function getPreferredPlexServerToken() {
  const configuredToken = String(getConfigValue('PLEX_TOKEN', '') || '').trim();
  if (isLikelyPlexServerToken(configuredToken)) return configuredToken;

  const tautulliServerToken = getTautulliServerTokenFallback();
  if (isLikelyPlexServerToken(tautulliServerToken)) return tautulliServerToken;

  try {
    const { AppSettingQueries } = require('./database');
    const runtimeToken = String(AppSettingQueries.get('runtime_plex_cloud_token', '') || '').trim();
    if (runtimeToken) return runtimeToken;
  } catch (_) {}
  return configuredToken || '';
}

function decodeBasicHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeCollectionTitle(value) {
  return decodeBasicHtmlEntities(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|le|la|les|un|une|des|du|de)\b/g, ' ')
    .replace(/\bfast and furious 6\b/g, 'furious 6')
    .replace(/\bfast and furious 7\b/g, 'furious 7')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCollectionTitleTokens(value) {
  return normalizeCollectionTitle(value)
    .split(' ')
    .map(token => token.trim())
    .filter(token => token && token.length >= 2);
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

  if (hasYears) {
    const shorter = normA.length <= normB.length ? normA : normB;
    const longer = shorter === normA ? normB : normA;
    if (
      shorter.length >= 8 &&
      (
        longer.startsWith(`${shorter} `) ||
        longer.startsWith(`${shorter}:`) ||
        longer.startsWith(`${shorter} -`)
      )
    ) {
      return true;
    }

    const tokensA = getCollectionTitleTokens(normA);
    const tokensB = getCollectionTitleTokens(normB);
    if (tokensA.length >= 3 && tokensB.length >= 3) {
      const setA = new Set(tokensA);
      const setB = new Set(tokensB);
      const common = tokensA.filter(token => setB.has(token));
      const overlap = common.length / Math.max(setA.size, setB.size);
      if (common.length >= 3 && overlap >= 0.6) {
        return true;
      }
    }
  }

  return false;
}

function plexEntryTitleCandidates(entry = {}) {
  return [
    entry?.title,
    entry?.originalTitle,
    entry?.titleSort,
    entry?.originalTitleSort
  ].filter(Boolean);
}

function getSessionHistoryMetadataMovieTitleColumns(alias = 'shm') {
  const columns = [];
  if (hasTableColumn('session_history_metadata', 'title')) columns.push(`${alias}.title AS raw_title`);
  if (hasTableColumn('session_history_metadata', 'original_title')) columns.push(`${alias}.original_title AS original_title`);
  if (hasTableColumn('session_history_metadata', 'full_title')) columns.push(`${alias}.full_title AS full_title`);
  if (hasTableColumn('session_history_metadata', 'sort_title')) columns.push(`${alias}.sort_title AS sort_title`);
  return columns;
}

function getSessionHistoryMetadataShowTitleColumns(alias = 'shm') {
  const columns = [];
  if (hasTableColumn('session_history_metadata', 'grandparent_title')) columns.push(`${alias}.grandparent_title AS raw_title`);
  if (hasTableColumn('session_history_metadata', 'original_title')) columns.push(`${alias}.original_title AS original_title`);
  if (hasTableColumn('session_history_metadata', 'full_title')) columns.push(`${alias}.full_title AS full_title`);
  if (hasTableColumn('session_history_metadata', 'sort_title')) columns.push(`${alias}.sort_title AS sort_title`);
  return columns;
}

function getSessionHistoryMetadataGuidColumns(alias = 'shm') {
  const columns = [];
  if (hasTableColumn('session_history_metadata', 'guid')) columns.push(`${alias}.guid AS guid`);
  if (hasTableColumn('session_history_metadata', 'guids')) columns.push(`${alias}.guids AS guids`);
  if (hasTableColumn('session_history_metadata', 'grandparent_guid')) columns.push(`${alias}.grandparent_guid AS grandparent_guid`);
  if (hasTableColumn('session_history_metadata', 'grandparent_guids')) columns.push(`${alias}.grandparent_guids AS grandparent_guids`);
  if (hasTableColumn('session_history_metadata', 'parent_guid')) columns.push(`${alias}.parent_guid AS parent_guid`);
  if (hasTableColumn('session_history_metadata', 'parent_guids')) columns.push(`${alias}.parent_guids AS parent_guids`);
  return columns;
}

function getRowTitleCandidates(row = {}) {
  return [row.raw_title, row.original_title, row.full_title, row.sort_title]
    .filter(Boolean)
    .map(value => String(value).trim())
    .filter(Boolean);
}

function findMatchingPlexEntriesForWatchedRow(index = [], row = {}, mediaType = 'movie') {
  const rowTitles = getRowTitleCandidates(row);
  if (!rowTitles.length) return [];
  return index.filter(entry =>
    entry.type === mediaType &&
    (entry.titles || [entry.title]).some(entryTitle =>
      rowTitles.some(rowTitle => collectionTitleMatches(entryTitle, rowTitle, entry.year, row.year))
    )
  );
}

function getMatchingPlexEntriesForCollectionItem(index = [], item = {}) {
  if (!Array.isArray(index) || !index.length || !item?.type) return [];

  const itemIds = buildExternalIds(item.ids || {});
  const matchingByIds = itemIds.size > 0
    ? index.filter(entry =>
        entry.type === item.type &&
        [...itemIds].some(id => entry.ids?.has(id))
      )
    : [];
  if (matchingByIds.length) return matchingByIds;

  return index.filter(entry =>
    entry.type === item.type &&
    (entry.titles || [entry.title]).some(candidate =>
      collectionTitleMatches(candidate, item.title, entry.year, item.year)
    )
  );
}

function getMatchingLocalEntriesForCollectionItem(index = [], item = {}, mapping = null) {
  if (!Array.isArray(index) || !index.length || !item?.type) return [];

  const mappedGuidIds = extractIdsFromRawGuidValue(mapping?.matched_guid);
  const allIds = mergeIdSets(buildExternalIds(item.ids || {}), mappedGuidIds);
  const idMatches = allIds.size > 0
    ? index.filter(entry =>
        entry.type === item.type &&
        [...allIds].some(id => entry.ids?.has(id))
      )
    : [];
  if (idMatches.length) return idMatches;

  const titles = [
    String(mapping?.matched_title || '').trim(),
    String(item.title || '').trim()
  ].filter(Boolean);

  return index.filter(entry =>
    entry.type === item.type &&
    (entry.titles || [entry.title]).some(candidate =>
      titles.some(title => collectionTitleMatches(candidate, title, entry.year, item.year))
    )
  );
}

function getTautulliLibraryIndex() {
  if (!tautulliDb) return [];
  const now = Date.now();
  if (tautulliLibraryIndexCache.items && (now - tautulliLibraryIndexCache.ts) < COLLECTION_CACHE_TTL) {
    return tautulliLibraryIndexCache.items;
  }

  try {
    const titleColumns = getSessionHistoryMetadataMovieTitleColumns('shm');
    const showTitleColumns = getSessionHistoryMetadataShowTitleColumns('shm');
    const guidColumns = getSessionHistoryMetadataGuidColumns('shm');
    const sectionFilter = hasTableColumn('session_history', 'section_id')
      ? `AND sh.section_id IN (
          SELECT section_id
          FROM library_sections
          WHERE is_active = 1 AND deleted_section = 0 AND section_type IN ('movie', 'show')
        )`
      : '';

    const movieRows = tautulliDb.prepare(`
      SELECT ${[...titleColumns, ...guidColumns].join(', ')},
             shm.year as year,
             'movie' as item_type
      FROM session_history_metadata shm
      JOIN session_history sh ON sh.id = shm.id
      WHERE sh.media_type = 'movie'
        ${sectionFilter}
      GROUP BY shm.rating_key
    `).all();

    const showRows = tautulliDb.prepare(`
      SELECT ${[...showTitleColumns, ...guidColumns].join(', ')},
             NULL as year,
             'show' as item_type
      FROM session_history_metadata shm
      JOIN session_history sh ON sh.id = shm.id
      WHERE sh.media_type = 'episode'
        ${sectionFilter}
      GROUP BY COALESCE(shm.grandparent_rating_key, shm.rating_key), COALESCE(shm.grandparent_title, shm.title)
    `).all();

    tautulliLibraryIndexCache.items = [...movieRows, ...showRows].map(row => ({
      type: row.item_type,
      year: row.year ?? null,
      titles: getRowTitleCandidates(row),
      ids: extractRowGuidIds(row)
    }));
    tautulliLibraryIndexCache.ts = now;
    return tautulliLibraryIndexCache.items;
  } catch (err) {
    log.warn(`Index Tautulli collections: ${err.message}`);
    return [];
  }
}

function getRowRatingKeys(row = {}, mediaType = 'movie') {
  if (mediaType === 'show') {
    return mergeIdSets(
      new Set([normalizeRatingKey(row.grandparent_rating_key)].filter(Boolean)),
      new Set([normalizeRatingKey(row.parent_rating_key)].filter(Boolean)),
      new Set([normalizeRatingKey(row.rating_key)].filter(Boolean))
    );
  }

  return mergeIdSets(
    new Set([normalizeRatingKey(row.rating_key)].filter(Boolean)),
    new Set([normalizeRatingKey(row.parent_rating_key)].filter(Boolean))
  );
}

function getSessionHistoryRatingKeyColumns(alias = 'sh') {
  const columns = [];
  if (hasTableColumn('session_history', 'rating_key')) columns.push(`${alias}.rating_key AS rating_key`);
  if (hasTableColumn('session_history', 'grandparent_rating_key')) columns.push(`${alias}.grandparent_rating_key AS grandparent_rating_key`);
  if (hasTableColumn('session_history', 'parent_rating_key')) columns.push(`${alias}.parent_rating_key AS parent_rating_key`);
  return columns;
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
  if (plexLibraryIndexCache.promise) {
    return plexLibraryIndexCache.promise;
  }
  if (plexLibraryIndexCache.failedAt && (now - plexLibraryIndexCache.failedAt) < 5 * 60 * 1000) {
    log.warn('Index Plex collections: derniere tentative en echec, nouvelle tentative differee');
    return null;
  }

  const plexUrl = String(getConfigValue('PLEX_URL', '') || '').trim();
  const plexToken = getPreferredPlexServerToken();
  if (!plexUrl || !plexToken) {
    log.warn('Index Plex collections: configuration Plex incomplete');
    return null;
  }

  plexLibraryIndexCache.promise = (async () => {
    try {
    const sectionsUrl = `${plexUrl}/library/sections?X-Plex-Token=${plexToken}`;
    const sectionsResp = await fetch(sectionsUrl, { headers: { Accept: 'application/json' } });
    if (!sectionsResp.ok) throw new Error(`sections HTTP ${sectionsResp.status}`);

    const sections = (await sectionsResp.json())?.MediaContainer?.Directory || [];
    const targetSections = sections.filter(section => section?.type === 'movie' || section?.type === 'show');
    const indexedItems = [];

    for (const section of targetSections) {
      const type = section.type === 'show' ? 2 : 1;
      let start = 0;
      const size = 200;

      while (true) {
        const url = new URL(`${plexUrl}/library/sections/${section.key}/all`);
        url.searchParams.set('type', String(type));
        url.searchParams.set('includeGuids', '1');
        url.searchParams.set('X-Plex-Container-Start', String(start));
        url.searchParams.set('X-Plex-Container-Size', String(size));
        url.searchParams.set('X-Plex-Token', plexToken);

        const resp = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
        if (!resp.ok) throw new Error(`section ${section.key} HTTP ${resp.status}`);

        const metadata = (await resp.json())?.MediaContainer?.Metadata || [];
        for (const entry of metadata) {
          const titleCandidates = plexEntryTitleCandidates(entry).map(value => String(value || '').trim()).filter(Boolean);
          const primaryTitle = titleCandidates[0];
          if (!primaryTitle) continue;
          const cacheKey = getPlexAvailabilityCacheKey({
            type: section.type === 'show' ? 'show' : 'movie',
            title: primaryTitle,
            year: entry?.year ?? null
          });
          indexedItems.push({
            cacheKey,
            type: section.type === 'show' ? 'show' : 'movie',
            title: primaryTitle,
            titles: titleCandidates,
            normalizedTitle: normalizeCollectionTitle(primaryTitle),
            year: entry?.year ?? null,
            ratingKey: normalizeRatingKey(entry?.ratingKey ?? entry?.rating_key),
            ids: extractPlexGuidIds(entry?.Guid || entry?.Guids || [])
          });
        }

        if (metadata.length < size) break;
        start += size;
      }
    }

    plexLibraryIndexCache.items = indexedItems;
    plexLibraryIndexCache.ts = now;
    plexLibraryIndexCache.failedAt = 0;
    log.info(`Index Plex collections: ${indexedItems.length} éléments référencés`);
    return indexedItems;
  } catch (err) {
    plexLibraryIndexCache.failedAt = now;
    log.warn(`Index Plex collections: ${err.message}`);
    return null;
  } finally {
    plexLibraryIndexCache.promise = null;
  }
  })();

  return plexLibraryIndexCache.promise;
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
  if (!plexUrl || !plexToken) return null;

  try {
    const index = await getPlexLibraryIndex();
    if (!index) return null;

    const itemIds = buildExternalIds(item?.ids || {});
    let available = false;

    if (itemIds.size > 0) {
      available = index.some(entry =>
        entry.type === item.type &&
        [...itemIds].some(id => entry.ids?.has(id))
      );
    }

    if (!available) {
      available = index.some(entry =>
        entry.type === item.type &&
        (entry.titles || [entry.title]).some(candidate =>
          collectionTitleMatches(candidate, item.title, entry.year, item.year)
        )
      );
    }

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
    const availability = await isItemAvailableInPlex(item);
    if (availability === null) return null;
    if (availability) {
      availableItems.push(item);
    }
  }
  return availableItems;
}

function resetCollectionCaches() {
  for (const key of Object.keys(traktListCache)) delete traktListCache[key];
  for (const key of Object.keys(plexAvailabilityCache)) delete plexAvailabilityCache[key];
  for (const key of Object.keys(traktListInflight)) delete traktListInflight[key];
  plexLibraryIndexCache.items = null;
  plexLibraryIndexCache.ts = 0;
  plexLibraryIndexCache.failedAt = 0;
  plexLibraryIndexCache.promise = null;
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

function isMovieWatchRowCompleted(row = {}) {
  const percent = Number(row.percent_complete);
  if (Number.isFinite(percent)) {
    return percent >= COLLECTION_MOVIE_MIN_PERCENT;
  }

  const watchedStatus = Number(row.watched_status);
  if (Number.isFinite(watchedStatus)) {
    if (watchedStatus === 1 || watchedStatus >= COLLECTION_MOVIE_MIN_PERCENT) return true;
    if (watchedStatus > 0 && watchedStatus < 1 && watchedStatus >= (COLLECTION_MOVIE_MIN_PERCENT / 100)) return true;
  }

  const duration = Number(row.duration);
  const watchedSeconds = Number(row.watched_seconds);
  const maxViewOffset = Number(row.max_view_offset);
  if (Number.isFinite(duration) && duration > 0) {
    const durationSeconds = duration > 100000 ? duration / 1000 : duration;
    const required = durationSeconds * (COLLECTION_MOVIE_MIN_PERCENT / 100);
    if (Number.isFinite(maxViewOffset) && maxViewOffset >= required) return true;
    if (Number.isFinite(watchedSeconds) && watchedSeconds >= required) return true;
  }

  return Number(row.last_stopped || 0) > Number(row.first_started || 0);
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

function getServerLibraryStats() {
  if (!tautulliDb) {
    return { available: false, reason: 'tautulli_not_ready' };
  }

  const sectionTypeExpr = hasTableColumn('library_sections', 'section_type')
    ? 'section_type'
    : (hasTableColumn('library_sections', 'section_kind') ? 'section_kind' : null);

  if (!sectionTypeExpr) {
    return { available: false, reason: 'library_sections_missing_section_type' };
  }

  const sectionNameExpr = hasTableColumn('library_sections', 'section_name')
    ? 'section_name'
    : (hasTableColumn('library_sections', 'name') ? 'name' : null);
  const countExpr = hasTableColumn('library_sections', 'count') ? 'count' : null;
  const childCountExpr = hasTableColumn('library_sections', 'child_count')
    ? 'child_count'
    : (hasTableColumn('library_sections', 'children_count') ? 'children_count' : null);

  const filters = ['1=1'];
  if (hasTableColumn('library_sections', 'is_active')) filters.push('is_active = 1');
  if (hasTableColumn('library_sections', 'deleted_section')) filters.push('deleted_section = 0');

  try {
    const rows = tautulliDb.prepare(`
      SELECT
        ${sectionTypeExpr} AS section_type,
        ${sectionNameExpr ? `COALESCE(${sectionNameExpr}, '')` : "''"} AS section_name,
        ${countExpr ? `COALESCE(${countExpr}, 0)` : '0'} AS count,
        ${childCountExpr ? `COALESCE(${childCountExpr}, 0)` : '0'} AS child_count
      FROM library_sections
      WHERE ${filters.join(' AND ')}
    `).all();

    if (!Array.isArray(rows) || rows.length === 0) {
      return { available: false, reason: 'no_library_sections' };
    }

    const AUDIOBOOK_KEYWORDS = ['audio', 'livre', 'audiobook', 'podcast'];
    const isAudiobook = name => AUDIOBOOK_KEYWORDS.some(keyword => String(name || '').toLowerCase().includes(keyword));

    let movies = 0;
    let shows = 0;
    let episodes = 0;
    let musicTracks = 0;
    let audiobookCount = 0;

    for (const row of rows) {
      const type = String(row.section_type || '').toLowerCase();
      const count = Number.parseInt(row.count, 10) || 0;
      const child = Number.parseInt(row.child_count, 10) || 0;

      if (type === 'movie') {
        movies += count;
      } else if (type === 'show') {
        shows += count;
        episodes += child;
      } else if (type === 'artist') {
        if (isAudiobook(row.section_name)) {
          audiobookCount += child || count;
        } else {
          musicTracks += child || count;
        }
      }
    }

    return { available: true, movies, shows, episodes, musicTracks, audiobookCount };
  } catch (err) {
    log.warn(`getServerLibraryStats: ${err.message}`);
    return { available: false, reason: err.message };
  }
}

function getHistorySyncRows(options = {}) {
  if (!tautulliDb) return [];

  const sinceTimestamp = Number(options.sinceTimestamp) || 0;
  const limit = Math.max(1, Number(options.limit) || 500);
  const offset = Math.max(0, Number(options.offset) || 0);

  const hasMetadataId = hasTableColumn('session_history_metadata', 'id');
  const titleCandidates = [];
  if (hasMetadataId && hasTableColumn('session_history_metadata', 'full_title')) titleCandidates.push('shm.full_title');
  if (hasMetadataId && hasTableColumn('session_history_metadata', 'title')) titleCandidates.push('shm.title');
  if (hasTableColumn('session_history', 'full_title')) titleCandidates.push('sh.full_title');
  if (hasTableColumn('session_history', 'title')) titleCandidates.push('sh.title');

  const titleExpr = titleCandidates.length
    ? `COALESCE(${titleCandidates.join(', ')}, 'Unknown')`
    : `'Unknown'`;
  const hasHistoryUserId = hasTableColumn('session_history', 'user_id');
  const hasHistoryUsername = hasTableColumn('session_history', 'user');
  const ratingKeyExpr = hasTableColumn('session_history', 'rating_key')
    ? 'COALESCE(sh.rating_key, 0)'
    : (hasMetadataId && hasTableColumn('session_history_metadata', 'rating_key') ? 'COALESCE(shm.rating_key, 0)' : '0');
  const watchedStatusExpr = hasTableColumn('session_history', 'watched_status')
    ? 'COALESCE(sh.watched_status, 0)'
    : (hasTableColumn('session_history', 'percent_complete') ? 'COALESCE(sh.percent_complete, 0) / 100.0' : '0');
  const durationExpr = hasTableColumn('session_history', 'play_duration')
    ? `COALESCE(sh.play_duration, CASE WHEN COALESCE(sh.stopped, 0) > COALESCE(sh.started, 0) THEN (sh.stopped - sh.started) ELSE 0 END)`
    : `CASE WHEN COALESCE(sh.stopped, 0) > COALESCE(sh.started, 0) THEN (sh.stopped - sh.started) ELSE 0 END`;
  const timestampExpr = hasTableColumn('session_history', 'stopped')
    ? 'COALESCE(NULLIF(sh.stopped, 0), sh.started, 0)'
    : 'COALESCE(sh.started, 0)';
  const userIdExpr = hasHistoryUserId ? 'COALESCE(sh.user_id, u.user_id, 0)' : 'COALESCE(u.user_id, 0)';
  const usernameExpr = hasHistoryUsername
    ? "LOWER(COALESCE(u.username, sh.user, 'unknown'))"
    : "LOWER(COALESCE(u.username, 'unknown'))";

  const whereClauses = ['COALESCE(sh.started, 0) > 0'];
  if (hasTableColumn('session_history', 'stopped')) {
    whereClauses.push('COALESCE(sh.stopped, 0) > COALESCE(sh.started, 0)');
  }
  if (sinceTimestamp > 0) {
    whereClauses.push(`${timestampExpr} > ?`);
  }

  const params = [];
  if (sinceTimestamp > 0) params.push(sinceTimestamp);
  params.push(limit, offset);

  try {
    return tautulliDb.prepare(`
      SELECT
        ${userIdExpr} AS user_id,
        ${usernameExpr} AS username,
        COALESCE(sh.media_type, 'unknown') AS media_type,
        ${titleExpr} AS full_title,
        ${durationExpr} AS play_duration,
        ${timestampExpr} AS date,
        ${watchedStatusExpr} AS watched_status,
        ${ratingKeyExpr} AS rating_key
      FROM session_history sh
      LEFT JOIN users u ON ${hasHistoryUserId ? 'u.user_id = sh.user_id' : '1 = 0'}
      ${hasMetadataId ? 'LEFT JOIN session_history_metadata shm ON shm.id = sh.id' : ''}
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY ${timestampExpr} ASC
      LIMIT ? OFFSET ?
    `).all(...params);
  } catch (err) {
    log.warn(`getHistorySyncRows: ${err.message}`);
    return [];
  }
}

function getTautulliUserInfoFromDb(username) {
  if (!tautulliDb || !hasTableColumn('users', 'username')) return null;

  try {
    return tautulliDb.prepare(`
      SELECT *
      FROM users
      WHERE LOWER(username) = ?
      LIMIT 1
    `).get(String(username || '').toLowerCase().trim()) || null;
  } catch (err) {
    log.warn(`getTautulliUserInfoFromDb: ${err.message}`);
    return null;
  }
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
    const stableUserClause = `sh.user_id IN (SELECT u.user_id FROM users u WHERE LOWER(u.username) = ?)`;
    
    // 🎯 Requête SQL optimisée - agrégation directe
    // Tautulli stocke les historiques dans la table `session_history`
    // Durée = (stopped - started) en secondes
    const stmt = tautulliDb.prepare(`
      SELECT 
        u.user_id,
        u.username,
        COUNT(sh.id) as session_count,
        SUM(CAST((sh.stopped - sh.started) AS INTEGER)) as total_duration_seconds,
        MAX(sh.stopped) as last_session_timestamp,
        SUM(CASE WHEN sh.media_type = 'movie' THEN 1 ELSE 0 END) as movie_count,
        SUM(CASE WHEN sh.media_type = 'movie' THEN CAST((sh.stopped - sh.started) AS INTEGER) ELSE 0 END) as movie_duration_seconds,
        SUM(CASE WHEN sh.media_type = 'episode' THEN 1 ELSE 0 END) as episode_count,
        SUM(CASE WHEN sh.media_type = 'episode' THEN CAST((sh.stopped - sh.started) AS INTEGER) ELSE 0 END) as episode_duration_seconds,
        SUM(CASE WHEN sh.media_type = 'track' THEN 1 ELSE 0 END) as music_count,
        SUM(CASE WHEN sh.media_type = 'track' THEN CAST((sh.stopped - sh.started) AS INTEGER) ELSE 0 END) as music_duration_seconds
      FROM session_history sh
      JOIN users u ON u.user_id = sh.user_id
      WHERE ${stableUserClause}
      GROUP BY sh.user_id
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
      videoSessionCount: (stats.movie_count || 0) + (stats.episode_count || 0),
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
        COUNT(sh.id) as session_count,
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
    const stableUserClause = `sh.user_id IN (SELECT u.user_id FROM users u WHERE LOWER(u.username) = ?)`;
    // Début du mois courant en timestamp Unix
    const stmt = tautulliDb.prepare(`
      SELECT SUM(CAST((sh.stopped - sh.started) AS INTEGER)) as monthly_seconds
      FROM session_history sh
      WHERE ${stableUserClause}
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
    const stableUserClause = `sh.user_id IN (SELECT u.user_id FROM users u WHERE LOWER(u.username) = ?)`;
    // Nuit : 22h-6h (heure locale)
    const nightStmt = tautulliDb.prepare(`
      SELECT COUNT(*) as cnt
      FROM session_history sh
      WHERE ${stableUserClause}
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
      WHERE ${stableUserClause}
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
    const d1095 = joinMs + 1095 * 86400000;
    const d1460 = joinMs + 1460 * 86400000;
    const d1825 = joinMs + 1825 * 86400000;
    const d3650 = joinMs + 3650 * 86400000;
    if (now >= d365)  dates['first-anniversary'] = fmtMs(d365);
    if (now >= d730)  dates['veteran']           = fmtMs(d730);
    if (now >= d1095) dates['trusted-regular']   = fmtMs(d1095);
    if (now >= d1460) dates['server-pillar']     = fmtMs(d1460);
    if (now >= d1825) dates['old-timer']          = fmtMs(d1825);
    if (now >= d3650) dates['decade-legend']      = fmtMs(d3650);
  }

  if (!tautulliDb) return dates;

  try {
    const norm = username.toLowerCase();
    const stableUserClause = `sh.user_id IN (SELECT u.user_id FROM users u WHERE LOWER(u.username) = ?)`;

    // Helper : date de la Nème session (tous types)
    const nthSession = (n, mediaType = null) => {
      try {
        const typeCond = mediaType ? `AND sh.media_type = '${mediaType}'` : '';
        const stmt = tautulliDb.prepare(`
          SELECT sh.started
          FROM session_history sh
          WHERE ${stableUserClause} AND sh.stopped > sh.started ${typeCond}
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
            WHERE ${stableUserClause} AND sh.stopped > sh.started
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
          WHERE ${stableUserClause} AND sh.stopped > sh.started AND ${whereCond}
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
          WHERE ${stableUserClause} AND sh.stopped > sh.started
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
  const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

  const norm = username.toLowerCase();
  const fmt  = (ts) => ts ? new Date(ts * 1000).toLocaleDateString('fr-FR') : null;
  const today = new Date().toLocaleDateString('fr-FR');

  // Préférer le filtrage par user_id numérique (stable même si le username change)
  // car un même utilisateur Plex peut apparaître sous plusieurs noms dans Tautulli
  const userFilter = plexUserId
    ? { clause: 'sh.user_id = ?', param: plexUserId }
    : { clause: 'LOWER(sh.user) = ?', param: norm };
  const mappingCache = new Map();

  const getAchievementMappings = (achievementId) => {
    if (mappingCache.has(achievementId)) return mappingCache.get(achievementId);
    try {
      const mappings = CollectionItemMappingQueries.getForAchievement(achievementId);
      mappingCache.set(achievementId, mappings);
      return mappings;
    } catch (err) {
      log.warn(`Collection mappings ${achievementId}: ${err.message}`);
      const empty = new Map();
      mappingCache.set(achievementId, empty);
      return empty;
    }
  };

  const getItemMapping = (achievementId, item) => {
    const mappings = getAchievementMappings(achievementId);
    return mappings.get(`${item.type}:${getTraktItemKey(item)}`) || null;
  };

  const saveItemMapping = (achievementId, item, mediaType, row) => {
    const traktKey = getTraktItemKey(item);
    const matchedTitle = row.raw_title || row.original_title || row.full_title || row.sort_title || item.title || null;
    const matchedYear = row.year ?? item.year ?? null;
    const matchedGuid = mediaType === 'show'
      ? String(row.grandparent_guid || row.grandparent_guids || row.guid || row.guids || '').trim()
      : String(row.guid || row.guids || row.parent_guid || row.parent_guids || '').trim();

    try {
      CollectionItemMappingQueries.upsert({
        achievementId,
        mediaType,
        traktKey,
        traktTitle: item.title || null,
        traktYear: item.year ?? null,
        matchedTitle,
        matchedYear,
        matchedGuid: matchedGuid || null
      });
      getAchievementMappings(achievementId).set(`${mediaType}:${traktKey}`, {
        achievement_id: achievementId,
        media_type: mediaType,
        trakt_key: traktKey,
        trakt_title: item.title || null,
        trakt_year: item.year ?? null,
        matched_title: matchedTitle,
        matched_year: matchedYear,
        matched_guid: matchedGuid || null
      });
    } catch (err) {
      log.warn(`Collection mapping save ${achievementId}: ${err.message}`);
    }
  };
  /**
   * Compte les films regardés par l'utilisateur via une liste de {title, year}.
   * Le matching par titre+année est robuste aux re-scans Plex qui changent les GUIDs.
   */
  const countMoviesByTitleYear = (achievementId, movies) => {
    if (!movies || !movies.length) return { cnt: 0, last_stopped: null, matchedItems: [], unmatchedItems: [] };
    try {
      const movieTitleColumns = getSessionHistoryMetadataMovieTitleColumns('shm');
      const movieGuidColumns = getSessionHistoryMetadataGuidColumns('shm');
      const movieRatingKeyColumns = getSessionHistoryRatingKeyColumns('sh');
      const aggregateColumns = [
        hasTableColumn('session_history', 'percent_complete') ? 'MAX(sh.percent_complete) as percent_complete' : null,
        hasTableColumn('session_history', 'watched_status') ? 'MAX(sh.watched_status) as watched_status' : null,
        hasTableColumn('session_history', 'view_offset') ? 'MAX(sh.view_offset) as max_view_offset' : null,
        hasTableColumn('session_history_metadata', 'duration') ? 'MAX(shm.duration) as duration' : null,
        'SUM(CASE WHEN sh.stopped > sh.started THEN (sh.stopped - sh.started) ELSE 0 END) as watched_seconds',
        'MAX(sh.stopped) as last_stopped',
        'MIN(sh.started) as first_started'
      ].filter(Boolean);
      const watchedRows = tautulliDb.prepare(`
        SELECT ${[...movieTitleColumns, ...movieGuidColumns, ...movieRatingKeyColumns, ...aggregateColumns].join(', ')},
               shm.year as year
        FROM session_history sh
        JOIN session_history_metadata shm ON sh.id = shm.id
        WHERE ${userFilter.clause}
          AND sh.stopped > sh.started
          AND sh.media_type = 'movie'
        GROUP BY ${hasTableColumn('session_history_metadata', 'title') ? 'shm.title' : 'shm.id'}, shm.year
      `).all(userFilter.param);

      const preparedMovies = movies.map(movie => {
        const mapping = getItemMapping(achievementId, movie);
        const mappedTitle = String(mapping?.matched_title || '').trim();
        const mappedGuidIds = extractIdsFromRawGuidValue(mapping?.matched_guid);
        return {
          movie,
          movieTitles: [mappedTitle, movie.plexTitle, movie.title].filter(Boolean),
          movieIds: mergeIdSets(buildExternalIds(movie.ids || {}), mappedGuidIds)
        };
      });

      let cnt = 0;
      let lastStopped = 0;
      const matchedItems = [];
      const unmatchedItems = [];
      for (const preparedMovie of preparedMovies) {
        const matched = watchedRows.find(row =>
          (
            preparedMovie.movieIds.size > 0 &&
            (
              [...preparedMovie.movieIds].some(id =>
                mergeIdSets(
                  extractIdsFromRawGuidValue(row.guid),
                  extractIdsFromRawGuidValue(row.guids),
                  extractIdsFromRawGuidValue(row.parent_guid),
                  extractIdsFromRawGuidValue(row.parent_guids),
                  extractIdsFromRawGuidValue(row.grandparent_guid),
                  extractIdsFromRawGuidValue(row.grandparent_guids)
                ).has(id)
              )
            )
          ) || [row.raw_title, row.original_title, row.full_title, row.sort_title]
            .filter(Boolean)
            .some(candidate => preparedMovie.movieTitles.some(movieTitle =>
              collectionTitleMatches(candidate, movieTitle, row.year, preparedMovie.movie.year)
            ))
        );
        if (matched && isMovieWatchRowCompleted(matched)) {
          cnt += 1;
          lastStopped = Math.max(lastStopped, Number(matched.last_stopped || 0));
          matchedItems.push(preparedMovie.movie.title);
          saveItemMapping(achievementId, preparedMovie.movie, 'movie', matched);
        } else {
          unmatchedItems.push(preparedMovie.movie.title);
        }
      }
      return { cnt, last_stopped: lastStopped || null, matchedItems, unmatchedItems };
    } catch(e) {
      log.warn('countMoviesByTitleYear:', e.message);
      return { cnt: 0, last_stopped: null, matchedItems: [], unmatchedItems: movies.map(movie => movie.title).filter(Boolean) };
    }
  };

  /**
   * Compte les séries regardées par l'utilisateur via leurs titres (grandparent_title).
   * La règle est "au moins un épisode vu" par série.
   */
  const countShowsByTitle = (achievementId, shows) => {
    if (!shows || !shows.length) return { cnt: 0, last_stopped: null, matchedItems: [], unmatchedItems: [] };
    try {
      const showTitleColumns = getSessionHistoryMetadataShowTitleColumns('shm');
      const showGuidColumns = getSessionHistoryMetadataGuidColumns('shm');
      const showRatingKeyColumns = getSessionHistoryRatingKeyColumns('sh');
      const watchedRows = tautulliDb.prepare(`
        SELECT ${[...showTitleColumns, ...showGuidColumns, ...showRatingKeyColumns].join(', ')},
               MAX(sh.stopped) as last_stopped
        FROM session_history sh
        JOIN session_history_metadata shm ON sh.id = shm.id
        WHERE ${userFilter.clause}
          AND sh.stopped > sh.started
          AND sh.media_type = 'episode'
        GROUP BY ${hasTableColumn('session_history_metadata', 'grandparent_title') ? 'shm.grandparent_title' : 'shm.id'}
      `).all(userFilter.param);

      const preparedShows = shows.map(show => {
        const mapping = getItemMapping(achievementId, show);
        const mappedTitle = String(mapping?.matched_title || '').trim();
        const mappedGuidIds = extractIdsFromRawGuidValue(mapping?.matched_guid);
        return {
          show,
          showTitles: [mappedTitle, show.plexTitle, show.title].filter(Boolean),
          showIds: mergeIdSets(buildExternalIds(show.ids || {}), mappedGuidIds)
        };
      });

      let cnt = 0;
      let lastStopped = 0;
      const matchedItems = [];
      const unmatchedItems = [];
      for (const preparedShow of preparedShows) {
        const matched = watchedRows.find(row =>
          (
            preparedShow.showIds.size > 0 &&
            (
              [...preparedShow.showIds].some(id =>
                mergeIdSets(
                  extractIdsFromRawGuidValue(row.guid),
                  extractIdsFromRawGuidValue(row.guids),
                  extractIdsFromRawGuidValue(row.parent_guid),
                  extractIdsFromRawGuidValue(row.parent_guids),
                  extractIdsFromRawGuidValue(row.grandparent_guid),
                  extractIdsFromRawGuidValue(row.grandparent_guids)
                ).has(id)
              )
            )
          ) || [row.raw_title, row.original_title, row.full_title, row.sort_title]
            .filter(Boolean)
            .some(candidate => preparedShow.showTitles.some(showTitle =>
              collectionTitleMatches(candidate, showTitle)
            ))
        );
        if (matched) {
          cnt += 1;
          lastStopped = Math.max(lastStopped, Number(matched.last_stopped || 0));
          matchedItems.push(preparedShow.show.title);
          saveItemMapping(achievementId, preparedShow.show, 'show', matched);
        } else {
          unmatchedItems.push(preparedShow.show.title);
        }
      }
      return { cnt, last_stopped: lastStopped || null, matchedItems, unmatchedItems };
    } catch(e) {
      log.warn('countShowsByTitle:', e.message);
      return { cnt: 0, last_stopped: null, matchedItems: [], unmatchedItems: shows.map(show => show.title).filter(Boolean) };
    }
  };

  /**
   * Évalue un succès de type "toute la collection regardée".
   * Source unique : liste Trakt.
   */
  const checkCollection = async (id, requiredCount = null) => {
    const traktItems = await getTraktListItems(id);
    if (traktItems && traktItems.length > 0) {
      const traktMovies = traktItems.filter(item => item.type === 'movie');
      if (traktMovies.length > 0) {
        const row = countMoviesByTitleYear(id, traktMovies);
        const required = requiredCount ?? traktMovies.length;
        const current = Math.min(row.cnt, required);
        log.debug(`${id} (trakt films): ${current}/${required}`);
        const details = {
          matchedMovies: row.matchedItems || [],
          unmatchedMovies: row.unmatchedItems || []
        };
        log.debug(`${id} detail: films vus [${details.matchedMovies.join(' | ')}]`);
        log.debug(`${id} detail: films manquants [${details.unmatchedMovies.join(' | ')}]`);
        if (current >= required) return { date: fmt(row.last_stopped) || today, current, total: required, details };
        return { date: null, current, total: required, details };
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

    if (movieItems.length > 0) movieRow = countMoviesByTitleYear(id, movieItems);

    if (showItems.length > 0) {
      showRow = countShowsByTitle(id, showItems);
    }

    const currentMovies = Math.min(movieRow.cnt || 0, requiredMovies);
    const currentShows = Math.min(showRow.cnt || 0, requiredShows);
    const totalCurrent = currentMovies + currentShows;
    const totalRequired = requiredMovies + requiredShows;
    const maxStopped = Math.max(movieRow.last_stopped || 0, showRow.last_stopped || 0);

    log.debug(`${id} (mixte): films ${currentMovies}/${requiredMovies}, séries ${currentShows}/${requiredShows}`);
    log.debug(`${id} detail: films vus [${(movieRow.matchedItems || []).join(' | ')}]`);
    log.debug(`${id} detail: films manquants [${(movieRow.unmatchedItems || []).join(' | ')}]`);
    if (showItems.length > 0) {
      log.debug(`${id} detail: series vues [${(showRow.matchedItems || []).join(' | ')}]`);
      log.debug(`${id} detail: series manquantes [${(showRow.unmatchedItems || []).join(' | ')}]`);
    }

    if (totalRequired > 0 && currentMovies >= requiredMovies && currentShows >= requiredShows) {
      return {
        date: fmt(maxStopped) || today,
        current: totalCurrent,
        total: totalRequired,
        details: {
          matchedMovies: movieRow.matchedItems || [],
          unmatchedMovies: movieRow.unmatchedItems || [],
          matchedShows: showRow.matchedItems || [],
          unmatchedShows: showRow.unmatchedItems || []
        }
      };
    }
    return {
      date: null,
      current: totalCurrent,
      total: totalRequired,
      details: {
        matchedMovies: movieRow.matchedItems || [],
        unmatchedMovies: movieRow.unmatchedItems || [],
        matchedShows: showRow.matchedItems || [],
        unmatchedShows: showRow.unmatchedItems || []
      }
    };
  };

  log.debug(`Évaluation secrets pour ${norm}: [${toCheckIds.join(', ')}]`);

  try {
    for (const id of toCheckIds) {
      await yieldToEventLoop();
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

        // 🦸 Marvel Fan — Films + séries de la collection Marvel
        case 'marvel-fan': {
          const r = await checkMixedCollection(id);
          if (r.date) results[id] = r.date;
          if (r.total > 0) progress[id] = { current: r.current, total: r.total };
          break;
        }

        // 🧑‍⚖️ Maître Jedi — Collection Star Wars disponible localement
        case 'black-knight': {
          const r = await checkCollection(id);
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

        // 🖖 Star Trek Universe — Films + séries de la collection
        case 'star-trek-universe': {
          const r = await checkMixedCollection(id);
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
            progress[id] = { current: r ? 1 : 0, total: 1 };
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
            const bestWeekend = tautulliDb.prepare(`
              SELECT MAX(weekend_hours) as max_hours
              FROM (
                SELECT SUM(CAST(sh.stopped - sh.started AS REAL) / 3600) as weekend_hours
                FROM session_history sh
                WHERE ${userFilter.clause} AND sh.stopped > sh.started
                  AND CAST(strftime('%w', datetime(sh.started, 'unixepoch', 'localtime')) AS INTEGER) IN (0, 6)
                GROUP BY strftime('%Y-%W', datetime(sh.started, 'unixepoch', 'localtime'))
              ) w
            `).get(userFilter.param);
            const current = Math.min(Math.round(Number(bestWeekend?.max_hours || 0) * 10) / 10, 20);
            progress[id] = { current, total: 20 };
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
            progress[id] = { current: r ? 1 : 0, total: 1 };
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
    const stableUserClause = `sh.user_id IN (SELECT u.user_id FROM users u WHERE LOWER(u.username) = ?)`;
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
      FROM session_history sh
      JOIN session_history_metadata shm ON sh.id = shm.id
      WHERE ${stableUserClause}
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
  const stableUserClause = `sh.user_id IN (SELECT u.user_id FROM users u WHERE LOWER(u.username) = ?)`;
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
      FROM session_history sh
      JOIN session_history_metadata shm ON sh.id = shm.id
      WHERE ${stableUserClause}
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
        FROM session_history sh
        WHERE ${stableUserClause}
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
        FROM session_history sh
        WHERE ${stableUserClause}
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
      FROM session_history sh
      WHERE ${stableUserClause} AND sh.stopped > sh.started
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
      FROM session_history sh
      JOIN session_history_metadata shm ON sh.id = shm.id
      WHERE ${stableUserClause} AND sh.stopped > sh.started
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
      FROM session_history sh
      JOIN session_history_metadata shm ON sh.id = shm.id
      WHERE ${stableUserClause} AND sh.stopped > sh.started
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
        FROM session_history sh
        JOIN session_history_media_info shm ON sh.id = shm.id
        WHERE ${stableUserClause}
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
          FROM session_history sh
          JOIN session_history_media_info shm ON sh.id = shm.id
          WHERE ${stableUserClause}
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
          FROM session_history sh
          WHERE ${stableUserClause}
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
      FROM session_history sh
      WHERE ${stableUserClause} AND sh.stopped > sh.started
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
      FROM session_history sh
      WHERE ${stableUserClause} AND sh.stopped > sh.started
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
      FROM session_history sh
      WHERE ${stableUserClause} AND sh.stopped > sh.started
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
      FROM session_history sh
      WHERE ${stableUserClause} AND sh.stopped > sh.started
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
  getServerLibraryStats,
  getHistorySyncRows,
  getTautulliUserInfoFromDb,
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
  resetCollectionCaches,
  closeTautulliDatabase
};

