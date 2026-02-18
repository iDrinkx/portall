const cron = require('node-cron');
const { updateAllUsersSessionCache, updateTracearrAllUsers } = require('./tracearr');
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

    // Priorite 1: Utiliser updateTracearrAllUsers pour scanner TOUS les utilisateurs Tracearr
    if (TRACEARR_URL && TRACEARR_API_KEY) {
      console.log("[CRON-JOB] Precalcul pour tous les utilisateurs Tracearr");
      await updateTracearrAllUsers(TRACEARR_URL, TRACEARR_API_KEY, PLEX_URL, PLEX_TOKEN);
    } else {
      console.log("[CRON-JOB] Tracearr URL ou API Key manquants");
    }
    
    console.log("========== [CRON-JOB] FIN ==========\n");
  });

  console.log("[CRON] Job session cache schedule: 0 2 * * * (tous les jours a 2h)");
  
  // Si le cache est vide, faire un pre-calcul au démarrage
  const cacheKeys = SessionStatsCache.getKeys();
  if (cacheKeys.length === 0 && TRACEARR_URL && TRACEARR_API_KEY) {
    console.log("[CRON] Cache vide - pré-calcul des stats au démarrage...");
    updateTracearrAllUsers(TRACEARR_URL, TRACEARR_API_KEY, PLEX_URL, PLEX_TOKEN)
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
