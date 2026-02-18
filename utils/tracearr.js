const fetch = require("node-fetch");

async function getTracearrStats(username, TRACEARR_URL, TRACEARR_API_KEY) {
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

    return {
      joinedAt: foundUser.createdAt || null,
      lastActivity: foundUser.lastActivityAt || null
    };

  } catch (err) {
    console.error("Tracearr error:", err.message);
    return null;
  }
}

module.exports = { getTracearrStats };
