const cron = require('node-cron');
const { scanTautulliHistoryForAllUsers } = require('./tautulli');
const SessionStatsCache = require('./session-stats-cache-db');  // 🗄️ Utiliser SQLite

/**
 * Lance un job cron pour mettre à jour les sessions en cache
 * Utilise le scan intelligent (delta) pour une perf optimale
 */
function startSessionCronJob(TAUTULLI_URL, TAUTULLI_API_KEY, PLEX_URL, PLEX_TOKEN, userList = []) {
  // Job cron: toutes les 60 minutes
  const cronJob = cron.schedule('0 * * * *', async () => {
    console.log("\n========== [CRON-JOB] 🕐 DEBUT MISE A JOUR CACHE (2h du matin) ==========");
    console.log("[CRON-JOB] Timestamp:", new Date().toISOString());

    if (!TAUTULLI_URL || !TAUTULLI_API_KEY) {
      console.error("[CRON-JOB] ❌ Tautulli URL ou API Key manquants - Skipped");
      console.log("========== [CRON-JOB] FIN ==========\n");
      return;
    }

    try {
      console.log("[CRON-JOB] 🚀 Lancement scan intelligent (delta mode)");
      const scanStartTime = Date.now();
      
      // Utiliser le scan intelligent qui arrête quand il atteint le cache existant
      // La fonction récupère elle-même tous les utilisateurs de Tautulli
      const result = await scanTautulliHistoryForAllUsers(TAUTULLI_URL, TAUTULLI_API_KEY);
      
      const duration = Math.round((Date.now() - scanStartTime) / 1000);
      const cachedCount = SessionStatsCache.getKeys().length;
      
      console.log("[CRON-JOB] ✅ SCAN CRON TERMINÉ");
      console.log("[CRON-JOB]   📊 Utilisateurs traités:", Object.keys(result).length);
      console.log("[CRON-JOB]   💾 Total en cache:", cachedCount);
      console.log("[CRON-JOB]   ⏱️  Durée:", duration, 'secondes');
      console.log("[CRON-JOB]   📢 Les données mises à jour seront visibles aux clients connectés");

        // Patch: rafraîchir le classement juste après la mise à jour des sessions
        try {
          const { refreshClassementCache } = require('./cron-classement-refresh');
          await refreshClassementCache();
          console.log("[CRON-JOB] 🏆 Classement rafraîchi après mise à jour sessions.");
        } catch (err) {
          console.error("[CRON-JOB] ❌ Erreur refresh classement:", err.message);
        }
      
    } catch (err) {
      console.error("[CRON-JOB] ❌ Erreur scan cron:", err.message);
      console.error("[CRON-JOB] Stack:", err.stack);
    }
    
    console.log("========== [CRON-JOB] FIN ==========\n");
  });

  console.log("[CRON] 🕐 Job cron schedule: 0 2 * * * (tous les jours à 2h)");
  console.log("[CRON] 💾 Cache au démarrage:", SessionStatsCache.getKeys().length, 'utilisateurs');
  console.log("[CRON] 📊 Utilisateurs détectés (Seerr):", userList.length);
  console.log("[CRON] ⚙️  Mode: Scan intelligent avec delta sync (arrêt automatique au cache)");
  
  return cronJob;
  // Exécution immédiate au démarrage
  (async () => {
    try {
      console.log("[CRON-JOB] 🚀 Scan sessions immédiat au démarrage");
      await scanTautulliHistoryForAllUsers(TAUTULLI_URL, TAUTULLI_API_KEY);
      const { refreshClassementCache } = require('./cron-classement-refresh');
      await refreshClassementCache();
      console.log("[CRON-JOB] 🏆 Classement rafraîchi au démarrage.");
    } catch (err) {
      console.error("[CRON-JOB] ❌ Erreur scan/refresh au démarrage:", err.message);
    }
  })();
}

/**
 * Lance une mise à jour manuelle du cache (pour tester ou forcer)
 */
async function updateAllManual(TAUTULLI_URL, TAUTULLI_API_KEY, PLEX_URL, PLEX_TOKEN, userList) {
  console.log("\n========== [MANUAL-UPDATE] DEBUT - Mise a jour manuelle des sessions ==========");
  
  const result = await scanTautulliHistoryForAllUsers(TAUTULLI_URL, TAUTULLI_API_KEY);
  
  console.log("========== [MANUAL-UPDATE] FIN ==========\n");
  return result;
}

module.exports = { startSessionCronJob, updateAllManual };
