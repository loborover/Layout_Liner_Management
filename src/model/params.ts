/**
 * @file params.ts
 *
 * Parameters (named values the user defines, e.g. 폭 = 12000) and the small expression language used by
 * parameters and driving dimensions ("폭 / 2 + 300", "=max(폭, 깊이)"). The parser is hand-written (no eval), so
 * a drawing file can never run code. Functions come from a built-in table plus any the caller passes; the data
 * gateway thread adds DB(...) that way (src/data/), which is why string literals are allowed as function arguments.
 * DOM-free: used by the constraint service, the API and the MCP server.
 * Related: src/model/types.ts (Parameter), src/constraints/service.ts (re-applying values), docs/DATA_MODEL.md.
 */
import type { Id, Parameter } from './types';

/** Raised for syntax errors, unknown names, cycles and missing values; `message` is Korean, for the user. */
export class ExpressionError extends Error {
  constructor(
    message: string,
    /** 'missing': a parameter or function had no value (yet), e.g. a DB value still loading. */
    readonly code: 'syntax' | 'unknown' | 'cycle' | 'missing' | 'math' = 'syntax',
  ) {
    super(message);
  }
}

export type Expr =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'name'; name: string }
  | { t: 'neg'; a: Expr }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^' | '%'; a: Expr; b: Expr }
  | { t: 'call'; name: string; args: Expr[] };

export type ExpressionFunction = (...args: (number | string)[]) => number | string | undefined;

export interface EvalContext {
  /** Value of a parameter by name; undefined when there is none. */
  params?: (name: string) => number | undefined;
  /** Extra functions; they win over built-ins of the same name. */
  functions?: Record<string, ExpressionFunction>;
}

const RAD = Math.PI / 180;

/** Built-in functions. Trigonometry is in degrees, like the angle constraint. */
export const BUILTIN_FUNCTIONS: Record<string, ExpressionFunction> = {
  min: (...a) => Math.min(...a.map(Number)),
  max: (...a) => Math.max(...a.map(Number)),
  abs: (x) => Math.abs(Number(x)),
  sqrt: (x) => Math.sqrt(Number(x)),
  round: (x, d = 0) => {
    const f = 10 ** Number(d);
    return Math.round(Number(x) * f) / f;
  },
  floor: (x) => Math.floor(Number(x)),
  ceil: (x) => Math.ceil(Number(x)),
  sin: (x) => Math.sin(Number(x) * RAD),
  cos: (x) => Math.cos(Number(x) * RAD),
  tan: (x) => Math.tan(Number(x) * RAD),
};

/** A parameter name: starts with a letter (any script, e.g. 한글) or _, then letters, digits or _. */
export const NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** Whether `text` is just a number (then a dimension stores a plain value, no expression). */
export const isPlainNumber = (text: string): boolean => /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(text);

/** Parses an expression; a leading '=' (spreadsheet habit) is allowed. */
export function parseExpression(text: string): Expr {
  const src = text.trim().replace(/^=/, '');
  let i = 0;
  const fail = (what: string): never => {
    throw new ExpressionError(`수식 오류: ${what} (${i + 1}번째 글자)`);
  };
  const space = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const peek = () => {
    space();
    return src[i];
  };
  const name = (): string | null => {
    space();
    const m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const primary = (): Expr => {
    const c = peek();
    if (c === undefined) return fail('식이 끝났습니다');
    if (c === '(') {
      i++;
      const e = sum();
      if (peek() !== ')') fail("')'가 필요합니다");
      i++;
      return e;
    }
    if (c === '-' || c === '+') {
      i++;
      const a = power();
      return c === '-' ? { t: 'neg', a } : a;
    }
    if (c === '"') {
      let s = '';
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) i++;
        s += src[i++];
      }
      if (src[i] !== '"') fail('문자열이 닫히지 않았습니다');
      i++;
      return { t: 'str', v: s };
    }
    const num = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return { t: 'num', v: Number(num[0]) };
    }
    const n = name();
    if (n === null) return fail(`알 수 없는 글자 '${c}'`);
    if (peek() === '(') {
      i++;
      const args: Expr[] = [];
      if (peek() !== ')') {
        for (;;) {
          args.push(sum());
          if (peek() === ',') {
            i++;
            continue;
          }
          break;
        }
      }
      if (peek() !== ')') fail("')'가 필요합니다");
      i++;
      return { t: 'call', name: n, args };
    }
    return { t: 'name', name: n };
  };
  // Right-associative power binds tighter than unary minus on its left operand only (-2^2 = -4).
  const power = (): Expr => {
    const a = primary();
    if (peek() === '^') {
      i++;
      return { t: 'bin', op: '^', a, b: power() };
    }
    return a;
  };
  const product = (): Expr => {
    let a = power();
    for (let c = peek(); c === '*' || c === '/' || c === '%'; c = peek()) {
      i++;
      a = { t: 'bin', op: c, a, b: power() };
    }
    return a;
  };
  const sum = (): Expr => {
    let a = product();
    for (let c = peek(); c === '+' || c === '-'; c = peek()) {
      i++;
      a = { t: 'bin', op: c, a, b: product() };
    }
    return a;
  };
  if (src === '') throw new ExpressionError('수식이 비어 있습니다.');
  const e = sum();
  if (peek() !== undefined) fail(`예상하지 못한 '${src[i]}'`);
  return e;
}

