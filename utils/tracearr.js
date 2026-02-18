const fetch = require("node-fetch");
const { getPlexJoinDate } = require("./plex");

async function getTracearrStats(username, TRACEARR_URL, TRACEARR_API_KEY, plexUserId, PLEX_URL, PLEX_TOKEN) {
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
      const plexJoinDate = await getPlexJoinDate(plexUserId, PLEX_URL, PLEX_TOKEN);
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
    console.error("Tracearr error:", err.message);
    return null;
  }
}

module.exports = { getTracearrStats };
