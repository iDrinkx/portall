const { initDatabase } = require('./database');
const { applyRuntimeConfig } = require('./config');
const { initTautulliDatabase } = require('./tautulli-direct');
const { buildClassementSnapshot } = require('./classement-refresh-build');

async function main() {
  const payloadRaw = process.argv[2] || '{}';
  let payload = {};

  try {
    payload = JSON.parse(payloadRaw);
  } catch (err) {
    throw new Error(`Payload invalide: ${err.message}`);
  }

  initDatabase();
  applyRuntimeConfig();
  initTautulliDatabase();

  const result = await buildClassementSnapshot(payload || {});

  if (typeof process.send === 'function') {
    process.send({ type: 'result', result });
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    const message = err?.stack || err?.message || String(err);
    if (typeof process.send === 'function') {
      process.send({ type: 'error', error: message });
    } else {
      process.stderr.write(String(message));
    }
    process.exit(1);
  });
