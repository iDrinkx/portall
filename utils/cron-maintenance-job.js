const cron = require('node-cron');
const { DatabaseMaintenance } = require('./database');

/**
 * Lance un job cron pour la maintenance automatique de la base de données
 * Exécuté chaque dimanche à 3h du matin
 */
function startDatabaseMaintenanceJob() {
  // Job cron: chaque dimanche à 3h du matin (0 3 * * 0)
  // Format: second minute hour day month weekday
  // 0 = dimanche, 1 = lundi, etc.
  const cronJob = cron.schedule('0 3 * * 0', async () => {
    console.log("\n════════════════════════════════════════════════════════");
    console.log("[DB-MAINTENANCE] 🧹 DÉBUT MAINTENANCE PROGRAMMÉE (dimanche 3h)");
    console.log("════════════════════════════════════════════════════════");
    console.log("[DB-MAINTENANCE] Timestamp:", new Date().toISOString());

    try {
      const result = DatabaseMaintenance.runFullMaintenance();

      console.log("[DB-MAINTENANCE] ✅ MAINTENANCE TERMINÉE AVEC SUCCÈS");
      console.log("════════════════════════════════════════════════════════\n");

      return result;
    } catch (err) {
      console.error("[DB-MAINTENANCE] ❌ Erreur maintenance:", err.message);
      console.error("[DB-MAINTENANCE] Stack:", err.stack);
      console.log("════════════════════════════════════════════════════════\n");
    }
  });

  console.log("[CRON] 🧹 Job maintenance programmé: Dimanche à 3h du matin (0 3 * * 0)");
  console.log("[CRON] ✅ Nettoyage automatique: ACTIVÉ");
  console.log("[CRON]    • Supprime tautulli_sessions > 1 an");
  console.log("[CRON]    • Supprime session_cache > 3 mois");
  console.log("[CRON]    • Supprime watch_history > 2 ans");
  console.log("[CRON]    • Supprime sync_metadata > 6 mois");
  console.log("[CRON]    • Optimise DB avec VACUUM\n");

  return cronJob;
}

/**
 * Lancer une maintenance manuelle (pour testing ou admin)
 */
async function runMaintenanceManual() {
  console.log("\n════════════════════════════════════════════════════════");
  console.log("[DB-MAINTENANCE] 🧹 MAINTENANCE MANUELLE - Démarrée");
  console.log("════════════════════════════════════════════════════════");

  try {
    const result = DatabaseMaintenance.runFullMaintenance();
    console.log("[DB-MAINTENANCE] ✅ MAINTENANCE MANUELLE TERMINÉE");
    console.log("════════════════════════════════════════════════════════\n");
    return result;
  } catch (err) {
    console.error("[DB-MAINTENANCE] ❌ Erreur:", err.message);
    console.log("════════════════════════════════════════════════════════\n");
    throw err;
  }
}

module.exports = { startDatabaseMaintenanceJob, runMaintenanceManual };
