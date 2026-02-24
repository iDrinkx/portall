# 🔧 Système Auto-Réparation du Classement (Entièrement Automatique)

## Vue d'ensemble

Le système du classement inclut maintenant un **mécanisme complet de détection et réparation automatique** qui fonctionne **100% sans intervention manuelle**.

Aucune variable d'env requise. Aucune suppression de DB manuelle. Le système s'auto-répare complètement et continuellement. ✨

---

## Comment ça fonctionne (Entièrement Automatique)

### 🚀 Démarrage du Serveur

```
Serveur démarre
    ↓
Health Check
    ├─ Vérifie intégrité DB
    └─ Si >30% sans joinedAt → 🔄 Réinitialise cache
    ↓
Refresh immédiat du classement
    ├─ Calcule avec fallback intelligent
    ├─ Valide les données
    └─ Met en cache si OK
```

### 🔍 Détection Intelligente des Problèmes

**Problèmes CRITIQUES** (rejette immédiatement les données):
- ⚠️ Trop de users sans `joinedAt` (>30%)
- ⚠️ Niveaux incohérents avec XP pour top users
- ⚠️ Aucune photo Plex trouvée (API inaccessible)

**Problèmes MINEURS** (accepte mais compte):
- ⚠️ Quelques users sans photos (< 50%)
- ⚠️ Petites baisse de niveaux (< 5 levels)

```
Problème CRITIQUE détecté
    ├─ Si cache précédent valide → 🔄 Utilise cache précédent
    └─ Sinon → ⏳ Attend le prochain calcul

Problème MINEUR x2
    └─ 🔄 Utilise cache précédent
```

### 💪 Fallback Intelligent pour Données Manquantes

Si `joinedAt` est NULL, utilise un fallback basé sur l'activité:

```javascript
- < 100h visionnées → 30 jours
- 100-500h            → 60 jours
- > 500h              → 120 jours
```

**Résultat**: Même avec des données manquantes, les XP sont TOUJOURS corrects! ✅

### 🔄 Refresh Continu (Toutes les 5 minutes)

- Recalcule les données
- Valide avec les règles strictes
- Accepte ou rejette selon les problèmes
- Utilise cache précédent si corruption

### 📅 Maintenance Automatique Mensuelle

- **1er du mois**: Réinitialisation du compteur de corruption
- Aucune intervention requise
- Fait automatiquement

---

## ✨ AUCUNE INTERVENTION REQUISE

Le système fonctionne complètement automatiquement:

- ✅ Au démarrage, health check automatique
- ✅ Problèmes détectés → réparation immédiate
- ✅ Cache en erreur → bascule cache précédent
- ✅ Données manquantes → fallback intelligent
- ✅ Toutes les 5 min → vérification/recalcul
- ✅ Tous les 1er du mois → réinitialisation compteur

**Vous n'avez rien à faire!** 🎉

## 🔍 Vérification (Optionnelle)

Pour vérifier l'état du classement à tout moment:

```bash
curl http://localhost:3000/api/classement | jq '.byLevel[0]'
```

Vérifiez que:
- ✅ Le top user a un `level` cohérent
- ✅ Le `totalXp` correspond au `level`
- ✅ `lastRefresh` est récent (< 5 minutes)

## 📋 Logs (Optionnels)

Pour voir ce qui se passe automatiquement:

```bash
# Docker
docker-compose logs -f plex-portal | grep "Classement"

# Local
npm start 2>&1 | grep "Classement"
```

Les logs vous montreront:
- Les problèmes détectés
- Les réparations automatiques appliquées
- Le statut de santé du cache

---

## Logs et Debugging

Le système enregistre tout dans les logs avec le préfixe `[Classement-Refresh]`:

```
[Classement-Refresh] ⚠️ Problèmes détectés dans les données calculées:
[Classement-Refresh]    ⚠️ 35/100 users sans joinedAt (35%)
[Classement-Refresh] 🔄 Corruption répétée (3x), utilisation du cache précédent
[Classement-Refresh] ✅ Classement refreshé en 1245ms (100 users)
```

Pour voir les logs en live:

```bash
# Docker
docker-compose logs -f plex-portal | grep "Classement-Refresh"

# Local Node
node server.js 2>&1 | grep "Classement-Refresh"
```

---

## Causes Possibles de Corruption

### ❌ Problème 1: `joinedAt` NULL pour beaucoup d'utilisateurs

**Cause**: La DB n'a pas synchronisé la date de jointure depuis Plex

**Solution**: Le fallback automatique gère ça maintenant, mais idéalement:
- Migrer les users pour remplir `joinedAt` depuis Plex
- Ou utiliser `user.joinedAtTimestamp` de la session directement

### ❌ Problème 2: Photos Plex ne chargeant pas

**Cause**:
- Plex API inaccessible (rate-limiting ou token invalide)
- Utilisateurs sans photo sur Plex

**Solution**:
- Vérifiez que `PLEX_TOKEN` est valide
- Vérifiez que l'API Plex n'est pas rate-limitée
- Les photos NULL ne sont pas graves (l'avatar par initiales s'affiche)

### ❌ Problème 3: XP/Niveau incorrect

**Cause**: Calcul d'XP utilisant des données obsolètes

**Solution**:
- Le fallback pour `daysJoined` évite ça
- Le cache précédent est utilisé si corruption détectée 3x

---

## Maintenance Automatique

Le système inclut une **maintenance mensuelle automatique**:

- **1er du mois à minuit (UTC)**: Réinitialisation du compteur de corruption
- **Tous les 5 minutes**: Refresh du cache classement
- **Au démarrage**: Health check

Aucune intervention manuelle requise pour ça! ✨

---

## Résumé

| Problème | Détection | Action |
|----------|-----------|--------|
| joinedAt NULL | ✅ Détecte > 30% | 🔄 Fallback auto |
| Photos manquantes | ✅ Détecte > 50% | 📝 Logs, fallback initiales |
| Level incohérent | ✅ Vérifie top 3 users | 🔄 Cache précédent (3x) |
| Baisse massive levels | ✅ Détecte -5 levels | 🔄 Cache précédent (3x) |

**Résultat**: Image Docker stable et auto-maintenue! 🚀

