const MS_PER_DAY = 1000 * 60 * 60 * 24;

function computeSubscription(user) {

  // ❌ Aucun utilisateur trouvé
  if (!user) {
    return {
      status: "not_found",
      label: "Aucun abonnement",
      daysLeft: null,
      expiresAt: null,
      progressPercent: 0
    };
  }

  // 🔵 Abonnement illimité
  if (!user.expires) {
    return {
      status: "unlimited",
      label: "Illimité",
      daysLeft: "Illimité",
      expiresAt: "Jamais",
      progressPercent: 100
    };
  }

  const now = new Date();
  const expireDate = new Date(user.expires);

  if (isNaN(expireDate.getTime())) {
    return {
      status: "not_found",
      label: "Erreur date",
      daysLeft: null,
      expiresAt: null,
      progressPercent: 0
    };
  }

  const diffDays = Math.ceil((expireDate - now) / MS_PER_DAY);

  // 🔴 Expiré
  if (diffDays <= 0) {
    return {
      status: "expired",
      label: "Expiré",
      daysLeft: "0 jour",
      expiresAt: expireDate.toLocaleDateString("fr-FR"),
      progressPercent: 0
    };
  }

  // 🟠 Warning si ≤ 15 jours
  const status = diffDays <= 15 ? "warning" : "active";

  return {
    status,
    label: status === "warning" ? "Expire bientôt" : "Actif",
    daysLeft: `${diffDays} jours`,
    expiresAt: expireDate.toLocaleDateString("fr-FR"),
    progressPercent: Math.min(100, Math.round((diffDays / 365) * 100))
  };
}

module.exports = { computeSubscription };
