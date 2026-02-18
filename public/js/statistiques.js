document.addEventListener("DOMContentLoaded", async () => {

  const container = document.getElementById("statsContainer");

  try {

    // ✅ Cache navigateur 30s
    const cached = sessionStorage.getItem("statsCache");
    const cacheTime = sessionStorage.getItem("statsCacheTime");
    const now = Date.now();

    let data;

    if (cached && cacheTime && now - cacheTime < 30000) {
      data = JSON.parse(cached);
    } else {
      const res = await fetch("/api/stats");
      if (!res.ok) throw new Error("API error");

      data = await res.json();

      sessionStorage.setItem("statsCache", JSON.stringify(data));
      sessionStorage.setItem("statsCacheTime", now);
    }

    if (!data || (!data.joinedAt && !data.lastActivity)) {
      container.innerHTML = "<p>Données indisponibles.</p>";
      return;
    }

    const joined = data.joinedAt
      ? new Date(data.joinedAt).toLocaleDateString("fr-FR")
      : "Inconnu";

    const last = data.lastActivity
      ? new Date(data.lastActivity).toLocaleString("fr-FR")
      : "Aucune activité";

    container.innerHTML = `
      <div class="subscription-row">
        <span class="label">📅 Membre depuis</span>
        <span class="value">${joined}</span>
      </div>

      <div class="subscription-row">
        <span class="label">🕒 Dernière activité</span>
        <span class="value">${last}</span>
      </div>
    `;

  } catch (err) {
    container.innerHTML = "<p>Erreur lors du chargement.</p>";
  }

});
