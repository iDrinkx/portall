# Guide Docker - Plex Portal

## Objectif

Le `docker-compose.yml` charge maintenant les variables via `config/.env` pour ne plus exposer les URLs et clés API directement dans le compose.

## Fichiers

- `docker-compose.yml` : définition du service
- `config/.env` : variables privées (non versionné)
- `config/.env.example` : template versionné

## Demarrage rapide

1. Créez le fichier d'environnement:
```bash
cp config/.env.example config/.env
```
2. Editez `config/.env`:
- `SESSION_SECRET` (obligatoire)
- URLs/API des intégrations (`SEERR_*`, `TAUTULLI_*`, `WIZARR_*`, `KOMGA_URL`, `KOMGA_PUBLIC_URL`, `JELLYFIN_URL`, `JELLYFIN_PUBLIC_URL`, `ROMM_URL`, `ROMM_PUBLIC_URL`, `RADARR_*`, `SONARR_*`, `PLEX_*`)
- Pour `komga_auto`, `jellyfin_auto` et `romm_auto`, chaque utilisateur renseigne ses identifiants une fois via le portail
3. Lancez:
```bash
docker-compose up -d
```

## Exemple compose

```yaml
version: '3.8'

services:
  plex-portal:
    build: .
    container_name: plex-portal
    ports:
      - "3000:3000"
    env_file:
      - ./config/.env
    environment:
      NODE_ENV: "${NODE_ENV:-production}"
    volumes:
      - ./config:/config
      - /mnt/user/appdata/tautulli:/tautulli-data
    restart: unless-stopped
```

## Notes securite

- Ne versionnez pas `config/.env`.
- Generez une vraie valeur `SESSION_SECRET` en production:
```bash
openssl rand -hex 32
```
