import {
  openSync, writeSync, closeSync, existsSync, mkdirSync, readdirSync,
  statSync, unlinkSync, readFileSync, writeFileSync, renameSync,
} from 'node:fs';
import path from 'node:path';

const SEGMENT_ROLL_BYTES = 1024 * 1024;

// The spool is a directory of fixed-size JSONL segments. Deliberately not SQLite and not a
// single JSON document: an append has to be O(1) and must never rewrite existing bytes, because
// the screenshot timer, the clipboard sampler and the extension watcher all hand events to this
// from a code path that cannot afford to await anything.
//
// Eviction is whole-segment and oldest-first, so a bounded spool degrades into a visible gap
// (spool_dropped) rather than into partial-line corruption or unbounded disk growth.
export function createSpool({ dir, maxBytes, segmentBytes = SEGMENT_ROLL_BYTES, onWarn = () => {} }) {
  mkdirSync(dir, { recursive: true });
  const metaFile = path.join(dir, 'meta.json');
  const blobsDir = path.join(dir, 'blobs');
  mkdirSync(blobsDir, { recursive: true });

  const state = loadMeta();
  let current = null; // {fd, file, bytes, seq}

  function loadMeta() {
    if (!existsSync(metaFile)) return { dropped: 0, nextSeq: 1 };
    try { return { dropped: 0, nextSeq: 1, ...JSON.parse(readFileSync(metaFile, 'utf8')) }; } catch {
      return { dropped: 0, nextSeq: 1 };
    }
  }

  function saveMeta() {
    try { writeFileSync(metaFile, JSON.stringify(state)); } catch (err) { onWarn(`meta: ${err.message}`); }
  }

  function segmentPath(seq) {
    return path.join(dir, `events-${String(seq).padStart(4, '0')}.jsonl`);
  }

  function listSegments() {
    return readdirSync(dir)
      .filter((f) => /^events-\d{4}\.jsonl$/.test(f))
      .sort()
      .map((f) => {
        const full = path.join(dir, f);
        const st = statSync(full);
        return { file: full, name: f, bytes: st.size, seq: Number(f.match(/\d{4}/)[0]) };
      })
      .filter((s) => s.bytes > 0);
  }

  function openCurrent() {
    if (current) return current;
    const segs = listSegments();
    if (segs.length === 0) {
      state.nextSeq = Math.max(1, state.nextSeq);
    } else {
      const last = segs[segs.length - 1];
      if (last.bytes < segmentBytes) {
        // Resume the newest segment when it still has room; the seq counter only advances on a roll.
        current = { fd: openSync(last.file, 'a'), file: last.file, bytes: last.bytes, seq: last.seq };
        state.nextSeq = last.seq + 1;
        return current;
      }
      state.nextSeq = last.seq + 1;
    }
    const file = segmentPath(state.nextSeq);
    current = { fd: openSync(file, 'a'), file, bytes: existsSync(file) ? statSync(file).size : 0, seq: state.nextSeq };
    state.nextSeq += 1;
    saveMeta();
    return current;
  }

  function countLines(file) {
    try {
      const buf = readFileSync(file);
      let n = 0;
      for (const b of buf) if (b === 0x0a) n += 1;
      return n;
    } catch { return 0; }
  }

  function blobList() {
    return readdirSync(blobsDir)
      .filter((f) => f.endsWith('.png'))
      .map((f) => {
        const full = path.join(blobsDir, f);
        return { file: full, name: f, bytes: statSync(full).size, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
  }

  function totals() {
    const segs = listSegments();
    const blobs = blobList();
    const bytes = segs.reduce((n, s) => n + s.bytes, 0) + blobs.reduce((n, b) => n + b.bytes, 0);
    return { bytes, segments: segs.length, blobs: blobs.length };
  }

  // Oldest-first whole-segment eviction. Blobs are evicted first: a screenshot is the largest
  // object and the least loss per item, whereas a segment holds many distinct events.
  function enforceCap() {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) return { evictedSegments: 0, evictedEvents: 0, evictedBlobs: 0 };
    let evictedSegments = 0;
    let evictedEvents = 0;
    let evictedBlobs = 0;
    let t = totals();
    if (t.bytes <= maxBytes) return { evictedSegments, evictedEvents, evictedBlobs };

    const blobs = blobList();
    for (const b of blobs) {
      if (t.bytes <= maxBytes) break;
      closeIfNeeded(b.file);
      unlinkSync(b.file);
      t.bytes -= b.bytes;
      evictedBlobs += 1;
      state.dropped += 1;
    }
    const segs = listSegments();
    for (const s of segs) {
      if (t.bytes <= maxBytes) break;
      const events = countLines(s.file);
      if (current && current.file === s.file) {
        // Never evict the segment we are writing into; roll it first so the cap can be honoured
        // without leaving a dangling fd.
        roll();
      }
      unlinkSync(s.file);
      t.bytes -= s.bytes;
      evictedSegments += 1;
      evictedEvents += events;
      state.dropped += events;
    }
    saveMeta();
    return { evictedSegments, evictedEvents, evictedBlobs, total: totals() };
  }

  function closeIfNeeded(file) {
    if (current && current.file === file) {
      try { closeSync(current.fd); } catch { /* already closed */ }
      current = null;
    }
  }

  function roll() {
    closeIfNeeded(current?.file);
  }

  function append(event) {
    const line = `${JSON.stringify(event)}\n`;
    const buf = Buffer.from(line, 'utf8');
    const seg = openCurrent();
    if (seg.bytes + buf.length > segmentBytes && seg.bytes > 0) {
      roll();
    }
    const target = openCurrent();
    try {
      // The fd is opened 'a', so writeSync appends at end-of-file on every call; there is no
      // appendSync in node:fs and a positional write here would corrupt the segment.
      writeSync(target.fd, buf);
      target.bytes += buf.length;
    } catch (err) {
      onWarn(`append failed: ${err.message}`);
      state.dropped += 1;
      saveMeta();
      current = null;
      return { ok: false, reason: err.message };
    }
    const cap = enforceCap();
    return { ok: true, segment: path.basename(target.file), bytes: buf.length, cap };
  }

  // PNG blobs are written synchronously by the capture child process handoff. They are flushed
  // one at a time and deleted on server acceptance.
  function writeBlob(name, buffer) {
    const clean = name.replace(/[^A-Za-z0-9._-]/g, '_');
    const full = path.join(blobsDir, `${Date.now().toString(36)}-${clean}.png`);
    const tmp = `${full}.part`;
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, buffer); } finally { closeSync(fd); }
    // Rename into place so a flush never picks up a half-written capture.
    renameSync(tmp, full);
    enforceCap();
    return full;
  }

  function pendingBlobFiles() { return blobList().map((b) => b.file); }

  // Take the oldest segments whose cumulative uncompressed size fits the batch budget, at most
  // maxItems lines. Returns the parsed events plus the files they came from; the caller deletes
  // them once the server has answered for the batch.
  function takeBatch(maxItems, maxBytes) {
    const segs = listSegments();
    const events = [];
    const files = [];
    let bytes = 0;
    for (const s of segs) {
      if (events.length >= maxItems) break;
      if (bytes + s.bytes > maxBytes && events.length > 0) break;
      let text;
      try { text = readFileSync(s.file, 'utf8'); } catch { continue; }
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      let consumed = 0;
      for (let i = 0; i < lines.length; i++) {
        if (events.length >= maxItems) break;
        let parsed = null;
        try { parsed = JSON.parse(lines[i]); } catch { consumed = i + 1; continue; }
        events.push(parsed);
        consumed = i + 1;
      }
      const takenBytes = lines.slice(0, consumed).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
      if (consumed >= lines.length) {
        files.push({ file: s.file, bytes: s.bytes, count: events.length });
      } else {
        // Partially consumed segment: rewrite the remainder and leave the file in place. The
        // remainder is re-serialised from the surviving lines, so a corrupt line that was skipped
        // is dropped rather than written back forever.
        const remainder = lines.slice(consumed);
        try {
          writeFileSync(s.file, remainder.length ? `${remainder.join('\n')}\n` : '');
          if (current && current.file === s.file) current.bytes = statSync(s.file).size;
        } catch (err) { onWarn(`segment rewrite: ${err.message}`); }
      }
      bytes += takenBytes;
    }
    return { events, files, bytes };
  }

  function discardFiles(files) {
    for (const f of files) closeIfNeeded(f.file);
    for (const f of files) { try { unlinkSync(f.file); } catch { /* already evicted */ } }
    // A fully drained spool must not leave `current` pointing at a deleted inode.
    if (current && !existsSync(current.file)) { try { closeSync(current.fd); } catch {} current = null; }
  }

  function markDropped(n) { state.dropped += n; saveMeta(); }

  return {
    append,
    writeBlob,
    takeBatch,
    discardFiles,
    pendingBlobFiles,
    enforceCap,
    totals,
    dropped: () => state.dropped,
    acknowledgeDropped: () => { const d = state.dropped; state.dropped = 0; saveMeta(); return d; },
    markDropped,
    blobsDir,
    dir,
    close() { if (current) { try { closeSync(current.fd); } catch {} current = null; } },
  };
}
