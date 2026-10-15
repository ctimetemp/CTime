// Show, create, or rotate the collector's TLS certificate.
//
// The collector already generates a self-signed certificate on first boot, so this script exists
// for the two moments an operator actually needs to touch it: reading the fingerprint to hand to
// `agent --pin`, and rotating it on a planned schedule. It writes into exactly the directory the
// collector reads, and it never silently replaces a key pair that is already pinned somewhere.
//
//   node scripts/make-cert.js             print the fingerprint, creating the pair if absent
//   node scripts/make-cert.js --check     fail (exit 1) if no certificate exists yet
//   node scripts/make-cert.js --rotate    replace the pair, after telling you what that costs
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadOrGenerateCert, DATA } from '../server/lib/boot.js';
import { fingerprintOfPem } from '../server/lib/x509.js';

function usage() {
  process.stdout.write(`usage: node scripts/make-cert.js [--check | --rotate] [--data <dir>]

  --check    report the existing fingerprint, exit 1 if there is none
  --rotate   replace key.pem/cert.pem. Every agent must then be re-pinned with the new
             fingerprint or it refuses to connect; there is no fallback by design.
  --data     collector data directory (default CTTIme_DATA, else server/data)

The pair lives in <data>/tls and is reused on every collector start so pins stay stable.
`);
}

function parse(argv) {
  const out = { mode: 'ensure', data: process.env.CTTIme_DATA ? path.resolve(process.env.CTTIme_DATA) : DATA };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; } else if (a === '--check') out.mode = 'check';
    else if (a === '--rotate') out.mode = 'rotate';
    else if (a === '--data') out.data = path.resolve(argv[++i]);
    else throw new Error(`unknown option ${a}`);
  }
  return out;
}

function report(tls, dir) {
  process.stdout.write(`
  certificate   ${path.join(dir, 'cert.pem')}
  private key   ${path.join(dir, 'key.pem')}   (keep this on the collector host)
  SHA-256 pin   ${tls.fingerprint}

  Give that pin to every agent:  node agent/cli.js run --host <collector> --pin ${tls.fingerprint}
  There is no plaintext fallback and no negotiated downgrade if it does not match.
`);
}

function main(argv) {
  const opts = parse(argv);
  if (opts.help) { usage(); return 0; }
  const dir = path.join(opts.data, 'tls');
  const have = existsSync(path.join(dir, 'cert.pem')) && existsSync(path.join(dir, 'key.pem'));

  if (opts.mode === 'check') {
    if (!have) {
      process.stderr.write(`No certificate in ${dir} yet. Start the collector, or run:\n`
        + '  node scripts/make-cert.js\n');
      return 1;
    }
    report({ fingerprint: fingerprintOfPem(readFileSync(path.join(dir, 'cert.pem'), 'utf8')) }, dir);
    return 0;
  }

  if (opts.mode === 'rotate' && have) {
    process.stdout.write(`Rotating replaces a certificate that running agents have pinned by `
      + 'fingerprint.\nAfter this they stop uploading until each one is restarted with the new '
      + '--pin value.\n');
  }
  const tls = loadOrGenerateCert(dir, { forceNew: opts.mode === 'rotate' });
  report(tls, dir);
  process.stdout.write(tls.reused ? '  status: reused the existing pair, pins unchanged\n'
    : `  status: ${opts.mode === 'rotate' ? 'new pair written, re-pin every agent' : 'new pair created for this install'}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
