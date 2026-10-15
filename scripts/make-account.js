// Create or rotate an admin account for the collector dashboard.
//
// There is no default credential anywhere in this product, so a fresh collector refuses logins
// until this script (or CTTIme_BOOTSTRAP_ACCOUNT) has created the first account. Passwords are
// scrypt-hashed with the same parameters the collector verifies against.
//
// The hash lands in server/accounts.json. If the collector database already holds that account the
// row is updated in place too, because the collector only ever inserts a missing account at boot
// and would otherwise keep the old hash forever.
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from '../server/lib/auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FILE = path.join(ROOT, 'server', 'accounts.json');
const MIN_PASSWORD = 12;

function usage() {
  process.stdout.write(`usage: node scripts/make-account.js <account> [--password-stdin]
       node scripts/make-account.js --list
       node scripts/make-account.js --remove <account>

  <account>          create or rotate this admin account
  --password-stdin   read the password from a pipe instead of prompting
  --file <path>      accounts file (default server/accounts.json)
  --db <path>        collector database to keep in step
  --list             show accounts and when each was created
  --remove <name>    delete an account from the file and the database

The prompt does not echo. A password piped in on stdin is visible to anything that can read the
shell history, so prefer the prompt.
`);
}

function parse(argv) {
  const out = { file: DEFAULT_FILE, db: null, account: null, stdin: false, list: false, remove: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; } else if (a === '--password-stdin') out.stdin = true;
    else if (a === '--list') out.list = true;
    else if (a === '--remove') { out.remove = true; out.account = argv[++i]; }
    else if (a === '--file') out.file = path.resolve(argv[++i]);
    else if (a === '--db') out.db = path.resolve(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (!out.account) out.account = a;
    else throw new Error('one account name at a time');
  }
  out.db ??= path.join(process.env.CTTIme_DATA ?? path.join(ROOT, 'server', 'data'), 'collector.db');
  return out;
}

function readAccounts(file) {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed;
  } catch (err) {
    throw new Error(`${file} exists but is not a JSON array (${err.message}); refusing to overwrite it`);
  }
}

function writeAccounts(file, accounts) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(accounts, null, 2)}\n`, 'utf8');
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  return new Promise((resolveP) => rl.question(question, (answer) => { rl.close(); resolveP(answer); }));
}

// Without a dependency there is no termios wrapper, so raw mode is driven by hand: keystrokes are
// consumed and only the editing we want is applied. Backspace and Ctrl-C are handled because a
// mistyped password has to be correctable without a visible cursor.
async function promptHidden(question) {
  if (!process.stdin.isTTY) throw new Error('no terminal: pass the password on stdin with --password-stdin');
  const { spawnSync } = await import('node:child_process');
  // PowerShell's Read-Host -AsSecureString is present on every supported Windows host and does the
  // masking for us; piping the result back keeps this script dependency-free.
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$s = Read-Host ${JSON.stringify(question).replace(/"/g, "'")} -AsSecureString; `
    + '[Runtime.InteropServices.Marshal]::PtrToStringAuto('
    + '[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))'],
  { encoding: 'utf8' });
  if (ps.status !== 0) throw new Error(`prompt failed: ${(ps.stderr || ps.error?.message || '').trim()}`);
  return (ps.stdout ?? '').replace(/\r?\n$/, '');
}

async function getPassword(opts) {
  if (opts.stdin) {
    const line = await new Promise((resolveP) => {
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', (d) => resolveP(d));
      if (process.stdin.isTTY) resolveP(null);
    });
    if (!line) throw new Error('--password-stdin was given but nothing arrived on the pipe');
    return line.replace(/\r?\n$/, '');
  }
  return promptHidden(`Password for ${opts.account} (at least ${MIN_PASSWORD} characters, not echoed): `);
}

function openDb(file) {
  if (!existsSync(file)) return null;
  return new DatabaseSync(file);
}

async function main(argv) {
  const opts = parse(argv);
  if (opts.help) return usage();
  const accounts = readAccounts(opts.file);

  if (opts.list) {
    const db = openDb(opts.db);
    const rows = db?.prepare('SELECT account, created_at FROM admin_accounts ORDER BY account').all() ?? [];
    db?.close();
    const inDb = new Map(rows.map((r) => [r.account, r.created_at]));
    const names = new Set([...accounts.map((e) => String(e.account)), ...inDb.keys()]);
    if (!names.size) {
      process.stdout.write(`No admin accounts exist yet.\n  file: ${opts.file}\n  db:   ${opts.db}\n`);
      return 0;
    }
    for (const name of [...names].sort()) {
      const inFile = accounts.some((e) => String(e.account) === name);
      const where = inDb.has(name)
        ? `database since ${inDb.get(name)}${inFile ? ', also in file' : ', NOT in file'}`
        : 'file only (not seeded into the database yet)';
      process.stdout.write(`${name.padEnd(24)} ${where}\n`);
    }
    process.stdout.write('\nAn account missing from the file comes back as the old hash after a '
      + 'database restore; run make-account for it to pin the current one.\n');
    return 0;
  }

  if (!opts.account) { usage(); return 2; }
  const db = openDb(opts.db);

  if (opts.remove) {
    const kept = accounts.filter((e) => String(e.account) !== opts.account);
    if (kept.length === accounts.length && !db?.prepare('SELECT 1 FROM admin_accounts WHERE account = ?').get(opts.account)) {
      db?.close();
      process.stderr.write(`no such account: ${opts.account}\n`);
      return 1;
    }
    writeAccounts(opts.file, kept);
    db?.prepare('DELETE FROM admin_accounts WHERE account = ?').run(opts.account);
    if (db) db.prepare('DELETE FROM admin_sessions WHERE account = ?').run(opts.account);
    db?.close();
    process.stdout.write(`Removed ${opts.account} from ${path.basename(opts.file)}${db ? ' and the database' : ''}.\n`);
    process.stdout.write('Any live session for it is gone; devices are unaffected.\n');
    return 0;
  }

  const password = await getPassword(opts);
  if (password.length < MIN_PASSWORD) {
    db?.close();
    process.stderr.write(`refused: at least ${MIN_PASSWORD} characters required\n`);
    return 1;
  }
  const hash = await hashPassword(password);
  const next = accounts.filter((e) => String(e.account) !== opts.account);
  next.push({ account: opts.account, password_hash: hash, created_at: new Date().toISOString() });
  writeAccounts(opts.file, next);

  let seeded = 'file only';
  if (db) {
    const existing = db.prepare('SELECT 1 FROM admin_accounts WHERE account = ?').get(opts.account);
    if (existing) {
      db.prepare("UPDATE admin_accounts SET password_hash = ?, created_at = datetime('now') WHERE account = ?")
        .run(hash, opts.account);
      db.prepare('DELETE FROM admin_sessions WHERE account = ?').run(opts.account);
      seeded = 'database updated, existing sessions for it revoked';
    } else {
      db.prepare("INSERT INTO admin_accounts (account, password_hash, created_at) VALUES (?, ?, datetime('now'))")
        .run(opts.account, hash);
      seeded = 'added to the database, so it can sign in immediately';
    }
    db.close();
  }
  process.stdout.write(`Account ${opts.account}: ${seeded}.\n`);
  if (!db) process.stdout.write(`(no database at ${opts.db} yet -- the collector seeds from the file at first boot)\n`);
  return 0;
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`make-account: ${err.message}\n`);
  process.exitCode = 1;
});
