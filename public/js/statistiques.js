document.addEventListener("DOMContentLoaded", async () => {

  const basePath = window.APP_BASE_PATH || "";
  const container = document.getElementById("statsContainer");
  const CACHE_DURATION = 30000; // 30 secondes

  // Récupérer l'ID utilisateur depuis le body
  const userId = document.body.getAttribute("data-user-id") || "guest";

  /* ===============================
     💾 CACHE UTILITIES
  =============================== */

  const cacheManager = {
    get(key) {
      const cacheKey = `${key}:${userId}`;
      const cached = sessionStorage.getItem(cacheKey);
      const time = sessionStorage.getItem(`${cacheKey}:time`);
      const now = Date.now();

      if (cached && time && now - parseInt(time) < CACHE_DURATION) {
        return JSON.parse(cached);
      }
      
      sessionStorage.removeItem(cacheKey);
      sessionStorage.removeItem(`${cacheKey}:time`);
      return null;
    },

    set(key, data) {
      const cacheKey = `${key}:${userId}`;
      sessionStorage.setItem(cacheKey, JSON.stringify(data));
      sessionStorage.setItem(`${cacheKey}:time`, Date.now());
    },

    invalidate(key) {
      const cacheKey = `${key}:${userId}`;
      sessionStorage.removeItem(cacheKey);
      sessionStorage.removeItem(`${cacheKey}:time`);
    }
  };

  /* ===============================
     📊 LOAD TRACEARR STATS
  =============================== */

  async function loadTracearrStats() {
    try {
      let data = cacheManager.get("statsCache");

      if (!data) {
        const res = await fetch(basePath + "/api/stats");
        if (!res.ok) throw new Error("API error");

        data = await res.json();
        cacheManager.set("statsCache", data);
      }

      if (!data || (!data.joinedAt && !data.lastActivity)) {
        return null;
      }

      const joined = data.joinedAt
        ? new Date(data.joinedAt).toLocaleDateString("fr-FR")
        : "Inconnu";

      const last = data.lastActivity
        ? new Date(data.lastActivity).toLocaleString("fr-FR")
        : "Aucune activité";

      return { joined, last };
    } catch (err) {
      console.error("Tracearr error:", err);
      return null;
    }
  }

  /* ===============================
     🎬 LOAD OVERSEERR STATS
  =============================== */

  async function loadOverseerrStats() {
    try {
      let data = cacheManager.get("overseerrCache");

      if (!data) {
        const res = await fetch(basePath + "/api/overseerr");
        if (!res.ok) throw new Error("API error");

        data = await res.json();
        cacheManager.set("overseerrCache", data);
      }

      if (!data || !data.total) {
        return null;
      }

      return {
        pending: data.pending || 0,
        approved: data.approved || 0,
        available: data.available || 0,
        total: data.total || 0
      };
    } catch (err) {
      console.error("Overseerr error:", err);
      return null;
    }
  }

  /* ===============================
     🚀 RENDER STATS
  =============================== */

  try {
    const [tracearrData, overseerrData] = await Promise.all([
      loadTracearrStats(),
      loadOverseerrStats()
    ]);

    let html = "";

    if (tracearrData) {
      html += `
        <div style="margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #333;">
          <div class="subscription-row">
            <span class="label">📅 Membre depuis</span>
            <span class="value">${tracearrData.joined}</span>
          </div>
          <div class="subscription-row">
            <span class="label">🕒 Dernière activité</span>
            <span class="value">${tracearrData.last}</span>
          </div>
        </div>
      `;
    }

    if (overseerrData) {
      html += `
        <div>
          <h4 style="margin-bottom: 10px;">🎬 Overseerr</h4>
          <div class="subscription-row">
            <span class="label">📊 Total demandes</span>
            <span class="value">${overseerrData.total}</span>
          </div>
          <div class="subscription-row">
            <span class="label">🔄 En attente</span>
            <span class="value">${overseerrData.pending}</span>
          </div>
          <div class="subscription-row">
            <span class="label">✅ Approuvées</span>
            <span class="value">${overseerrData.approved}</span>
          </div>
        </div>
      `;
    }

    if (!tracearrData && !overseerrData) {
      html = "<p>Aucune donnée disponible.</p>";
    }

    container.innerHTML = html;

  } catch (err) {
    console.error("Stats loading error:", err);
    container.innerHTML = "<p>Erreur lors du chargement des statistiques.</p>";
  }

});
