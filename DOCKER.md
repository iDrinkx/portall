# Guide Docker - Plex Portal

## Objectif

Le `docker-compose.yml` ne porte plus que les variables de bootstrap.
Les URLs et clés API des services sont désormais gérées par le setup web puis `Parametres > Connexions`.

## Fichiers

- `docker-compose.yml` : définition du service
- `SETUP.md` : guide de premier lancement
- `TECHNICAL.md` : détail de l'architecture de configuration

## Demarrage rapide

1. Editez `docker-compose.yml`
2. Renseignez au minimum `SESSION_SECRET`
3. Lancez:
```bash
docker-compose up -d
```
4. Ouvrez l'application
5. Finalisez `/setup`
6. Renseignez ensuite les services dans `Parametres > Connexions`

## Exemple compose

```yaml
version: '3.8'

services:
  plex-portal:
    build: .
    container_name: plex-portal
    ports:
      - "3000:3000"
    environment:
      SESSION_SECRET: "change-me"
      NODE_ENV: "production"
      COOKIE_SECURE: "true"
    volumes:
      - ./config:/config
      - /mnt/user/appdata/tautulli:/tautulli-data
    restart: unless-stopped
```

## Notes securite

- Generez une vraie valeur `SESSION_SECRET` en production:
```bash
openssl rand -hex 32
```
- Les secrets applicatifs saisis dans l'UI sont persistés en base SQLite. Protégez le volume `/config`.
- Pour les intégrations iframe et SSO, utilisez des URLs publiques HTTPS cohérentes sur le même domaine parent quand nécessaire.
