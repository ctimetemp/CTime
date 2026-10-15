// The first-run credential that lets a dashboard claim the initial administrator account.
//
// Why this exists: the collector deliberately ships with no default password, so a fresh install
// had exactly one way to create its first login -- a console command against the right database
// path, on the machine, by whoever found the file tree. That is a needless wall for the person
// standing at the box and it is the kind of step that gets copy-pasted into a shared document.
//
// What it is not: a default password. The code is random per installation, exists only while the
// account table is empty, is required in addition to the passphrase the claimer types, and is
// deleted the moment an account exists. Reaching it proves access to the collector's own disk,
// which is the thing a remote claimer does not have.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// No 0/O, 1/I/L: this is read off a console and typed into a form.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const LENGTH = 15;
const CODE_RE = new RegExp(`^[${ALPHABET}]{${LENGTH}}$`);

function generate() {
  const bytes = randomBytes(LENGTH);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  // `b % 32` would bias the last characters if the alphabet did not divide 256 evenly; it does,
  // so every character here is uniform over the alphabet with no rejection needed.
  return out;
}

export function formatCode(raw) {
  const chars = normalizeCode(raw);
  const out = [];
  for (let i = 0; i < chars.length; i += 5) out.push(chars.slice(i, i + 5));
  return out.join('-');
}

// Anything the operator types or pastes is accepted in either shape: XXXXX-XXXXX-XXXXX or the
// bare 15 characters, any case.
export function normalizeCode(supplied) {
  return String(supplied ?? '').toUpperCase().replace(/[\s-]+/g, '');
}

export function createSetupCode(dataDir) {
  const file = path.join(dataDir, 'first-run-code.txt');

  return {
    file,

    // The code on disk, created on first use. Reading rather than regenerating matters: a reboot
    // must not invalidate a code someone already wrote down on a sticky note beside the box.
    current() {
      if (existsSync(file)) {
        const stored = readFileSync(file, 'utf8').trim().toUpperCase();
        if (CODE_RE.test(stored)) return stored;
      }
      const fresh = generate();
      try {
        writeFileSync(file, `${fresh}\n`, { mode: 0o600 });
      } catch { /* an unwritable data dir falls back to the printed code at boot */ }
      return fresh;
    },

    matches(supplied) {
      const given = normalizeCode(supplied);
      if (!CODE_RE.test(given)) return false;
      const want = Buffer.from(this.current(), 'utf8');
      const got = Buffer.from(given, 'utf8');
      return want.length === got.length && timingSafeEqual(want, got);
    },

    // Called once an account exists. A stale code file sitting next to a live database is a
    // liability with no purpose.
    clear() {
      try { if (existsSync(file)) unlinkSync(file); } catch { /* best effort, see below */ }
    },
  };
}
