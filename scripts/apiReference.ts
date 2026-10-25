/**
 * @file apiReference.ts
 *
 * Generates docs/API-METHODS.md from the METHODS table in src/api/rpc.ts, so the method reference can never drift
 * from the code. Run `npm run docs:api` after changing a method; tests/api.test.ts fails while the file is stale.
 */
import { METHODS } from '../src/api/rpc';

type Schema = Record<string, unknown>;

/** Short type of a JSON Schema node, e.g. "number", "string[]", "center | inside | outside". */
function typeOf(s: Schema): string {
  if (Array.isArray(s.enum)) return s.enum.map(String).join(' \\| ');
  if (Array.isArray(s.oneOf)) return s.oneOf.map((o) => typeOf(o as Schema)).join(' \\| ');
  if (Array.isArray(s.type)) return s.type.join(' \\| ');
  if (s.type === 'array') return `${s.items ? typeOf(s.items as Schema) : 'any'}[]`;
  if (s.type === 'object' && s.properties && Object.keys(s.properties).length === 2 && 'x' in (s.properties as Schema)) return '{x, y}';
  return typeof s.type === 'string' ? s.type : 'any';
}

const cell = (t: unknown) => String(t ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function apiReference(): string {
  const out = [
    '# API 메서드 목록',
    '',
    '<!-- 자동 생성 파일입니다. 직접 고치지 말고 src/api/rpc.ts를 고친 뒤 `npm run docs:api`를 실행하십시오. -->',
    '',
    '모든 전송 방식(브라우저 `layoutLiner.call`, MCP 도구, HTTP JSON-RPC, 실시간 브리지)이 같은 목록을 씁니다. 사용법은 [API.md](API.md)를 보십시오.',
    '좌표와 길이는 mm, Y축은 위쪽입니다. "변경"이 예인 메서드는 실행 취소(undo) 한 단계로 기록됩니다.',
    '',
    '| 메서드 | 변경 | 설명 |',
    '| --- | --- | --- |',
  ];
  for (const [name, m] of Object.entries(METHODS)) out.push(`| [\`${name}\`](#${name.toLowerCase()}) | ${m.mutates ? '예' : ''} | ${cell(m.description)} |`);
  for (const [name, m] of Object.entries(METHODS)) {
    out.push('', `## ${name}`, '', m.description, '');
    const props = (m.params.properties ?? {}) as Record<string, Schema>;
    const required = new Set((m.params.required as string[]) ?? []);
    if (Object.keys(props).length === 0) {
      out.push('매개변수 없음.');
      continue;
    }
    out.push('| 매개변수 | 형식 | 필수 | 설명 |', '| --- | --- | --- | --- |');
    for (const [p, s] of Object.entries(props)) out.push(`| \`${p}\` | ${typeOf(s)} | ${required.has(p) ? '예' : ''} | ${cell(s.description)} |`);
  }
  return out.join('\n') + '\n';
}

// CLI: write the file.
if (process.argv[1]?.endsWith('apiReference.ts')) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(new URL('../docs/API-METHODS.md', import.meta.url), apiReference());
  console.log('docs/API-METHODS.md 갱신');
}
