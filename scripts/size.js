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
  bumps the cap to 12.5 kB raw / 5.625 kB gz. The 1.3 trim pass is the
  first cap *reduction* since 0.5.1: routeErr extraction shares the
  error-routing pattern between runSystem and callFn, bindAction/
  bindEach hoist el.dataset to a local, and bindAction's
  removeEventListener (used twice — `.once` self-removal + cleanup
  return) collapses into a single `rm` arrow. Net −108 B raw / −1 B
  gz; cap dropped to 12.25 kB raw / 5.5625 kB gz. The 1.4 data-each
  refactor replaces rewriteScope with proper per-iteration scope
  (with(state) with(scope), SCOPE_PATHS Symbol for path translation,
  EACH_HOST marker on the data-each container so outer walks skip
  clone subtrees, textTemplates WeakMap so re-bind reads the original
  template not its rendered result, `active` flag on systems so mid-
  tick teardown is honored). Keyed reorder now ALWAYS reuses the
  clone — data-stable-key becomes a no-op for back-compat. Adds
  $path / $index / $first / $last as scope variables; removes the
  data-as short-name + shadow warnings and the data-stable-key
  prerequisite warn. Cap raised to 12.5 kB raw / 5.75 kB gz to
  absorb the +289 B net (new scope plumbing minus rewriteScope and
  the dropped warnings). The 1.5 batch introduces `addValue(path,
  value, id?)` and `data-fn="addValue"` (symmetric with `setValue`;
  `trigger` becomes a thin alias). The mutator + data-fn were tuned
  for +0 B against the pre-1.4 cap via ternary collapse and a shared
  `addFn` reference between `addValue` and `trigger`; the 1.4 scope
  refactor changed `data-fn` bodies from `el.dataset.id` to
  `resolvePath(el.dataset.id, sc)` to honor per-row scope, which the
  pre-tuning didn't anticipate. Net +77 B raw. Cap raised modestly
  to 12.5625 kB raw (12,864 B); gz stays at 5.75 kB. Five engine
  fixes land alongside in the same release window:
    1. evalExpr regex matches chained `.\d+` runs in one pass
       (`grid.1.0` → `grid[1][0]`) and skips float literals (so
       `val + 1.5` is no longer false-positive normalized).
    2. addAsync skips its initial fetch when state already carries a
       settled `{data}`/`{error}` shape (post-`loadHistory` ergonomics
       — `refresh(path)` still forces a fresh fetch).
    3. `data-ref` cleanup only frees the slot if it still owns it, so
       two elements sharing a name no longer wipe each other's entry.
    4. `data-each` keyed mode warns on duplicate keys instead of
       silently merging clones.
    5. `attempt()` handle is single-shot — defensive `commit()` in a
       `finally{}` after `discard()` no longer appends an orphan
       checkpoint.
  Combined +~200 B raw / +~32 B gz; cap raised to 12.875 kB raw
  (13,184 B) and 5.875 kB gz (6,016 B). The 1.0.2 fixes address three
  silent-failure modes reported by a real consumer ([:innerHTML] /
  [:aria-pressed] / `:attr` on the data-each clone root) plus a
  self-dep guard in `computed()`:
    1. bindDOM's per-element walk now includes the root, not only its
       descendants — so `:attr` / `data-if` / `data-action` authored on
       a data-each loop body's own tag actually bind.
    2. bindAttrs aliases HTML-lowercased camelCase props (`:innerhtml`
       → `innerHTML`, `:textcontent` → `textContent`) so writing
       `:innerHTML="…"` in HTML doesn't silently assign a JS expando.
    3. Hyphenated property names route through setAttribute /
       removeAttribute so `:aria-pressed`, `:data-*`, etc. reach the
       DOM instead of becoming dead JS expandos.
    4. `computed(path, deps, fn)` rejects self-referential dep sets at
       registration with `E_COMPUTED_SELF_DEP` — previously a self-dep
       silently burned the 1024-iteration tick cap and triggered the
       delta-clear safety net, *dropping other systems' pending writes
       queued in the same tick*.
    5. `warn()` now returns undefined explicitly so `return warn(…)`
       from guard clauses can't smuggle a monkey-patched console.warn
       return value into a cleanup collector.
  Net +~255 B raw / +~95 B gz; cap raised to 13.125 kB raw (13,440 B)
  and 5.969 kB gz (6,112 B). The production-hardening pass adds a
  `deepClone` helper used at both snapshot boundaries: stored snapshots
  (and the state replay() restores from one) now own their whole object
  graph instead of aliasing live arrays via deepMerge, so a direct
  `appState.list.push(x)` — or an in-place sub-path merge during replay
  — can no longer reach back and corrupt a snapshot. This is a
  time-travel *correctness* fix, not a feature, but it costs bytes:
  +~159 B raw / +~47 B gz. One 256 B raw step (13,440 → 13,696) and a
  128 B gz step (6,112 → 6,240) absorb it with ~95 B raw / ~80 B gz
  headroom. Adjust caps deliberately — every bump invites complacency.
  Trim before raising.
*/

import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  // file relative to repo root, raw cap (bytes), gzipped cap (bytes)
  { file: 'spektrum.min.js',          raw: 13696, gz: 6240 },
  { file: 'companions/spektrum-persist.min.js',  raw:  1024, gz:  576 },
  // 1.2 dock integration adds ~120 B for the [data-spektrum-dock]
  // detection branch + dockPanel.detach() in unmount. Standalone
  // behavior unchanged; cap raised once to absorb the integration.
  { file: 'companions/spektrum-devtools.min.js', raw:  3328, gz: 1664 },
  // 1.0.1 protectedPaths gate: createTools(s, { protectedPaths: [...] })
  // adds a buildGuard() matcher (string-prefix or RegExp) and three
  // tool-handler check sites (setValue, trigger, attempt.start's
  // inline ops). +166 B raw after minification; gzip stays under the
  // existing cap. One 256 B cap step (5120 → 5376) to absorb the
  // new code with ~90 B headroom for future MCP additions.
  // 1.1.0 deny-by-default (breaking, shipped as minor — no users yet):
  // writes are now DENIED unless the caller opts in via protectedPaths
  // ("allow all but these", which takes precedence) or allowAllPaths
  // ("allow everything"). A forgotten config yields a read-only agent
  // instead of one with full write authority. This REPLACED a brief
  // 1.0.2 warn-on-ungated approach, so the long warn() string is gone:
  // the three-way guard ternary is far cheaper than the message it
  // replaced, and buildGuard shed its now-unreachable empty-patterns
  // check (the three-way ternary only calls it with a non-empty
  // array). Net trim — raw cap returns to the 1.0.1 level (5,376 B,
  // actual 5,320) and gz holds a small cushion (2,112 B, actual 2,043,
  // below even the 1.0.1 gz). Trimmed, then tightened — the opposite
  // of a complacent bump.
  { file: 'companions/spektrum-mcp.min.js',      raw:  5376, gz: 2112 },
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
