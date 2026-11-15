/**
 * @file parameters.ts
 *
 * Side panel "파라미터": the drawing's named values (e.g. 폭 = 12000) that driving dimensions use in their
 * expressions ("폭 / 2"). Each row has the name, the expression (a number or a formula of other parameters and
 * functions), its current value or why it can't be computed, and how many dimensions use it. Every change goes
 * through ConstraintService.setParameters, which re-applies the dimensions and solves the geometry as one undo step.
 * Related: src/model/params.ts (expression language), src/constraints/service.ts, docs/DATA_MODEL.md.
 */
import type { ConstraintService } from '../constraints/service';
import { newId } from '../model/ids';
import { evaluateParameters, nameProblem, parseExpression, references } from '../model/params';
import type { Parameter } from '../model/types';
import { formatLength } from '../view/format';
import type { UiHost } from './host';

export class ParameterPanel {
  private timer: number | undefined;

  constructor(
    private readonly host: UiHost,
    private readonly constraints: ConstraintService,
    private readonly root: HTMLElement,
  ) {}

  refresh(): void {
    if (this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      // Don't rebuild under the user's cursor while they type.
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && this.root.contains(active)) return;
      this.render();
    }, 150);
  }

  /** Adds a parameter with a free name ("변수1", "변수2", ...) and the given expression. */
  async add(expression = '1000'): Promise<void> {
    const { doc } = this.host;
    let n = doc.parameters.size + 1;
    const names = new Set([...doc.parameters.values()].map((p) => p.name));
    while (names.has(`변수${n}`)) n++;
    await this.commit([...doc.parameters.values(), { id: newId('v'), name: `변수${n}`, expression }], '파라미터 추가');
  }

  render(): void {
    const { doc } = this.host;
    const readOnly = this.host.mode() === 'view';
    const params = [...doc.parameters.values()];
    const { values } = evaluateParameters(params, this.constraints.functions);
    const errors = this.constraints.parameterErrors();
    const uses = this.usage();
    const rows: HTMLElement[] = [];
    if (params.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = '파라미터가 없습니다. "+ 추가"로 이름 붙은 값을 만들고, 치수 값에 "폭 / 2"처럼 이름이나 수식을 쓰십시오.';
      rows.push(empty);
    }
    for (const p of params) {
      const row = document.createElement('div');
      row.className = 'param-row';
      const name = this.input(p.name, '이름', readOnly, (v) => {
        const problem = nameProblem(v.trim(), params, p.id);
        if (problem) return this.host.notify(problem);
        void this.rename(p, v.trim());
      });
      const expr = this.input(p.expression, '값 또는 수식 (예: 12000, 폭 * 2)', readOnly, (v) => {
        try {
          parseExpression(v);
        } catch (err) {
          return this.host.notify((err as Error).message);
        }
        void this.commit(params.map((q) => (q.id === p.id ? { ...q, expression: v.trim() } : q)), '파라미터 값 변경');
      });
      const value = document.createElement('span');
      value.className = 'param-value';
      const error = errors.get(p.id);
      const v = values.get(p.name);
      value.textContent = error ? `⚠ ${error}` : v !== undefined ? formatLength(v, 'mm') : '';
      if (error) value.classList.add('warn');
      const count = uses.get(p.name) ?? 0;
      value.title = count > 0 ? `치수 ${count}곳에서 사용` : '사용하는 치수가 없습니다';
      const remove = document.createElement('button');
      remove.textContent = '삭제';
      remove.className = 'edit-only';
      remove.title = count > 0 ? `치수 ${count}곳이 이 파라미터를 씁니다. 지우면 그 치수는 마지막 값으로 고정됩니다.` : '파라미터 삭제';
      remove.disabled = readOnly;
      remove.addEventListener('click', () => {
        if (count > 0 && !this.host.confirm(`'${p.name}'을(를) 쓰는 치수가 ${count}곳 있습니다. 지우면 그 치수는 지금 값으로 남습니다. 지울까요?`)) return;
        void this.commit(params.filter((q) => q.id !== p.id), '파라미터 삭제');
      });
      row.append(name, expr, value, remove);
      rows.push(row);
    }
    this.root.replaceChildren(...rows);
  }

  private async rename(p: Parameter, to: string): Promise<void> {
    if (to === p.name) return;
    const r = this.constraints.renameParameter(p.id, to);
    if (!r.ok) this.host.notify(r.message);
    this.render();
  }

  private async commit(next: Parameter[], label: string): Promise<void> {
    const r = await this.constraints.setParameters(next, label);
    if (!r.ok) this.host.notify(r.message);
    this.render();
  }

  /** How many driving dimensions use each parameter name. */
  private usage(): Map<string, number> {
    const { doc } = this.host;
    const out = new Map<string, number>();
    const targets = [...doc.constraints.values(), ...[...doc.entities.values()].filter((e) => e.kind === 'dimension')];
    for (const t of targets) {
      if (!t.expression) continue;
      try {
        for (const n of references(parseExpression(t.expression)).params) out.set(n, (out.get(n) ?? 0) + 1);
      } catch {
        // a broken expression uses nothing
      }
    }
    return out;
  }

  private input(value: string, placeholder: string, readOnly: boolean, onCommit: (v: string) => void): HTMLInputElement {
    const i = document.createElement('input');
    i.type = 'text';
    i.value = value;
    i.placeholder = placeholder;
    i.title = placeholder;
    i.disabled = readOnly;
    i.addEventListener('change', () => onCommit(i.value));
    i.addEventListener('keydown', (e) => e.key === 'Enter' && i.blur());
    return i;
  }
}
