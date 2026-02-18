document.addEventListener("DOMContentLoaded", async () => {

  /* ===============================
     📅 SUBSCRIPTION
  =============================== */

  try {
    const res = await fetch("/api/subscription");
    if (!res.ok) throw new Error();
    const sub = await res.json();

    const statusEl = document.getElementById("subscriptionStatus");
    const contentEl = document.getElementById("subscriptionContent");

    statusEl.className = "status-mini " + sub.status;
    statusEl.textContent = sub.status || "Indispo";

    contentEl.innerHTML = `<p>${sub.daysLeft || "Accès illimité"}</p>`;

  } catch {
    document.getElementById("subscriptionStatus").textContent = "Erreur";
  }


  /* =====================================
     📊 STATS (Tracearr)
  ===================================== */

  const statusEl = document.getElementById("statsStatus");
  const contentEl = document.getElementById("statsContent");

  try {

    // ✅ Cache navigateur (30s)
    const cached = sessionStorage.getItem("statsCache");
    const cacheTime = sessionStorage.getItem("statsCacheTime");
    const now = Date.now();

    let data;

    if (cached && cacheTime && now - cacheTime < 30000) {
      data = JSON.parse(cached);
    } else {
      const res = await fetch("/api/stats", {
        headers: { "Accept": "application/json" }
      });

      if (!res.ok) throw new Error("stats_api_error");

      data = await res.json();

      sessionStorage.setItem("statsCache", JSON.stringify(data));
      sessionStorage.setItem("statsCacheTime", now);
    }

    if (!data || (!data.joinedAt && !data.lastActivity)) {
      statusEl.className = "status-mini loading";
      statusEl.textContent = "Indispo";
      contentEl.innerHTML = `<p class="subscription-loading">Données indisponibles.</p>`;
      return;
    }

    const joined = data.joinedAt
      ? new Date(data.joinedAt).toLocaleDateString("fr-FR")
      : "Inconnu";

    const last = data.lastActivity
      ? new Date(data.lastActivity).toLocaleString("fr-FR")
      : "Aucune";

    statusEl.className = "status-mini active";
    statusEl.textContent = "OK";

    contentEl.innerHTML = `
      <p style="font-size:14px; margin-bottom:6px;">
        📅 Membre depuis : <strong>${joined}</strong>
      </p>
      <p style="color:#bbb; font-size:13px;">
        🕒 Dernière activité : ${last}
      </p>
    `;

  } catch (err) {
    statusEl.className = "status-mini expired";
    statusEl.textContent = "Erreur";
    contentEl.innerHTML = `<p class="subscription-expired">Impossible de charger</p>`;
  }

});