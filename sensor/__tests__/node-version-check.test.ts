/**
 * Pin the Node-25 block banner content. The banner replaced a soft
 * `console.warn` because the warning was scrolling off-screen before
 * the OOM crash 30 seconds later, generating duplicate bug reports
 * (#54, #81, #140). The recipe and override env var below are
 * load-bearing — if any of them get edited away, this test catches it.
 */

import { describe, it, expect } from 'vitest';
import {
  buildNode25BlockBanner,
  buildNodeTooOldBanner,
  isNode25Affected,
  MIN_NODE_MAJOR,
  isNodeRealmLifetimeAffected,
  evaluateNodeVersionGuard,
} from '../src/bin/node-version-check';

describe('isNode25Affected', () => {
  it('blocks Node 25だけを既知のV8 bug対象として扱う', () => {
    expect(isNode25Affected(24)).toBe(false);
    expect(isNode25Affected(25)).toBe(true);
    expect(isNode25Affected(26)).toBe(false);
  });
});

describe('buildNode25BlockBanner', () => {
  it('embeds the reported Node version in the header', () => {
    expect(buildNode25BlockBanner('25.9.0')).toContain(
      'Unsupported Node.js version: 25.9.0'
    );
  });

  it('names the V8 turboshaft WASM root cause and the OOM symptom', () => {
    const banner = buildNode25BlockBanner('25.7.0');
    expect(banner).toContain('V8 WASM JIT');
    expect(banner).toContain('turboshaft');
    expect(banner).toContain('Fatal process out of memory: Zone');
  });

  it('points users to Node 22 LTS via nvm and Homebrew', () => {
    const banner = buildNode25BlockBanner('25.7.0');
    expect(banner).toContain('Node.js 22 LTS');
    expect(banner).toContain('nvm install 22');
    expect(banner).toContain('brew install node@22');
  });

  it('documents the LATTICE_SENSOR_ALLOW_UNSAFE_NODE override', () => {
    const banner = buildNode25BlockBanner('25.7.0');
    expect(banner).toContain('LATTICE_SENSOR_ALLOW_UNSAFE_NODE=1');
  });

  it('links to issue #81 for the root-cause writeup', () => {
    expect(buildNode25BlockBanner('25.7.0')).toContain(
      'github.com/kitepon/Lattice/issues/81'
    );
  });
});

describe('buildNodeTooOldBanner', () => {
  it('embeds the reported Node version in the header', () => {
    expect(buildNodeTooOldBanner('18.20.0')).toContain(
      'Unsupported Node.js version: 18.20.0'
    );
  });

  it('states the supported floor matching MIN_NODE_MAJOR', () => {
    expect(MIN_NODE_MAJOR).toBe(20);
    expect(buildNodeTooOldBanner('18.0.0')).toContain(
      `requires Node.js ${MIN_NODE_MAJOR} or newer`
    );
  });

  it('points users to Node 22 LTS via nvm and Homebrew', () => {
    const banner = buildNodeTooOldBanner('16.0.0');
    expect(banner).toContain('Node.js 22 LTS');
    expect(banner).toContain('nvm install 22');
    expect(banner).toContain('brew install node@22');
  });

  it('documents the LATTICE_SENSOR_ALLOW_UNSAFE_NODE override', () => {
    expect(buildNodeTooOldBanner('18.0.0')).toContain('LATTICE_SENSOR_ALLOW_UNSAFE_NODE=1');
  });
});

describe('Realm lifetime runtime compatibility', () => {
  it.each(['24.2.0', '24.20.0', '24.21.999', '26.0.0', '26.9.999'])('rejects unpatched %s before worker startup', (version) => {
    expect(isNodeRealmLifetimeAffected(version)).toBe(true);
    expect(evaluateNodeVersionGuard(version, false).blocked).toBe(true);
  });
  it.each(['22.13.0', '22.23.1', '24.0.0', '24.1.0', '24.22.0', '24.22.1', '26.10.0', '26.12.0'])('keeps supported %s available', (version) => {
    expect(isNodeRealmLifetimeAffected(version)).toBe(false);
    expect(evaluateNodeVersionGuard(version, false)).toEqual({ blocked: false, banner: null });
  });
  it('keeps the explicit patched-runtime override visible', () => {
    const support = evaluateNodeVersionGuard('24.20.0', true);
    expect(support.blocked).toBe(false);
    expect(support.banner).toContain('24.22.0');
    expect(support.banner).toContain('nodejs/node/pull/65778');
  });
});
