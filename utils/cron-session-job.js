const cron = require('node-cron');
const { scanTautulliHistoryForAllUsers } = require('./tautulli');
const SessionStatsCache = require('./session-stats-cache-db');
const { isTautulliReady } = require('./tautulli-direct');

/**
 * Lance un job cron pour mettre a jour les sessions en cache
 * Utilise le scan intelligent (delta) pour une perf optimale
 */
function startSessionCronJob(TAUTULLI_URL, TAUTULLI_API_KEY, PLEX_URL, PLEX_TOKEN, userList = []) {
  const cronJob = cron.schedule('0 * * * *', async () => {
    console.log("\n========== [CRON-JOB] DEBUT MISE A JOUR CACHE (tache horaire) ==========");
    console.log("[CRON-JOB] Timestamp:", new Date().toISOString());

    const hasDirectDb = isTautulliReady();
    const hasApiFallback = Boolean(TAUTULLI_URL && TAUTULLI_API_KEY);

    if (!hasDirectDb && !hasApiFallback) {
      console.error("[CRON-JOB] Tautulli DB non prete et API non configuree - Skipped");
      console.log("========== [CRON-JOB] FIN ==========\n");
      return;
    }

    try {
      console.log(`[CRON-JOB] Lancement scan intelligent (delta mode) - source prioritaire: ${hasDirectDb ? 'tautulli.db' : 'api'}`);
      const scanStartTime = Date.now();

      const repairedBeforeScan = SessionStatsCache.repairInconsistentWatchHistory();
      if (repairedBeforeScan > 0) {
        console.log(`[CRON-JOB]   Reparation watch_history avant scan: ${repairedBeforeScan} ligne(s)`);
      }

      const result = await scanTautulliHistoryForAllUsers(TAUTULLI_URL, TAUTULLI_API_KEY);

      const repairedAfterScan = SessionStatsCache.repairInconsistentWatchHistory();
      if (repairedAfterScan > 0) {
        console.log(`[CRON-JOB]   Reparation watch_history apres scan: ${repairedAfterScan} ligne(s)`);
      }

      const duration = Math.round((Date.now() - scanStartTime) / 1000);
      const cachedCount = SessionStatsCache.getKeys().length;

      console.log("[CRON-JOB] SCAN CRON TERMINE");
      console.log("[CRON-JOB]   Utilisateurs traites:", Object.keys(result).length);
      console.log("[CRON-JOB]   Total en cache:", cachedCount);
      console.log("[CRON-JOB]   Duree:", duration, 'secondes');
      console.log("[CRON-JOB]   Les donnees mises a jour seront visibles aux clients connectes");

      console.log("[CRON-JOB] Scan sessions termine - succes et classement suivront via leurs cron dedies.");
    } catch (err) {
      console.error("[CRON-JOB] Erreur scan cron:", err.message);
      console.error("[CRON-JOB] Stack:", err.stack);
    }

    console.log("========== [CRON-JOB] FIN ==========\n");
  });

  console.log("[CRON] Job cron schedule: 0 * * * * (toutes les heures)");
  console.log("[CRON] Cache au demarrage:", SessionStatsCache.getKeys().length, 'utilisateurs');
  console.log("[CRON] Utilisateurs detectes (Seerr):", userList.length);
  console.log(`[CRON] Mode: Scan intelligent avec delta sync - source prioritaire: ${isTautulliReady() ? 'tautulli.db' : 'api'}`);

  return cronJob;
}

/**
 * Lance une mise a jour manuelle du cache (pour tester ou forcer)
 */
async function updateAllManual(TAUTULLI_URL, TAUTULLI_API_KEY, PLEX_URL, PLEX_TOKEN, userList) {
  console.log("\n========== [MANUAL-UPDATE] DEBUT - Mise a jour manuelle des sessions ==========");

  const result = await scanTautulliHistoryForAllUsers(TAUTULLI_URL, TAUTULLI_API_KEY);

  console.log("========== [MANUAL-UPDATE] FIN ==========\n");
  return result;
}

module.exports = { startSessionCronJob, updateAllManual };
