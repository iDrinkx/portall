const cron = require('node-cron');
const { updateUserSessionCache } = require('./tracearr');
const SessionStatsCache = require('./session-stats-cache');

/**
 * Lance un job cron pour mettre à jour les sessions en cache
 * @param {0} app - Express app (pas utilisé mais gardé pour future extensibilité)
 * @param {string} TRACEARR_URL - URL serveur Tracearr
 * @param {string} TRACEARR_API_KEY - Clé API Tracearr
 * @param {string} PLEX_URL - URL serveur Plex
 * @param {string} PLEX_TOKEN - Token Plex
 * @param {Array} userList - Liste des utilisateurs à mettre à jour (avec id, username, joinedAtTimestamp)
 */
function startSessionCronJob(app, TRACEARR_URL, TRACEARR_API_KEY, PLEX_URL, PLEX_TOKEN, userList = []) {
  // Job cron: tous les jours à 2h du matin
  const cronJob = cron.schedule('0 2 * * *', async () => {
    console.log("\n========== [CRON-JOB] DEBUT - Mise a jour du cache sessions ==========");
    console.log("[CRON-JOB] Timestamp:", new Date().toISOString());

    if (!userList || userList.length === 0) {
      console.log("[CRON-JOB] Aucun utilisateur a mettre a jour");
      return;
    }

    console.log("[CRON-JOB] Nombres d'utilisateurs a traiter:", userList.length);

    let successCount = 0;
    let failureCount = 0;
    const startTime = Date.now();

    for (const user of userList) {
      try {
        await updateUserSessionCache(
          user.username,
          TRACEARR_URL,
          TRACEARR_API_KEY,
          user.id || user.plexUserId,
          PLEX_URL,
          PLEX_TOKEN,
          user.joinedAtTimestamp
        );
        successCount++;
      } catch (err) {
        console.error("[CRON-JOB] Erreur mise a jour", user.username, ":", err.message);
        failureCount++;
      }
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log("[CRON-JOB] Termine - Succes:", successCount, "Echecs:", failureCount, "Durée:", duration, "sec");
    console.log("========== [CRON-JOB] FIN ==========\n");
  });

  console.log("[CRON] Job session cache schedule: 0 2 * * * (tous les jours a 2h)");
  return cronJob;
}

/**
 * Lance une mise à jour manuelle du cache (pour tester ou forcer)
 */
async function updateAllSessionsCache(TRACEARR_URL, TRACEARR_API_KEY, PLEX_URL, PLEX_TOKEN, userList) {
  console.log("\n========== [MANUAL-UPDATE] DEBUT - Mise a jour manuelle des sessions ==========");
  
  let successCount = 0;
  let failureCount = 0;
  const startTime = Date.now();

  for (const user of userList) {
    try {
      await updateUserSessionCache(
        user.username,
        TRACEARR_URL,
        TRACEARR_API_KEY,
        user.id || user.plexUserId,
        PLEX_URL,
        PLEX_TOKEN,
        user.joinedAtTimestamp
      );
      successCount++;
    } catch (err) {
      console.error("[MANUAL-UPDATE] Erreur pour", user.username, ":", err.message);
      failureCount++;
    }
  }

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log("[MANUAL-UPDATE] Completé - Succes:", successCount, "Echecs:", failureCount, "Durée:", duration, "sec");
  console.log("========== [MANUAL-UPDATE] FIN ==========\n");
}

module.exports = { startSessionCronJob, updateAllSessionsCache };
