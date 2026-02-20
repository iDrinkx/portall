# 🚀 Installation Plex Portal - Guide pas à pas

## 📋 Prérequis

- ✅ Docker installé ([Installer Docker](https://docs.docker.com/get-docker/))
- ✅ Docker Compose installé (généralement inclus avec Docker)
- ✅ Compte Plex ([Créer un compte](https://www.plex.tv/sign-up/))
- ✅ Un peu de temps ☕

---

## 🎯 Étape 1: Télécharger le projet

### Option A: Git (recommandé)

```bash
git clone https://github.com/idrinkx/plex-portal.git
cd plex-portal
```

### Option B: Télécharger le ZIP

1. Aller sur [GitHub](https://github.com/idrinkx/plex-portal)
2. Cliquer sur **Code** ➜ **Download ZIP**
3. Extraire le fichier
4. Ouvrir le dossier

---

## ⚙️ Étape 2: Configuration (minimale!)

### 1. Éditer `docker-compose.yml`

Ouvrir le fichier et changer **SESSION_SECRET**:

```yaml
SESSION_SECRET: "change-me-to-a-secure-key"
        ↓
SESSION_SECRET: "my-super-secret-key-12345"
```

**C'est tout ce qui est obligatoire!**

L'app détecte automatiquement:
- ✅ Si elle est en local ou derrière un reverse proxy
- ✅ L'URL publique (via headers du reverse proxy)
- ✅ Le chemin de base (via headers du reverse proxy)

### 2. Créer le dossier `config` (optionnel)

```bash
mkdir -p config
```

### 3. Ajouter votre logo (optionnel)

Placer un fichier `logo.png` dans le dossier `config/` (300x300px recommandé)

---

## 🚀 Étape 3: Lancer l'application

### En local

```bash
docker-compose up -d
```

✅ L'app est maintenant accessible à: **http://localhost:3000**

### Vérifier que tout fonctionne

```bash
docker-compose logs -f plex-portal
```

Vous devriez voir: `🚀 Server running on port 3000`

---

## 🧪 Étape 4: Tester l'application

1. Ouvrir votre navigateur
2. Aller à **http://localhost:3000**
3. Cliquer sur "Se connecter avec Plex"
4. Vous connecter avec votre compte Plex
5. Vous devriez être redirigé au dashboard ✅

---

## 🛑 Arrêter l'application

```bash
docker-compose down
```

---

## 🚀 Production: Unraid + Reverse Proxy

> ℹ️ Une fois que ça fonctionne en local, vous pouvez passer à la production

### 1. Aucune modification du docker-compose.yml!

L'app détecte automatiquement le reverse proxy. ✅

### 2. Configurer le reverse proxy (ngx proxy manager)

1. Ouvrir ngx proxy manager
2. **Créer une route:**
   - **Domain**: `example.com`
   - **Path**: `/plex-portal`
   - **Forward Hostname**: `192.168.10.104` (votre IP Unraid)
   - **Forward Port**: `3000`
   - **Websockets**: ✅ ON
   - **Strip Path**: ✅ **TRÈS IMPORTANT**

3. _(Optionnel)_ **SSL:**
   - Cliquer sur **SSL** ➜ **Choisir un certificat** (Let's Encrypt)
   - Cocher **Force SSL**

### 3. Lancer le conteneur

```bash
docker-compose up -d
```

### 4. Accès

- **Public**: `https://example.com/plex-portal`
- **Local**: `http://192.168.10.104:3000`

L'app détecte automatiquement chaque environnement! ✨

---

## 🆘 Problèmes courants

### ❌ "Cannot connect to Docker daemon"

- Vérifier que Docker est en cours d'exécution
- Sur Windows: Ouvrir Docker Desktop

### ❌ "Port 3000 already in use"

```yaml
ports:
  - "3001:3000"  # Utiliser 3001 au lieu de 3000
```

### ❌ "Plex login redirection error"

**En local:**
- Aucun problème prévu

**Avec reverse proxy:**
- Vérifier que ngx proxy manager envoie les headers `X-Forwarded-*`
- Vérifier que **Strip Path** est ✅ ON
- Vérifier que le domaine public est accessible

### ❌ "Logo ne s'affiche pas"

- Vérifier que `logo.png` existe dans `config/`
- Redémarrer: `docker-compose down && docker-compose up -d`

### ❌ "Session perte après restart"

- C'est normal! Les sessions sont en mémoire.
- Se reconnecter avec Plex.

---

## 📊 Options avancées (optionnel)

Si vous avez Wizarr ou Tautulli:

```yaml
environment:
  SESSION_SECRET: "your-key"
  WIZARR_URL: "http://192.168.10.100:5290"
  WIZARR_API_KEY: "your-key"
  TAUTULLI_URL: "http://192.168.10.100:8181"
  TAUTULLI_API_KEY: "your-key"
  DEBUG: "true"  # Affiche logs de détection
```

---

## 💡 Tips

- **Logs**: `docker-compose logs -f` pour déboguer
- **Redémarrer**: `docker-compose restart plex-portal`
- **Rebuild**: `docker-compose up -d --build` après changements du code
- **Nettoyer**: `docker-compose down -v` pour supprimer aussi les volumes

---

## 🎉 Fait!

Vous devriez maintenant avoir une application Plex Portal fonctionnelle! 

**En local**: `http://localhost:3000`
**Production**: Auto-détecté via le reverse proxy! ✨

En cas de problème:
1. Vérifier les logs: `docker-compose logs -f`
2. Consulter [DOCKER.md](./DOCKER.md)
3. Ouvrir une issue sur GitHub