/** Parameter names and function calls an expression uses (a call's argument is its value when it is a literal). */
export function references(expr: Expr): { params: string[]; calls: { name: string; args: (number | string | null)[] }[] } {
  const params = new Set<string>();
  const calls: { name: string; args: (number | string | null)[] }[] = [];
  const walk = (e: Expr) => {
    if (e.t === 'name') params.add(e.name);
    else if (e.t === 'neg') walk(e.a);
    else if (e.t === 'bin') {
      walk(e.a);
      walk(e.b);
    } else if (e.t === 'call') {
      calls.push({ name: e.name, args: e.args.map((a) => (a.t === 'num' || a.t === 'str' ? a.v : null)) });
      e.args.forEach(walk);
    }
  };
  walk(expr);
  return { params: [...params], calls };
}

/** Evaluates an expression (text or parsed) to a finite number. */
export function evaluate(expr: Expr | string, ctx: EvalContext = {}): number {
  const e = typeof expr === 'string' ? parseExpression(expr) : expr;
  const v = run(e, ctx);
  if (typeof v !== 'number') throw new ExpressionError('수식의 결과가 숫자가 아닙니다.', 'math');
  if (!Number.isFinite(v)) throw new ExpressionError('수식의 결과가 유한한 숫자가 아닙니다(0으로 나누기 등).', 'math');
  return v;
}

function run(e: Expr, ctx: EvalContext): number | string {
  switch (e.t) {
    case 'num':
    case 'str':
      return e.v;
    case 'name': {
      const v = ctx.params?.(e.name);
      if (v === undefined) throw new ExpressionError(`알 수 없는 파라미터: ${e.name}`, 'unknown');
      return v;
    }
    case 'neg':
      return -num(run(e.a, ctx));
    case 'bin': {
      const a = num(run(e.a, ctx));
      const b = num(run(e.b, ctx));
      switch (e.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '%':
          return a % b;
        case '^':
          return a ** b;
      }
      break;
    }
    case 'call': {
      const fn = ctx.functions?.[e.name] ?? BUILTIN_FUNCTIONS[e.name];
      if (!fn) throw new ExpressionError(`알 수 없는 함수: ${e.name}`, 'unknown');
      const v = fn(...e.args.map((a) => run(a, ctx)));
      if (v === undefined) throw new ExpressionError(`값 없음: ${e.name}(…)`, 'missing');
      return v;
    }
  }
  throw new ExpressionError('수식을 계산할 수 없습니다.', 'math');
}

function num(v: number | string): number {
  if (typeof v === 'number') return v;
  const n = Number(v);
  if (v.trim() === '' || !Number.isFinite(n)) throw new ExpressionError(`숫자가 아닌 값: "${v}"`, 'math');
  return n;
}

/** Result of evaluating every parameter: values by name, and the error of each one that failed. */
export interface ParameterValues {
  values: Map<string, number>;
  errors: Map<Id, ExpressionError>;
}

/**
 * Evaluates all parameters, each after the ones it uses. A parameter that fails (syntax, unknown name, cycle,
 * missing value) keeps its last good `value` when it has one, so a gateway being down doesn't collapse the drawing.
 */
export function evaluateParameters(params: Iterable<Parameter>, functions?: Record<string, ExpressionFunction>): ParameterValues {
  const byName = new Map<string, Parameter>();
  for (const p of params) byName.set(p.name, p);
  const values = new Map<string, number>();
  const errors = new Map<Id, ExpressionError>();
  const state = new Map<string, 'busy' | 'done'>();
  const visit = (p: Parameter): number | undefined => {
    if (state.get(p.name) === 'done') return values.get(p.name);
    if (state.get(p.name) === 'busy') throw new ExpressionError(`순환 참조: ${p.name}`, 'cycle');
    state.set(p.name, 'busy');
    try {
      const v = evaluate(p.expression, {
        functions,
        params: (n) => {
          const q = byName.get(n);
          return q ? visit(q) : undefined;
        },
      });
      values.set(p.name, v);
      return v;
    } catch (err) {
      const e = err instanceof ExpressionError ? err : new ExpressionError(String(err), 'math');
      // A cycle is reported on every parameter in it.
      if (!errors.has(p.id)) errors.set(p.id, e);
      if (p.value !== undefined) {
        values.set(p.name, p.value);
        return p.value;
      }
      if (e.code === 'cycle') throw e;
      return undefined;
    } finally {
      state.set(p.name, 'done');
    }
  };
  for (const p of byName.values()) {
    try {
      visit(p);
    } catch {
      // recorded in errors
    }
  }
  return { values, errors };
}

/** Checks a parameter name for the user: valid, and not already used by another parameter. */
export function nameProblem(name: string, others: Iterable<Parameter>, self?: Id): string | null {
  if (!NAME.test(name)) return '파라미터 이름은 글자(한글 가능)나 _로 시작하고 글자·숫자·_만 쓸 수 있습니다.';
  if (name in BUILTIN_FUNCTIONS) return `'${name}'은(는) 함수 이름이라 쓸 수 없습니다.`;
  for (const p of others) if (p.name === name && p.id !== self) return `'${name}' 파라미터가 이미 있습니다.`;
  return null;
}

/** Replaces a parameter name in an expression, as a whole name only (not inside longer names or strings). */
export function renameInExpression(text: string, from: string, to: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = text.indexOf('"', i + 1);
      const stop = end < 0 ? text.length : end + 1;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    const m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(text.slice(i));
    if (m) {
      // A name directly followed by '(' is a function call, not a parameter.
      const call = /^\s*\(/.test(text.slice(i + m[0].length));
      out += m[0] === from && !call ? to : m[0];
      i += m[0].length;
      continue;
    }
    // Digits run together so "2e3" isn't read as a name "e3".
    const num = /^\d+(\.\d*)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (num) {
      out += num[0];
      i += num[0].length;
      continue;
    }
    out += text[i++];
  }
  return out;
}
