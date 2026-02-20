/**
 * Logger minimaliste avec timestamps et niveaux colorés.
 *
 * Format : 16:31:09 INFO  [Auth] Message
 *
 * Usage :
 *   const log = require('./logger').create('[Auth]');
 *   log.info('Login réussi');
 *   log.warn('Token expiré');
 *   log.error('Connexion échouée:', err.message);
 *   log.debug('Payload brut:', data);  // uniquement si DEBUG=true
 */

// ANSI — désactivé si pas de TTY (ex: Docker sans terminal alloué)
const isColor = process.stdout.isTTY;
const c = {
  reset:  isColor ? '\x1b[0m'  : '',
  bold:   isColor ? '\x1b[1m'  : '',
  gray:   isColor ? '\x1b[90m' : '',
  cyan:   isColor ? '\x1b[36m' : '',
  yellow: isColor ? '\x1b[33m' : '',
  red:    isColor ? '\x1b[31m' : '',
  green:  isColor ? '\x1b[32m' : '',
  white:  isColor ? '\x1b[97m' : '',
};

function timestamp() {
  const now = new Date();
  return now.toTimeString().slice(0, 8); // "HH:MM:SS"
}

const LEVELS = {
  info:  { label: 'INFO ', color: c.cyan   },
  warn:  { label: 'WARN ', color: c.yellow },
  error: { label: 'ERROR', color: c.red    },
  debug: { label: 'DEBUG', color: c.gray   },
};

/**
 * Formate et écrit une ligne de log.
 * @param {string} level - 'info' | 'warn' | 'error' | 'debug'
 * @param {string} tag   - ex: '[Auth]'
 * @param {any[]}  args  - message + données additionnelles
 */
function write(level, tag, args) {
  const { label, color } = LEVELS[level];
  const ts   = `${c.gray}${timestamp()}${c.reset}`;
  const lvl  = `${color}${label}${c.reset}`;
  const lbl  = `${c.bold}${tag}${c.reset}`;

  // Premier arg = message texte, les suivants sont joints
  const parts = args.map(a =>
    (a instanceof Error) ? a.message :
    (typeof a === 'object' && a !== null) ? JSON.stringify(a) :
    String(a)
  );

  const line = parts.join(' ');
  const out  = `${ts} ${lvl} ${lbl} ${line}`;

  if (level === 'error') {
    console.error(out);
  } else if (level === 'warn') {
    console.warn(out);
  } else {
    console.log(out);
  }
}

/**
 * Crée un logger attaché à un tag.
 * @param {string} tag - ex: '[Auth]', '[Tautulli]'
 */
function create(tag) {
  const debugEnabled = process.env.DEBUG === 'true';
  return {
    info:  (...a) => write('info',  tag, a),
    warn:  (...a) => write('warn',  tag, a),
    error: (...a) => write('error', tag, a),
    debug: (...a) => { if (debugEnabled) write('debug', tag, a); },
  };
}

module.exports = { create };
