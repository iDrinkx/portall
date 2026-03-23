const fetch = require("node-fetch");
const { AppSettingQueries } = require("./database");
const { getConfigValue } = require("./config");
const seerrLog = require("./logger").create("[Seerr]");

let cachedSeerrSessionCookie = null;
let cachedSeerrSessionCookieExpiresAt = 0;

function getAdminPlexToken() {
  return String(
    AppSettingQueries.get("runtime_plex_cloud_token", "") ||
    getConfigValue("PLEX_TOKEN", "") ||
    process.env.PLEX_TOKEN ||
    ""
  ).trim();
}

async function createSeerrSessionCookie(SEERR_URL) {
  const now = Date.now();
  if (cachedSeerrSessionCookie && cachedSeerrSessionCookieExpiresAt > now) {
    return cachedSeerrSessionCookie;
  }

  const adminPlexToken = getAdminPlexToken();
  if (!SEERR_URL || !adminPlexToken) return null;

  try {
    const res = await fetch(`${SEERR_URL.replace(/\/$/, "")}/api/v1/auth/plex`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ authToken: adminPlexToken })
    });

    if (!res.ok) {
      seerrLog.warn(`Impossible d'ouvrir une session Seerr admin: HTTP ${res.status}`);
      return null;
    }

    const setCookies = res.headers.raw()["set-cookie"] || [];
    const sidCookie = setCookies.find(cookie => cookie.startsWith("connect.sid="));
    if (!sidCookie) {
      seerrLog.warn("Session Seerr admin ouverte sans connect.sid");
      return null;
    }

    cachedSeerrSessionCookie = sidCookie.split(";")[0];
    cachedSeerrSessionCookieExpiresAt = now + (10 * 60 * 1000);
    return cachedSeerrSessionCookie;
  } catch (err) {
    seerrLog.warn(`Erreur session Seerr admin: ${err.message}`);
    return null;
  }
}

async function fetchSeerrJson(url, SEERR_API_KEY, SEERR_URL, options = {}) {
  const requireSession = options.requireSession === true;

  async function run(headers) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, status: res.status, text };
    }
    return { ok: true, json: await res.json() };
  }

  if (!requireSession) {
    const apiAttempt = await run({
      "X-API-Key": SEERR_API_KEY,
      "Accept": "application/json"
    });

    if (apiAttempt.ok) {
      return apiAttempt.json;
    }

    const bodyText = String(apiAttempt.text || "");
    const needsCookie = /connect\.sid/i.test(bodyText) || /cookie.+required/i.test(bodyText);
    if (!needsCookie) {
      return null;
    }
  }

  const sessionCookie = await createSeerrSessionCookie(SEERR_URL);
  if (!sessionCookie) return null;

  const cookieAttempt = await run({
    "Cookie": sessionCookie,
    "Accept": "application/json"
  });

  return cookieAttempt.ok ? cookieAttempt.json : null;
}

/**
 * Cherche un utilisateur Seerr par email OU username Plex
 * @param {string} email - Email a chercher
 * @param {string} SEERR_URL - URL de base d'Seerr
 * @param {string} SEERR_API_KEY - Cle API Seerr
 * @param {string} username - Username Plex a chercher aussi en fallback
 * @returns {Promise<Object|null>} Utilisateur trouve ou null
 */
