const EventEmitter = require('events');

/**
 * 📢 EventEmitter global pour notifier les clients quand le scan Tautulli finit
 * Permet aux clients long-polling (/api/stats-wait) d'être notifiés immédiatement
 */
class TautulliEventsEmitter extends EventEmitter {}

const emitter = new TautulliEventsEmitter();

let scanFinishTime = null;

/**
 * Émettre un événement 'scan-complete' quand les données sont prêtes
 */
function emitScanComplete() {
  scanFinishTime = Date.now();  // Marquer le moment où le scan a fini
  emitter.emit('scan-complete', { timestamp: scanFinishTime });
}

/**
 * Attendre que le scan soit terminé
 * Utilisé par /api/stats-wait pour notifier les clients
 * @param {number} timeout - Timeout en millisecondes (5 min par défaut)
 * @returns {Promise} Résout quand scan terminé ou timeout
 */
function waitForScanComplete(timeout = 5 * 60 * 1000) {
  return new Promise((resolve) => {
    // Vérifier si un scan a déjà fini récemment (< 2 secondes)
    if (scanFinishTime && (Date.now() - scanFinishTime) < 2000) {
      console.log("[TAUTULLI-EVENTS] Scan déjà fini il y a peu, résolution immédiate");
      return resolve({ alreadyDone: true });
    }

    // Attendre l'événement
    const timeoutId = setTimeout(() => {
      console.warn("[TAUTULLI-EVENTS] ⚠️  Timeout attendant scan-complete");
      emitter.off('scan-complete', onScanComplete);
      resolve({ timeout: true });
    }, timeout);

    const onScanComplete = () => {
      clearTimeout(timeoutId);
      emitter.off('scan-complete', onScanComplete);
      console.log("[TAUTULLI-EVENTS] ✅ Scan complété, clients notifiés");
      resolve({ scanned: true });
    };

    emitter.once('scan-complete', onScanComplete);
  });
}

module.exports = {
  emitScanComplete,
  waitForScanComplete,
  emitter
};
