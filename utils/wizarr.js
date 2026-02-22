const fetch = require('node-fetch');

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function computeSubscription(user) {

  // ❌ Aucun utilisateur trouvé
  if (!user) {
    return {
      status: "not_found",
      label: "Aucun abonnement",
      daysLeft: null,
      expiresAt: null,
      progressPercent: 0
    };
  }

  // 🔵 Abonnement illimité
  if (!user.expires) {
    return {
      status: "unlimited",
      label: "Illimité",
      daysLeft: "Illimité",
      expiresAt: "Jamais",
      progressPercent: 100
    };
  }

  const now = new Date();
  const expireDate = new Date(user.expires);

  if (isNaN(expireDate.getTime())) {
    return {
      status: "not_found",
      label: "Erreur date",
      daysLeft: null,
      expiresAt: null,
      progressPercent: 0
    };
  }

  const diffDays = Math.ceil((expireDate - now) / MS_PER_DAY);

  // 🔴 Expiré
  if (diffDays <= 0) {
    return {
      status: "expired",
      label: "Expiré",
      daysLeft: "0 jour",
      expiresAt: expireDate.toLocaleDateString("fr-FR"),
      progressPercent: 0
    };
  }

  // 🟠 Warning si ≤ 15 jours
  const status = diffDays <= 15 ? "warning" : "active";

  return {
    status,
    label: status === "warning" ? "Expire bientôt" : "Actif",
    daysLeft: `${diffDays} jours`,
    expiresAt: expireDate.toLocaleDateString("fr-FR"),
    progressPercent: Math.min(100, Math.round((diffDays / 365) * 100))
  };
}

/**
 * Vérifie auprès de Wizarr si l'utilisateur a un accès actif (abonnement non expiré)
 * @param {Object} user - Objet utilisateur Plex avec { email, username, id }
 * @param {string} wizarrUrl - URL de Wizarr (ex: http://wizarr.example.com)
 * @param {string} apiKey - Clé API Wizarr
 * @returns {Promise<{authorized: boolean, reason?: string}>}
 */
async function checkWizarrAccess(user, wizarrUrl, apiKey) {
  // Si pas de config Wizarr, on autorise par défaut
  if (!wizarrUrl || !apiKey) {
    return { authorized: true, reason: 'Wizarr non configuré — accès accordé par défaut' };
  }

  try {
    const resp = await fetch(`${wizarrUrl}/api/users`, {
      headers: {
        Accept: "application/json",
        "X-API-Key": apiKey
      }
    });

    if (!resp.ok) {
      return { authorized: false, reason: `Wizarr API ${resp.status} — vérification impossible` };
    }

    const payload = await resp.json();
    const list =
      Array.isArray(payload) ? payload :
      Array.isArray(payload?.users) ? payload.users :
      Array.isArray(payload?.data) ? payload.data :
      [];

    const norm = s => (s || "").toLowerCase().trim();
    const plexEmail = norm(user.email);

    if (!plexEmail) {
      return { authorized: false, reason: 'Email Plex manquant' };
    }

    const wizUser = list.find(u => norm(u.email) === plexEmail);

    if (!wizUser) {
      return { authorized: false, reason: 'Utilisateur non trouvé dans Wizarr' };
    }

    // Vérifier que l'abonnement est actif (illimité ou pas expiré)
    if (!wizUser.expires) {
      // Abonnement illimité → OK
      return { authorized: true };
    }

    const now = new Date();
    const expireDate = new Date(wizUser.expires);

    if (isNaN(expireDate.getTime())) {
      return { authorized: false, reason: 'Date d\'expiration invalide' };
    }

    const diffDays = Math.ceil((expireDate - now) / MS_PER_DAY);

    if (diffDays <= 0) {
      return { authorized: false, reason: `Abonnement expiré le ${expireDate.toLocaleDateString('fr-FR')}` };
    }

    // Abonnement actif
    return { authorized: true };

  } catch (err) {
    return { authorized: false, reason: `Erreur Wizarr: ${err.message}` };
  }
}

module.exports = { computeSubscription, checkWizarrAccess };
