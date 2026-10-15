import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './httpkit.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function createFileStore(rootDir) {
  mkdirSync(rootDir, { recursive: true });
  return {
    root: rootDir,
    // The key is server-generated from the event id; nothing about the on-disk path comes from
    // a request field, so there is no traversal surface in the store at all.
    keyFor(deviceId, eventId) {
      return join(deviceId.slice(0, 8), `${eventId}.png`);
    },
    absolute(storageKey) { return join(rootDir, storageKey); },
    async put(req, { deviceId, eventId, maxSize, expectSha256 }) {
      const rel = this.keyFor(deviceId, eventId);
      const abs = join(rootDir, rel);
      mkdirSync(join(rootDir, deviceId.slice(0, 8)), { recursive: true });
      const hash = createHash('sha256');
      let size = 0;
      let head = Buffer.alloc(0);
      let dimensionsRead = false;
      let width = 0;
      let height = 0;
      const out = createWriteStream(abs);
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > maxSize) throw new HttpError(413, 'body_too_large', `screenshot exceeds ${maxSize} bytes`);
          hash.update(chunk);
          head = Buffer.concat([head, chunk]).subarray(0, 24);
          if (!dimensionsRead && head.length >= 24) {
            dimensionsRead = true;
            if (!head.subarray(0, 8).equals(PNG_SIG)) {
              throw new HttpError(400, 'bad_request', 'body is not a PNG');
            }
            // IHDR is the first chunk: 8-byte signature, 4 length, 4 type, then width/height
            // as big-endian uint32. Dimensions are read from the bytes, never trusted from a header.
            if (head.subarray(12, 16).toString('latin1') !== 'IHDR') {
              throw new HttpError(400, 'bad_request', 'PNG has no IHDR first');
            }
            width = head.readUInt32BE(16);
            height = head.readUInt32BE(20);
            if (width === 0 || height === 0 || width > 16384 || height > 16384) {
              throw new HttpError(400, 'bad_request', 'implausible PNG dimensions');
            }
          }
          if (!out.write(chunk)) {
            await new Promise((r) => out.once('drain', r));
          }
        }
      } catch (err) {
        out.destroy();
        rmSync(abs, { force: true });
        throw err;
      } finally {
        await new Promise((r) => out.end(r));
      }
      if (!dimensionsRead || head.length < 24 || !head.subarray(0, 8).equals(PNG_SIG)) {
        rmSync(abs, { force: true });
        throw new HttpError(400, 'bad_request', 'body is not a PNG');
      }
      const sha256 = hash.digest('hex');
      if (expectSha256 && expectSha256 !== sha256) {
        // Mismatch means the agent's stated hash disagrees with what actually arrived. Refusing
        // the file keeps the stored sha from being an unverifiable claim.
        rmSync(abs, { force: true });
        throw new HttpError(400, 'bad_request', 'X-Sha256 does not match the bytes received');
      }
      if (size === 0) { rmSync(abs, { force: true }); throw new HttpError(400, 'bad_request', 'empty body'); }
      return { storageKey: rel, bytes: size, width, height, sha256 };
    },
    remove(storageKey) { rmSync(join(rootDir, storageKey), { force: true }); },
  };
}
