# Documentation Technique

## Vue d'ensemble

Plex Portal utilise maintenant une configuration hybride:

- variables de bootstrap au démarrage via `docker-compose.yml`
- configuration applicative modifiable via l'interface admin
- persistance en base SQLite dans `app_settings`

La règle de priorité est:

`base de données > environnement > valeur par défaut`

Le point d'entrée principal est [`server.js`](./server.js). La configuration éditable est centralisée dans [`utils/config.js`](./utils/config.js).

## Configuration runtime

### Variables de bootstrap

Ces variables doivent exister avant le démarrage du process:

- `SESSION_SECRET`
- `PORT`
- `COOKIE_SECURE`
- `NODE_ENV`
- `DEBUG`

Elles restent dans `docker-compose.yml`.

### Configuration éditable

Les URLs et tokens des services sont stockés en base via `app_settings` et modifiables dans `Parametres > Connexions`.

Exemples:

- `PLEX_URL`
- `PLEX_TOKEN`
- `SEERR_URL`
- `SEERR_PUBLIC_URL`
- `TAUTULLI_URL`
- `TAUTULLI_API_KEY`
- `KOMGA_URL`
- `KOMGA_PUBLIC_URL`
- `JELLYFIN_URL`
- `JELLYFIN_PUBLIC_URL`
- `ROMM_URL`
- `ROMM_PUBLIC_URL`
- `RADARR_URL`
- `RADARR_API_KEY`
- `SONARR_URL`
- `SONARR_API_KEY`

Implémentation:

- lecture centralisée: [`utils/config.js`](./utils/config.js)
- persistance: [`utils/database.js`](./utils/database.js)
- écran admin: [`views/parametres/index.ejs`](./views/parametres/index.ejs)
- API admin: [`routes/dashboard.routes.js`](./routes/dashboard.routes.js)

### Setup initial

Si la configuration minimale Plex n'est pas présente, l'application redirige vers `/setup`.

Le setup:

- stocke les connexions en base
- applique la config au runtime
- marque l'installation comme terminée

Fichiers:

- [`routes/auth.routes.js`](./routes/auth.routes.js)
- [`views/setup.ejs`](./views/setup.ejs)

## Interface admin

La page `Parametres` est devenue le point de contrôle principal.

Onglets actuels:

- `General`
- `Fond du site`
- `Connexions`
- `Dashboard HTML`

Fonctions principales:

- activation/desactivation de certaines options globales
- sélection de la langue du site
- gestion du fond global
- gestion des connexions applicatives
- gestion des cartes natives et custom du dashboard
- injection de HTML custom sous les cartes

## Dashboard

### Cartes natives

Les cartes natives peuvent être:

- réordonnées
- activées ou désactivées

Le même ordre est appliqué:

- au dashboard
- au menu supérieur

Fichiers:

- [`utils/dashboard-builtins.js`](./utils/dashboard-builtins.js)
- [`routes/dashboard.routes.js`](./routes/dashboard.routes.js)
- [`views/dashboard/index.ejs`](./views/dashboard/index.ejs)
- [`views/layout.ejs`](./views/layout.ejs)

### HTML custom

Un bloc HTML custom peut être injecté sous les cartes du dashboard.

Modes disponibles:

- `safe`: nettoyage du HTML
- `raw`: compatibilité Organizr

Fichiers:

- [`utils/dashboard-custom-html.js`](./utils/dashboard-custom-html.js)
- [`views/parametres/index.ejs`](./views/parametres/index.ejs)
- [`views/dashboard/index.ejs`](./views/dashboard/index.ejs)

## Internationalisation

Le portail supporte actuellement:

- français
- anglais

Le choix de langue est global et stocké en base.

Composants:

- dictionnaire serveur: [`utils/i18n.js`](./utils/i18n.js)
- injection globale: [`server.js`](./server.js)
- traduction runtime DOM: [`views/layout.ejs`](./views/layout.ejs)

## Fond global du site

Le fond du site est configurable depuis `Parametres > Fond du site`.

Presets disponibles:

- `particles`
- `aurora`
- `mesh`
- `nebula`
- `spotlight`
- `waves`
- `custom`

Le mode `custom` accepte:

- URL d'image
- import de fichier image
- réglage d'opacité

Fichiers:

- [`utils/site-background.js`](./utils/site-background.js)
- [`views/parametres/index.ejs`](./views/parametres/index.ejs)
- [`views/layout.ejs`](./views/layout.ejs)
- [`public/css/style.css`](./public/css/style.css)

## Noms dynamiques liés à Plex

Les textes qui mentionnaient un nom fixe de serveur utilisent désormais le nom réel du serveur Plex.

Source:

- endpoint Plex `/identity`

Injection:

- [`server.js`](./server.js)

Utilisation:

- [`utils/achievements.js`](./utils/achievements.js)
- [`routes/dashboard.routes.js`](./routes/dashboard.routes.js)
- [`views/login.ejs`](./views/login.ejs)
- [`views/succes.ejs`](./views/succes.ejs)

## Auto-auth et SSO

### Seerr

Le flux Seerr utilise:

- `SEERR_URL` pour l'auth interne
- `SEERR_PUBLIC_URL` pour l'iframe publique

Le cookie `connect.sid` est récupéré côté serveur puis reposé sur le domaine parent compatible.

Fichiers:

- [`routes/auth.routes.js`](./routes/auth.routes.js)
- [`routes/seerr-proxy.routes.js`](./routes/seerr-proxy.routes.js)
- [`views/seerr/index.ejs`](./views/seerr/index.ejs)

### Komga

Le flux Komga est un auto-auth par compte utilisateur.

Chaque utilisateur enregistre une fois ses identifiants Komga, puis le portail:

- récupère ou force une session Komga
- repose les cookies sur le domaine parent
- ouvre la carte dans une iframe

Fichiers:

- [`routes/dashboard.routes.js`](./routes/dashboard.routes.js)
- [`views/apps/service-connect.ejs`](./views/apps/service-connect.ejs)
- [`views/apps/iframe.ejs`](./views/apps/iframe.ejs)

### Jellyfin

Le flux Jellyfin authentifie l'utilisateur puis enrichit l'URL iframe avec le token nécessaire.

Fichier principal:

- [`routes/dashboard.routes.js`](./routes/dashboard.routes.js)

### RomM

Le flux RomM ouvre une session web côté serveur puis repose les cookies sur le domaine parent.

Fichier principal:

- [`routes/dashboard.routes.js`](./routes/dashboard.routes.js)

### Important

Les flux `Seerr`, `Komga`, `Jellyfin` et `RomM` lisent désormais leurs URLs via la config centralisée et non via les anciennes variables d'environnement seules.

## Base de données

La base SQLite stocke notamment:

- utilisateurs
- succès
- progression
- cartes dashboard
- credentials service par utilisateur
- paramètres applicatifs

Fichier principal:

- [`utils/database.js`](./utils/database.js)

## Redémarrage requis

La plupart des changements enregistrés dans `Parametres > Connexions` sont persistants immédiatement.

Certains paramètres techniques peuvent nécessiter un redémarrage du conteneur, par exemple:

- `TAUTULLI_DB_PATH`

## Recommandations de maintenance

- garder `SESSION_SECRET` uniquement dans le compose
- utiliser `Parametres > Connexions` pour les URLs et tokens
- vérifier les URLs publiques utilisées pour les iframes et cookies cross-subdomain
- en cas d'auto-auth cassé, vérifier en priorité:
  - domaine parent commun
  - HTTPS
  - valeur publique du service dans `Connexions`
