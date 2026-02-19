// Système d'Achievements/Trophées
const ACHIEVEMENTS = {
  // 🎁 TEMPORELS
  temporels: [
    {
      id: "first-anniversary",
      name: "Premier Anniversaire",
      icon: "🎂",
      description: "Un an déjà ! Merci de la fidélité",
      condition: (data) => data.daysSince >= 365,
      conditionText: "1 an d'ancienneté sur Dark TV",
      getProgress: (data) => ({
        current: Math.min(data.daysSince, 365),
        total: 365,
        percent: Math.min(Math.round((data.daysSince / 365) * 100), 100)
      }),
      unlockedDate: null,
      category: "temporels"
    },
    {
      id: "veteran",
      name: "Vétéran",
      icon: "🛡️",
      description: "Plus de 2 ans d'ancienneté sur Dark TV",
      condition: (data) => data.daysSince >= 730,
      conditionText: "Plus de 2 ans d'ancienneté sur Dark TV",
      getProgress: (data) => ({
        current: Math.min(data.daysSince, 730),
        total: 730,
        percent: Math.min(Math.round((data.daysSince / 730) * 100), 100)
      }),
      unlockedDate: null,
      category: "temporels"
    },
    {
      id: "old-timer",
      name: "Vieux de la Veille",
      icon: "👴",
      description: "Plus de 10 ans d'ancienneté sur Dark TV",
      condition: (data) => data.daysSince >= 3650,
      conditionText: "Plus de 5 ans d'ancienneté sur Dark TV",
      getProgress: (data) => ({
        current: Math.min(data.daysSince, 1825),
        total: 1825,
        percent: Math.min(Math.round((data.daysSince / 1825) * 100), 100)
      }),
      unlockedDate: null,
      category: "temporels"
    },
    {
      id: "og",
      name: "OG",
      icon: "⭐",
      description: "Premier visionnage en 2024 lors du lancement",
      condition: (data) => false,
      conditionText: "Premier visionnage en 2024 lors du lancement",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: null,
      category: "temporels"
    }
  ],

  // 🔥 ACTIVITÉ
  activites: [
    {
      id: "first-watch",
      name: "Premier Pas",
      icon: "🎬",
      description: "Ton premier visionnage sur Dark TV",
      condition: (data) => data.sessionCount >= 1,
      conditionText: "Regardez votre premier visionnage",
      getProgress: (data) => ({
        current: Math.min(data.sessionCount, 1),
        total: 1,
        percent: Math.min(Math.round((data.sessionCount / 1) * 100), 100)
      }),
      unlockedDate: null,
      category: "activites"
    },
    {
      id: "regular",
      name: "Régulier",
      icon: "🔥",
      description: "Au moins 1 visionnage par jour pendant 7 jours",
      condition: (data) => data.sessionCount >= 7,
      conditionText: "Au moins 1 visionnage par jour pendant 7 jours",
      getProgress: (data) => ({
        current: Math.min(data.sessionCount, 7),
        total: 7,
        percent: Math.min(Math.round((data.sessionCount / 7) * 100), 100)
      }),
      unlockedDate: null,
      category: "activites"
    },
    {
      id: "night-owl",
      name: "Oiseau de Nuit",
      icon: "🦉",
      description: "Plus de 30 visionages entre 22h et 6h",
      condition: (data) => false,
      conditionText: "Plus de 30 visionages entre 22h et 6h",
      getProgress: (data) => ({
        current: 0,
        total: 30,
        percent: 0
      }),
      unlockedDate: null,
      category: "activites"
    },
    {
      id: "early-bird",
      name: "Lève-Tôt",
      icon: "🐦",
      description: "Plus de 50 visionnages entre 6h et 9h",
      condition: (data) => data.sessionCount >= 50,
      conditionText: "Plus de 50 visionnages entre 6h et 9h",
      getProgress: (data) => ({
        current: Math.min(data.sessionCount, 50),
        total: 50,
        percent: Math.min(Math.round((data.sessionCount / 50) * 100), 100)
      }),
      unlockedDate: null,
      category: "activites"
    },
    {
      id: "centurion",
      name: "Centurion",
      icon: "💯",
      description: "Plus de 100 heures de visionnage au total",
      condition: (data) => data.totalHours >= 100,
      conditionText: "Plus de 100 heures de visionnage au total",
      getProgress: (data) => ({
        current: Math.min(Math.round(data.totalHours), 100),
        total: 100,
        percent: Math.min(Math.round((data.totalHours / 100) * 100), 100)
      }),
      unlockedDate: null,
      category: "activites"
    },
    {
      id: "marathoner",
      name: "Marathonien",
      icon: "🏃",
      description: "Plus de 500 heures de visionnage au total",
      condition: (data) => data.totalHours >= 500,
      conditionText: "Plus de 500 heures de visionnage au total",
      getProgress: (data) => ({
        current: Math.min(Math.round(data.totalHours), 500),
        total: 500,
        percent: Math.min(Math.round((data.totalHours / 500) * 100), 100)
      }),
      unlockedDate: null,
      category: "activites"
    }
  ],

  // 🎬 FILMS
  films: [
    {
      id: "cinema-marathon",
      name: "Marathon Cinéma",
      icon: "🍿",
      description: "5 films regardés en 24 heures",
      condition: (data) => data.movieCount >= 5,
      conditionText: "5 films regardés en 24 heures",
      getProgress: (data) => ({
        current: Math.min(data.movieCount, 5),
        total: 5,
        percent: Math.min(Math.round((data.movieCount / 5) * 100), 100)
      }),
      unlockedDate: null,
      category: "films"
    },
    {
      id: "cinephile",
      name: "Cinéphile",
      icon: "🎥",
      description: "50 films regardés au total",
      condition: (data) => data.movieCount >= 50,
      conditionText: "50 films regardés au total",
      getProgress: (data) => ({
        current: Math.min(data.movieCount, 50),
        total: 50,
        percent: Math.min(Math.round((data.movieCount / 50) * 100), 100)
      }),
      unlockedDate: null,
      category: "films"
    },
    {
      id: "film-critic",
      name: "Critique Ciné",
      icon: "📋",
      description: "100 films regardés au total",
      condition: (data) => data.movieCount >= 100,
      conditionText: "100 films regardés au total",
      getProgress: (data) => ({
        current: Math.min(data.movieCount, 100),
        total: 100,
        percent: Math.min(Math.round((data.movieCount / 100) * 100), 100)
      }),
      unlockedDate: null,
      category: "films"
    },
    {
      id: "cinema-master",
      name: "Maître du Cinéma",
      icon: "👑",
      description: "250 films regardés au total",
      condition: (data) => data.movieCount >= 250,
      conditionText: "250 films regardés au total",
      getProgress: (data) => ({
        current: Math.min(data.movieCount, 250),
        total: 250,
        percent: Math.min(Math.round((data.movieCount / 250) * 100), 100)
      }),
      unlockedDate: null,
      category: "films"
    },
    {
      id: "hollywood-legend",
      name: "Légende d'Hollywood",
      icon: "✨",
      description: "500 films regardés au total",
      condition: (data) => data.movieCount >= 500,
      conditionText: "500 films regardés au total",
      getProgress: (data) => ({
        current: Math.min(data.movieCount, 500),
        total: 500,
        percent: Math.min(Math.round((data.movieCount / 500) * 100), 100)
      }),
      unlockedDate: null,
      category: "films"
    }
  ],

  // 📺 SÉRIES
  series: [
    {
      id: "binge-watcher",
      name: "Binge Watcher",
      icon: "📺",
      description: "10 épisodes d'une série en 24h",
      condition: (data) => data.episodeCount >= 10,
      conditionText: "10 épisodes d'une série en 24h",
      getProgress: (data) => ({
        current: Math.min(data.episodeCount, 10),
        total: 10,
        percent: Math.min(Math.round((data.episodeCount / 10) * 100), 100)
      }),
      unlockedDate: null,
      category: "series"
    },
    {
      id: "series-addict",
      name: "Accro aux Séries",
      icon: "🚀",
      description: "100 épisodes regardés au total",
      condition: (data) => data.episodeCount >= 100,
      conditionText: "100 épisodes regardés au total",
      getProgress: (data) => ({
        current: Math.min(data.episodeCount, 100),
        total: 100,
        percent: Math.min(Math.round((data.episodeCount / 100) * 100), 100)
      }),
      unlockedDate: null,
      category: "series"
    },
    {
      id: "series-master",
      name: "Maître des Séries",
      icon: "🎭",
      description: "500 épisodes regardés au total",
      condition: (data) => data.episodeCount >= 500,
      conditionText: "500 épisodes regardés au total",
      getProgress: (data) => ({
        current: Math.min(data.episodeCount, 500),
        total: 500,
        percent: Math.min(Math.round((data.episodeCount / 500) * 100), 100)
      }),
      unlockedDate: null,
      category: "series"
    },
    {
      id: "serial-killer-legend",
      name: "Légende Serial Killer",
      icon: "👹",
      description: "1000 épisodes regardés au total",
      condition: (data) => data.episodeCount >= 1000,
      conditionText: "1000 épisodes regardés au total",
      getProgress: (data) => ({
        current: Math.min(data.episodeCount, 1000),
        total: 1000,
        percent: Math.min(Math.round((data.episodeCount / 1000) * 100), 100)
      }),
      unlockedDate: null,
      category: "series"
    }
  ],

  // 📅 MENSUELS
  mensuels: [
    {
      id: "busy-month",
      name: "Mois Chargé",
      icon: "📊",
      description: "50 heures de visionnage en un seul mois",
      condition: (data) => false,
      conditionText: "50 heures de visionnage en un seul mois",
      getProgress: (data) => ({ current: 0, total: 50, percent: 0 }),
      unlockedDate: null,
      category: "mensuels"
    },
    {
      id: "intense-month",
      name: "Mois Intense",
      icon: "⚡",
      description: "100 heures de visionnage en un seul mois",
      condition: (data) => false,
      conditionText: "100 heures de visionnage en un seul mois",
      getProgress: (data) => ({ current: 0, total: 100, percent: 0 }),
      unlockedDate: null,
      category: "mensuels"
    }
  ],

  // 🔒 SECRETS
  secrets: [
    {
      id: "secret-wanderer",
      name: "Aventurier",
      icon: "🗺️",
      description: "Badge secret",
      condition: (data) => false,
      conditionText: "🔒 Badge secret",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: null,
      category: "secrets",
      isSecret: true
    },
    {
      id: "secret-bartender",
      name: "Barman",
      icon: "🍸",
      description: "Badge secret",
      condition: (data) => false,
      conditionText: "🔒 Badge secret",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: null,
      category: "secrets",
      isSecret: true
    },
    {
      id: "secret-castle",
      name: "Château",
      icon: "🏰",
      description: "Badge secret",
      condition: (data) => false,
      conditionText: "🔒 Badge secret",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: null,
      category: "secrets",
      isSecret: true
    },
    {
      id: "secret-spirit",
      name: "Âme spirituelle",
      icon: "👻",
      description: "Badge secret",
      condition: (data) => false,
      conditionText: "🔒 Badge secret",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: null,
      category: "secrets",
      isSecret: true
    },
    {
      id: "avenger",
      name: "Avenger",
      icon: "🦸",
      description: "Fan de l'univers de Marvel",
      condition: (data) => false,
      conditionText: "Fan de l'univers de Marvel",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: "31/12/2025",
      category: "secrets",
      isSecret: false
    },
    {
      id: "beta-tester",
      name: "Beta Tester",
      icon: "🧪",
      description: "Utilisateur expert Dark TV en phase beta",
      condition: (data) => false,
      conditionText: "Utilisateur expert Dark TV en phase beta",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: "31/12/2025",
      category: "secrets",
      isSecret: false
    },
    {
      id: "dark-knight",
      name: "Chevalier Noir",
      icon: "🗡️",
      description: "Fan de l'univers de Star Wars",
      condition: (data) => false,
      conditionText: "Fan de l'univers de Star Wars",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: "31/12/2025",
      category: "secrets",
      isSecret: false
    },
    {
      id: "clever-girl",
      name: "Clever Girl",
      icon: "🧩",
      description: "Fan de l'univers des Jurassic Park",
      condition: (data) => false,
      conditionText: "🔒 Badge secret",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: null,
      category: "secrets",
      isSecret: true
    },
    {
      id: "potter-head",
      name: "Potterhead",
      icon: "⚡",
      description: "Fan de l'univers d'Harry Potter",
      condition: (data) => false,
      conditionText: "Fan de l'univers d'Harry Potter",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: "31/12/2025",
      category: "secrets",
      isSecret: false
    },
    {
      id: "spell-master",
      name: "Maître des Sorts",
      icon: "🪄",
      description: "Fan de l'univers de la Magie",
      condition: (data) => false,
      conditionText: "🔒 Badge secret",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: null,
      category: "secrets",
      isSecret: true
    },
    {
      id: "weekend-warrior",
      name: "Guerrier du Week-end",
      icon: "⚔️",
      description: "Plus de 20 heures de visionnage un week-end",
      condition: (data) => false,
      conditionText: "Plus de 20 heures de visionnage un week-end",
      getProgress: (data) => ({ current: 0, total: 20, percent: 0 }),
      unlockedDate: "28/12/2025",
      category: "secrets",
      isSecret: false
    },
    {
      id: "black-knight",
      name: "Maître Jedi",
      icon: "🧑‍⚖️",
      description: "Fan de l'univers de Star Wars",
      condition: (data) => false,
      conditionText: "Fan de l'univers de Star Wars",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: "31/12/2025",
      category: "secrets",
      isSecret: false
    },
    {
      id: "countdown-pajama",
      name: "Countdown en Pyjama",
      icon: "🛌",
      description: "Fous d'articles détente, scicore and chilling!",
      condition: (data) => false,
      conditionText: "Fous d'articles détente, scicore and chilling!",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: "01/01/2026",
      category: "secrets",
      isSecret: false
    },
    {
      id: "evolutionist",
      name: "Évolutionniste",
      icon: "🐵",
      description: "Fan de l'univers de la Planète des Singes",
      condition: (data) => false,
      conditionText: "Fan de l'univers de la Planète des Singes",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: "31/12/2025",
      category: "secrets",
      isSecret: false
    },
    {
      id: "midnight-watcher",
      name: "Spectateur de Minuit",
      icon: "🌙",
      description: "Regarder un contenu exactement à minuit",
      condition: (data) => false,
      conditionText: "Regarder un contenu exactement à minuit",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: "29/12/2025",
      category: "secrets",
      isSecret: false
    },
    {
      id: "tolkiendil",
      name: "Tolkiendil",
      icon: "👑",
      description: "Fan de l'univers de Tolkien",
      condition: (data) => false,
      conditionText: "Fan de l'univers de Tolkien",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: "31/12/2025",
      category: "secrets",
      isSecret: false
    }
  ],

  // Obtenir tous les achievements
  getAll() {
    return [
      ...this.temporels,
      ...this.activites,
      ...this.films,
      ...this.series,
      ...this.mensuels,
      ...this.secrets
    ];
  },

  // Obtenir les achievements débloqués basé sur les données
  getUnlocked(data) {
    return this.getAll().filter(achievement => {
      // Si l'achievement a une date de déblocage définie, il est débloqué
      if (achievement.unlockedDate) return true;
      // Sinon on vérifie la condition
      return achievement.condition(data);
    });
  },

  // Obtenir les achievements verrouillés
  getLocked(data) {
    return this.getAll().filter(achievement => !this.getUnlocked(data).includes(achievement));
  },

  // Obtenir les stats
  getStats(data) {
    const all = this.getAll();
    const unlocked = this.getUnlocked(data);
    return {
      total: all.length,
      unlocked: unlocked.length,
      locked: all.length - unlocked.length,
      progress: Math.round((unlocked.length / all.length) * 100)
    };
  }
};

module.exports = { ACHIEVEMENTS };
