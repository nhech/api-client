import { useRef } from 'preact/hooks';
import type { Var } from '../../../../src/core/model';
import type { Path } from '../../../../src/view/request-protocol';
import { edit } from './store';

const emptyVar = (): Var => ({ name: '', value: '', secret: false, enabled: true });

/**
 * The variables of an environment, a collection or a folder: a switch, a name, a value, whether the value is secret, and an empty row
 * at the end where typing adds a row. The value of a secret is drawn as dots unless `reveal` is on; it is kept in a file next to the
 * file of the variables, which Git ignores, so it is never shared.
 */
export function VarsGrid(props: { rows: readonly Var[]; path: Path; reveal: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const set = (index: number, key: keyof Var, value: string | boolean): void => edit({ op: 'set', path: [...props.path, index, key], value });
  const addFrom = (field: 'name' | 'value', typed: string, target: HTMLInputElement): void => {
    const index = props.rows.length;
    edit({ op: 'insert', path: props.path, index, value: { ...emptyVar(), [field]: typed } as never });
    target.value = '';
    setTimeout(() => {
      const created = root.current?.querySelector<HTMLInputElement>(`[data-row="${index}"] input.${field}`);
      created?.focus();
      created?.setSelectionRange(typed.length, typed.length);
    }, 0);
  };
  return (
    <div class="grid" role="group" aria-label="Variables" ref={root}>
      {props.rows.length > 0 ? <div class="grid-row var head" aria-hidden="true"><span /><span>Name</span><span>Value</span><span>Secret</span><span /></div> : null}
      {props.rows.map((row, index) => (
        <div class={row.enabled ? 'grid-row var' : 'grid-row var off'} key={index} data-row={index}>
          <input type="checkbox" aria-label={`Use ${row.name || `variable ${index + 1}`}`} checked={row.enabled} onChange={event => set(index, 'enabled', (event.target as HTMLInputElement).checked)} />
          <input class="name" aria-label={`Name of variable ${index + 1}`} placeholder="Name" value={row.name} spellcheck={false} onInput={event => set(index, 'name', (event.target as HTMLInputElement).value)} />
          {row.secret && !props.reveal
            ? <input class="value" type="password" aria-label={`Value of variable ${index + 1}`} placeholder="Value" value={row.value} spellcheck={false} autocomplete="off" onInput={event => set(index, 'value', (event.target as HTMLInputElement).value)} />
            : <input class="value" type="text" aria-label={`Value of variable ${index + 1}`} placeholder="Value" value={row.value} spellcheck={false} autocomplete="off" onInput={event => set(index, 'value', (event.target as HTMLInputElement).value)} />}
          <input type="checkbox" class="secret" aria-label={`${row.name || `Variable ${index + 1}`} is secret`} checked={row.secret} onChange={event => set(index, 'secret', (event.target as HTMLInputElement).checked)} />
          <button type="button" class="icon" aria-label={`Delete variable ${index + 1}`} title="Delete" onClick={() => edit({ op: 'remove', path: props.path, index })}>&times;</button>
        </div>
      ))}
      <div class="grid-row var ghost" key="ghost">
        <span class="spacer" />
        <input class="name" aria-label="Name of a new variable" placeholder="Name" value="" spellcheck={false} onInput={event => addFrom('name', (event.target as HTMLInputElement).value, event.target as HTMLInputElement)} />
        <input class="value" aria-label="Value of a new variable" placeholder="Value" value="" spellcheck={false} onInput={event => addFrom('value', (event.target as HTMLInputElement).value, event.target as HTMLInputElement)} />
        <span class="spacer" />
        <span class="spacer" />
      </div>
    </div>
  );
}
