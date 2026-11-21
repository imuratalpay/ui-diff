import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from '../../src/capture.js';
import { parseConfig } from '../../src/config.js';
import { initScript } from '../../src/determinism.js';
import { collectStyles, styleCapWarning } from '../../src/styles.js';

const SHADOW_PAGE = `<!doctype html><html><body>
<main><x-card id="card"></x-card><x-card class="plain"></x-card></main>
<script>
customElements.define('x-card', class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = '<style>.primary{letter-spacing:0.5px;padding:4px}</style><div class="body"><button class="primary">Buy</button><button class="secondary">Later</button></div>';
  }
});
</script></body></html>`;

describe('style snapshot', { timeout: 120_000 }, () => {
  let browser: Browser;
  let page: Page;
  let html = '';
  // setContent does not run init scripts, so pages are loaded by navigation.
  const load = async (content: string) => {
    html = content;
    await page.goto('http://ui-diff.test/');
  };

  before(async () => {
    browser = await launchBrowser();
    page = await browser.newPage();
    await page.addInitScript({ content: initScript({}) });
    await page.route('http://ui-diff.test/**', (route) => route.fulfill({ body: html, contentType: 'text/html' }));
  });

  after(async () => {
    await browser?.close();
  });

  it('builds selectors that reach into open shadow roots and resolve to that one element', async () => {
    await load(SHADOW_PAGE);
    const selectors = await page.evaluate(() => {
      const helpers = (window as unknown as { __uiDiff: { cssPath(el: Element): string } }).__uiDiff;
      const cards = document.querySelectorAll('x-card');
      return [...cards].map((card) => helpers.cssPath(card.shadowRoot!.querySelector('button.primary')!));
    });
    assert.deepEqual(selectors, ['#card >> button.primary', 'x-card.plain >> button.primary']);
    for (const [i, selector] of selectors.entries()) {
      assert.equal(await page.locator(selector).count(), 1, selector);
      const index = await page.locator(selector).evaluate((el) => [...document.querySelectorAll('x-card')].findIndex((c) => c.shadowRoot!.contains(el)));
      assert.equal(index, i, `${selector} resolves to the button of card ${i}`);
    }
  });

  it('records elements inside shadow roots, with letter-spacing', async () => {
    await load(SHADOW_PAGE);
    const { snapshot, capped } = await collectStyles(page, { maxElements: 100, ignore: [], extraColors: [] });
    assert.equal(capped, false);
    const button = snapshot.elements.find((e) => e.selector === '#card >> button.primary');
    assert.ok(button, JSON.stringify(snapshot.elements.map((e) => e.selector)));
    assert.equal(button.styles.letterSpacing, '0.5px');
    assert.deepEqual(button.styles.padding, ['4px', '4px', '4px', '4px']);
  });

  it('says when the element cap was hit', async () => {
    await load(`<!doctype html><html><body>${Array.from({ length: 30 }, (_, i) => `<p>Line ${i}</p>`).join('')}</body></html>`);
    const capped = await collectStyles(page, { maxElements: 10, ignore: [], extraColors: [] });
    assert.equal(capped.capped, true);
    assert.equal(capped.snapshot.elements.length, 10);
    assert.equal((await collectStyles(page, { maxElements: 100, ignore: [], extraColors: [] })).capped, false);
    assert.match(styleCapWarning('head', 10), /^head: style snapshot stopped at 10 elements \(capture\.styleMaxElements\)/);
  });

  it('takes the cap from capture.styleMaxElements and still honours the old tokens.maxElements', () => {
    assert.equal(parseConfig({}, { repoRoot: '/tmp' }).capture.styleMaxElements, 2500);
    assert.equal(parseConfig({ capture: { styleMaxElements: 900 } }, { repoRoot: '/tmp' }).capture.styleMaxElements, 900);
    assert.equal(parseConfig({ tokens: { maxElements: 700 } }, { repoRoot: '/tmp' }).capture.styleMaxElements, 700);
  });
});
