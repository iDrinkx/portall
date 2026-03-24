const cron = require('node-cron');
const { scanTautulliHistoryForAllUsers } = require('./tautulli');
const SessionStatsCache = require('./session-stats-cache-db');
const { isTautulliReady } = require('./tautulli-direct');
const { refreshAchievementsForAllUsers } = require('./cron-achievement-job');
const {
  refreshClassementCache,
  healthCheckAndRepair
} = require('./cron-classement-refresh');
const log = require('./logger').create('[Refresh-Orchestrator]');

const MASTER_REFRESH_CRON = '0 * * * *';
let orchestratorRunInFlight = null;

async function refreshSessionCacheStep(TAUTULLI_URL, TAUTULLI_API_KEY) {
  const hasDirectDb = isTautulliReady();
  const hasApiFallback = Boolean(TAUTULLI_URL && TAUTULLI_API_KEY);

  if (!hasDirectDb && !hasApiFallback) {
    log.warn('Refresh sessions ignore: Tautulli DB non prete et API non configuree');
    return { skipped: true, reason: 'tautulli_unavailable' };
  }

  log.info(`Etape sessions: scan intelligent (${hasDirectDb ? 'tautulli.db' : 'api'})`);
  const scanStartTime = Date.now();

  const repairedBeforeScan = SessionStatsCache.repairInconsistentWatchHistory();
  if (repairedBeforeScan > 0) {
    log.info(`Etape sessions: reparation watch_history avant scan (${repairedBeforeScan})`);
  }

  const result = await scanTautulliHistoryForAllUsers(TAUTULLI_URL, TAUTULLI_API_KEY);

  const repairedAfterScan = SessionStatsCache.repairInconsistentWatchHistory();
  if (repairedAfterScan > 0) {
    log.info(`Etape sessions: reparation watch_history apres scan (${repairedAfterScan})`);
  }

  const durationSec = Math.round((Date.now() - scanStartTime) / 1000);
  const cachedCount = SessionStatsCache.getKeys().length;
  log.info(`Etape sessions terminee: ${Object.keys(result || {}).length} users, cache=${cachedCount}, ${durationSec}s`);

  return {
    skipped: false,
    result,
    durationSec,
    cachedCount
  };
}

async function runRefreshPipeline(context = {}) {
  const source = context.source || 'manual';
  const TAUTULLI_URL = context.TAUTULLI_URL || '';
  const TAUTULLI_API_KEY = context.TAUTULLI_API_KEY || '';

  if (orchestratorRunInFlight) {
    log.info(`Pipeline deja en cours - requete fusionnee (${source})`);
    return orchestratorRunInFlight;
  }

  orchestratorRunInFlight = (async () => {
    const startedAt = Date.now();
    log.info(`Debut pipeline global (${source})`);

    try {
      const sessions = await refreshSessionCacheStep(TAUTULLI_URL, TAUTULLI_API_KEY);
      const achievements = await refreshAchievementsForAllUsers({ includeSecretEvaluation: true });
      const classement = await refreshClassementCache({ includeSecretEvaluation: false });

      const durationSec = Math.round((Date.now() - startedAt) / 1000);
      log.info(`Pipeline global termine (${source}) en ${durationSec}s`);

      return {
        source,
        durationSec,
        sessions,
        achievements,
        classement
      };
    } catch (err) {
      log.error(`Pipeline global echoue (${source}): ${err.message}`);
      throw err;
    } finally {
      orchestratorRunInFlight = null;
    }
  })();

  return orchestratorRunInFlight;
}

async function startRefreshOrchestrator(options = {}) {
  const TAUTULLI_URL = options.TAUTULLI_URL || '';
  const TAUTULLI_API_KEY = options.TAUTULLI_API_KEY || '';
  const backgroundInitialRefresh = options.backgroundInitialRefresh !== false;
  const initialDelayMs = Math.max(0, Number(options.initialDelayMs || 60000));

  healthCheckAndRepair();

  const runWithContext = (source) => runRefreshPipeline({
    source,
    TAUTULLI_URL,
    TAUTULLI_API_KEY
  }).catch((err) => {
    log.warn(`Pipeline ${source} echoue: ${err.message}`);
  });

  if (backgroundInitialRefresh) {
    log.info(`Pipeline initial programme dans ${Math.round(initialDelayMs / 1000)}s`);
    const timeout = setTimeout(() => {
      runWithContext('startup');
    }, initialDelayMs);
    if (typeof timeout.unref === 'function') timeout.unref();
  } else {
    await runWithContext('startup');
  }

  cron.schedule(MASTER_REFRESH_CRON, () => {
    runWithContext('hourly');
  });

  cron.schedule('0 0 1 * *', () => {
    log.info('Maintenance mensuelle pipeline: revalidation classement');
    healthCheckAndRepair();
  });

  log.info(`Orchestrateur des refresh demarre (${MASTER_REFRESH_CRON})`);
}

module.exports = {
  MASTER_REFRESH_CRON,
  startRefreshOrchestrator,
  runRefreshPipeline,
  refreshSessionCacheStep
};
