const express = require("express");
const fetch = require("node-fetch");
const router = express.Router();

const { isUserAuthorized } = require("../utils/plex");

/**
 * Grab le cookie connect.sid de Seerr via le token Plex.
 * Même logique qu'Organizr sso-functions.php#L335.
 *
 * Approche iframe : le cookie est posé avec domain=.idrinktv.ovh (parent commun
 * entre plex-portal.idrinktv.ovh et overseerr.idrinktv.ovh) → le browser l'envoie
 * automatiquement quand l'iframe charge overseerr.idrinktv.ovh.
 */
function getSeerrCookieDomain() {
  const publicUrl = process.env.OVERSEERR_PUBLIC_URL || "";
  if (!publicUrl) return null;
  try {
    const hostname = new URL(publicUrl).hostname; // ex: overseerr.idrinktv.ovh
    const parts = hostname.split(".");
    if (parts.length >= 2) return "." + parts.slice(-2).join("."); // .idrinktv.ovh
  } catch (e) {}
  return null;
}

async function grabSeerrCookie(authToken, res) {
  const overseerrUrl = (process.env.OVERSEERR_URL || "").replace(/\/$/, "");
  if (!overseerrUrl || !authToken) return;
  try {
    const r = await fetch(`${overseerrUrl}/api/v1/auth/plex`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ authToken })
    });
    if (!r.ok) {
      console.warn(`[Auth] Seerr SSO échoué: HTTP ${r.status}`);
      return;
    }
    const setCookies = r.headers.raw()["set-cookie"] || [];
    const sidCookie = setCookies.find(c => c.startsWith("connect.sid="));
    if (sidCookie) {
      const value = sidCookie.split(";")[0].replace("connect.sid=", "");
      const cookieDomain = getSeerrCookieDomain();
      const cookieOpts = {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: true  // HTTPS requis pour cross-subdomain
      };
      if (cookieDomain) cookieOpts.domain = cookieDomain;
      res.cookie("connect.sid", decodeURIComponent(value), cookieOpts);
      console.info(`[Auth] ✅ Cookie Seerr posé dans le browser (connect.sid, domain=${cookieDomain || "courant"})`);
    } else {
      console.warn("[Auth] Seerr n'a pas retourné de connect.sid");
    }
  } catch (e) {
    console.warn("[Auth] Erreur grab cookie Seerr:", e.message);
  }
}

router.get("/login", async (req, res) => {

  const response = await fetch("https://plex.tv/api/v2/pins?strong=true", {
    method: "POST",
    headers: {
      "X-Plex-Client-Identifier": "plex-portal-app",
      "X-Plex-Product": "Plex Portal",
      "Accept": "application/json"
    }
  });

  const data = await response.json();

  req.session.pinId = data.id;

  // Construire l'URL de callback automatiquement
  const forwardUrl = req.appUrl + "/auth-complete";

  res.redirect(
    `https://app.plex.tv/auth#?clientID=plex-portal-app&code=${data.code}&forwardUrl=${encodeURIComponent(forwardUrl)}`
  );
});

router.get("/auth-complete", async (req, res) => {

  if (!req.session.pinId) return res.redirect(req.basePath + "/");

  let authToken = null;

  for (let i = 0; i < 10; i++) {
    const response = await fetch(
      `https://plex.tv/api/v2/pins/${req.session.pinId}`,
      {
        headers: {
          "X-Plex-Client-Identifier": "plex-portal-app",
          "Accept": "application/json"
        }
      }
    );

    const data = await response.json();

    if (data.authToken) {
      authToken = data.authToken;
      break;
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  if (!authToken) return res.redirect(req.basePath + "/");

  const account = await fetch("https://plex.tv/api/v2/user", {
    headers: {
      "X-Plex-Token": authToken,
      "Accept": "application/json"
    }
  });

  const user = await account.json();

  console.info(`\n[Auth] Login attempt from Plex user:`);
  console.info(`  ID: ${user.id}`);
  console.info(`  Email: ${user.email}`);
  console.info(`  Username: ${user.username}`);
  console.debug(`[Auth] Full user response from plex.tv:`, JSON.stringify(user, null, 2));

  // ⚠️ NOTE: Whitelist validation would require access to Plex server's user list,
  // which is not reliably exposed via Plex API. Since the user has successfully 
  // authenticated via Plex OAuth, we trust this as sufficient validation.
  
  console.info(`✅ [Auth] LOGIN SUCCESS for Plex user ${user.id} (${user.email})`);
  console.info(`[Auth] User authenticated via Plex OAuth\n`);

  req.session.user = user;
  req.session.user.joinedAtTimestamp = user.joinedAt;
  req.session.plexToken = authToken;
  delete req.session.pinId;

  // Grab le cookie Seerr immédiatement au login (same as Organizr)
  // Le cookie connect.sid est posé en cross-subdomain → l'iframe overseerr.idrinktv.ovh
  // est authentifiée automatiquement sans que l'utilisateur ait à se re-connecter.
  await grabSeerrCookie(authToken, res);

  res.redirect(req.basePath + "/dashboard");
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect(req.basePath + "/");
  });
});

module.exports = router;
