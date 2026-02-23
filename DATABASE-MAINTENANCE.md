# 🧹 Maintenance Automatique de la Base de Données

## 📋 Vue d'ensemble

Plex Portal inclut un **système de maintenance automatique** qui nettoie et optimise la base de données SQLite pour garantir une **stabilité à long terme** et prévenir une croissance infinie.

---

## 🤖 Nettoyage Automatique

### ⏰ Planification

Une **maintenance complète** s'exécute **chaque dimanche à 3h du matin** (UTC).

```
Cron: 0 3 * * 0
= Tous les dimanches à 03:00:00
```

### 🗑️ Ce qui est nettoyé

| Table | Politique | Résultat |
|-------|----------|----------|
| **tautulli_sessions** | Supprimer les entrées > 1 an | Gagne ~200-500 MB/an |
| **session_cache** | Supprimer les entrées > 3 mois | Gagne ~10-50 MB/an |
| **watch_history** | Supprimer les entrées > 2 ans | Gagne ~10-20 MB/an |
| **sync_metadata** | Supprimer les entrées > 6 mois | Gaine minimal |

### 💾 Optimisation

Après chaque suppression, une opération **VACUUM** est exécutée :
- Récupère l'espace disque inutilisé
- Réorganise les indices
- Réduit la taille physique du fichier `.db`

---

## 📊 Estimations d'impact

### Avant implémentation
- **Croissance annuelle** : ~200-500 MB/an
- **Base de données** : Grandit indéfiniment
- **Performance** : Dégradation progressive

### Après implémentation
- **Croissance annuelle** : **~20-50 MB/an** (données récentes seulement)
- **Taille stable** : Oscillation autour de 500-1000 MB
- **Performance** : Maintenue dans le temps

---

## 🔧 Configuration

### Variables d'environnement (optionnel)

Actuellement, la maintenance utilise des valeurs par défaut. Pour personnaliser :

**Fichier** : `utils/cron-maintenance-job.js`

```javascript
// Modifiez les paramètres (en jours) :
DatabaseMaintenance.cleanOldTautulliSessions(365);   // Par défaut: 1 an
DatabaseMaintenance.cleanOldSessionCache(90);        // Par défaut: 3 mois
DatabaseMaintenance.cleanOldWatchHistory(730);       // Par défaut: 2 ans
DatabaseMaintenance.cleanSyncMetadata(180);          // Par défaut: 6 mois
```

---

## 🛠️ Maintenance Manuelle

### Via API REST

Vous pouvez déclencher une maintenance **à tout moment** :

```bash
curl -X POST \
  http://localhost:3000/api/maintenance/database \
  -H "Cookie: plex-portal.sid=<votre_session>"
```

**Réponse** (200 OK) :
```json
{
  "success": true,
  "message": "Maintenance complète exécutée avec succès",
  "details": {
    "tautulliSessions": 1250,
    "sessionCache": 45,
    "watchHistory": 8,
    "syncMetadata": 3,
    "vacuumSuccess": true,
    "duration": 15
  }
}
```

### Via logs

Pour vérifier que la maintenance s'est bien exécutée :

```bash
docker logs <container-name> | grep "DB-MAINTENANCE"
```

**Exemple de sortie** :
```
[DB-MAINTENANCE] ═══════════════════════════════════════════════════
[DB-MAINTENANCE] 🧹 DÉBUT MAINTENANCE COMPLÈTE DE LA BASE DE DONNÉES
[DB-MAINTENANCE] ✂️ tautulli_sessions:  1250 sessions supprimées (>365 jours)
[DB-MAINTENANCE] ✂️ session_cache:      45 entrées supprimées (>90 jours)
[DB-MAINTENANCE] ✂️ watch_history:      8 entrées supprimées (>730 jours)
[DB-MAINTENANCE] ✂️ sync_metadata:      3 entrées supprimées (>180 jours)
[DB-MAINTENANCE] 💾 VACUUM terminé - base de données optimisée
[DB-MAINTENANCE] 📊 RÉSUMÉ NETTOYAGE:
[DB-MAINTENANCE]    • tautulli_sessions:  1250 supprimées
[DB-MAINTENANCE]    • session_cache:      45 supprimées
[DB-MAINTENANCE]    • watch_history:      8 supprimées
[DB-MAINTENANCE]    • sync_metadata:      3 supprimées
[DB-MAINTENANCE]    • VACUUM:             ✅ OK
[DB-MAINTENANCE]    • TOTAL SUPPRIMÉ:     1306 enregistrements
[DB-MAINTENANCE]    • DURÉE:              15s
[DB-MAINTENANCE] ═══════════════════════════════════════════════════
```

---

## 📁 Structures de fichiers

### Fichiers principaux

| Fichier | Rôle |
|---------|------|
| `utils/database.js` | Contient la classe `DatabaseMaintenance` avec les fonctions de nettoyage |
| `utils/cron-maintenance-job.js` | Lance le cron job hebdomadaire |
| `server.js` | Démarre le cron job au démarrage |
| `routes/dashboard.routes.js` | Route API `/api/maintenance/database` pour déclenchement manuel |

### Fonctions clé

