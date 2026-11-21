import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveBrowser } from '../../src/capture.js';
import { parseConfig } from '../../src/config.js';

describe('browser choice', () => {
  it('uses Playwright\'s Chromium unless an installed browser is chosen', () => {
    assert.deepEqual(resolveBrowser(undefined, {}), { label: 'chromium' });
    assert.equal(parseConfig({}, { repoRoot: '/repo' }).browser.channel, undefined);
  });

  it('takes the channel from config, the environment over config, and a custom executable over both', () => {
    const channel = parseConfig({ browser: { channel: 'chrome' } }, { repoRoot: '/repo' }).browser.channel;
    assert.deepEqual(resolveBrowser(channel, {}), { channel: 'chrome', label: 'chrome' });
    assert.deepEqual(resolveBrowser(channel, { UI_DIFF_BROWSER_CHANNEL: 'msedge' }), { channel: 'msedge', label: 'msedge' });
    assert.deepEqual(resolveBrowser(channel, { UI_DIFF_BROWSER_CHANNEL: 'msedge', UI_DIFF_CHROMIUM_PATH: '/opt/chromium/chrome' }), { executablePath: '/opt/chromium/chrome', label: 'custom executable' });
    assert.deepEqual(resolveBrowser(channel, { UI_DIFF_BROWSER_CHANNEL: '' }), { channel: 'chrome', label: 'chrome' }, 'an empty variable (the workflow default for Chromium) defers to config');
  });
});
