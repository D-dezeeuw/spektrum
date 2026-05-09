#!/usr/bin/env node
/*
  Zero-dep size budget. Reads spektrum.min.js, gzips it via Node's
  built-in zlib, and exits non-zero if either raw or gzipped exceeds
  the cap. Run after build; wired into CI as a gate.

  Why custom: pulling in size-limit (or any of the other size tools)
  would contradict the "audit it in an afternoon" pitch with a
  transitive-dep tail dozens deep. zlib is built into Node.

  Tune the caps below as the surface area grows. Today the engine
  prints around 11 kB raw / 5 kB gzipped; caps were bumped to
  11264 / 5184 in the 0.5.0-track work to absorb the 1.0-credibility
  batch: addAsync, watch alias, computed read-through fix, model
  .number/.trim modifiers, data-action .self, .capture, .passive, and
  the .enter/.esc/.tab/.shift/.cmd key modifiers. Earlier 0.4.x caps
  were 10240/4672 (added checkpoint(), data-stable-key, append/pop
  tail diff, structured onError, serialize()). The 1.0-batch crossed
  ~860 B raw / ~360 B gzip; trims (RESERVED keyword/operator entries,
  walkTextNodes inlined childNodes, F-12 regex inlined) had already
  been applied. Adjust caps deliberately — every bump invites
  complacency. Trim before raising.
*/

import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  // file relative to repo root, raw cap (bytes), gzipped cap (bytes)
  { file: 'spektrum.min.js',          raw: 11264, gz: 5184 },
  { file: 'spektrum-persist.min.js',  raw:  1024, gz:  576 },
  { file: 'spektrum-devtools.min.js', raw:  3072, gz: 1536 },
];

let failed = false;

for (const t of TARGETS) {
  const path = resolve(ROOT, t.file);
  let raw, gz;
  try {
    raw = statSync(path).size;
    gz = gzipSync(readFileSync(path)).length;
  } catch {
    console.error(`size: cannot read ${t.file} — did you run \`npm run build\`?`);
    process.exit(1);
  }
  const rawOk = raw <= t.raw;
  const gzOk = gz <= t.gz;
  const mark = (ok) => ok ? '✓' : '✗';
  console.log(
    `${mark(rawOk)} ${t.file}  raw ${raw}B / ${t.raw}B   ${mark(gzOk)} gzip ${gz}B / ${t.gz}B`,
  );
  if (!rawOk || !gzOk) failed = true;
}

process.exit(failed ? 1 : 0);
