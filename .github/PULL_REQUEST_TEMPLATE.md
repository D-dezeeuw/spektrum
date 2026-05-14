<!-- Thanks for contributing to Spektrum. Most of these prompts are
     short on purpose — keep the PR description tight, the diff
     speaks for itself. -->

## What this changes

<!-- One or two sentences. What does this PR do, from the user's
     perspective? -->

## Why

<!-- The motivation. Bug? New feature? Footgun report from a real
     user? Link the issue if one exists. -->

## Test plan

<!-- - [ ] New test added (which file?)
     - [ ] Existing tests cover this
     - [ ] Manually verified in example/ (browser)
     - [ ] N/A — docs / build / chore -->

## Size impact

<!-- Required when touching engine or any companion. Run `npm run build &&
     npm run size`. Paste the relevant rows. If a cap was bumped, justify
     it per docs/constraints.md (one-shot, tied to a named feature). -->

```
spektrum.min.js                       raw  ?B / ?B   gz ?B / ?B
companions/spektrum-<name>.min.js     raw  ?B / ?B   gz ?B / ?B
```

## Checklist

- [ ] `npm test` passes
- [ ] `npm run lint` passes
- [ ] `npm run build && npm run size` passes
- [ ] Public surface change → `spektrum.d.ts` updated
- [ ] Public surface change → `docs/` updated
- [ ] Behavior change → entry under `## [Unreleased]` in `CHANGELOG.md`
