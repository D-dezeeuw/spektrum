#!/usr/bin/env node
/*
  Zero-dep size budget. Reads spektrum.min.js, gzips it via Node's
  built-in zlib, and exits non-zero if either raw or gzipped exceeds
  the cap. Run after build; wired into CI as a gate.

  Why custom: pulling in size-limit (or any of the other size tools)
  would contradict the "audit it in an afternoon" pitch with a
  transitive-dep tail dozens deep. zlib is built into Node.

  Tune the caps below as the surface area grows. Today the engine
  prints around 9.9 kB raw / 4.5 kB gzipped; caps were bumped to
  10240 / 4672 across 0.4.0 + 0.4.1: 0.4.0 added checkpoint() +
  checkpoints, data-stable-key, append/pop tail diff, structured
  onError, and serialize() (raw 10240, gz 4608). 0.4.1's audit-Low
  cleanups (F-12 literal-stripping in extractPaths, F-13 amortized
  history trim, F-18 iterative walkTextNodes) needed +64 B gzip
  on top — three small additions whose collective cost crossed the
  4608 ceiling by ~30 B. Trims tried first: walkTextNodes inlined
  childNodes access, F-12 regex inlined into extractPaths. Adjust
  caps deliberately — every bump invites complacency. Trim before
  raising.
*/

import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  // file relative to repo root, raw cap (bytes), gzipped cap (bytes)
  { file: 'spektrum.min.js', raw: 10240, gz: 4672 },
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
