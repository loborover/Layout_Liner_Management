import { describe, expect, it } from 'vitest';
import { applyThresholds, normalize, sourceFor } from '../src/viewer/sources';

describe('viewer data sources', () => {
  it('normalizes the three payload shapes', () => {
    const at = 1000;
    expect(normalize({ values: { 'pump-1': 42 } }, at).get('pump-1')).toMatchObject({ value: 42, at });
    expect(normalize({ a: 1, b: 'run' }, at).get('b')?.value).toBe('run');
    const arr = normalize([{ key: 'k', value: 3, status: 'alarm', unit: '°C' }], at);
    expect(arr.get('k')).toMatchObject({ value: 3, status: 'alarm', unit: '°C' });
  });

  it('applies thresholds by exact key and prefix, keeping explicit statuses', () => {
    const v = normalize([{ key: 'temp-1', value: 85 }, { key: 'temp-2', value: 50 }, { key: 'p', value: 5 }, { key: 'x', value: 1, status: 'warn' }], 0);
    applyThresholds(v, { 'temp*': { warn: 60, alarm: 80 }, p: { low: 10 } });
    expect(v.get('temp-1')?.status).toBe('alarm');
    expect(v.get('temp-2')?.status).toBe('ok');
    expect(v.get('x')?.status).toBe('warn');
    expect(['warn', 'alarm']).toContain(v.get('p')?.status);
  });

  it('picks a source by URL scheme', () => {
    expect(sourceFor('mock', 1000, () => []).label).toMatch(/모의|mock/i);
    expect(() => sourceFor('ftp://x', 1000, () => [])).toThrow();
  });
});
