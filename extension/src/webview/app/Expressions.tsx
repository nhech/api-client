import { useRef } from 'preact/hooks';
import type { Path } from '../../../../src/view/request-protocol';
import { edit } from './store';

export interface Suggestion {
  label: string;
  expr: string;
}

/**
 * A list of lines of the grammar of tests or captures: a switch, the line itself, a delete button and an empty line at the end where
 * typing adds one. Each line is checked as it is typed and the reason it cannot be read is shown under it; buttons add the usual ones.
 */
export function ExpressionList(props: {
  rows: readonly { expr: string; enabled: boolean }[];
  path: Path;
  label: string;
  placeholder: string;
  /** The reason a line cannot be read, or undefined when it can. */
  check: (expr: string) => string | undefined;
  suggestions?: readonly Suggestion[];
}) {
  const root = useRef<HTMLDivElement>(null);
  const set = (index: number, key: 'expr' | 'enabled', value: string | boolean): void => edit({ op: 'set', path: [...props.path, index, key], value });
  const add = (expr: string, focus: boolean): void => {
    const index = props.rows.length;
    edit({ op: 'insert', path: props.path, index, value: { expr, enabled: true } as never });
    if (focus) {
      setTimeout(() => {
        const created = root.current?.querySelector<HTMLInputElement>(`[data-row="${index}"] input.expr`);
        created?.focus();
        created?.setSelectionRange(expr.length, expr.length);
      }, 0);
    }
  };
  return (
    <div ref={root}>
      <div class="grid" role="group" aria-label={props.label}>
        {props.rows.map((row, index) => {
          const problem = row.enabled && row.expr.trim() !== '' ? props.check(row.expr) : undefined;
          return (
            <>
              <div class={row.enabled ? 'grid-row expr' : 'grid-row expr off'} key={index} data-row={index}>
                <input type="checkbox" aria-label={`Use ${props.label.toLowerCase()} ${index + 1}`} checked={row.enabled} onChange={event => set(index, 'enabled', (event.target as HTMLInputElement).checked)} />
                <input class="expr" aria-label={`${props.label} ${index + 1}`} aria-invalid={problem !== undefined} placeholder={props.placeholder} value={row.expr} spellcheck={false} onInput={event => set(index, 'expr', (event.target as HTMLInputElement).value)} />
                <button type="button" class="icon" aria-label={`Delete ${props.label.toLowerCase()} ${index + 1}`} title="Delete" onClick={() => edit({ op: 'remove', path: props.path, index })}>&times;</button>
              </div>
              {problem !== undefined ? <div class="row-error" role="alert">{problem}</div> : null}
            </>
          );
        })}
        <div class="grid-row expr ghost" key="ghost">
          <span class="spacer" />
          <input class="expr" aria-label={`A new ${props.label.toLowerCase()}`} placeholder={props.placeholder} value="" spellcheck={false} onInput={event => { const target = event.target as HTMLInputElement; add(target.value, true); target.value = ''; }} />
          <span class="spacer" />
        </div>
      </div>
      {props.suggestions !== undefined ? (
        <div class="suggest" role="group" aria-label={`Add a ${props.label.toLowerCase()}`}>
          {props.suggestions.map(suggestion => <button type="button" class="chip" title={suggestion.expr} onClick={() => add(suggestion.expr, false)}>+ {suggestion.label}</button>)}
        </div>
      ) : null}
    </div>
  );
}
