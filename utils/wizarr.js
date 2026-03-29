const fetch = require('node-fetch');
const log = require('./logger').create('[Wizarr]');

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const WIZARR_LIST_TIMEOUT_MS = 20000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeList(payload) {
  return Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.users) ? payload.users
    : [];
}

function mapUser(user) {
  const username =
    user.username ||
    user.plexUsername ||
    user.plex_username ||
    user.displayName ||
    user.display_name ||
    user.name ||
    user.fullName ||
    user.full_name ||
    null;

  return {
    id: user.id || null,
    username,
    plexUserId: user.plexUserId || user.plex_user_id || user.plexId || null,
    email: user.email || null,
    joinedAtTimestamp: null,
    expires: user.expires || null
  };
}

function getWizarrHeaders(apiKey) {
  return {
    Accept: 'application/json',
    'X-API-Key': apiKey
  };
}

function getWizarrHeaderVariants(apiKey) {
  const trimmedKey = String(apiKey || '').trim();
  const primary = getWizarrHeaders(trimmedKey);

  return [
    primary,
    { Accept: 'application/json', 'X-Api-Key': trimmedKey },
    { Accept: 'application/json', Authorization: `Bearer ${trimmedKey}` },
    { ...primary, Authorization: `Bearer ${trimmedKey}` }
  ];
}

function isTimeoutError(err) {
  const message = String(err?.message || '').toLowerCase();
  return err?.type === 'request-timeout' || message.includes('network timeout');
}

