const cron = require('node-cron');
const path = require('path');
const { fork } = require('child_process');
const log = require('./logger');
const { UserQueries } = require('./database');
const { XP_SYSTEM } = require('./xp-system');
const {
  getAllUserStatsFromTautulli,
  isTautulliReady
} = require('./tautulli-direct');
const { getConfigValue } = require('./config');
const { buildClassementSnapshot } = require('./classement-refresh-build');
const {
  loadClassementCacheFromDisk,
  saveClassementCacheToDisk,
  clearClassementCacheOnDisk
} = require('./classement-cache-store');

const logCR = log.create('[Classement-Refresh]');
const CLASSEMENT_REFRESH_CRON = '10 * * * *';
const CLASSEMENT_WORKER_TIMEOUT_MS = 15 * 60 * 1000;

let classementCache = loadClassementCacheFromDisk();
let classementRefreshInFlight = null;
let lastValidCache = classementCache?.data?.byLevel?.length > 0
  ? {
      data: {
        byHours: [...classementCache.data.byHours],
        byLevel: [...classementCache.data.byLevel]
      }
    }
  : null;
let corruptionCount = 0;

function buildClassementUsersFromDb(dbUsers = []) {
  return dbUsers.map((u) => ({
    username: u.username,
    plexUserId: null,
    email: u.email || null,
    joinedAtTimestamp: u.joinedAt ? Number(u.joinedAt) : null
  }));
}

function buildClassementUsersFromTautulli() {
  const tautulliUsers = getAllUserStatsFromTautulli() || [];
  const seen = new Set();
  const results = [];

  for (const user of tautulliUsers) {
    const username = String(user?.username || '').trim();
    if (!username) continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      UserQueries.upsert(username, null, null, null);
    } catch (_) {}

    results.push({
      username,
      plexUserId: user.userId || null,
      email: null,
      joinedAtTimestamp: null
    });
  }

  return results;
}

function chooseBestClassementFallbackUsers() {
  const dbUsers = buildClassementUsersFromDb(UserQueries.getAll() || []);
  const tautulliUsers = buildClassementUsersFromTautulli();

  if (tautulliUsers.length > dbUsers.length) {
    return {
      source: 'tautulli',
      users: tautulliUsers,
      dbCount: dbUsers.length,
      tautulliCount: tautulliUsers.length
    };
  }

  if (dbUsers.length > 0) {
    return {
      source: 'db',
      users: dbUsers,
      dbCount: dbUsers.length,
      tautulliCount: tautulliUsers.length
    };
  }

  return {
    source: 'tautulli',
    users: tautulliUsers,
    dbCount: dbUsers.length,
    tautulliCount: tautulliUsers.length
  };
}

function validateCacheData(users) {
  const issues = [];

  const noPhotoCount = users.filter((u) => !u.thumb).length;
  if (noPhotoCount > users.length * 0.5) {
    issues.push(`⚠️ ${noPhotoCount}/${users.length} users sans photo (${Math.round((noPhotoCount / users.length) * 100)}%)`);
  }

  const topUsers = users.slice(0, 3);
  topUsers.forEach((user) => {
    const expectedLevel = XP_SYSTEM.getLevel(user.totalXp);
    if (expectedLevel !== user.level) {
      issues.push(`⚠️ ${user.username}: level incohérent (level=${user.level}, XP=${user.totalXp} → level ${expectedLevel})`);
    }
  });

  if (lastValidCache && lastValidCache.data.byLevel.length > 0) {
    const topUserPrev = lastValidCache.data.byLevel[0];
    const topUserNow = users.find((u) => u.username === topUserPrev.username);

    if (topUserNow && topUserNow.level < topUserPrev.level - 5) {
      issues.push(`⚠️ Niveau du top user a baissé drastiquement (${topUserPrev.level} → ${topUserNow.level})`);
    }
  }

  const hasPlexToken = String(getConfigValue('PLEX_TOKEN', '') || '').trim().length > 0;
  if (hasPlexToken && noPhotoCount === users.length) {
    issues.push('⚠️ Aucune photo Plex trouvée (Plex API probablement inaccessible)');
  }

  return issues;
}

