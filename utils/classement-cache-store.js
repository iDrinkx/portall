const fs = require('fs');
const path = require('path');
const { DB_PATH } = require('./database');
const log = require('./logger').create('[Classement-Cache]');

const CLASSEMENT_CACHE_PATH = path.join(path.dirname(DB_PATH), 'classement-cache.json');

function normalizeClassementCache(cache) {
  if (!cache || typeof cache !== 'object') {
    return {
      data: { byHours: [], byLevel: [] },
      timestamp: null,
      lastRefresh: null
    };
  }

  const byHours = Array.isArray(cache?.data?.byHours) ? cache.data.byHours : [];
  const byLevel = Array.isArray(cache?.data?.byLevel) ? cache.data.byLevel : [];

  return {
    ...cache,
    data: { byHours, byLevel },
    timestamp: cache.timestamp || null,
    lastRefresh: cache.lastRefresh || null
  };
}

function loadClassementCacheFromDisk() {
  try {
    if (!fs.existsSync(CLASSEMENT_CACHE_PATH)) {
      return normalizeClassementCache(null);
    }

    const raw = fs.readFileSync(CLASSEMENT_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const normalized = normalizeClassementCache(parsed);
    if (normalized.data.byLevel.length > 0) {
      log.info(`Cache classement charge depuis le disque (${normalized.data.byLevel.length} users)`);
    }
    return normalized;
  } catch (err) {
    log.warn(`Lecture cache classement impossible: ${err.message}`);
    return normalizeClassementCache(null);
  }
}

function saveClassementCacheToDisk(cache) {
  try {
    const normalized = normalizeClassementCache(cache);
    fs.mkdirSync(path.dirname(CLASSEMENT_CACHE_PATH), { recursive: true });
    const tempPath = `${CLASSEMENT_CACHE_PATH}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2), 'utf8');
    fs.renameSync(tempPath, CLASSEMENT_CACHE_PATH);
  } catch (err) {
    log.warn(`Ecriture cache classement impossible: ${err.message}`);
  }
}

function clearClassementCacheOnDisk() {
  try {
    if (fs.existsSync(CLASSEMENT_CACHE_PATH)) {
      fs.unlinkSync(CLASSEMENT_CACHE_PATH);
    }
  } catch (err) {
    log.warn(`Suppression cache classement impossible: ${err.message}`);
  }
}

module.exports = {
  CLASSEMENT_CACHE_PATH,
  loadClassementCacheFromDisk,
  saveClassementCacheToDisk,
  clearClassementCacheOnDisk,
  normalizeClassementCache
};
