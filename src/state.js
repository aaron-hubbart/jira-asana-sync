const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_map (
      jira_key       TEXT PRIMARY KEY,
      asana_task_gid TEXT NOT NULL,
      last_status    TEXT,
      updated_at     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

function getMapping(db, jiraKey) {
  return db.prepare("SELECT * FROM issue_map WHERE jira_key = ?").get(jiraKey);
}

function upsertMapping(db, jiraKey, asanaTaskGid, status) {
  db.prepare(`
    INSERT INTO issue_map (jira_key, asana_task_gid, last_status, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(jira_key) DO UPDATE SET
      asana_task_gid = excluded.asana_task_gid,
      last_status    = excluded.last_status,
      updated_at     = excluded.updated_at
  `).run(jiraKey, asanaTaskGid, status);
}

function getRunState(db, key) {
  const row = db.prepare("SELECT value FROM run_state WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setRunState(db, key, value) {
  db.prepare(`
    INSERT INTO run_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

module.exports = { open, getMapping, upsertMapping, getRunState, setRunState };