function buildCachePayloadFromUsers(users) {
  const byHours = [...users].sort((a, b) => b.totalHours - a.totalHours);
  const byLevel = [...users].sort((a, b) => b.level - a.level || b.totalXp - a.totalXp);

  return {
    data: { byHours, byLevel },
    timestamp: Date.now(),
    lastRefresh: new Date().toISOString()
  };
}

function applyRefreshedUsers(users, durationMs = null) {
  const issues = validateCacheData(users);

  if (issues.length > 0) {
    logCR.warn('⚠️ Problèmes détectés dans les données calculées:');
    issues.forEach((issue) => logCR.warn(`   ${issue}`));
    corruptionCount++;

    const hasOnlyPhotoIssues = issues.every((i) =>
      i.includes('sans photo') || i.includes('Aucune photo Plex trouvée')
    );
    if (hasOnlyPhotoIssues) {
      logCR.warn('ℹ️ Absence de photos Plex détectée - le classement continue sans avatars');
    }

    const hasCriticalIssue = issues.some((i) => i.includes('incohérent'));
    if (hasCriticalIssue) {
      logCR.warn('🚨 Problème critique détecté - rejet des données');
      if (lastValidCache && lastValidCache.data.byLevel.length > 0) {
        classementCache = {
          ...lastValidCache,
          timestamp: Date.now(),
          lastRefresh: new Date().toISOString()
        };
        saveClassementCacheToDisk(classementCache);
        logCR.info(`✅ Cache restauré${durationMs !== null ? ` en ${durationMs}ms` : ''}`);
        return classementCache;
      }
      logCR.warn('⚠️ Pas de cache précédent - attente prochain calcul');
      return classementCache;
    }

    if (corruptionCount >= 2 && lastValidCache) {
      logCR.warn(`🔄 Corruption répétée (${corruptionCount}x), utilisation du cache précédent`);
      classementCache = {
        ...lastValidCache,
        timestamp: Date.now(),
        lastRefresh: new Date().toISOString()
      };
      saveClassementCacheToDisk(classementCache);
      logCR.info(`✅ Cache restauré${durationMs !== null ? ` en ${durationMs}ms` : ''}`);
      return classementCache;
    }
  } else {
    corruptionCount = 0;
  }

  classementCache = buildCachePayloadFromUsers(users);
  lastValidCache = {
    data: {
      byHours: [...classementCache.data.byHours],
      byLevel: [...classementCache.data.byLevel]
    }
  };
  saveClassementCacheToDisk(classementCache);
  logCR.debug(`✅ Classement refreshé${durationMs !== null ? ` en ${durationMs}ms` : ''} (${users.length} users)`);
  return classementCache;
}

function runRefreshInWorker(options = {}) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'classement-refresh-worker.js');
    const worker = fork(workerPath, [JSON.stringify(options || {})], { silent: false });
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (worker.connected) {
        try {
          worker.disconnect();
        } catch (_) {}
      }
      if (err) reject(err);
      else resolve(result);
    };

    const timeout = setTimeout(() => {
      try {
        worker.kill();
      } catch (_) {}
      finish(new Error('Timeout worker refresh classement'));
    }, CLASSEMENT_WORKER_TIMEOUT_MS);
    if (typeof timeout.unref === 'function') timeout.unref();

    worker.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'result') {
        finish(null, message.result);
      } else if (message.type === 'error') {
        finish(new Error(message.error || 'Erreur worker inconnue'));
      }
    });

    worker.on('error', (err) => finish(err));
    worker.on('exit', (code) => {
      if (settled) return;
      finish(new Error(`Worker refresh classement quitté avec code ${code}`));
    });
  });
}

async function refreshClassementCache(options = {}) {
  const normalizedOptions = {
    ...options,
    includeSecretEvaluation: options.includeSecretEvaluation === true
  };

  if (classementRefreshInFlight) {
    logCR.debug('⏳ Refresh classement déjà en cours - requête fusionnée');
    return classementRefreshInFlight;
  }

  classementRefreshInFlight = (async () => {
    try {
      logCR.debug('🔄 Refresh classement en cours...');

      const runInWorker = normalizedOptions.useWorker !== false;
      const result = runInWorker
        ? await runRefreshInWorker(normalizedOptions)
        : await buildClassementSnapshot(normalizedOptions);

      if (!result || result.skipped) {
        const reason = result?.reason || 'unknown';
        if (reason === 'tautulli_not_ready' && !isTautulliReady()) {
          logCR.warn('Tautulli pas prêt, skip refresh');
        } else if (reason === 'no_users') {
          logCR.warn('Aucun user trouvé pour le refresh classement');
        } else {
          logCR.warn(`Refresh classement ignoré: ${reason}`);
        }
        return classementCache;
      }

      return applyRefreshedUsers(result.users || [], result.durationMs || null);
    } catch (err) {
      logCR.error(`Error refreshing classement: ${err.message}`);
      return classementCache;
    } finally {
      classementRefreshInFlight = null;
    }
  })();

  return classementRefreshInFlight;
}

