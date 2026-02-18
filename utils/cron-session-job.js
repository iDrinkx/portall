const cron = require('node-cron');
const { updateAllUsersSessionCache } = require('./tracearr');
const SessionStatsCache = require('./session-stats-cache');

/**
 * Lance un job cron pour mettre à jour les sessions en cache
 * @param {Array} userList - Liste des utilisateurs {username, id, joinedAtTimestamp}
 */
function startSessionCronJob(TRACEARR_URL, TRACEARR_API_KEY, PLEX_URL, PLEX_TOKEN, userList = []) {
  // Job cron: tous les jours à 2h du matin ET au démarrage du serveur (si cache vide)
  const cronJob = cron.schedule('0 2 * * *', async () => {
    console.log("\n========== [CRON-JOB] DEBUT - Mise a jour du cache sessions ==========");
    console.log("[CRON-JOB] Timestamp:", new Date().toISOString());

    if (!userList || userList.length === 0) {
      console.log("[CRON-JOB] Aucun utilisateur a mettre a jour");
      return;
    }

    await updateAllUsersSessionCache(TRACEARR_URL, TRACEARR_API_KEY, PLEX_URL, PLEX_TOKEN, userList);
    
    console.log("========== [CRON-JOB] FIN ==========\n");
  });

  console.log("[CRON] Job session cache schedule: 0 2 * * * (tous les jours a 2h)");
  
  // Si le cache est vide, faire un pre-calcul au démarrage
  const cacheKeys = SessionStatsCache.getKeys();
  if (cacheKeys.length === 0 && userList.length > 0) {
    console.log("[CRON] Cache vide - pré-calcul des stats au démarrage...");
    updateAllUsersSessionCache(TRACEARR_URL, TRACEARR_API_KEY, PLEX_URL, PLEX_TOKEN, userList)
      .then(() => console.log("[CRON] Pré-calcul au démarrage termine"))
      .catch(err => console.error("[CRON] Erreur pré-calcul:", err.message));
  } else {
    console.log("[CRON] Cache existant avec", cacheKeys.length, "utilisateurs");
  }
  
  return cronJob;
}

/**
 * Lance une mise à jour manuelle du cache (pour tester ou forcer)
 */
async function updateAllManual(TRACEARR_URL, TRACEARR_API_KEY, PLEX_URL, PLEX_TOKEN, userList) {
  console.log("\n========== [MANUAL-UPDATE] DEBUT - Mise a jour manuelle des sessions ==========");
  
  const result = await updateAllUsersSessionCache(TRACEARR_URL, TRACEARR_API_KEY, PLEX_URL, PLEX_TOKEN, userList);
  
  console.log("========== [MANUAL-UPDATE] FIN ==========\n");
  return result;
}

module.exports = { startSessionCronJob, updateAllManual };
