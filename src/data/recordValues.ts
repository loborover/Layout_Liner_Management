/**
 * @file recordValues.ts
 *
 * Source data as values ("DB 값을 개체값으로", the user's request 2026-11-15): the `DB(dataset, key, field)`
 * function that parameters and formulas (src/model/params.ts, owned by the dimension constraint work) use to read
 * a field of a record served by the data gateway, e.g. `DB("equipment", "MC-1", "정격전력(kW)") * 2`.
 *
 * Formulas are evaluated synchronously, so the function answers from RecordStore's cache: a value not fetched
 * yet is `undefined` (the evaluator reports "값 없음" and the parameter keeps its last good value) and the fetch
 * starts in the background; when it lands, RecordStore.onChange fires and the caller re-evaluates. Read-only:
 * nothing here writes to the source. No DOM, so the MCP server and tests can use it.
 */
import { type FieldValue, type RecordStore, DATASET_NAME, MAX_RECORD_KEY } from './records';

/** Name of the formula function. */
export const DB_FUNCTION = 'DB';

/** One field of one record. */
export interface FieldRef {
  dataset: string;
  key: string;
  field: string;
}

/** Writes a reference as formula text, e.g. DB("equipment", "MC-1", "설비명"). */
export function formatFieldRef(r: FieldRef): string {
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `${DB_FUNCTION}(${q(r.dataset)}, ${q(r.key)}, ${q(r.field)})`;
}

/** A valid reference from function arguments, or undefined. */
export function fieldRefOf(args: readonly unknown[]): FieldRef | undefined {
  const [dataset, key, field] = args;
  if (args.length !== 3 || typeof dataset !== 'string' || typeof key !== 'string' || typeof field !== 'string') return undefined;
  if (!DATASET_NAME.test(dataset) || !key || key.length > MAX_RECORD_KEY || !field) return undefined;
  return { dataset, key, field };
}

/**
 * DB references among a formula's function calls (as listed by the formula parser's `references`), to fetch them
 * ahead of evaluation. Calls whose arguments are not all text literals are skipped.
 */
export function refsFromCalls(calls: readonly { name: string; args: readonly unknown[] }[]): FieldRef[] {
  return calls.flatMap((c) => {
    const ref = c.name === DB_FUNCTION ? fieldRefOf(c.args) : undefined;
    return ref ? [ref] : [];
  });
}

/** Text that is a plain number ("22", " 5.5 ", "1e3", "1,200") as that number; other values unchanged. */
export function asFormulaValue(v: FieldValue | undefined): number | string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  const t = v.trim().replace(/(\d),(?=\d{3}\b)/g, '$1');
  if (t !== '' && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return Number(t);
  return v;
}

/** Cached field value, starting a fetch when it is missing or stale; undefined until it arrives. */
export function readField(store: RecordStore, r: FieldRef): number | string | undefined {
  const state = store.peek(r.dataset, r.key);
  // get() answers from a fresh cache without a request, so asking every time keeps values current.
  if (state?.status !== 'loading') void store.get(r.dataset, r.key);
  if (state?.status !== 'ok' || !Object.prototype.hasOwnProperty.call(state.fields, r.field)) return undefined;
  return asFormulaValue(state.fields[r.field]);
}

/** Starts fetching the records of `refs` (e.g. every DB reference in the drawing) so formulas find them cached. */
export function prefetch(store: RecordStore, refs: readonly FieldRef[]): Promise<void> {
  const seen = new Set<string>();
  const jobs: Promise<unknown>[] = [];
  for (const r of refs) {
    const id = `${r.dataset}\u0000${r.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    jobs.push(store.get(r.dataset, r.key));
  }
  return Promise.all(jobs).then(() => undefined);
}

/** Function table for the formula evaluator: `DB(dataset, key, field)`. */
export function recordFunctions(store: RecordStore): Record<string, (...args: (number | string)[]) => number | string | undefined> {
  return {
    [DB_FUNCTION]: (...args) => {
      const ref = fieldRefOf(args);
      return ref ? readField(store, ref) : undefined;
    },
  };
}
