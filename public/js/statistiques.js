document.addEventListener("DOMContentLoaded", async () => {

  const basePath  = window.APP_BASE_PATH || "";
  const container = document.getElementById("statsContainer");
  const CACHE_DURATION = 30000; // 30 secondes (sessionStorage)
  const SWR_TTL        = 30 * 60 * 1000; // 30 min (localStorage stale-while-revalidate)

  // Récupérer l'ID utilisateur depuis le body
  const userId = document.body.getAttribute("data-user-id") || "guest";
  const SWR_KEY = 'stats_html_snap:' + userId;

  /* ===============================
     � DATE UTILITIES
  =============================== */

  function formatRelativeTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    const diffWeek = Math.floor(diffDay / 7);
    const diffMonth = Math.floor(diffDay / 30);
    const diffYear = Math.floor(diffDay / 365);

    if (diffYear > 0) return `il y a ${diffYear} an${diffYear > 1 ? 's' : ''}`;
    if (diffMonth > 0) return `il y a ${diffMonth} mois`;
    if (diffWeek > 0) return `il y a ${diffWeek} semaine${diffWeek > 1 ? 's' : ''}`;
    if (diffDay > 0) return `il y a ${diffDay} jour${diffDay > 1 ? 's' : ''}`;
    if (diffHour > 0) return `il y a ${diffHour}h`;
    if (diffMin > 0) return `il y a ${diffMin}min`;
    return 'À l\'instant';
  }

  /* ===============================
     �💾 CACHE UTILITIES
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

  // ⚡ Stale-While-Revalidate — restaurer instantanément depuis localStorage
  try {
    const raw = localStorage.getItem(SWR_KEY);
    if (raw) {
      const snap = JSON.parse(raw);
      if (snap.savedAt && Date.now() - snap.savedAt < SWR_TTL && snap.html) {
        container.innerHTML = snap.html;
        container.classList.remove('skel');
      }
    }
  } catch (_) {}

  /* ===============================
     📊 LOAD TAUTULLI STATS
  =============================== */

  async function loadTautulliStats() {
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
        ? formatRelativeTime(data.lastActivity)
        : "Aucune activité";

      return { joined, last };
    } catch (err) {
      console.error("Tautulli error:", err);
      return null;
    }
  }

  /* ===============================
     🎬 LOAD OVERSEERR STATS
  =============================== */

  async function loadSeerrStats() {
    try {
      let data = cacheManager.get("seerrCache");

      if (!data) {
        const res = await fetch(basePath + "/api/seerr");
        if (!res.ok) throw new Error("API error");

        data = await res.json();
        cacheManager.set("seerrCache", data);
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
      console.error("Seerr error:", err);
      return null;
    }
  }

  /* ===============================
     🚀 RENDER STATS
  =============================== */

  try {
    const [tautulliData, seerrData] = await Promise.all([
      loadTautulliStats(),
      loadSeerrStats()
    ]);

    let html = "";

    if (tautulliData) {
      html += `
        <div style="margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #333;">
          <div class="subscription-row">
            <span class="label">📅 Membre depuis</span>
            <span class="value">${tautulliData.joined}</span>
          </div>
          <div class="subscription-row">
            <span class="label">🕒 Dernière activité</span>
            <span class="value">${tautulliData.last}</span>
          </div>
        </div>
      `;
    }

    if (seerrData) {
      html += `
        <div>
          <h4 style="margin-bottom: 10px;"><img src="${window.APP_BASE_PATH || ''}/img/seerr-icon.png" alt="Seerr" style="width:16px;height:16px;object-fit:contain;vertical-align:middle;margin-right:4px;border-radius:3px;"> Demandes de contenu</h4>
          <div class="subscription-row">
            <span class="label">📊 Total demandes</span>
            <span class="value">${seerrData.total}</span>
          </div>
          <div class="subscription-row">
            <span class="label">🔄 En attente</span>
            <span class="value">${seerrData.pending}</span>
          </div>
          <div class="subscription-row">
            <span class="label">✅ Approuvées</span>
            <span class="value">${seerrData.approved}</span>
          </div>
        </div>
      `;
    }

    if (!tautulliData && !seerrData) {
      html = "<p>Aucune donnée disponible.</p>";
    }

    container.innerHTML = html;
    container.classList.remove('skel');

    // 💾 Persister pour la prochaine visite (stale-while-revalidate)
    try {
      localStorage.setItem(SWR_KEY, JSON.stringify({ html, savedAt: Date.now() }));
    } catch (_) {}

  } catch (err) {
    console.error("Stats loading error:", err);
    container.innerHTML = "<p>Erreur lors du chargement des statistiques.</p>";
  }

});
