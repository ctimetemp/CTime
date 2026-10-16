import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// node:sqlite is synchronous and every write is an fsync at commit. That is why writes are
// grouped: a 200-event flush must be one transaction, not two hundred. txCount is exported so
// scripts/perf-bench.js can assert it rather than trust it.
export const stats = { tx: 0, statements: 0, rowsWritten: 0 };

export function openDatabase(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  // NORMAL under WAL: fsync happens at checkpoint, not at every commit. Safe against process
  // death; the durability trade-off is a power loss inside the last checkpoint.
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

export function isEmpty(db) {
  return db
    .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .get().c === 0;
}

export function loadSchema(db, schemaSql) {
  db.exec(schemaSql);
}

// Columns added since the first shipped schema. There is no migration framework in node:sqlite
// and no intention of adding one, so each addition is an idempotent ALTER: a fresh database gets
// the column from schema.sql, an existing one gets it here. Written to be safe to re-run.
const DEVICE_ADDITIONS = [
  ['token_delivered_at', 'TEXT'],
  ['first_contact_at', 'TEXT'],
  ['first_data_at', 'TEXT'],
];

const CLIPBOARD_ADDITIONS = [
  ['clip_text', 'TEXT'],
  ['clip_files', 'TEXT'],
  ['clip_image_b64', 'TEXT'],
];

export function migrate(db) {
  const have = new Set(db.prepare('PRAGMA table_info(devices)').all().map((r) => r.name));
  const added = [];
  for (const [name, type] of DEVICE_ADDITIONS) {
    if (have.has(name)) continue;
    db.exec(`ALTER TABLE devices ADD COLUMN ${name} ${type}`);
    added.push(name);
  }

  const clip = new Set(db.prepare('PRAGMA table_info(clipboard_metrics)').all().map((r) => r.name));
  for (const [name, type] of CLIPBOARD_ADDITIONS) {
    if (clip.has(name)) continue;
    db.exec(`ALTER TABLE clipboard_metrics ADD COLUMN ${name} ${type}`);
    added.push(`clipboard_metrics.${name}`);
  }
  return added;
}

// Runs fn inside a single transaction. Nested calls throw on purpose: a nested BEGIN would
// silently become an error from SQLite and hide a caller that thought it owned the commit.
// DatabaseSync exposes no inTransaction flag, so ownership is tracked here.
let txDepth = 0;
export function tx(db, fn) {
  if (txDepth > 0) throw new Error('nested transaction');
  txDepth = 1;
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    stats.tx += 1;
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* tx already aborted by SQLite */ }
    throw err;
  } finally {
    txDepth = 0;
  }
}

export function inTransaction() {
  return txDepth > 0;
}

// Counting wrapper: every statement the ingest path runs goes through here so the write count
// in perf-bench is a property of the code, not of a log-grepping convention.
export function prepared(db, sql) {
  const stmt = db.prepare(sql);
  stats.statements += 1;
  return {
    run(...args) {
      const r = stmt.run(...args);
      stats.rowsWritten += r.changes ?? 0;
      return r;
    },
    get(...args) { return stmt.get(...args); },
    all(...args) { return stmt.all(...args); },
  };
}

export function resetStats() {
  stats.tx = 0;
  stats.statements = 0;
  stats.rowsWritten = 0;
}

// Cursor pagination over a monotonic column, descending. There is deliberately no offset/limit
// variant and no unbounded "all" mode: the screenshot wall must never be able to ask for every
// image. Shared by the JSON admin API and the server-rendered dashboard so both page identically.
export function pagedQuery(db, table, where, params, order, { limit, cursor }) {
  const clauses = [...where];
  const args = [...params];
  if (cursor !== null) { clauses.push(`${order.col} < ?`); args.push(cursor); }
  const sql = `SELECT * FROM ${table} ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY ${order.col} DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...args, limit + 1);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const next = hasMore ? items[items.length - 1][order.col] : null;
  return { items, next_cursor: next, has_more: hasMore };
}
