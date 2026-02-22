
# Plex Portal

**Version : 1.11.6**

Application web pour gérer votre accès Plex, afficher abonnements, statistiques de visionnage, et accéder à Seerr via SSO intégré.

##  Fonctionnalités

🔐 **Authentification Plex** : Connexion via compte Plex (OAuth)

📊 **Dashboard** : Vue d'ensemble (abonnement, statistiques, demandes Seerr)

🎫 **Abonnements Wizarr** : Date d'expiration et groupe (requis pour toutes les fonctionnalités)

📈 **Statistiques Tautulli** : Historique de visionnage, temps total, collections (requis pour toutes les fonctionnalités)

🛡️ **Intégration Seerr (SSO)** : Accès à Seerr dans une iframe full-page sans re-connexion

🏆 **Système XP & Succès** : Points d'expérience et badges selon l'activité de visionnage

👤 **Page Profil** : Stats personnelles, demandes Seerr, succès débloqués

🔄 **Reverse Proxy Automatique** : Détection auto via headers `X-Forwarded-*`

⚡ **Configuration Minimale** : Juste `SESSION_SECRET` en obligatoire

---

##  Démarrage rapide

### Prérequis

🛠️ Docker & Docker Compose
👤 Compte Plex
🔗 Wizarr, Tautulli, Seerr (requis pour toutes les fonctionnalités)


### Production (Unraid + ngx proxy manager)

```bash
# L'app détecte automatiquement le reverse proxy via X-Forwarded-*
docker compose up -d
# Accès : https://plex-portal.votredomaine.com
```

> Image Docker publique : `ghcr.io/idrinkx/plex-portal:latest`

---

##  Documentation

- **[SETUP.md](./SETUP.md)**  Guide pas à pas complet
- **[DOCKER.md](./DOCKER.md)**  Guide Docker et reverse proxy
- **[UNRAID.md](./UNRAID.md)**  Configuration spécifique Unraid

---

##  Structure du projet

```
plex-portal/
 Dockerfile
 docker-compose.yml
 server.js                           # Serveur Express principal
 package.json

 middleware/
    auth.middleware.js              # Vérification session
    reverseproxy.middleware.js      # Auto-détection reverse proxy

 routes/
    auth.routes.js                  # Login Plex OAuth + SSO Seerr
    dashboard.routes.js             # APIs dashboard, stats, profil
    seerr-proxy.routes.js           # Route iframe Seerr (/seerr)

 views/
    layout.ejs
    login.ejs
    badges.ejs
    dashboard/
       index.ejs
       _activity.ejs
       _overseerr.ejs
       _stats.ejs
       _subscription.ejs

     profil/
       index.ejs
     seerr/
       index.ejs                   # Iframe full-page Seerr
     statistiques/
        index.ejs
        activite.ejs

   public/
     css/style.css
     js/
        dashboard.js
        statistiques.js

   utils/
     achievements.js                 # Système de succès
     cache.js                        # Couche de cache mémoire
     cron-session-job.js             # Job cron sessions/stats
     database.js                     # SQLite (sessions, XP, cache)
     health-check.js                 # Vérification santé services
     plex.js                         # Whitelist utilisateurs Plex
     seerr.js                        # API Seerr (stats demandes)
     session-stats-cache.js
     session-stats-cache-db.js
     tautulli.js                     # API Tautulli
     tautulli-direct.js              # Lecture directe DB Tautulli
     tautulli-events.js
     logger.js                       # Logger unifié (timestamp + couleurs)
     wizarr.js                       # API Wizarr
     xp-system.js                    # Calcul XP et niveaux

   config/
      logo.png                        # Logo personnalisable
  ```

  ---


---

##  Système XP, Succès, Badges et Classement

Plex Portal propose un système de gamification avancé pour encourager l'engagement :

