# Guide Docker - portall

## Objectif

Le `docker-compose.yml` ne porte plus que les variables de bootstrap.
Les URLs et clés API des services sont désormais gérées par le setup web puis `Parametres > Connexions`.

## Fichiers

- `docker-compose.yml` : définition du service
- `SETUP.md` : guide de premier lancement
- `TECHNICAL.md` : détail de l'architecture de configuration

## Demarrage rapide

1. Editez `docker-compose.yml`
2. Renseignez `SESSION_SECRET` et définissez un `SETUP_TOKEN` aléatoire long dans votre fichier `.env` :
```bash
SETUP_TOKEN=$(openssl rand -hex 32)
```
3. Lancez:
```bash
docker-compose up -d
```
4. Ouvrez l'application
5. Finalisez `/setup` en saisissant la même valeur dans le champ **Setup token**
6. Renseignez ensuite les services dans `Parametres > Connexions`

Le conteneur execute Node sans privileges root. Les valeurs `PUID` et `PGID` (1000 par defaut) determinent le proprietaire de `/config`; definissez-les dans `.env` pour correspondre a votre utilisateur hote, par exemple `PUID=1000` et `PGID=1000`. Au demarrage, le conteneur corrige uniquement l'ownership de `/config` lorsqu'il est inscriptible, puis abandonne root. Les montages de donnees de services, notamment Tautulli en lecture seule, ne sont jamais modifies.

## Exemple compose

```yaml
version: '3.8'

services:
  portall:
    build: .
    container_name: portall
    ports:
      - "3000:3000"
    environment:
      SESSION_SECRET: "change-me"
      SETUP_TOKEN: "${SETUP_TOKEN}"
      NODE_ENV: "production"
      COOKIE_SECURE: "true"
      TRUST_PROXY: "${TRUST_PROXY:-false}"
    volumes:
      - ./config:/config
      - /mnt/user/appdata/tautulli:/tautulli-data
    restart: unless-stopped
```

## Reverse proxy

`TRUST_PROXY` vaut `false` par defaut : les headers `X-Forwarded-*` sont ignores et un acces direct au port `3000` ne peut pas usurper l'IP client. Avec Nginx Proxy Manager, definissez `TRUST_PROXY=1` dans `.env` et n'exposez pas directement ce port ; `req.ip` reflete alors le client et `req.secure` reconnait HTTPS. Pour plusieurs proxies, utilisez leurs IP/CIDR explicites, separes par des virgules. N'utilisez jamais `TRUST_PROXY=true`.

## Notes securite

- Generez une vraie valeur `SESSION_SECRET` en production:
```bash
openssl rand -hex 32
```
- `SETUP_TOKEN` protège uniquement les API de configuration initiale. Ce n'est pas un token Plex : générez une valeur aléatoire longue, définissez-la dans `.env`, puis saisissez la même valeur dans le champ **Setup token** lors du premier `/setup`.
- Les secrets applicatifs saisis dans l'UI sont persistés en base SQLite. Protégez le volume `/config`.
- Pour les intégrations iframe et SSO, utilisez des URLs publiques HTTPS cohérentes sur le même domaine parent quand nécessaire.