#### `DatabaseMaintenance.runFullMaintenance()`
Exécute **tous** les nettoyages dans l'ordre :
1. Supprime les sessions Tautulli anciennes
2. Supprime le cache de session ancien
3. Supprime l'historique de visionnage ancien
4. Supprime les métadonnées de sync anciennes
5. Optimise la DB avec VACUUM

**Retour** :
```javascript
{
  tautulliSessions: 1250,    // Nombre supprimé
  sessionCache: 45,
  watchHistory: 8,
  syncMetadata: 3,
  vacuumSuccess: true,
  duration: 15               // Secondes
}
```

---

## 🚨 Sauvegardes

### ⚠️ Avant la première maintenance

**Il est recommandé de sauvegarder votre base de données** :

```bash
# Copier le fichier DB
docker exec <container> cp /config/plex-portal.db /config/plex-portal.db.backup

# Ou télécharger depuis votre système
cp /volume1/docker/<app>/config/plex-portal.db ./plex-portal.db.backup
```

### 📊 Vérification après maintenance

Vous pouvez vérifier que la maintenance ne pose aucun problème :

```bash
# Depuis container
sqlite3 /config/plex-portal.db "SELECT COUNT(*) as total_tautulli FROM tautulli_sessions;"
sqlite3 /config/plex-portal.db "SELECT COUNT(*) as total_watch FROM watch_history;"
```

---

## ⚙️ Gestion avancée

### Désactiver temporairement la maintenance

Pour **suspendre** la maintenance programmée (rarement nécessaire) :

**Dans `utils/cron-maintenance-job.js`** :
```javascript
// Commentez cette ligne :
// startDatabaseMaintenanceJob();
```

Puis redémarrez le container.

### Personnaliser les horaires

Pour changer l'heure de maintenance (par défaut dimanche 3h) :

**Dans `utils/cron-maintenance-job.js`** :
```javascript
// Actuel : dimanche 3h
cron.schedule('0 3 * * 0', async () => { ... });

// Exemples :
// Tous les jours à 2h
// cron.schedule('0 2 * * *', async () => { ... });

// Mercredi à 4h
// cron.schedule('0 4 * * 3', async () => { ... });

// Chaque 6 heures
// cron.schedule('0 */6 * * *', async () => { ... });
```

**Format Cron** :
```
┌───────────── seconde (0 - 59)
│ ┌───────────── minute (0 - 59)
│ │ ┌───────────── heure (0 - 23)
│ │ │ ┌───────────── jour du mois (1 - 31)
│ │ │ │ ┌───────────── mois (1 - 12)
│ │ │ │ │ ┌───────────── jour de la semaine (0 - 7) (0 et 7 = dimanche)
│ │ │ │ │ │
0 3 * * 0
```

### Audit des suppressions

Si vous voulez **voir exactement ce qui sera supprimé** avant suppression :

**Dans `utils/database.js`**, ajoutez avant une suppression :
```javascript
const count = db.prepare(
  'SELECT COUNT(*) as cnt FROM tautulli_sessions WHERE session_date < ?'
).get(beforeDate).cnt;
console.log(`[AUDIT] ${count} sessions à supprimer`);
```

---

## 📈 Surveillance

### Taille du fichier DB

```bash
# Depuis le container
docker exec <container> ls -lh /config/plex-portal.db

# Exemple :
# -rw-r--r-- 1 root root 512M Nov 10 15:23 /config/plex-portal.db
```

### Croissance au fil du temps

Notez la taille avant/après maintenance :

```bash
# Avant maintenance
du -h /config/plex-portal.db

# Après maintenance (quelques jours plus tard)
du -h /config/plex-portal.db
```

---

## 🐛 Dépannage

### La maintenance prend trop de temps

Si le nettoyage dure > 1 minute :

1. Vérifiez la charge du système
2. Considérez un délai d'exécution plus espacé
3. Vérifiez les indices de la table `tautulli_sessions`

```bash
sqlite3 /config/plex-portal.db ".indices tautulli_sessions"
```

### Le DB grandit toujours

1. Vérifiez les logs de maintenance : elle s'exécute-t-elle ?
2. Vérifiez la date du dimanche dans votre fuseau horaire
3. Lancez une maintenance manuelle pour tester

### Erreur VACUUM

Si vous voyez `VACUUM: ❌ ÉCHOUÉ` :

1. Vérifiez l'espace disque disponible
2. Vérifiez les permissions du fichier `/config/plex-portal.db`
3. Redémarrez le container

---

## 📖 Références

- **SQLite VACUUM** : https://www.sqlite.org/lang_vacuum.html
- **node-cron** : https://github.com/kelektiv/node-cron
- **Gestion des données** : [DATABASE-ARCHITECTURE.md](./DATABASE-ARCHITECTURE.md) (si existe)

---

## ✅ Résumé

✅ **Maintenance automatique** : Dimanche 3h du matin (UTC)
✅ **Nettoyage intelligent** : Garde 1-2 ans de données
✅ **Optimisation DB** : VACUUM après chaque suppression
✅ **Maintenance manuelle** : Via API `/api/maintenance/database`
✅ **Base de données stable** : Croissance contrôlée à long terme