async function fetchJson(url, apiKey, timeout = WIZARR_LIST_TIMEOUT_MS) {
  const headersToTry = getWizarrHeaderVariants(apiKey);
  let lastError = null;

  for (const headers of headersToTry) {
    try {
      const resp = await fetch(url, {
        headers,
        timeout
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        const error = new Error(`HTTP ${resp.status} sur ${url}${body ? ` - ${body.slice(0, 160)}` : ''}`);
        error.status = resp.status;
        throw error;
      }

      return resp.json();
    } catch (err) {
      lastError = err;
      if (err?.status === 404 || isTimeoutError(err)) {
        throw err;
      }
    }
  }

  throw lastError || new Error(`Requete Wizarr impossible sur ${url}`);
}

async function probeWizarrConnection(wizarrUrl, apiKey) {
  if (!wizarrUrl || !apiKey) {
    return { ok: false, reason: 'Wizarr non configure', source: 'config', users: [] };
  }

  const endpoints = [
    `${wizarrUrl}/api/users?limit=1`,
    `${wizarrUrl}/api/users`,
    `${wizarrUrl}/api/v1/user?skip=0&take=1`
  ];
  const reasons = [];

  for (const url of endpoints) {
    try {
      const payload = await fetchJson(url, apiKey, 10000);
      return {
        ok: true,
        reason: null,
        source: url,
        users: normalizeList(payload).map(mapUser)
      };
    } catch (err) {
      reasons.push(
        isTimeoutError(err)
          ? `${url} - timeout apres 10000ms`
          : (err.message || `Erreur sur ${url}`)
      );
    }
  }

  return {
    ok: false,
    reason: reasons.join(' | ') || 'Connexion Wizarr impossible',
    source: 'none',
    users: []
  };
}

function computeSubscription(user) {
  if (!user) {
    return {
      status: 'not_found',
      label: 'Aucun abonnement',
      daysLeft: null,
      expiresAt: null,
      progressPercent: 0
    };
  }

  if (!user.expires) {
    return {
      status: 'unlimited',
      label: 'Illimite',
      daysLeft: 'Illimite',
      expiresAt: 'Jamais',
      progressPercent: 100
    };
  }

  const now = new Date();
  const expireDate = new Date(user.expires);

  if (isNaN(expireDate.getTime())) {
    return {
      status: 'not_found',
      label: 'Erreur date',
      daysLeft: null,
      expiresAt: null,
      progressPercent: 0
    };
  }

  const diffDays = Math.ceil((expireDate - now) / MS_PER_DAY);
  if (diffDays <= 0) {
    return {
      status: 'expired',
      label: 'Expire',
      daysLeft: '0 jour',
      expiresAt: expireDate.toLocaleDateString('fr-FR'),
      progressPercent: 0
    };
  }

  const status = diffDays <= 15 ? 'warning' : 'active';
  return {
    status,
    label: status === 'warning' ? 'Expire bientot' : 'Actif',
    daysLeft: `${diffDays} jours`,
    expiresAt: expireDate.toLocaleDateString('fr-FR'),
    progressPercent: Math.min(100, Math.round((diffDays / 365) * 100))
  };
}

async function getAllWizarrUsersDetailed(wizarrUrl, apiKey) {
  if (!wizarrUrl || !apiKey) {
    return { users: [], ok: false, reason: 'Wizarr non configure', source: 'config' };
  }

  const apiUsersEndpoints = [
    `${wizarrUrl}/api/users?limit=250`,
    `${wizarrUrl}/api/users?limit=1000`,
    `${wizarrUrl}/api/users`
  ];

  let lastError = null;
  const attemptReasons = [];

  for (const url of apiUsersEndpoints) {
    try {
      const payload = await fetchJson(url, apiKey);
      const list = normalizeList(payload);
      if (list.length > 0) {
        const filtered = list
          .map(mapUser)
          .filter(user => user.username || user.email || user.plexUserId);
        log.info(`getAllWizarrUsersDetailed success via ${url} (${filtered.length} users)`);
        return { users: filtered, ok: true, reason: null, source: url };
      }

      lastError = `Reponse vide sur ${url}`;
      attemptReasons.push(lastError);
    } catch (err) {
      if (err.status === 404) {
        log.debug(`Wizarr endpoint absent: ${url}`);
        continue;
      }

      lastError = isTimeoutError(err)
        ? `${url} - timeout apres ${WIZARR_LIST_TIMEOUT_MS}ms`
        : err.message;
      attemptReasons.push(lastError);
    }
  }

  const users = [];
  const take = 50;
  let skip = 0;
  let hasMore = true;
  let pageCount = 0;

  while (hasMore) {
    try {
      const url = `${wizarrUrl}/api/v1/user?skip=${skip}&take=${take}`;
      const payload = await fetchJson(url, apiKey);
      const page = normalizeList(payload);
      pageCount += 1;

      if (page.length === 0) {
        hasMore = false;
      } else {
        users.push(...page.map(mapUser));
        skip += take;
        const total = payload?.total ?? payload?.pageInfo?.results ?? null;
        if ((total !== null && users.length >= total) || page.length < take) {
          hasMore = false;
        }
      }
    } catch (err) {
      if (err.status === 404) {
        log.debug('Wizarr legacy endpoint /api/v1/user absent sur cette version');
      } else {
        const v1Error = isTimeoutError(err)
          ? `/api/v1/user - timeout apres ${WIZARR_LIST_TIMEOUT_MS}ms`
          : `/api/v1/user - ${err.message}`;
        if (!lastError) lastError = v1Error;
        attemptReasons.push(v1Error);
      }
      hasMore = false;
    }
  }

  const filtered = users.filter(user => user.username || user.email || user.plexUserId);
  if (filtered.length > 0) {
    return {
      users: filtered,
      ok: true,
      reason: null,
      source: `/api/v1/user (${pageCount} page${pageCount > 1 ? 's' : ''})`
    };
  }

  return {
    users: [],
    ok: false,
    reason: attemptReasons.length ? attemptReasons.join(' | ') : (lastError || 'Aucun utilisateur retourne par Wizarr'),
    source: 'none'
  };
}

async function getAllWizarrUsers(wizarrUrl, apiKey) {
  const result = await getAllWizarrUsersDetailed(wizarrUrl, apiKey);
  return result.users;
}

async function checkWizarrAccess(user, wizarrUrl, apiKey) {
  if (!wizarrUrl || !apiKey) {
    return { authorized: true, reason: 'Wizarr non configure - acces accorde par defaut' };
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
    const emailParam = encodeURIComponent(user.email);

    try {
      const payload = await fetchJson(`${wizarrUrl}/api/users?email=${emailParam}`, apiKey, 10000);
      const list = normalizeList(payload);
      log.debug('checkWizarrAccess direct email lookup', {
        ...debugContext,
        directMatches: list.length
      });
      wizUser = list[0] || null;
    } catch (err) {
      if (!isTimeoutError(err) && err.status) {
        return { authorized: false, reason: `Wizarr API ${err.status} - verification impossible` };
      }
      log.warn(`checkWizarrAccess direct lookup failed - ${err.message}`);
    }

    if (!wizUser) {
      const allUsers = await getAllWizarrUsers(wizarrUrl, apiKey);
      const targetEmail = String(user.email || '').trim().toLowerCase();
      const targetUsername = String(user.username || '').trim().toLowerCase();
      const targetPlexId = String(user.id || '').trim();

      log.debug('checkWizarrAccess fallback scan', {
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
      log.warn('checkWizarrAccess no match', debugContext);
      return { authorized: false, reason: 'Utilisateur non trouve dans Wizarr' };
    }

    log.info('checkWizarrAccess match', {
      ...debugContext,
      matchedUsername: wizUser.username || null,
      matchedEmail: wizUser.email || null,
      matchedPlexUserId: wizUser.plexUserId || null,
      expires: wizUser.expires || null
    });

    if (!wizUser.expires) {
      return { authorized: true };
    }

    const now = new Date();
    const expireDate = new Date(wizUser.expires);

    if (isNaN(expireDate.getTime())) {
      return { authorized: false, reason: 'Date d expiration invalide' };
    }

    const diffDays = Math.ceil((expireDate - now) / MS_PER_DAY);
    if (diffDays <= 0) {
      return { authorized: false, reason: `Abonnement expire le ${expireDate.toLocaleDateString('fr-FR')}` };
    }

    return { authorized: true };
  } catch (err) {
    return { authorized: false, reason: `Erreur Wizarr: ${err.message}` };
  }
}

module.exports = {
  computeSubscription,
  checkWizarrAccess,
  getAllWizarrUsers,
  getAllWizarrUsersDetailed,
  probeWizarrConnection,
  delay
};