async function findSeerrUserByEmail(email, SEERR_URL, SEERR_API_KEY, username = null) {
  try {
    if (!email || !SEERR_URL || !SEERR_API_KEY) {
      return null;
    }

    let allUsers = [];
    let page = 0;
    let hasMore = true;
    let pageInfo = null;

    while (hasMore) {
      const url = new URL(`${SEERR_URL}/api/v1/user`);
      url.searchParams.set("skip", page * 50);
      url.searchParams.set("take", 50);

      const res = await fetch(url.toString(), {
        headers: {
          "X-API-Key": SEERR_API_KEY,
          "Accept": "application/json"
        }
      });

      if (!res.ok) break;

      const json = await res.json();
      pageInfo = json.pageInfo;

      let users = [];
      if (Array.isArray(json)) {
        users = json;
      } else if (Array.isArray(json.results)) {
        users = json.results;
      } else if (Array.isArray(json.data)) {
        users = json.data;
      } else if (Array.isArray(json.users)) {
        users = json.users;
      }

      if (users.length === 0) break;

      allUsers = allUsers.concat(users);

      if (pageInfo?.pages && page + 1 >= pageInfo.pages) {
        hasMore = false;
      }

      page++;
    }

    let found = allUsers.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
    if (found) return found;

    if (username) {
      const target = username.toLowerCase();
      found = allUsers.find(u => {
        const displayName = String(u.displayName || "").toLowerCase();
        const usernameField = String(u.username || "").toLowerCase();
        const plexUsername = String(u.plexUsername || "").toLowerCase();
        return (
          displayName === target ||
          usernameField === target ||
          plexUsername === target ||
          displayName.includes(target) ||
          usernameField.includes(target) ||
          plexUsername.includes(target)
        );
      });
      if (found) return found;
    }

    return null;
  } catch (err) {
    seerrLog.error("findSeerrUserByEmail:", err.message);
    return null;
  }
}

/**
 * Recupere l'utilisateur courant Seerr via la cle API
 * @param {string} SEERR_URL - URL de base d'Seerr
 * @param {string} SEERR_API_KEY - Cle API Seerr
 * @returns {Promise<Object|null>} Utilisateur courant avec son ID
 */
