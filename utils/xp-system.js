// 
// Système de rangs et niveaux XP
//  XP  Niveau : level = floor(totalXp / XP_PAR_NIVEAU) + 1
//  Niveau  Rang : tranches définies dans RANKS
// 

const XP_PAR_NIVEAU = 1000;

const RANKS = [
  { name: "Fer",        icon: "⚙️",  minLevel: 1,   maxLevel: 10,   color: "#8B9BA8", bgColor: "rgba(139,155,168,0.15)", borderColor: "#8B9BA8" },
  { name: "Bronze",     icon: "🥉",  minLevel: 11,  maxLevel: 20,   color: "#CD7F32", bgColor: "rgba(205,127,50,0.15)",  borderColor: "#CD7F32" },
  { name: "Argent",     icon: "🥈",  minLevel: 21,  maxLevel: 30,   color: "#C0C0C0", bgColor: "rgba(192,192,192,0.15)", borderColor: "#C0C0C0" },
  { name: "Or",         icon: "🥇",  minLevel: 31,  maxLevel: 40,   color: "#E5A00D", bgColor: "rgba(229,160,13,0.15)",  borderColor: "#E5A00D" },
  { name: "Platine",    icon: "💠",  minLevel: 41,  maxLevel: 50,   color: "#00D9FF", bgColor: "rgba(0,217,255,0.15)",   borderColor: "#00D9FF" },
  { name: "Émeraude",   icon: "💚",  minLevel: 51,  maxLevel: 65,   color: "#2ECC71", bgColor: "rgba(46,204,113,0.15)",  borderColor: "#2ECC71" },
  { name: "Diamant",    icon: "💎",  minLevel: 66,  maxLevel: 80,   color: "#7B68EE", bgColor: "rgba(123,104,238,0.15)", borderColor: "#7B68EE" },
  { name: "Master",     icon: "🏆",  minLevel: 81,  maxLevel: 100,  color: "#FF6B35", bgColor: "rgba(255,107,53,0.15)",  borderColor: "#FF6B35" },
  { name: "Challenger", icon: "👑",  minLevel: 101, maxLevel: 9999, color: "#FF1493", bgColor: "rgba(255,20,147,0.15)",  borderColor: "#FF1493" },
];
const XP_SYSTEM = {
  ranks: RANKS,
  get badges() { return this.ranks; }, // rétrocompatibilité

  getLevel(totalXp) {
    return Math.floor((totalXp || 0) / XP_PAR_NIVEAU) + 1;
  },

  getRankByLevel(level) {
    return RANKS.find(r => level >= r.minLevel && level <= r.maxLevel)
      || RANKS[RANKS.length - 1];
  },

  getRankByXp(totalXp) {
    return this.getRankByLevel(this.getLevel(totalXp));
  },

  getBadgeByXp(totalXp) { return this.getRankByXp(totalXp); },

  calculateTotalXp(hoursWatched, achievementsXp, daysJoined) {
    // Formula: HOURS*8 + ACHIEVEMENTS_XP + DAYS*5
    return Math.round((hoursWatched || 0) * 8)
         + (achievementsXp || 0)
         + (daysJoined || 0) * 5;
  },

  getProgressToNextLevel(totalXp) {
    const xp        = totalXp || 0;
    const level     = this.getLevel(xp);
    const rank      = this.getRankByLevel(level);
    const xpInLevel = xp % XP_PAR_NIVEAU;
    return {
      current        : rank,
      next           : this.getRankByLevel(level + 1),
      level,
      nextLevel      : level + 1,
      currentXp      : xp,
      xpInLevel,
      progressPercent: Math.floor((xpInLevel / XP_PAR_NIVEAU) * 100),
      xpNeeded       : XP_PAR_NIVEAU - xpInLevel,
      rankChanged    : this.getRankByLevel(level + 1).name !== rank.name
    };
  },

  getProgressToNextBadge(totalXp) { return this.getProgressToNextLevel(totalXp); },

  getDetailedStats(sessionCount, totalRequests) {
    const totalXp  = this.calculateTotalXp(sessionCount, totalRequests);
    const level    = this.getLevel(totalXp);
    const rank     = this.getRankByLevel(level);
    const progress = this.getProgressToNextLevel(totalXp);
    return {
      totalXp, level, rank,
      badge: rank,
      progress,
      breakdown: {
        sessionXp : (sessionCount || 0) * 2,
        requestXp : (totalRequests || 0) * 15,
        sessionCount, totalRequests
      }
    };
  },

  xpParNiveau: XP_PAR_NIVEAU
};

module.exports = { XP_SYSTEM };