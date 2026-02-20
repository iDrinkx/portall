const EventEmitter = require('events');
const log = require('./logger').create('[Tautulli]');

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
      return resolve({ alreadyDone: true });
    }

    // Attendre l'événement
    const timeoutId = setTimeout(() => {
      log.warn('Timeout wait scan-complete');
      emitter.off('scan-complete', onScanComplete);
      resolve({ timeout: true });
    }, timeout);

    const onScanComplete = () => {
      clearTimeout(timeoutId);
      emitter.off('scan-complete', onScanComplete);
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
