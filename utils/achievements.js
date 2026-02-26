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
      category: "temporels",
      xp: 250
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
      category: "temporels",
      xp: 750
    },
    {
      id: "old-timer",
      name: "Vieux de la Veille",
      icon: "👴",
      description: "Plus de 5 ans d'ancienneté sur Dark TV",
      condition: (data) => data.daysSince >= 1825,
      conditionText: "Plus de 5 ans d'ancienneté sur Dark TV",
      getProgress: (data) => ({
        current: Math.min(data.daysSince, 1825),
        total: 1825,
        percent: Math.min(Math.round((data.daysSince / 1825) * 100), 100)
      }),
      unlockedDate: null,
      category: "temporels",
      xp: 1500
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
      category: "activites",
      xp: 150
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
      category: "activites",
      xp: 300
    },
    {
      id: "night-owl",
      name: "Oiseau de Nuit",
      icon: "🦉",
      description: "Plus de 30 visionnages entre 22h et 6h",
      condition: (data) => (data.nightCount || 0) >= 30,
      conditionText: "Plus de 30 visionnages entre 22h et 6h",
      getProgress: (data) => ({
        current: Math.min(data.nightCount || 0, 30),
        total: 30,
        percent: Math.min(Math.round(((data.nightCount || 0) / 30) * 100), 100)
      }),
      unlockedDate: null,
      category: "activites",
      xp: 450
    },
    {
      id: "early-bird",
      name: "Lève-Tôt",
      icon: "🐦",
      description: "Plus de 50 visionnages entre 6h et 9h",
      condition: (data) => (data.morningCount || 0) >= 50,
      conditionText: "Plus de 50 visionnages entre 6h et 9h",
      getProgress: (data) => ({
        current: Math.min(data.morningCount || 0, 50),
        total: 50,
        percent: Math.min(Math.round(((data.morningCount || 0) / 50) * 100), 100)
      }),
      unlockedDate: null,
      category: "activites",
      xp: 450
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
      category: "activites",
      xp: 750
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
      category: "activites",
      xp: 2500
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
      category: "films",
      xp: 200
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
      category: "films",
      xp: 350
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
      category: "films",
      xp: 550
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
      category: "films",
      xp: 900
    },
    {
      id: "cinema-god",
      name: "Dieu du Cinéma",
      icon: "🏛️",
      description: "1000 films regardés au total",
      condition: (data) => data.movieCount >= 1000,
      conditionText: "1000 films regardés au total",
      getProgress: (data) => ({
        current: Math.min(data.movieCount, 1000),
        total: 1000,
        percent: Math.min(Math.round((data.movieCount / 1000) * 100), 100)
      }),
      unlockedDate: null,
      category: "films",
      xp: 1500
    },
    {
      id: "cinema-universe",
      name: "Seigneur du Cinéma",
      icon: "🌌",
      description: "2000 films regardés au total",
      condition: (data) => data.movieCount >= 2000,
      conditionText: "2000 films regardés au total",
      getProgress: (data) => ({
        current: Math.min(data.movieCount, 2000),
        total: 2000,
        percent: Math.min(Math.round((data.movieCount / 2000) * 100), 100)
      }),
      unlockedDate: null,
      category: "films",
      xp: 2500
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
      category: "series",
      xp: 200
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
      category: "series",
      xp: 350
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
      category: "series",
      xp: 550
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
      category: "series",
      xp: 900
    },
    {
      id: "series-overlord",
      name: "Overlord des Séries",
      icon: "👑",
      description: "2000 épisodes regardés au total",
      condition: (data) => data.episodeCount >= 2000,
      conditionText: "2000 épisodes regardés au total",
      getProgress: (data) => ({
        current: Math.min(data.episodeCount, 2000),
        total: 2000,
        percent: Math.min(Math.round((data.episodeCount / 2000) * 100), 100)
      }),
      unlockedDate: null,
      category: "series",
      xp: 1500
    },
    {
      id: "series-titan",
      name: "Titan des Séries",
      icon: "🌊",
      description: "5000 épisodes regardés au total",
      condition: (data) => data.episodeCount >= 5000,
      conditionText: "5000 épisodes regardés au total",
      getProgress: (data) => ({
        current: Math.min(data.episodeCount, 5000),
        total: 5000,
        percent: Math.min(Math.round((data.episodeCount / 5000) * 100), 100)
      }),
      unlockedDate: null,
      category: "series",
      xp: 2500
    }
  ],

  // 📅 MENSUELS
  mensuels: [
    {
      id: "busy-month",
      name: "Mois Chargé",
      icon: "📊",
      description: "50 heures de visionnage en un seul mois",
      condition: (data) => (data.monthlyHours || 0) >= 50,
      conditionText: "50 heures de visionnage en un seul mois",
      getProgress: (data) => ({
        current: Math.min(Math.round((data.monthlyHours || 0) * 10) / 10, 50),
        total: 50,
        percent: Math.min(Math.round(((data.monthlyHours || 0) / 50) * 100), 100)
      }),
      unlockedDate: null,
      category: "mensuels",
      xp: 300
    },
    {
      id: "intense-month",
      name: "Mois Intense",
      icon: "⚡",
      description: "100 heures de visionnage en un seul mois",
      condition: (data) => (data.monthlyHours || 0) >= 100,
      conditionText: "100 heures de visionnage en un seul mois",
      getProgress: (data) => ({
        current: Math.min(Math.round((data.monthlyHours || 0) * 10) / 10, 100),
        total: 100,
        percent: Math.min(Math.round(((data.monthlyHours || 0) / 100) * 100), 100)
      }),
      unlockedDate: null,
      category: "mensuels",
      xp: 800
    }
  ],

  // 🎬 COLLECTIONS
  collections: [
    {
      id: "marvel-fan",
      name: "Marvel Fan",
      icon: "🦸",
      description: "A regardé toute la collection Marvel Cinematic Universe",
      condition: (data) => false,
      conditionText: "A regardé toute la collection Marvel Cinematic Universe",
      getProgress: (data) => ({ current: 0, total: 44, percent: 0 }),
      unlockedDate: null,
      category: "collections",
      isSecret: false,
      revocable: true,
      // Barème équilibré collections: 250 XP/film, cap à 7500 XP
      xp: 7500
    },
    {
      id: "black-knight",
      name: "Maître Jedi",
      icon: "🧑‍⚖️",
      description: "A regardé au moins 7 films de la saga Star Wars",
      condition: (data) => false,
      conditionText: "A regardé au moins 7 films de la saga Star Wars",
      getProgress: (data) => ({ current: 0, total: 7, percent: 0 }),
      unlockedDate: null,
      category: "collections",
      isSecret: false,
      revocable: true,
      // Barème équilibré collections: 250 XP/film
      xp: 1750
    },
    {
      id: "jurassic-survivor",
      name: "Survivant du Parc",
      icon: "🦕",
      description: "A survécu à tous les parcs — les 7 films Jurassic",
      condition: (data) => false,
      conditionText: "A survécu à tous les parcs — les 7 films Jurassic",
      getProgress: (data) => ({ current: 0, total: 7, percent: 0 }),
      unlockedDate: null,
      category: "collections",
      isSecret: false,
      revocable: true,
      // Barème équilibré collections: 250 XP/film
      xp: 1750
    },
    {
      id: "potter-head",
      name: "Wizarding World",
      icon: "⚡",
      description: "A regardé toute la collection Wizarding World",
      condition: (data) => false,
      conditionText: "A regardé toute la collection Wizarding World",
      getProgress: (data) => ({ current: 0, total: 11, percent: 0 }),
      unlockedDate: null,
      category: "collections",
      isSecret: false,
      revocable: true,
      // Barème équilibré collections: 250 XP/film
      xp: 2750
    },
    {
      id: "tolkiendil",
      name: "Middle Earth",
      icon: "👑",
      description: "A regardé toute la collection Middle Earth",
      condition: (data) => false,
      conditionText: "A regardé toute la collection Middle Earth",
      getProgress: (data) => ({ current: 0, total: 6, percent: 0 }),
      unlockedDate: null,
      category: "collections",
      isSecret: false,
      revocable: true,
      // Barème équilibré collections: 250 XP/film
      xp: 1500
    },
    {
      id: "evolutionist",
      name: "Évolutionniste",
      icon: "🐵",
      description: "Fan de l'univers de la Planète des Singes",
      condition: (data) => false,
      conditionText: "Fan de l'univers de la Planète des Singes",
      getProgress: (data) => ({ current: 0, total: 4, percent: 0 }),
      unlockedDate: null,
      category: "collections",
      isSecret: false,
      revocable: true,
      // Barème équilibré collections: 250 XP/film
      xp: 1000
    },
    {
      id: "monsterverse",
      name: "MonsterVerse",
      icon: "🦖",
      description: "A regardé les films et séries de la collection MonsterVerse",
      condition: (data) => false,
      conditionText: "A regardé les films et séries de la collection MonsterVerse",
      // Fallback UI: 5 films + 2 séries = 7 éléments au total
      getProgress: (data) => ({ current: 0, total: 7, percent: 0 }),
      unlockedDate: null,
      category: "collections",
      isSecret: false,
      revocable: true,
      // Barème équilibré collections: valeur mixte films+séries
      xp: 2000
    }
  ],

  // 🔒 SECRETS
  secrets: [
    {
      id: "weekend-warrior",
      name: "Guerrier du Week-end",
      icon: "⚔️",
      description: "Plus de 20 heures de visionnage un week-end",
      condition: (data) => false,
      conditionText: "Plus de 20 heures de visionnage un week-end",
      getProgress: (data) => ({ current: 0, total: 20, percent: 0 }),
      unlockedDate: null,
      category: "secrets",
      isSecret: false,
      xp: 1200
    },
    {
      id: "countdown-pajama",
      name: "Countdown en Pyjama",
      icon: "🛌",
      description: "Fous d'articles détente, scicore and chilling!",
      condition: (data) => false,
      conditionText: "Fous d'articles détente, scicore and chilling!",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: null,
      category: "secrets",
      isSecret: false,
      xp: 700
    },
    {
      id: "midnight-watcher",
      name: "Spectateur de Minuit",
      icon: "🌙",
      description: "Regarder un contenu exactement à minuit",
      condition: (data) => false,
      conditionText: "Regarder un contenu exactement à minuit",
      getProgress: (data) => ({ current: 0, total: 1, percent: 0 }),
      unlockedDate: null,
      category: "secrets",
      isSecret: false,
      xp: 900
    },
    {
      id: "direct-play-master",
      name: "Maître de la Lecture Directe",
      icon: "⚡",
      description: "Effectuer 1000 lectures sans Transcoder",
      condition: (data) => false,
      conditionText: "Effectuer 1000 lectures sans Transcoder",
      getProgress: (data) => ({ current: 0, total: 1000, percent: 0 }),
      unlockedDate: null,
      category: "secrets",
      isSecret: false,
      xp: 1200
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
      ...this.collections,
      ...this.secrets
    ];
  },

  // Obtenir les achievements débloqués basé sur les données + succès manuels de la DB
  // userUnlockedMap : { achievementId: "dd/mm/yyyy" } depuis UserAchievementQueries.getForUser(userId)
  getUnlocked(data, userUnlockedMap = {}) {
    return this.getAll().filter(achievement => {
      // Succès débloqué manuellement (DB) : présent dans la map de l'utilisateur
      if (userUnlockedMap[achievement.id]) return true;
      // Sinon on vérifie la condition calculée (non-secrets)
      return achievement.condition(data);
    });
  },

  // Obtenir les achievements verrouillés
  getLocked(data, userUnlockedMap = {}) {
    const unlocked = this.getUnlocked(data, userUnlockedMap);
    return this.getAll().filter(achievement => !unlocked.includes(achievement));
  },

  // Obtenir les stats
  getStats(data, userUnlockedMap = {}) {
    const all = this.getAll();
    const unlocked = this.getUnlocked(data, userUnlockedMap);
    return {
      total: all.length,
      unlocked: unlocked.length,
      locked: all.length - unlocked.length,
      progress: Math.round((unlocked.length / all.length) * 100)
    };
  }
};

module.exports = { ACHIEVEMENTS };
