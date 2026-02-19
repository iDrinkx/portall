const cron = require('node-cron');
const { scanTracearrHistoryForAllUsers } = require('./tracearr');
const SessionStatsCache = require('./session-stats-cache');

/**
 * Lance un job cron pour mettre à jour les sessions en cache
 * Utilise le scan intelligent (delta) pour une perf optimale
 */
function startSessionCronJob(TRACEARR_URL, TRACEARR_API_KEY, PLEX_URL, PLEX_TOKEN, userList = []) {
  // Job cron: tous les jours à 2h du matin
  const cronJob = cron.schedule('0 2 * * *', async () => {
    console.log("\n========== [CRON-JOB] 🕐 DEBUT MISE A JOUR CACHE (2h du matin) ==========");
    console.log("[CRON-JOB] Timestamp:", new Date().toISOString());

    if (!TRACEARR_URL || !TRACEARR_API_KEY) {
      console.error("[CRON-JOB] ❌ Tracearr URL ou API Key manquants - Skipped");
      console.log("========== [CRON-JOB] FIN ==========\n");
      return;
    }

    try {
      console.log("[CRON-JOB] 🚀 Lancement scan intelligent (delta mode)");
      const scanStartTime = Date.now();
      
      // Utiliser le scan intelligent qui arrête quand il atteint le cache existant
      // La fonction récupère elle-même tous les utilisateurs de Tracearr
      const result = await scanTracearrHistoryForAllUsers(TRACEARR_URL, TRACEARR_API_KEY);
      
      const duration = Math.round((Date.now() - scanStartTime) / 1000);
      const cachedCount = SessionStatsCache.getKeys().length;
      
      console.log("[CRON-JOB] ✅ SCAN CRON TERMINÉ");
      console.log("[CRON-JOB]   📊 Utilisateurs traités:", Object.keys(result).length);
      console.log("[CRON-JOB]   💾 Total en cache:", cachedCount);
      console.log("[CRON-JOB]   ⏱️  Durée:", duration, 'secondes');
      console.log("[CRON-JOB]   📢 Les données mises à jour seront visibles aux clients connectés");
      
    } catch (err) {
      console.error("[CRON-JOB] ❌ Erreur scan cron:", err.message);
      console.error("[CRON-JOB] Stack:", err.stack);
    }
    
    console.log("========== [CRON-JOB] FIN ==========\n");
  });

  console.log("[CRON] 🕐 Job cron schedule: 0 2 * * * (tous les jours à 2h)");
  console.log("[CRON] 💾 Cache au démarrage:", SessionStatsCache.getKeys().length, 'utilisateurs');
  console.log("[CRON] 📊 Utilisateurs détectés (Overseerr):", userList.length);
  console.log("[CRON] ⚙️  Mode: Scan intelligent avec delta sync (arrêt automatique au cache)");
  
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
