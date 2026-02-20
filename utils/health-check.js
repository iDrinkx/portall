/**
 * 🏥 HEALTH CHECK - Vérification de la configuration PRO
 * Lance des vérifications pour s'assurer que tout est configuré correctement
 */

const SessionStatsCache = require('./session-stats-cache-db');  // 🗄️ Utiliser SQLite
const TautulliEvents = require('./tautulli-events');  // 📢 EventEmitter

async function runHealthCheck() {
  console.log("\n========== [HEALTH-CHECK] 🏥 VÉRIFICATION SYSTÈME ==========\n");

  let issuesFound = 0;
  const checks = [];

  // ✅ Vérifier le cache
  console.log("[HC] 📦 Vérification cache...");
  try {
    const cacheData = SessionStatsCache.getAll();
    const cacheKeys = Object.keys(cacheData);
    
    if (cacheKeys.length === 0) {
      console.log("[HC]   ℹ️  Cache vide (normal au premier démarrage)");
      checks.push({ name: "Cache", status: "⚠️  VIDE", detail: "Sera rempli au premier connexion" });
    } else {
      console.log("[HC]   ✅ Cache valide avec", cacheKeys.length, 'utilisateurs');
      checks.push({ name: "Cache", status: "✅ OK", detail: cacheKeys.length + " users" });
      
      // Vérifier quelques entrées
      const sample = cacheKeys[0];
      const sampleData = cacheData[sample];
      console.log("[HC]     Sample:", sample, "->", {
        sessionCount: sampleData?.sessionCount || 0,
        watchStats: sampleData?.watchStats?.totalHours || 0 + "h",
        cached: sampleData?.lastUpdated
      });
    }
  } catch (err) {
    console.error("[HC]   ❌ Erreur cache:", err.message);
    checks.push({ name: "Cache", status: "❌ ERREUR", detail: err.message });
    issuesFound++;
  }

  // ✅ Vérifier l'EventEmitter
  console.log("[HC] 📢 Vérification EventEmitter...");
  try {
    if (TautulliEvents && TautulliEvents.emitter && typeof TautulliEvents.emitter.on === 'function') {
      console.log("[HC]   ✅ EventEmitter opérationnel");
      checks.push({ name: "EventEmitter", status: "✅ OK", detail: "À l'écoute des événements" });
    } else {
      console.error("[HC]   ❌ EventEmitter non disponible");
      checks.push({ name: "EventEmitter", status: "❌ ERREUR", detail: "Module non chargé" });
      issuesFound++;
    }
  } catch (err) {
    console.error("[HC]   ❌ Erreur EventEmitter:", err.message);
    checks.push({ name: "EventEmitter", status: "❌ ERREUR", detail: err.message });
    issuesFound++;
  }

  // ✅ Vérifier les variables d'environnement
  console.log("[HC] ⚙️  Vérification configuration...");
  const configChecks = {
    TAUTULLI_URL: process.env.TAUTULLI_URL ? "✅" : "❌",
    TAUTULLI_API_KEY: process.env.TAUTULLI_API_KEY ? "✅" : "❌",
    PLEX_URL: process.env.PLEX_URL ? "✅" : "❌",
    PLEX_TOKEN: process.env.PLEX_TOKEN ? "✅" : "❌",
    WIZARR_URL: process.env.WIZARR_URL ? "✅" : "⚠️",
    SEERR_URL: process.env.SEERR_URL ? "✅" : "⚠️",
  };

  for (const [key, status] of Object.entries(configChecks)) {
    const symbol = status === "✅" ? "✅" : status === "❌" ? "❌" : "⚠️";
    console.log("[HC]   " + symbol + " " + key);
    if (status === "❌") issuesFound++;
  }

  const missCount = Object.values(configChecks).filter(s => s === "❌").length;
  if (missCount > 0) issuesFound += missCount;
  checks.push({ 
    name: "Configuration", 
    status: missCount === 0 ? "✅ OK" : "❌ ERREUR", 
    detail: missCount + " configs manquantes"
  });

  // 📊 Résumé
  console.log("\n========== [HEALTH-CHECK] 📊 RÉSUMÉ ==========\n");
  checks.forEach(check => {
    console.log(`${check.status} ${check.name.padEnd(20)} - ${check.detail}`);
  });

  if (issuesFound > 0) {
    console.warn("\n⚠️  " + issuesFound + " problème(s) détecté(s) - Vérifiez votre configuration\n");
  } else {
    console.log("\n✅ Tous les checks sont OK! Le système est prêt.\n");
  }

  console.log("========== [HEALTH-CHECK] FIN ==========\n");
}

module.exports = { runHealthCheck };
