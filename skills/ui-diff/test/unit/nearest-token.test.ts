import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderComment } from '../../src/markdown.js';
import { auditSnapshot, buildTokenSet, deltaE2000, deltaE2000Lab, NEAREST_COLOR_MAX_DELTA_E, parseJsonTokens, type StyledElement, type StyleSnapshot } from '../../src/tokens.js';
import { sampleReport } from './fixtures.js';

function element(selector: string, backgroundColor: string): StyledElement {
  return {
    selector,
    box: { x: 0, y: 0, width: 100, height: 20 },
    text: false,
    styles: { color: 'rgb(15, 23, 42)', backgroundColor, borderColor: [], margin: ['0px', '0px', '0px', '0px'], padding: ['0px', '0px', '0px', '0px'], gap: ['normal', 'normal'], radius: ['0px', '0px', '0px', '0px'], fontSize: '16px', fontWeight: '400', fontFamily: 'Inter', lineHeight: 'normal' },
  };
}

const TOKENS = buildTokenSet(parseJsonTokens({ color: { $type: 'color', text: { $value: '#0f172a' }, neutral: { 500: { $value: '#64748b' } }, brand: { $value: '#2563eb' } } }, 'tokens.json'));
const AUDIT = { properties: ['background-color' as const], colorTolerance: 2, pxTolerance: 0.5, allow: [] };

describe('nearest color token', () => {
  it('computes CIEDE2000 like the published test data', () => {
    // Sharma, Wu and Dalal (2005), pairs 1, 7 and 17.
    assert.equal(deltaE2000Lab([50, 2.6772, -79.7751], [50, 0, -82.7485]).toFixed(4), '2.0425');
    assert.equal(deltaE2000Lab([50, 0, 0], [50, -1, 2]).toFixed(4), '2.3669');
    assert.equal(deltaE2000Lab([50, 2.5, 0], [73, 25, -18]).toFixed(4), '27.1492');
    assert.equal(deltaE2000([255, 255, 255, 1], [255, 255, 255, 1]), 0);
  });

  it('suggests a token only when it is close, and says so when none is', () => {
    assert.equal(NEAREST_COLOR_MAX_DELTA_E, 5);
    const snapshot: StyleSnapshot = { colors: {}, elements: [element('.cta', 'rgb(11, 122, 91)'), element('.link', 'rgb(40, 100, 235)')] };
    const findings = auditSnapshot(snapshot, TOKENS, AUDIT);
    const green = findings.find((f) => f.value === '#0b7a5b')!;
    assert.ok(deltaE2000([11, 122, 91, 1], [100, 116, 139, 1]) > 5, 'green is far from the slate gray');
    assert.equal(green.nearest, undefined, 'no slate gray suggested for a green');
    assert.equal(findings.find((f) => f.value === '#2864eb')?.nearest, 'color.brand (#2563eb)', 'a near-identical blue gets its token');
  });

  it('writes "no close token" in the comment when there is no suggestion', () => {
    const r = sampleReport();
    r.tokens = { files: ['tokens.json'], tokenCount: 3, scope: 'changed areas', audited: ['home__desktop__light'], skipped: [], findings: [{ property: 'background-color', value: '#0b7a5b', count: 1, selectors: ['a.cta'], captures: ['home__desktop__light'], isNew: true }] } as unknown as typeof r.tokens;
    const body = renderComment(r, { id: 'default', title: 'UI diff', link: (p) => p });
    assert.match(body, /\| background-color \| `#0b7a5b` \| no close token \| `a\.cta` \|/);
  });
});
