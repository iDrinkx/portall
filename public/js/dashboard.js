document.addEventListener("DOMContentLoaded", async () => {

  const basePath = window.APP_BASE_PATH || "";
  const CACHE_DURATION = 30000; // 30 secondes

  /* ===============================
     💾 CACHE UTILITIES
  =============================== */

  const cacheManager = {
    get(key) {
      const cached = sessionStorage.getItem(key);
      const time = sessionStorage.getItem(`${key}:time`);
      const now = Date.now();

      if (cached && time && now - parseInt(time) < CACHE_DURATION) {
        return JSON.parse(cached);
      }
      
      sessionStorage.removeItem(key);
      sessionStorage.removeItem(`${key}:time`);
      return null;
    },

    set(key, data) {
      sessionStorage.setItem(key, JSON.stringify(data));
      sessionStorage.setItem(`${key}:time`, Date.now());
    },

    invalidate(key) {
      sessionStorage.removeItem(key);
      sessionStorage.removeItem(`${key}:time`);
    },

    invalidateAll() {
      ["subscriptionCache", "statsCache", "overseerrCache"].forEach(key => this.invalidate(key));
    }
  };

  // Expose pour utilisation depuis le HTML si besoin
  window.cacheManager = cacheManager;

  /* ===============================
     📅 SUBSCRIPTION
  =============================== */

  async function loadSubscription() {
    const statusEl = document.getElementById("subscriptionStatus");
    const contentEl = document.getElementById("subscriptionContent");

    try {
      // Vérifier cache local (30s)
      let sub = cacheManager.get("subscriptionCache");

      if (!sub) {
        const res = await fetch(basePath + "/api/subscription");
        if (!res.ok) throw new Error("API error");
        sub = await res.json();
        cacheManager.set("subscriptionCache", sub);
      }

      statusEl.className = "status-mini " + sub.status;
      statusEl.textContent = sub.status || "Indispo";
      contentEl.innerHTML = `<p>${sub.daysLeft || "Accès illimité"}</p>`;

    } catch (err) {
      console.error("Subscription load error:", err);
      statusEl.textContent = "Erreur";
    }
  }

  /* =====================================
     📊 STATS (Tracearr + Overseerr)
  ===================================== */

  async function loadStats() {
    const statusEl = document.getElementById("statsStatus");
    const contentEl = document.getElementById("statsContent");

    try {
      // Charger Tracearr stats
      let tracearrData = cacheManager.get("statsCache");
      if (!tracearrData) {
        const res = await fetch(basePath + "/api/stats", {
          headers: { "Accept": "application/json" }
        });
        if (!res.ok) throw new Error("stats_api_error");
        tracearrData = await res.json();
        cacheManager.set("statsCache", tracearrData);
      }

      // Charger Overseerr stats
      let overseerrData = cacheManager.get("overseerrCache");
      if (!overseerrData) {
        const res = await fetch(basePath + "/api/overseerr", {
          headers: { "Accept": "application/json" }
        });
        if (!res.ok) throw new Error("overseerr_api_error");
        overseerrData = await res.json();
        cacheManager.set("overseerrCache", overseerrData);
      }

      // Vérifier si on a au moins une donnée
      const hasTracearrData = tracearrData && (tracearrData.joinedAt || tracearrData.lastActivity);
      const hasOverseerrData = overseerrData && overseerrData.total > 0;

      if (!hasTracearrData && !hasOverseerrData) {
        statusEl.className = "status-mini loading";
        statusEl.textContent = "Indispo";
        contentEl.innerHTML = `<p class="subscription-loading">Données indisponibles.</p>`;
        return;
      }

      statusEl.className = "status-mini active";
      statusEl.textContent = "OK";

      let html = "";

      // Afficher derniere activité Tracearr
      if (hasTracearrData && tracearrData.lastActivity) {
        const last = new Date(tracearrData.lastActivity).toLocaleString("fr-FR");
        html += `<p style="font-size:14px; margin-bottom:6px;">🕒 Dernière activité : <strong>${last}</strong></p>`;
      }

      // Afficher nombre de demandes Overseerr
      if (hasOverseerrData) {
        html += `<p style="color:#bbb; font-size:13px;">🎬 Demandes : ${overseerrData.total}</p>`;
      }

      contentEl.innerHTML = html;

    } catch (err) {
      console.error("Stats load error:", err);
      statusEl.className = "status-mini expired";
      statusEl.textContent = "Erreur";
      contentEl.innerHTML = `<p class="subscription-expired">Impossible de charger</p>`;
    }
  }

  /* ===============================
     🚀 LOAD ALL DATA
  =============================== */

  await Promise.all([
    loadSubscription(),
    loadStats()
  ]);

});