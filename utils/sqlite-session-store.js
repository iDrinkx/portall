const session = require("express-session");

const TABLE_NAME = "http_sessions";

class SQLiteSessionStore extends session.Store {
  constructor({ db, ttlMs, cleanupIntervalMs = 60 * 60 * 1000 }) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this.cleanupIntervalMs = cleanupIntervalMs;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        sid TEXT PRIMARY KEY,
        session_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${TABLE_NAME}_expires_at
        ON ${TABLE_NAME}(expires_at);
    `);

    this.getStatement = this.db.prepare(`
      SELECT session_json FROM ${TABLE_NAME}
      WHERE sid = ? AND expires_at > ?
    `);
    this.setStatement = this.db.prepare(`
      INSERT INTO ${TABLE_NAME} (sid, session_json, expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET
        session_json = excluded.session_json,
        expires_at = excluded.expires_at
    `);
    this.destroyStatement = this.db.prepare(`DELETE FROM ${TABLE_NAME} WHERE sid = ?`);
    this.clearStatement = this.db.prepare(`DELETE FROM ${TABLE_NAME}`);
    this.cleanupStatement = this.db.prepare(`DELETE FROM ${TABLE_NAME} WHERE expires_at <= ?`);
    this.lengthStatement = this.db.prepare(`
      SELECT COUNT(*) AS count FROM ${TABLE_NAME} WHERE expires_at > ?
    `);

    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
    this.cleanup();
  }

  getExpiry(sessionData) {
    const cookieExpiry = sessionData?.cookie?.expires;
    const parsedExpiry = cookieExpiry ? new Date(cookieExpiry).getTime() : NaN;
    return Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + this.ttlMs;
  }

  get(sid, callback = () => {}) {
    try {
      const row = this.getStatement.get(sid, Date.now());
      if (!row) return callback(null, null);

      try {
        return callback(null, JSON.parse(row.session_json));
      } catch (error) {
        this.destroyStatement.run(sid);
        return callback(error);
      }
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sessionData, callback = () => {}) {
    try {
      this.setStatement.run(sid, JSON.stringify(sessionData), this.getExpiry(sessionData));
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  touch(sid, sessionData, callback = () => {}) {
    return this.set(sid, sessionData, callback);
  }

  destroy(sid, callback = () => {}) {
    try {
      this.destroyStatement.run(sid);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  clear(callback = () => {}) {
    try {
      this.clearStatement.run();
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  length(callback = () => {}) {
    try {
      const row = this.lengthStatement.get(Date.now());
      return callback(null, row.count);
    } catch (error) {
      return callback(error);
    }
  }

  cleanup() {
    try {
      this.cleanupStatement.run(Date.now());
    } catch (error) {
      this.emit("disconnect", error);
    }
  }
}

module.exports = SQLiteSessionStore;
