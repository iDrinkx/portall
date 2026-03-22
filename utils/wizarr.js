const fetch = require('node-fetch');
const log = require('./logger').create('[Wizarr]');

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

  if (!user.email) {
    return { authorized: false, reason: 'Email Plex manquant' };
  }

  try {
    const debugContext = {
      plexUsername: String(user?.username || '').trim() || null,
      plexEmail: String(user?.email || '').trim() || null,
      plexUserId: String(user?.id || '').trim() || null
    };

    let wizUser = null;

    // Essai 1: filtre direct par email côté Wizarr
    const emailParam = encodeURIComponent(user.email);
    const resp = await fetch(`${wizarrUrl}/api/users?email=${emailParam}`, {
      headers: {
        Accept: "application/json",
        "X-API-Key": apiKey
      }
    });

    if (!resp.ok) {
      return { authorized: false, reason: `Wizarr API ${resp.status} — vérification impossible` };
    }

    const payload = await resp.json();
    const list = Array.isArray(payload?.users) ? payload.users : [];
    log.debug(`checkWizarrAccess direct email lookup`, {
      ...debugContext,
      directMatches: list.length
    });
    wizUser = list[0] || null;

    // Essai 2: fallback robuste sur la liste complète, avec plusieurs critères
    if (!wizUser) {
      const allUsers = await getAllWizarrUsers(wizarrUrl, apiKey);
      const targetEmail = String(user.email || '').trim().toLowerCase();
      const targetUsername = String(user.username || '').trim().toLowerCase();
      const targetPlexId = String(user.id || '').trim();

      log.debug(`checkWizarrAccess fallback scan`, {
        ...debugContext,
        wizarrUsers: allUsers.length,
        sample: allUsers.slice(0, 5).map(entry => ({
          username: entry?.username || null,
          email: entry?.email || null,
          plexUserId: entry?.plexUserId || null
        }))
      });

      wizUser = allUsers.find(entry => {
        const entryEmail = String(entry?.email || '').trim().toLowerCase();
        const entryUsername = String(entry?.username || '').trim().toLowerCase();
        const entryPlexId = String(entry?.plexUserId || '').trim();

        return (
          (targetEmail && entryEmail === targetEmail) ||
          (targetUsername && entryUsername === targetUsername) ||
          (targetPlexId && entryPlexId === targetPlexId)
        );
      }) || null;
    }

    if (!wizUser) {
      log.warn(`checkWizarrAccess no match`, debugContext);
      return { authorized: false, reason: 'Utilisateur non trouvé dans Wizarr' };
    }

    log.info(`checkWizarrAccess match`, {
      ...debugContext,
      matchedUsername: wizUser.username || null,
      matchedEmail: wizUser.email || null,
      matchedPlexUserId: wizUser.plexUserId || null,
      expires: wizUser.expires || null
    });

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

/**
 * Récupère TOUS les utilisateurs Wizarr avec pagination
 * @param {string} wizarrUrl - URL de Wizarr
 * @param {string} apiKey - Clé API Wizarr
 * @returns {Promise<Array<{id, username, plexUserId, email, joinedAtTimestamp}>>}
 */
async function getAllWizarrUsers(wizarrUrl, apiKey) {
  if (!wizarrUrl || !apiKey) return [];

  // Extraire un timestamp Unix (secondes) depuis plusieurs noms de champs possibles
  function extractTs(u) {
    const raw = u.joinedAtTimestamp || u.created_at || u.date_created || u.created || u.dateCreated || null;
    if (!raw) return null;
    if (typeof raw === 'number') return raw < 1e12 ? raw : Math.floor(raw / 1000);
    const ms = new Date(raw).getTime();
    return isNaN(ms) ? null : Math.floor(ms / 1000);
  }

  function normalizeList(payload) {
    return Array.isArray(payload)        ? payload :
           Array.isArray(payload?.data)  ? payload.data :
           Array.isArray(payload?.users) ? payload.users :
           [];
  }

  function mapUser(u) {
    return {
      id:                u.id || null,
      username:          u.username || u.plexUsername || u.plex_username || null,
      plexUserId:        u.plexUserId || u.plex_user_id || u.plexId || null,
      email:             u.email || null,
      joinedAtTimestamp: extractTs(u),
      expires:           u.expires || null
    };
  }

  // Essayer d'abord /api/users (endpoint confirmé opérationnel dans cette installation)
  // On essaie avec un grand limit pour éviter une pagination par défaut restrictive
  const apiUsersEndpoints = [
    `${wizarrUrl}/api/users?limit=1000`,
    `${wizarrUrl}/api/users`,
  ];

  for (const url of apiUsersEndpoints) {
    try {
      const resp = await fetch(url, {
        headers: { Accept: 'application/json', 'X-API-Key': apiKey },
        timeout: 8000
      });
      if (resp.ok) {
        const payload = await resp.json();
        const list = normalizeList(payload);
        if (list.length > 0) {
          const filtered = list.map(mapUser).filter(u => u.username);
          // Si on a moins de résultats filtrés que bruts, c'est que certains n'ont pas de username (invitation en attente)
          return filtered;
        }
      }
    } catch (_) {}
  }

  // Fallback: /api/v1/user avec pagination (Wizarr v4+)
  const users = [];
  const take = 50;
  let skip = 0;
  let hasMore = true;

  while (hasMore) {
    try {
      const resp = await fetch(`${wizarrUrl}/api/v1/user?skip=${skip}&take=${take}`, {
        headers: { Accept: 'application/json', 'X-API-Key': apiKey },
        timeout: 8000
      });
      if (!resp.ok) break;

      const payload = await resp.json();
      const page = normalizeList(payload);

      if (page.length === 0) {
        hasMore = false;
      } else {
        users.push(...page.map(mapUser));
        skip += take;
        const total = payload?.total ?? payload?.pageInfo?.results ?? null;
        if ((total !== null && users.length >= total) || page.length < take) hasMore = false;
      }
    } catch (_) {
      hasMore = false;
    }
  }

  return users.filter(u => u.username);
}

module.exports = { computeSubscription, checkWizarrAccess, getAllWizarrUsers };
