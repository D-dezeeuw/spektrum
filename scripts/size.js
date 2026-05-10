#!/usr/bin/env node
/*
  Zero-dep size budget. Reads spektrum.min.js, gzips it via Node's
  built-in zlib, and exits non-zero if either raw or gzipped exceeds
  the cap. Run after build; wired into CI as a gate.

  Why custom: pulling in size-limit (or any of the other size tools)
  would contradict the "audit it in an afternoon" pitch with a
  transitive-dep tail dozens deep. zlib is built into Node.

  Tune the caps below as the surface area grows. Today the engine
  prints around 10 kB raw / 4.7 kB gzipped. After 0.5.0 the bundle
  briefly grew to 11.1 kB raw to absorb the 1.0-credibility batch
  (addAsync, computed read-through, modifier sets); 0.5.1 brought it
  back under 10 kB by dropping the dev-mode warns (data-stable-key
  foot-gun, unknown-modifier, hook-overwrite, defineFn-redefine,
  reset-detach) and tightening many internals (RESERVED → regex,
  applyClass loop, deepMerge chainable, snapshot.at(-1), bitwise ~i
  trick, etc). 1.0 (which absorbed the 0.6 agent-native surface —
  describe / explain / attempt / findByIntent / data-intent
  registration / defineFn metadata) raises the cap to 11.5 kB raw /
  5.25 kB gz; multi-subscriber hooks added a bit more. Adjust caps
  deliberately — every bump invites complacency. Trim before raising.
*/

import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  // file relative to repo root, raw cap (bytes), gzipped cap (bytes)
  { file: 'spektrum.min.js',          raw: 11776, gz: 5376 },
  { file: 'spektrum-persist.min.js',  raw:  1024, gz:  576 },
  { file: 'spektrum-devtools.min.js', raw:  3072, gz: 1536 },
  { file: 'spektrum-mcp.min.js',      raw:  5120, gz: 2048 },
  { file: 'spektrum-agent.min.js',    raw: 13312, gz: 5120 },
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
