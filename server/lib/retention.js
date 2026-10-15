import { rmSync } from 'node:fs';

// Runs hourly in its own pass. Never on the write path: a delete that rides along with ingest
// would put filesystem I/O inside the ingest transaction and destroy the one-fsync-per-batch
// property the batch design depends on.
//
// Deletes files first, then rows. The reverse order would leave orphan files that nothing can
// find, because the row is what records the storage key.
export function sweepExpired(db, store, { now = Date.now(), limit = 5000 } = {}) {
  const cutoff = new Date(now).toISOString();
  const rows = db.prepare(
    'SELECT id, storage_key FROM screenshots WHERE expires_at < ? ORDER BY expires_at LIMIT ?',
  ).all(cutoff, limit);
  let files = 0;
  for (const row of rows) {
    try { rmSync(store.absolute(row.storage_key), { force: true }); files += 1; } catch { /* already gone */ }
  }
  let removed = 0;
  if (rows.length > 0) {
    // Parameterised per id rather than one big IN (...) string: an injected literal list built by
    // joining unvalidated ids is the classic way this pattern goes wrong.
    const del = db.prepare('DELETE FROM screenshots WHERE id = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) { del.run(row.id); removed += 1; }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return { scanned: rows.length, filesRemoved: files, rowsRemoved: removed, cutoff };
}

export function startSweeper(db, store, { intervalMs = 60 * 60 * 1000, onSweep = () => {}, onError = () => {} } = {}) {
  const run = () => {
    try { onSweep(sweepExpired(db, store)); } catch (err) { onError(err); }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), runNow: run };
}

export function retentionExpiry(nowMs, days) {
  return new Date(nowMs + days * 86400000).toISOString();
}
