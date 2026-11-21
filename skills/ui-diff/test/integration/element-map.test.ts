import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from '../../src/capture.js';
import { initScript } from '../../src/determinism.js';
import { collectStyles } from '../../src/styles.js';

const PAGE = `<!doctype html><html><head><style>
body { margin: 0; font: 16px Arial, sans-serif; }
.cta { display: inline-block; padding: 8px 14px; border-radius: 4px; background: #2563eb; color: #fff; }
.card { margin: 20px; padding: 12px; border: 1px solid #e5e7eb; }
nav a { display: inline-block; width: 24px; height: 24px; background: #111827; margin-right: 4px; }
</style></head><body>
<header><nav><a href="/a" aria-label="Home"></a><a href="/b"></a><a href="/c"></a></nav></header>
<main>
  <h1>Pricing</h1>
  <a class="cta" href="/start" data-testid="hero-cta">Get started</a>
  <div class="card" id="pro"><h2>Pro</h2><p>For teams.</p><img src="/hero.svg" alt="Hero illustration" width="40" height="20"></div>
  <section class="vue-root"><p>Rendered by Vue</p></section>
</main>
<script>
  // What React and Vue leave on their DOM nodes.
  document.getElementById('pro')['__reactFiber$test'] = { type: 'div', return: { type: function PricingCard() {}, return: { type: 'main' } } };
  document.querySelector('h1')['__reactFiber$test'] = { type: 'h1', return: { type: 'main' } };
  const vue = document.querySelector('.vue-root');
  vue.__vueParentComponent = { subTree: { el: vue }, type: { name: 'FooterNote' } };
</script>
</body></html>`;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#bfdbfe"/></svg>';

describe('element map', { timeout: 120_000 }, () => {
  let browser: Browser;
  let page: Page;

  before(async () => {
    browser = await launchBrowser();
    page = await browser.newPage({ viewport: { width: 600, height: 400 }, deviceScaleFactor: 2 });
    await page.addInitScript({ content: initScript({}) });
    await page.route('http://ui-diff.test/**', (route) => {
      const svg = route.request().url().endsWith('.svg');
      return route.fulfill({ body: svg ? SVG : PAGE, contentType: svg ? 'image/svg+xml' : 'text/html' });
    });
    await page.goto('http://ui-diff.test/');
  });

  after(async () => {
    await browser?.close();
  });

  it('names elements by component, role and text, else by selector, with a stable id', async () => {
    const { snapshot } = await collectStyles(page, { maxElements: 500, ignore: [], extraColors: [] });
    const by = (selector: string) => snapshot.elements.find((e) => e.selector === selector)!;
    assert.deepEqual([by('[data-testid="hero-cta"]').name, by('[data-testid="hero-cta"]').id], ["link 'Get started'", 'testid:hero-cta']);
    assert.equal(by('h1').name, "heading 'Pricing'", 'no component when its fiber is a DOM element');
    assert.equal(by('#pro').name, 'PricingCard (#pro)');
    assert.equal(by('#pro').component, 'PricingCard');
    assert.equal(by('#pro').id, 'id:pro');
    assert.equal(by('section.vue-root').component, 'FooterNote');
    assert.equal(by('img').name, "img 'Hero illustration'");
    assert.equal(by('img').src, '/hero.svg', 'no origin');
    const home = snapshot.elements.find((e) => e.attrs?.ariaLabel === 'Home')!;
    assert.deepEqual([home.name, home.id], ["link 'Home'", 'aria:link:Home']);
    const icon = snapshot.elements.find((e) => e.selector === 'a:nth-of-type(2)' || e.selector.endsWith('a:nth-of-type(2)'))!;
    assert.equal(icon.name, icon.selector, 'an unlabelled icon link is named by its selector');
    assert.equal(icon.id, `path:${icon.selector}`);
    assert.equal(snapshot.elements.find((e) => e.ownText === 'For teams.')?.tag, 'p', 'own text is recorded');
  });

  it('links each element to its nearest recorded parent and records CSS and device boxes', async () => {
    const { snapshot } = await collectStyles(page, { maxElements: 500, ignore: [], extraColors: [] });
    const els = snapshot.elements;
    const card = els.findIndex((e) => e.selector === '#pro');
    const h2 = els.find((e) => e.ownText === 'Pro')!;
    assert.equal(h2.parent, card);
    assert.equal(els[card].parent, els.findIndex((e) => e.tag === 'main'));
    assert.equal(els.find((e) => e.tag === 'header')!.parent, null, 'body is not recorded, so a top-level element has no parent');
    for (const e of els) {
      assert.deepEqual(e.deviceBox, { x: Math.round(e.box.x * 2), y: Math.round(e.box.y * 2), width: Math.round(e.box.width * 2), height: Math.round(e.box.height * 2) }, e.selector);
    }
    const cta = els.find((e) => e.id === 'testid:hero-cta')!;
    assert.deepEqual(cta.styles.padding, ['8px', '14px', '8px', '14px']);
    assert.deepEqual(cta.styles.radius, ['4px', '4px', '4px', '4px']);
    assert.equal(cta.styles.display, 'inline-block');
    assert.deepEqual(els.find((e) => e.selector === '#pro')!.styles.borderWidth, ['1px', '1px', '1px', '1px']);
  });

  it('stops at the element limit and says so', async () => {
    const capped = await collectStyles(page, { maxElements: 5, ignore: [], extraColors: [] });
    assert.equal(capped.capped, true);
    assert.equal(capped.snapshot.elements.length, 5);
  });
});
