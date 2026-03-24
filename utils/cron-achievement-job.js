const cron = require('node-cron');
const path = require('path');
const { spawn } = require('child_process');
const { UserQueries } = require('./database');
const log = require('./logger').create('[Achievements-Cron]');

const ACHIEVEMENT_REFRESH_CRON = '5 * * * *';
const ACHIEVEMENT_WORKER_TIMEOUT_MS = 5 * 60 * 1000;
let achievementRefreshInFlight = null;

function runAchievementRefreshWorker(sessionUser, options = {}) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'achievement-refresh-worker.js');
    const child = spawn(process.execPath, [
      workerPath,
      JSON.stringify({
        sessionUser,
        options
      })
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let settled = false;
    let stderrBuffer = '';

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve();
    };

    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {}
      finish(new Error(`Timeout refresh succes pour ${sessionUser?.username || 'unknown'}`));
    }, ACHIEVEMENT_WORKER_TIMEOUT_MS);
    if (typeof timeout.unref === 'function') timeout.unref();

    child.stderr.on('data', (chunk) => {
      stderrBuffer += String(chunk || '');
    });

    child.on('error', (err) => finish(err));
    child.on('exit', (code) => {
      if (code === 0) {
        finish(null);
        return;
      }
      const stderr = stderrBuffer.trim();
      finish(new Error(stderr || `Worker achievements quitte avec code ${code}`));
    });
  });
}

async function refreshAchievementsForAllUsers(options = {}) {
  if (achievementRefreshInFlight) {
    log.debug('Refresh succes deja en cours - requete fusionnee');
    return achievementRefreshInFlight;
  }

  achievementRefreshInFlight = (async () => {
  const includeSecretEvaluation = options.includeSecretEvaluation !== false;
  const users = UserQueries.getAll() || [];

  if (users.length === 0) {
    log.info('Aucun utilisateur pour le refresh des succes');
    return { processed: 0, failed: 0, total: 0 };
  }

  let processed = 0;
  let failed = 0;
  const startTime = Date.now();

  log.info(`Debut refresh succes pour ${users.length} utilisateur(s)`);

  for (const user of users) {
    const sessionUser = {
      id: user.plexId || null,
      username: user.username,
      email: user.email || null,
      joinedAtTimestamp: user.joinedAt || null
    };

    try {
      await runAchievementRefreshWorker(sessionUser, { includeSecretEvaluation });
      processed += 1;
    } catch (err) {
      failed += 1;
      log.warn(`Refresh succes impossible pour ${user.username}: ${err.message}`);
    }
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  log.info(`Refresh succes termine: ${processed}/${users.length} OK, ${failed} erreur(s), ${durationSec}s`);

  return { processed, failed, total: users.length, durationSec };
  })();

  try {
    return await achievementRefreshInFlight;
  } finally {
    achievementRefreshInFlight = null;
  }
}

async function startAchievementRefreshJob(options = {}) {
  const backgroundInitialRefresh = options.backgroundInitialRefresh !== false;
  const initialDelayMs = Math.max(0, Number(options.initialDelayMs || 120000));
  const refreshOptions = options.refreshOptions || {};

  const launchInitialRefresh = async () => {
    try {
      await refreshAchievementsForAllUsers(refreshOptions);
    } catch (err) {
      log.warn(`Refresh initial succes echoue: ${err.message}`);
    }
  };

  if (backgroundInitialRefresh) {
    log.info(`Refresh initial des succes programme dans ${Math.round(initialDelayMs / 1000)}s`);
    const timeout = setTimeout(() => {
      launchInitialRefresh();
    }, initialDelayMs);
    if (typeof timeout.unref === 'function') timeout.unref();
  } else {
    await launchInitialRefresh();
  }

  cron.schedule(ACHIEVEMENT_REFRESH_CRON, () => {
    refreshAchievementsForAllUsers(refreshOptions).catch((err) => {
      log.warn(`Cron succes echoue: ${err.message}`);
    });
  });

  log.info(`Cron succes demarre (${ACHIEVEMENT_REFRESH_CRON})`);
}

module.exports = {
  ACHIEVEMENT_REFRESH_CRON,
  startAchievementRefreshJob,
  refreshAchievementsForAllUsers
};
