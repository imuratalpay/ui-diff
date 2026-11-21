import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { captureKey, keyId } from '../../src/key.js';

describe('capture keys', () => {
  const route = { slug: 'home' };
  const desktop = { name: 'desktop' };
  const light = { name: 'light' };

  it('serializes to the file-name stems ui-diff has always written', () => {
    assert.equal(keyId(captureKey(route, desktop, light)), 'home__desktop__light');
    assert.equal(keyId(captureKey(route, desktop, light, { param: 'hero' })), 'home__desktop__light__hero');
    assert.equal(keyId(captureKey(route, desktop, light, { param: 'hero', value: '2' })), 'home__desktop__light__hero-2');
    assert.equal(keyId(captureKey(route, desktop, light, { param: 'plan', value: 'pro / yearly' })), 'home__desktop__light__plan-pro_yearly');
  });

  it('keeps the parts apart instead of a joined string', () => {
    assert.deepEqual(captureKey({ slug: 'pricing' }, { name: 'mobile' }, { name: 'dark' }, { param: 'plan', value: 'pro' }), {
      route: 'pricing',
      viewport: 'mobile',
      theme: 'dark',
      variant: { param: 'plan', value: 'pro' },
    });
    assert.equal('variant' in captureKey(route, desktop, light), false);
  });
});