async function resetClassementCache() {
  logCR.warn('🔄 Réinitialisation forcée du cache classement...');
  classementCache = {
    data: { byHours: [], byLevel: [] },
    timestamp: null,
    lastRefresh: null
  };
  lastValidCache = null;
  corruptionCount = 0;
  clearClassementCacheOnDisk();

  await refreshClassementCache({ includeSecretEvaluation: true });
  logCR.info('✅ Cache réinitialisé et recalculé');
}

function getClassementCache() {
  return classementCache;
}

function healthCheckAndRepair() {
  try {
    logCR.debug('🔧 Vérification intégrité au démarrage...');

    const allUsers = UserQueries.getAll();
    if (!allUsers || allUsers.length === 0) {
      logCR.debug('✅ Aucun utilisateur en DB, vérification OK');
      return;
    }

    const usersWithoutJoinedAt = allUsers.filter((u) => !u.joinedAt).length;
    const percentMissing = (usersWithoutJoinedAt / allUsers.length) * 100;
    const hasPlexToken = String(getConfigValue('PLEX_TOKEN', '') || '').trim().length > 0;

    if (percentMissing > 30) {
      if (hasPlexToken) {
        logCR.info(`ℹ️ ${percentMissing.toFixed(1)}% des users sans joinedAt en DB — Plex servira de source au refresh`);
        logCR.info('   🔄 Backfill automatique des dates Plex vers la DB en cours de refresh');
      } else {
        logCR.warn(`⚠️ ${percentMissing.toFixed(1)}% des users sans joinedAt`);
        logCR.warn('   💡 Fallback intelligent sera utilisé (30/60/120 jours selon heures)');
      }
      logCR.warn('   🔧 Réinitialisation du cache pour recalcul automatique');

      classementCache = {
        data: { byHours: [], byLevel: [] },
        timestamp: null,
        lastRefresh: null
      };
      lastValidCache = null;
      corruptionCount = 0;
      clearClassementCacheOnDisk();

      logCR.info('✅ Cache réinitialisé - recalcul immédiat au prochain refresh');
      return;
    }

    logCR.info('✅ Vérification intégrité OK - données cohérentes');
  } catch (err) {
    logCR.warn('⚠️ Erreur lors de la vérification:', err.message);
  }
}

async function startClassementRefreshJob(options = {}) {
  const backgroundInitialRefresh = options.backgroundInitialRefresh !== false;
  const initialDelayMs = Math.max(0, Number(options.initialDelayMs || 5000));

  healthCheckAndRepair();

  const launchInitialRefresh = async () => {
    try {
      await refreshClassementCache({
        includeSecretEvaluation: false,
        ...(options.initialRefreshOptions || {})
      });
    } catch (err) {
      logCR.warn(`Refresh initial classement échoué: ${err.message}`);
    }
  };

  if (backgroundInitialRefresh) {
    logCR.info(`⏳ Refresh initial du classement programmé dans ${Math.round(initialDelayMs / 1000)}s`);
    const timeout = setTimeout(() => {
      launchInitialRefresh();
    }, initialDelayMs);
    if (typeof timeout.unref === 'function') timeout.unref();
  } else {
    await launchInitialRefresh();
  }

  cron.schedule(CLASSEMENT_REFRESH_CRON, () => {
    refreshClassementCache({ includeSecretEvaluation: false });
  });

  cron.schedule('0 0 1 * *', () => {
    logCR.debug('🧹 Réinitialisation mensuelle du compteur de corruption');
    corruptionCount = 0;
  });

  logCR.info(`✅ Cron job classement démarré (${CLASSEMENT_REFRESH_CRON})`);
}

module.exports = {
  startClassementRefreshJob,
  getClassementCache,
  refreshClassementCache,
  resetClassementCache,
  healthCheckAndRepair
};
