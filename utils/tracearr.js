const fetch = require("node-fetch");
const { getPlexJoinDate } = require("./plex");

async function getTracearrStats(username, TRACEARR_URL, TRACEARR_API_KEY, plexUserId, PLEX_URL, PLEX_TOKEN, joinedAtTimestamp = null) {
  try {
    if (!TRACEARR_URL || !TRACEARR_API_KEY) return null;

    let page = 1;
    let totalPages = 1;
    let foundUser = null;

    while (page <= totalPages) {
      const res = await fetch(
        `${TRACEARR_URL}/api/v1/public/users?page=${page}&pageSize=50`,
        {
          headers: {
            Authorization: `Bearer ${TRACEARR_API_KEY}`,
            Accept: "application/json"
          }
        }
      );

      if (!res.ok) return null;

      const json = await res.json();
      if (!json?.data) return null;

      totalPages = Math.ceil(json.meta.total / json.meta.pageSize);

      foundUser = json.data.find(
        u => u.username?.toLowerCase() === username.toLowerCase()
      );

      if (foundUser) break;

      page++;
    }

    if (!foundUser) return null;

    // Prioriser Plex pour une date plus fiable
    let joinedAt = null;
    
    if (plexUserId && PLEX_URL && PLEX_TOKEN) {
      const plexJoinDate = await getPlexJoinDate(plexUserId, PLEX_URL, PLEX_TOKEN, joinedAtTimestamp);
      joinedAt = plexJoinDate ? plexJoinDate.toISOString() : null;
    }
    
    // Fallback sur Tracearr si Plex ne fourni pas de date
    if (!joinedAt) {
      joinedAt = foundUser.createdAt || null;
    }

    return {
      joinedAt,
      lastActivity: foundUser.lastActivityAt || null
    };

  } catch (err) {
    return null;
  }
}

async function getTracearrActivity(username, TRACEARR_URL, TRACEARR_API_KEY) {
  try {
    if (!TRACEARR_URL || !TRACEARR_API_KEY) {
      console.log("[Tracearr] Missing URL or API key");
      return null;
    }

    console.log(`[Tracearr] Searching for user: ${username}`);
    let page = 1;
    let totalPages = 1;
    let foundUser = null;

    // Trouver l'utilisateur
    while (page <= totalPages) {
      console.log(`[Tracearr] Fetching users page ${page}/${totalPages}`);
      const res = await fetch(
        `${TRACEARR_URL}/api/v1/public/users?page=${page}&pageSize=50`,
        {
          headers: {
            Authorization: `Bearer ${TRACEARR_API_KEY}`,
            Accept: "application/json"
          }
        }
      );

      if (!res.ok) {
        console.log(`[Tracearr] Failed to fetch users: ${res.status} ${res.statusText}`);
        return null;
      }

      const json = await res.json();
      if (!json?.data) {
        console.log("[Tracearr] No data in response");
        return null;
      }

      console.log(`[Tracearr] Got ${json.data.length} users on page ${page}`);
      totalPages = Math.ceil(json.meta.total / json.meta.pageSize);

      foundUser = json.data.find(
        u => u.username?.toLowerCase() === username.toLowerCase()
      );

      if (foundUser) {
        console.log(`[Tracearr] Found user with ID: ${foundUser.id}`);
        break;
      }

      page++;
    }

    if (!foundUser) {
      console.log(`[Tracearr] User ${username} not found`);
      return null;
    }

    // Récupérer l'historique d'activité de l'utilisateur
    console.log(`[Tracearr] Fetching activity for user ${foundUser.id}`);
    const activityRes = await fetch(
      `${TRACEARR_URL}/api/v1/public/users/${foundUser.id}/activity?pageSize=100`,
      {
        headers: {
          Authorization: `Bearer ${TRACEARR_API_KEY}`,
          Accept: "application/json"
        }
      }
    );

    if (!activityRes.ok) {
      console.log(`[Tracearr] Activity endpoint returned ${activityRes.status} ${activityRes.statusText}`);
      // Fallback: retourner juste l'info utilisateur sans historique
      return {
        user: {
          id: foundUser.id,
          username: foundUser.username,
          avatar: foundUser.avatar || null,
          createdAt: foundUser.createdAt,
          lastActivityAt: foundUser.lastActivityAt
        },
        activities: []
      };
    }

    const activityData = await activityRes.json();
    const activities = Array.isArray(activityData) ? activityData : (activityData.data || []);

    console.log(`[Tracearr] Got ${activities.length} activities`);

    return {
      user: {
        id: foundUser.id,
        username: foundUser.username,
        avatar: foundUser.avatar || null,
        createdAt: foundUser.createdAt,
        lastActivityAt: foundUser.lastActivityAt
      },
      activities: activities || []
    };

  } catch (err) {
    console.log(`[Tracearr] Error: ${err.message}`);
    return null;
  }
}

module.exports = { getTracearrStats, getTracearrActivity };
