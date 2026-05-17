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
  5.25 kB gz; multi-subscriber hooks added a bit more. The 1.1 DX
  batch (data-each / data-as warnings, async data-fn error routing,
  refresh(path) keyed re-runner) selectively re-adds the warns that
  0.5.1 dropped — this time pinned to the highest-pain footguns
  surfaced by real-world feedback — and bumps the cap to 12 kB raw /
  5.5 kB gz. The 1.2 batch adds <template data-each> as an additive
  form alongside the legacy container form — HTML5-spec-aligned, no
  pre-bind flicker, and the only correct way to bind data-each rows
  inside <table> / <select> / <thead> (where the HTML parser would
  otherwise re-parent a container-form child). Adds ~275 B raw /
  ~30 B gz for the host/anchor split and unified live-clone tracking;
  bumps the cap to 12.5 kB raw / 5.625 kB gz. The 1.3 trim pass (this
  one) is the first cap *reduction* since 0.5.1: routeErr extraction
  shares the error-routing pattern between runSystem and callFn,
  bindAction/bindEach hoist el.dataset to a local, and bindAction's
  removeEventListener (used twice — `.once` self-removal + cleanup
  return) collapses into a single `rm` arrow. Net −108 B raw / −1 B
  gz (gzip already deduped the "[spektrum] " prefix). Cap drops to
  12.25 kB raw / 5.5625 kB gz. Adjust caps deliberately — every bump
  invites complacency. Trim before raising.
*/

import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  // file relative to repo root, raw cap (bytes), gzipped cap (bytes)
  { file: 'spektrum.min.js',          raw: 12544, gz: 5696 },
  { file: 'companions/spektrum-persist.min.js',  raw:  1024, gz:  576 },
  // 1.2 dock integration adds ~120 B for the [data-spektrum-dock]
  // detection branch + dockPanel.detach() in unmount. Standalone
  // behavior unchanged; cap raised once to absorb the integration.
  { file: 'companions/spektrum-devtools.min.js', raw:  3328, gz: 1664 },
  { file: 'companions/spektrum-mcp.min.js',      raw:  5120, gz: 2048 },
  { file: 'companions/spektrum-agent.min.js',    raw: 13312, gz: 5120 },
  // Inspect Phase 1 + Lint (element inspector with hover tooltip +
  // outline overlay, three-tab panel, mutation tracer with filter, and
  // static lint pass). First cap-set, not a bump. The design doc's
  // ~6 kB estimate was optimistic — the scoped CSS block, tooltip
  // rendering, multi-feature panel HTML, and trigger-annotation logic
  // together push to ~10 kB raw / 4 kB gz. Still well under the agent
  // companion (~12 kB) and proportional to the surface area; trim
  // before raising further. Revisit when Phase 2/3 features land.
  { file: 'companions/spektrum-inspect.min.js',  raw: 10752, gz: 4352 },
  // Dock: shared container for the dev-time companions (devtools,
  // inspect, agent). Provides tab strip, collapse/expand, side toggle,
  // and a registerPanel() API that the others detect at mount time.
  // First cap-set, not a bump.
  { file: 'companions/spektrum-dock.min.js',     raw:  5632, gz: 2304 },
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
