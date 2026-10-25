import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cssVariables, PALETTE } from '../src/theme';

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
const root = /:root \{([\s\S]*?)\n\}/.exec(css)![1];

describe('design tokens', () => {
  it('style.css :root matches src/theme.ts cssVariables()', () => {
    const declared = Object.fromEntries([...root.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
    expect(declared).toEqual(cssVariables());
  });

  it('style.css uses no literal colours outside :root', () => {
    const rest = css.replace(root, '');
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|:\s*(white|black)\b/g)).toBeNull();
  });

  it('keeps the four Ink wash colours', () => {
    expect(Object.values(PALETTE)).toEqual(['#4A4A4A', '#CBCBCB', '#FFFFE3', '#6D8196']);
  });
});
