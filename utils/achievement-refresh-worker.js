const { initDatabase } = require("./database");
const { applyRuntimeConfig } = require("./config");
const { initTautulliDatabase } = require("./tautulli-direct");
const { refreshUserAchievementState } = require("./achievement-state");

async function main() {
  const payloadRaw = process.argv[2] || "";
  if (!payloadRaw) {
    throw new Error("Payload manquant");
  }

  let payload = null;
  try {
    payload = JSON.parse(payloadRaw);
  } catch (err) {
    throw new Error(`Payload invalide: ${err.message}`);
  }

  initDatabase();
  applyRuntimeConfig();
  initTautulliDatabase();

  await refreshUserAchievementState(payload.sessionUser || {}, payload.options || {});
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    const message = err?.stack || err?.message || String(err);
    process.stderr.write(String(message));
    process.exit(1);
  });