- **XP (Points d'expérience)** : Gagnez des points en fonction de votre activité de visionnage (heures, films, séries, sessions).
- **Badges & Succès** : Débloquez des badges selon des critères variés (nombre de films, séries, heures, collections, événements spéciaux, etc.). Certains badges sont révoqués si les conditions ne sont plus remplies.
- **Catégories de succès** : Plusieurs catégories (visionnage, collections, activité, événements, etc.) avec progression visible.
- **Classement** : Comparez votre progression avec les autres utilisateurs via une page podium dynamique.
- **Progression & Modalités** : Visualisez votre progression via des barres, modals et liens dédiés sur le dashboard et le profil.
- **XP Breakdown** : Accédez à un détail de vos sources d'XP (modal explicative).

Exemples de badges :
- "Cinema God" (nombre de films vus)
- "Series Overlord" (nombre d'épisodes)
- "Collections Master" (collections complètes)
- Succès spéciaux (événements, horaires, etc.)

Pour plus de détails, consultez la page `/succes` ou le dashboard.


---

##  Configuration

### Variables d'environnement

#### Obligatoire

```yaml
SESSION_SECRET: "votre-cle-secrete"     # Clé de session (obligatoire)
COOKIE_SECURE: "true"                   # true en production (HTTPS), false en local
```

#### Intégrations

```yaml
# Wizarr  affichage abonnement
WIZARR_URL: "http://Wizarr:5690"
WIZARR_API_KEY: "votre-cle"

# Tautulli  statistiques de visionnage
TAUTULLI_URL: "http://tautulli:8181"
TAUTULLI_API_KEY: "votre-cle"
TAUTULLI_DB_PATH: "/tautulli-data/tautulli.db"   # Lecture DB directe (optimal)

# Seerr (ex-Overseerr/Jellyseerr)  SSO iframe
SEERR_URL: "http://Seerr:5055"                   # URL interne (API auth au login)
SEERR_PUBLIC_URL: "https://seerr.votredomaine.com" # URL publique (src iframe)
SEERR_API_KEY: "votre-cle"                        # Clé API (stats profil)

# Sécurité  restriction aux utilisateurs du serveur Plex
PLEX_URL: "http://plex:32400"
PLEX_TOKEN: "votre-token"
```

#### Overrides manuels (auto-détectés si omis)

```yaml
APP_URL: "https://plex-portal.votredomaine.com"
BASE_PATH: "/plex-portal"
PORT: "3000"
DEBUG: "true"
```

### docker-compose.yml complet (exemple production)

```yaml
services:
  plex-portal:
    image: ghcr.io/idrinkx/plex-portal:latest
    container_name: plex-portal
    ports:
      - "4000:3000"
    restart: unless-stopped
    networks:
      - proxy
    environment:
      - SESSION_SECRET=votre-cle-secrete
      - COOKIE_SECURE=true
      - WIZARR_URL=http://Wizarr:5690
      - WIZARR_API_KEY=votre-cle
      - TAUTULLI_URL=http://tautulli:8181
      - TAUTULLI_API_KEY=votre-cle
      - TAUTULLI_DB_PATH=/tautulli-data/tautulli.db
      - SEERR_URL=http://Seerr:5055
      - SEERR_PUBLIC_URL=https://seerr.votredomaine.com
      - SEERR_API_KEY=votre-cle
      - PLEX_URL=http://plex:32400
      - PLEX_TOKEN=votre-token
    volumes:
      - /chemin/appdata/plex-portal/config:/config
      - /chemin/appdata/tautulli:/tautulli-data

networks:
  proxy:
    external: true
```

---

##  Intégration Seerr (SSO)

Plex Portal intègre Seerr (ex-Overseerr / Jellyseerr) via **SSO Organizr-style** :

1. Au login Plex  plex-portal contacte Seerr en interne (`SEERR_URL`) et récupère le `connect.sid`
2. Ce cookie est posé dans le browser avec `domain=.votredomaine.com` (sous-domaine parent commun)
3. Navigation vers `/seerr`  iframe full-page chargée depuis `SEERR_PUBLIC_URL`
4. Le browser envoie automatiquement le cookie  Seerr authentifié sans re-connexion

**Prérequis :**
- `SEERR_PUBLIC_URL` et l'URL de plex-portal doivent partager le même domaine parent
  _(ex: `plex-portal.votredomaine.com` + `seerr.votredomaine.com`  parent `.votredomaine.com`)_
- HTTPS obligatoire en production (cookie `secure: true`)

---

##  Routes disponibles

```
# Pages
GET  /                          Login ou redirect dashboard
GET  /dashboard                 Dashboard principal (auth requis)
GET  /profil                    Page profil utilisateur (auth requis)
GET  /statistiques              Statistiques de visionnage (auth requis)
GET  /statistiques/activite     Activité détaillée (auth requis)
GET  /seerr                     Seerr en iframe full-page (auth requis)
GET  /succes                    Liste des succès disponibles

# Auth
GET  /login                     Initie l'auth Plex OAuth
GET  /auth-complete             Callback Plex OAuth
GET  /logout                    Déconnexion

# APIs JSON
GET  /api/subscription          Infos abonnement Wizarr
GET  /api/stats                 Statistiques Tautulli
GET  /api/seerr                 Stats demandes Seerr
GET  /api/server-stats          Stats librairies serveur (films, séries, musiques)
POST /api/cache/invalidate      Invalide le cache utilisateur
```

---

##  Détection reverse proxy automatique

### En local
```
Aucun header X-Forwarded-*
 http://localhost:3000   (basePath: "")
```

### Derrière ngx proxy manager / Traefik
```
X-Forwarded-Proto: https
X-Forwarded-Host: plex-portal.votredomaine.com
X-Forwarded-Prefix: /
 https://plex-portal.votredomaine.com   (auto-détecté)
```

Aucune configuration manuelle requise. 

---

##  Sécurité

-  Authentification via Plex OAuth uniquement (aucun mot de passe stocké)
-  Sessions HttpOnly, SameSite=Lax, nom personnalisé (`plex-portal.sid`)
-  Support HTTPS via reverse proxy
-  Whitelist optionnelle par serveur Plex (`PLEX_URL` + `PLEX_TOKEN`)
-  Changez `SESSION_SECRET` en production : `openssl rand -hex 32`
-  Gardez toutes les clés API secrètes

---

##  Développement

### Stack technique

- **Backend** : Node.js + Express.js
- **Templating** : EJS + express-ejs-layouts
- **Auth** : Plex OAuth (plex.tv API v2)
- **Base de données** : SQLite (sessions, XP, cache stats)
- **Container** : Docker


---

## Code source et contributions

Le code source de Plex Portal n'est pas public. Seule l'image Docker officielle et la documentation sont disponibles.

Pour toute suggestion ou bug, ouvrez une issue ou contactez l'auteur.


---

##  Support & FAQ

**Q : Que modifier pour passer du local à la production ?**
R : Rien côté app. Configurez ngx proxy manager pour pointer vers plex-portal, les headers `X-Forwarded-*` sont auto-détectés.

**Q : Seerr ne charge pas dans l'iframe ?**
R : Vérifiez que `SEERR_PUBLIC_URL` et l'URL du portail partagent le même domaine parent (`.votredomaine.com`). HTTPS requis.

**Q : Comment changer le port ?**
R : Dans docker-compose.yml : `ports: ["4000:3000"]`  l'interne reste 3000, l'externe est libre.

**Q : Comment personnaliser le logo ?**
R : Placez votre `logo.png` dans le volume `./config:/config`.

**Plus de questions ?**
-  Consultez [SETUP.md](./SETUP.md) et [DOCKER.md](./DOCKER.md)
-  Logs : `docker compose logs -f plex-portal`
-  Ouvrez une issue sur GitHub

---

## Contribution

Les contributions publiques ne sont pas autorisées.

Si vous souhaitez proposer une amélioration ou signaler un bug,
merci d’ouvrir une issue ou de me contacter directement.

---

##  Remerciements

- [Plex](https://plex.tv/)  Pour leur API OAuth
- [Wizarr](https://github.com/wizarrrr/wizarr)  Gestion des invitations
- [Tautulli](https://github.com/Tautulli/Tautulli)  Statistiques de visionnage
- [Seerr](https://github.com/seerr-team/seerr)  Gestion des demandes de médias
- [Organizr](https://github.com/causefx/Organizr)  Inspiration pour le SSO iframe

---

## Licence

Ce projet est propriétaire.

L'utilisation de l'image Docker officielle est autorisée pour un usage personnel ou interne uniquement.

Toute modification, redistribution ou usage commercial est strictement interdit sans autorisation écrite de l'auteur.

Voir le fichier [LICENSE](LICENSE) pour plus d'informations.