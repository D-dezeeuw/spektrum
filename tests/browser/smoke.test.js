/*
  Real-browser smoke tests (Chromium / Firefox / WebKit).

  Why this file exists: happy-dom is a fast stand-in for a browser, and
  it is lenient in exactly the places real engines are strict. That gap
  has shipped bugs.

    - `progress.value = NaN` throws a TypeError in every real browser
      (WebIDL restricted double) and does nothing in happy-dom. The
      engine's binding-error containment was written against a
      hand-installed throwing setter because of this.
    - Safari did not ship the lookbehind assertion the engine's path
      regex uses until 16.4. That is a hard parse failure of the whole
      module — no Node run and no happy-dom run can observe it, but
      WebKit here will.

  Playwright is deliberately NOT a project dependency: the zero-runtime-
  dep rule stands, and keeping it out of devDependencies keeps a normal
  `npm ci` lean. CI installs it ad hoc. Locally:

      npx playwright install chromium
      SPEKTRUM_BROWSERS=chromium node --test tests/browser/smoke.test.js

  With Playwright absent the whole file SKIPS rather than fails, so the
  default `npm test` stays dependency-free and green.
*/

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

let chromium, firefox, webkit;
let playwrightAvailable = true;
try {
  ({ chromium, firefox, webkit } = await import('playwright'));
} catch {
  playwrightAvailable = false;
}

const ENGINES = { chromium, firefox, webkit };
const requested = (process.env.SPEKTRUM_BROWSERS || 'chromium')
  .split(',').map(s => s.trim()).filter(Boolean);

const ENGINE_SRC = readFileSync(resolve(ROOT, 'spektrum.js'), 'utf8');

/** Serve the engine from a data: URL so the page needs no HTTP server. */
const ENGINE_URL = 'data:text/javascript;base64,' +
  Buffer.from(ENGINE_SRC).toString('base64');

const pageHtml = (body, script) => `<!doctype html>
<html><body>
${body}
<script type="module">
  import spektrum, { setValue, bindDOM, tick, precompile } from '${ENGINE_URL}';
  window.__result = (async () => {
    try {
      ${script}
    } catch (err) {
      return { error: String(err && err.message || err) };
    }
  })();
</script>
</body></html>`;

for (const name of requested) {
  const launcher = ENGINES[name];

  describe(`${name}`, { skip: !playwrightAvailable ? 'playwright not installed' : false }, () => {
    let browser;

    // SPEKTRUM_BROWSER_EXECUTABLE lets a sandbox or an image with
    // pre-installed browsers point at them instead of downloading a
    // matching build (Playwright pins browser revisions to its own
    // version, so a pre-baked image often mismatches). CI leaves it
    // unset and uses the revision `playwright install` fetched.
    const executablePath = process.env.SPEKTRUM_BROWSER_EXECUTABLE || undefined;

    before(async () => { browser = await launcher.launch({ executablePath }); });
    after(async () => { await browser?.close(); });

    const run = async (body, script) => {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
      await page.setContent(pageHtml(body, script));
      const result = await page.evaluate(() => window.__result);
      await page.close();
      return { result, pageErrors };
    };

    test('the engine module parses and binds in this engine', async () => {
      // The Safari-lookbehind class of failure surfaces here: a parse
      // error means no module, so __result never resolves.
      const { result, pageErrors } = await run(
        '<p id="out">{{greeting}}</p>',
        `setValue('greeting', 'hello'); bindDOM(document.body); tick();
         return { text: document.getElementById('out').textContent };`,
      );
      assert.deepEqual(pageErrors, [], 'module must parse and execute cleanly');
      assert.equal(result.text, 'hello');
    });

    test('a real restricted-double rejection is contained, not fatal', async () => {
      // The genuine version of the case the happy-dom suite has to fake:
      // <progress> really does throw on NaN here.
      const { result } = await run(
        `<progress id="p" :value="score"></progress>
         <span id="s" :title="label">x</span>`,
        `setValue('score', NaN);
         setValue('label', 'still-bound');
         const destroy = bindDOM(document.body);
         tick();
         return {
           title: document.getElementById('s').title,
           destroyType: typeof destroy,
         };`,
      );
      assert.equal(result.error, undefined, `bindDOM must not propagate: ${result.error}`);
      assert.equal(result.title, 'still-bound',
        'the binding after the throwing one still bound');
      assert.equal(result.destroyType, 'function', 'destroy handle still returned');
    });

    test('keyed data-each re-renders on fresh row objects', async () => {
      const { result } = await run(
        `<ul id="list" data-each="rows" data-key="item.id"><li>{{item.label}}</li></ul>`,
        `setValue('rows', [{id:1,label:'a'},{id:2,label:'b'}]);
         bindDOM(document.body); tick();
         setValue('rows', spektrum.appState.rows.map(r => ({...r, label: r.label.toUpperCase()})));
         tick();
         return { labels: [...document.querySelectorAll('#list li')].map(li => li.textContent) };`,
      );
      assert.deepEqual(result.labels, ['A', 'B']);
    });

    test('precompiled expressions work with real CSP semantics', async () => {
      // Not a CSP header test — this blocks the Function constructor the
      // way a strict policy does, and checks the registry path carries
      // both state and data-each scope.
      const { result } = await run(
        `<p id="out">{{count + 1}}</p>
         <ul id="list" data-each="rows" data-key="item.id"><li>{{item.label}} #{{$index}}</li></ul>`,
        `precompile('count + 1', (state) => state.count + 1);
         precompile('item.label', (_s, scope) => scope.item.label);
         precompile('item.id', (_s, scope) => scope.item.id);
         precompile('$index', (_s, scope) => scope.$index);
         const RealFunction = Function;
         window.Function = function () { throw new EvalError('blocked'); };
         try {
           setValue('count', 41);
           setValue('rows', [{id:1,label:'alpha'},{id:2,label:'beta'}]);
           bindDOM(document.body); tick();
           return {
             out: document.getElementById('out').textContent,
             rows: [...document.querySelectorAll('#list li')].map(li => li.textContent),
           };
         } finally { window.Function = RealFunction; }`,
      );
      assert.equal(result.out, '42');
      assert.deepEqual(result.rows, ['alpha #0', 'beta #1']);
    });

    test('javascript: URLs are neutralized on a real anchor', async () => {
      const { result } = await run(
        '<a id="a" :href="link">go</a>',
        `setValue('link', 'javascript:alert(1)');
         bindDOM(document.body); tick();
         return { href: document.getElementById('a').getAttribute('href') };`,
      );
      assert.equal(result.href, '#');
    });

    test('data-model round-trips through a real input event', async () => {
      const page = await browser.newPage();
      await page.setContent(pageHtml(
        '<input id="in" data-model="user.name"><p id="out">{{user.name}}</p>',
        `setValue('user.name', ''); bindDOM(document.body);
         spektrum.run(); return { ready: true };`,
      ));
      await page.evaluate(() => window.__result);
      await page.fill('#in', 'alice');
      // rAF pump commits it; give the browser a frame.
      await page.waitForFunction(
        () => document.getElementById('out').textContent === 'alice',
        undefined, { timeout: 2000 },
      );
      assert.ok(true, 'typed value reached state and re-rendered');
      await page.close();
    });
  });
}