async function getCurrentSeerrUser(SEERR_URL, SEERR_API_KEY) {
  try {
    if (!SEERR_URL || !SEERR_API_KEY) {
      return null;
    }

    const url = `${SEERR_URL}/api/v1/auth/me`;
    const res = await fetch(url, {
      headers: {
        "X-API-Key": SEERR_API_KEY,
        "Accept": "application/json"
      }
    });

    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

/**
 * Recupere les statistiques Seerr pour un utilisateur specifique
 * @param {string} userEmail - Email de l'utilisateur Plex
 * @param {string} username - Username Plex
 * @param {string} SEERR_URL - URL de base d'Seerr
 * @param {string} SEERR_API_KEY - Cle API Seerr
 * @returns {Promise<Object|null>} Stats avec quotas restants
 */
async function getSeerrStats(userEmail, username, SEERR_URL, SEERR_API_KEY) {
  try {
    if (!SEERR_URL || !SEERR_API_KEY || !userEmail) {
      return null;
    }

    const seerrUser = await findSeerrUserByEmail(userEmail, SEERR_URL, SEERR_API_KEY, username);
    if (!seerrUser?.id) {
      return null;
    }

    const userIdNum = Number(seerrUser.id);
    let allRequests = [];
    let skip = 0;
    const take = 50;
    let hasMore = true;

    while (hasMore) {
      const url = new URL(`${SEERR_URL}/api/v1/user/${userIdNum}/requests`);
      url.searchParams.set("skip", skip);
      url.searchParams.set("take", take);

      const json = await fetchSeerrJson(url.toString(), SEERR_API_KEY, SEERR_URL);
      if (!json) break;

      let requests = [];
      if (Array.isArray(json)) {
        requests = json;
      } else if (Array.isArray(json.results)) {
        requests = json.results;
      } else if (Array.isArray(json.data)) {
        requests = json.data;
      }

      if (requests.length === 0) break;

      allRequests = allRequests.concat(requests);
      if (requests.length < take) {
        hasMore = false;
      } else {
        skip += take;
      }
    }

    const quotaJson = await fetchSeerrJson(
      `${SEERR_URL}/api/v1/user/${userIdNum}/quota`,
      SEERR_API_KEY,
      SEERR_URL,
      { requireSession: true }
    );

    const now = Date.now();

    const buildQuotaSummary = (type, limit, days, explicitUsed = null, explicitRemaining = null, restricted = false) => {
      const normalizedLimit = Number(limit);
      const normalizedDays = Number(days);
      const hasLimit = Number.isFinite(normalizedLimit) && normalizedLimit > 0;
      const hasDays = Number.isFinite(normalizedDays) && normalizedDays > 0;

      if (hasLimit && hasDays && Number.isFinite(Number(explicitUsed)) && Number.isFinite(Number(explicitRemaining))) {
        const remaining = Math.max(0, Number(explicitRemaining));
        return {
          limit: normalizedLimit,
          days: normalizedDays,
          used: Number(explicitUsed),
          remaining,
          restricted: Boolean(restricted),
          text: `${remaining} sur ${normalizedLimit} restantes`
        };
      }

      if (!hasLimit || !hasDays) {
        return {
          limit: hasLimit ? normalizedLimit : null,
          days: hasDays ? normalizedDays : null,
          used: 0,
          remaining: null,
          restricted: Boolean(restricted),
          text: "Illimité"
        };
      }

      const cutoff = now - (normalizedDays * 24 * 60 * 60 * 1000);
      const used = allRequests.filter(req => {
        const requestType = String(req.type || req.media?.mediaType || "").toLowerCase();
        if (requestType !== type) return false;
        const createdAtMs = req.createdAt ? Date.parse(req.createdAt) : 0;
        return Number.isFinite(createdAtMs) && createdAtMs >= cutoff;
      }).length;

      const remaining = Math.max(0, normalizedLimit - used);
      return {
        limit: normalizedLimit,
        days: normalizedDays,
        used,
        remaining,
        restricted: Boolean(restricted),
        text: `${remaining} sur ${normalizedLimit} restantes`
      };
    };

    let pending = 0;
    let approved = 0;
    let approvedAvailable = 0;
    let available = 0;
    let unavailable = 0;
    let movieRequests = 0;
    let tvRequests = 0;

    allRequests.forEach(req => {
      const requestType = String(req.type || req.media?.mediaType || "").toLowerCase();
      if (requestType === "movie") movieRequests++;
      else if (requestType === "tv") tvRequests++;

      if (req.status === 1) {
        pending++;
      } else if (req.status === 2) {
        approved++;
        if (req.media?.status === 5) approvedAvailable++;
      } else if (req.status === 3) {
        unavailable++;
      }

      if (req.media?.status === 5) {
        available++;
      }
    });

    const movieQuota = buildQuotaSummary(
      "movie",
      quotaJson?.movie?.limit ?? seerrUser.movieQuotaLimit,
      quotaJson?.movie?.days ?? seerrUser.movieQuotaDays,
      quotaJson?.movie?.used,
      quotaJson?.movie?.remaining,
      quotaJson?.movie?.restricted
    );

    const tvQuota = buildQuotaSummary(
      "tv",
      quotaJson?.tv?.limit ?? seerrUser.tvQuotaLimit,
      quotaJson?.tv?.days ?? seerrUser.tvQuotaDays,
      quotaJson?.tv?.used,
      quotaJson?.tv?.remaining,
      quotaJson?.tv?.restricted
    );

    return {
      pending,
      movieRequests,
      tvRequests,
      movieQuota,
      tvQuota,
      approved: approved - approvedAvailable,
      available: approvedAvailable,
      unavailable,
      total: allRequests.length || Number(seerrUser.requestCount || 0)
    };
  } catch (err) {
    seerrLog.error("getSeerrStats:", err.message);
    return null;
  }
}

/**
 * Recupere les statistiques globales d'Seerr
 * @param {string} SEERR_URL - URL de base d'Seerr
 * @param {string} SEERR_API_KEY - Cle API Seerr
 * @returns {Promise<Object|null>} Stats globales
 */
async function getSeerrGlobalStats(SEERR_URL, SEERR_API_KEY) {
  try {
    if (!SEERR_URL || !SEERR_API_KEY) return null;

    const url = new URL(`${SEERR_URL}/api/v1/request`);
    url.searchParams.set("sort", "updated");
    url.searchParams.set("page", "1");
    url.searchParams.set("perPage", "1");

    const res = await fetch(url.toString(), {
      headers: {
        "X-API-Key": SEERR_API_KEY,
        "Accept": "application/json"
      }
    });

    if (!res.ok) return null;

    const json = await res.json();
    const totalRequests = Number(json.pageInfo?.results || json.pageInfo?.totalResults || 0);

    return {
      totalRequests,
      pending: 0,
      approved: 0,
      available: 0
    };
  } catch (err) {
    seerrLog.error("getSeerrGlobalStats:", err.message);
    return null;
  }
}

module.exports = {
  getSeerrStats,
  getSeerrGlobalStats,
  getCurrentSeerrUser,
  findSeerrUserByEmail
};
