# 📦 Configuration Unraid - Plex Portal

Guide spécifique pour configurer Plex Portal sur **Unraid** avec **ngx proxy manager**.

> ✨ **NOUVEAU**: L'app détecte automatiquement la configuration via les headers du reverse proxy!

---

## 🎯 Prérequis

- ✅ Unraid installé et en cours d'exécution
- ✅ Docker installé sur Unraid
- ✅ ngx proxy manager ([Community Apps](https://hub.docker.com/r/jc21/nginx-proxy-manager))
- ✅ Compte Plex
- ✅ Domaine public (ex: `example.com`) ou DuckDNS

---

## 📁 Étape 1: Préparer les dossiers

### 1. Créer la structure sur Unraid

```
/mnt/user/appdata/
├── plex-portal/
│   └── config/         # Logo et configuration
```

### Via Terminal Unraid:

```bash
mkdir -p /mnt/user/appdata/plex-portal/config
```

---

## ⚙️ Étape 2: Configuration (ultra-simple!)

### 1. Créer/modifier `docker-compose.yml`

Ajouter juste le `SESSION_SECRET`:

```yaml
environment:
  SESSION_SECRET: "change-me-to-a-secure-key"
```

**C'est tout!** ✨

L'app détectera automatiquement:
- La présence du reverse proxy via les headers `X-Forwarded-*`
- L'URL publique via `X-Forwarded-Host`
- Le chemin de base via `X-Forwarded-Prefix`

### 2. Ajouter le logo (optionnel)

Placer `logo.png` dans `/mnt/user/appdata/plex-portal/config/`

Recommandé: 300x300px ou 400x400px

---

## 🐳 Étape 3: Créer le conteneur Docker

### Option A: Via Unraid UI (Easiest)

1. Aller à **Docker** ➜ **Add Container**

2. **Configuration:**
   - Name: `plex-portal`
   - Repository: `ghcr.io/idrinkx/plex-portal:latest`

3. **Ports:**
   - Container Port: `3000`
   - Host Port: `3000`
   - Protocol: `TCP`

4. **Volumes:**
   - Container Path: `/config`
   - Host Path: `/mnt/user/appdata/plex-portal/config`
   - Access Mode: `RW`

5. **Environment Variables:**
   - `SESSION_SECRET` = `your-secret-key` ⚠️ **OBLIGATOIRE**
   - `COOKIE_SECURE` = `true` ⚠️ **OBLIGATOIRE en production (HTTPS)**
   - `DEBUG` = `true` (optionnel, pour voir les logs)

6. Cliquer sur **Apply**

### Option B: Via docker-compose

1. Créer `/mnt/user/appdata/plex-portal/docker-compose.yml`:

```yaml
version: '3.8'

services:
  plex-portal:
    image: ghcr.io/idrinkx/plex-portal:latest
    container_name: plex-portal
    ports:
      - "3000:3000"
    environment:
      SESSION_SECRET: "change-me-to-a-secure-key"
      COOKIE_SECURE: "true"   # HTTPS via reverse proxy
    volumes:
      - /mnt/user/appdata/plex-portal/config:/config
      - /mnt/user/appdata/tautulli:/tautulli-data  # optionnel
    restart: unless-stopped
```

2. Lancer:
   ```bash
   cd /mnt/user/appdata/plex-portal
   docker-compose up -d
   ```

---

## 🌐 Étape 4: Configurer ngx proxy manager

### 1. Accéder à ngx

- Ouvrir: `http://192.168.10.101:81` (remplacer par votre IP)
- Login par défaut: `admin@example.com` / `changeme`

### 2. Créer une nouvelle route

**Dashboard** ➜ **Hosts** ➜ **Proxy Hosts** ➜ **Add Proxy Host**

#### Onglet: Details

```
Domain Names:      example.com
Scheme:            http
Forward Hostname:  192.168.10.101    (IP de plex-portal)
Forward Port:      3000
Cache Assets:      ✅ ON
Block Common Exploits: ✅ ON
Websockets Support: ✅ ON (IMPORTANT)
```

#### Onglet: Custom Locations

**Créer une location:**

```
Location:          /plex-portal
Scheme:            http
Forward Hostname:  192.168.10.101
Forward Port:      3000
Strip Path:        ✅ ON (TRÈS IMPORTANT!)
```

> ⚠️ **Strip Path DOIT être activé** - ngx envoie les headers `X-Forwarded-Prefix` que l'app utilise pour auto-détection!

#### Onglet: SSL

- SSL Certificate: `Request New SSL Certificate`
- Domain Name: `example.com`
- Email: `your-email@example.com`
- Use wildcard DNS?: ✅ (si vous avez un wildcard)
- Force SSL: ✅ ON
- HTTP/2 Support: ✅ ON
- HSTS Enabled: ✅ ON

#### Onglet: Access Control

_(Optionnel)_ Restreindre l'accès si nécessaire

### 3. Sauvegarder

Cliquer sur **Save** ✅

---

## ✅ Étape 5: Tester

### 1. Test local

```
http://192.168.10.101:3000
```

Vous devriez voir la page login. ✅

### 2. Test via reverse proxy

```
https://example.com/plex-portal
```

Vous devriez être redirigé vers login. ✅

### 3. Tester l'authentification Plex

1. Cliquer sur "Se connecter avec Plex"
2. Vous connecter avec votre compte Plex
3. Redirection vers le dashboard ✅

**L'app a automatiquement détecté que vous étiez derrière un reverse proxy!** ✨

---

## 🔍 Debugging (si problèmes)

### Afficher les logs de détection

Ajouter dans les environment variables:

```
DEBUG=true
```

Puis vérifier les logs:

```bash
docker logs plex-portal
```

Vous devriez voir:

```
🔍 Reverse Proxy Detection:
   basePath: "/plex-portal"
   appUrl: "https://example.com/plex-portal"
   isReverseProxy: true
```

---

## 🔒 Configuration HTTPS/SSL

### 1. Let's Encrypt (recommandé)

ngx proxy manager va générer automatiquement un certificat Let's Encrypt. ✅

### 2. DuckDNS (si pas de domaine)

1. Aller sur [DuckDNS](https://www.duckdns.org/)
2. Créer un compte
3. Ajouter un domaine: `my-plex.duckdns.org`
4. Dans ngx: utiliser `my-plex.duckdns.org`
5. ngx va générer le SSL automatiquement

---

## 🛠️ Troubleshooting Unraid

### ❌ "Connection refused" sur `192.168.10.101:3000`

- Vérifier que le conteneur plex-portal est en cours d'exécution
- Vérifier que le port 3000 n'est pas utilisé
- Logs: `docker logs plex-portal`

### ❌ "Plex redirect error"

**Solution**: L'app utilise maintenant les headers du reverse proxy pour l'URL. Assurez-vous que:
- ngx proxy manager envoie `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-Prefix`
- Ces headers sont standards et envoyés automatiquement par ngx ✅

### ❌ "Logo ne s'affiche pas"

- Vérifier que `logo.png` est dans `/mnt/user/appdata/plex-portal/config/`
- Redémarrer le conteneur

### ❌ "API routes not found (404)"

- Vérifier que **Strip Path** est ✅ ON dans ngx
- Vérifier les logs avec `DEBUG=true`

### ❌ "static files not found (CSS/JS)"

- Généralement c'est le même que API routes
- Vérifier **Strip Path: ON**

---

## 📊 Intégrations supplémentaires

### Wizarr (Gestion des invitations)

1. IP interne Wizarr: `192.168.x.x:5690`
2. Obtenir la clé API dans Wizarr: Settings ➜ API

Ajouter aux environment variables:
```
WIZARR_URL=http://192.168.x.x:5690
WIZARR_API_KEY=your-key
```

### Tautulli (Statistiques de visionnage)

1. IP interne Tautulli: `192.168.x.x:8181`
2. Obtenir la clé API dans Tautulli: Web Interface ➜ Settings ➜ API

Ajouter aux environment variables:
```
TAUTULLI_URL=http://192.168.x.x:8181
TAUTULLI_API_KEY=your-key
TAUTULLI_DB_PATH=/tautulli-data/tautulli.db
```

---

## 📝 Montage des volumes

```
Container Path    │ Host Path
─────────────────┼────────────────────────────────
/config          │ /mnt/user/appdata/plex-portal/config
/tautulli-data   │ /mnt/user/appdata/tautulli          (optionnel, lecture DB directe)
```

---

## 💾 Sauvegarde Unraid

### Sauvegarder la configuration

```bash
# Sauvegarder le config
cp -r /mnt/user/appdata/plex-portal /mnt/backup/
```

### Restaurer après crash

```bash
cp -r /mnt/backup/plex-portal /mnt/user/appdata/
docker-compose up -d
```

---

## 🎯 Checklist finale

- ✅ Docker installé
- ✅ ngx proxy manager installé
- ✅ Dossier `/mnt/user/appdata/plex-portal/config` créé
- ✅ SESSION_SECRET configuré
- ✅ `logo.png` placé dans `config/` (optionnel)
- ✅ Conteneur Docker créé et en cours d'exécution
- ✅ Route ngx créée avec "Strip Path: ON"
- ✅ SSL configuré
- ✅ Accessible via `https://example.com/plex-portal`
- ✅ Authentification Plex fonctionnelle
- ✅ Auto-détection du reverse proxy fonctionnelle ✨

---


## 🆘 Support

- 📖 Consulter [DOCKER.md](./DOCKER.md)
- 📖 Consulter [SETUP.md](./SETUP.md)
- 💬 Ouvrir une issue sur GitHub

---

## Code source et contributions

Le code source de Plex Portal n'est pas public. Seule l'image Docker officielle et la documentation sont disponibles.
Pour toute suggestion ou bug, ouvrez une issue ou contactez l'auteur.
