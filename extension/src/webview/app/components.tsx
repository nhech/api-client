import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import type { KV } from '../../../../src/core/model';
import type { Path } from '../../../../src/view/request-protocol';
import { edit } from './store';

/** The small parts the tabs are made of: a row of tabs, a grid of rows with a switch, a labelled field. */
export interface TabSpec {
  id: string;
  label: string;
  /** A count or a mark next to the label. */
  badge?: string;
}

export function Tabs(props: { tabs: TabSpec[]; active: string; onSelect: (id: string) => void; label: string; children: ComponentChildren }) {
  const list = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent, index: number): void => {
    const last = props.tabs.length - 1;
    let target = -1;
    if (event.key === 'ArrowRight') target = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft') target = index === 0 ? last : index - 1;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = last;
    if (target < 0) return;
    event.preventDefault();
    const next = props.tabs[target];
    if (next === undefined) return;
    props.onSelect(next.id);
    (list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[target])?.focus();
  };
  return (
    <div class="tabs">
      <div class="tab-list" role="tablist" aria-label={props.label} ref={list}>
        {props.tabs.map((tab, index) => (
          <button type="button" role="tab" id={`tab-${tab.id}`} class={tab.id === props.active ? 'tab active' : 'tab'} aria-selected={tab.id === props.active} aria-controls={`panel-${tab.id}`} tabIndex={tab.id === props.active ? 0 : -1} onClick={() => props.onSelect(tab.id)} onKeyDown={event => move(event, index)}>
            {tab.label}{tab.badge !== undefined && tab.badge !== '' ? <span class="badge">{tab.badge}</span> : null}
          </button>
        ))}
      </div>
      <div class="tab-panel" role="tabpanel" id={`panel-${props.active}`} aria-labelledby={`tab-${props.active}`}>{props.children}</div>
    </div>
  );
}

/** A text field that sends its value as an edit while the person types. */
export function Field(props: { label: string; value: string; path: Path; placeholder?: string; type?: 'text' | 'password'; wide?: boolean }) {
  return (
    <label class={props.wide === true ? 'field wide' : 'field'}>
      <span class="field-label">{props.label}</span>
      {props.type === 'password'
        ? <input type="password" value={props.value} placeholder={props.placeholder} spellcheck={false} autocomplete="off" onInput={event => edit({ op: 'set', path: props.path, value: (event.target as HTMLInputElement).value })} />
        : <input type="text" value={props.value} placeholder={props.placeholder} spellcheck={false} autocomplete="off" onInput={event => edit({ op: 'set', path: props.path, value: (event.target as HTMLInputElement).value })} />}
    </label>
  );
}

export function Choice<T extends string>(props: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <label class="field">
      <span class="field-label">{props.label}</span>
      <select value={props.value} onChange={event => props.onChange((event.target as HTMLSelectElement).value as T)}>
        {props.options.map(option => <option value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

export function Check(props: { label: string; checked: boolean; path: Path }) {
  return (
    <label class="check">
      <input type="checkbox" checked={props.checked} onChange={event => edit({ op: 'set', path: props.path, value: (event.target as HTMLInputElement).checked })} />
      <span>{props.label}</span>
    </label>
  );
}

const emptyRow = (): KV => ({ name: '', value: '', enabled: true, description: '' });

/**
 * Rows of name and value with a switch, a delete button and an empty row at the end: typing in the empty row adds a row.
 * `path` is where the list is in the request.
 */
export function KeyValueGrid(props: { rows: readonly KV[]; path: Path; label: string; namePlaceholder?: string; valuePlaceholder?: string }) {
  const root = useRef<HTMLDivElement>(null);
  /** After a row is added from the empty row, the person goes on typing in the row that was made, not in a new empty one. */
  const addFrom = (field: 'name' | 'value', typed: string, target: HTMLInputElement): void => {
    const index = props.rows.length;
    edit({ op: 'insert', path: props.path, index, value: { ...emptyRow(), [field]: typed } as never });
    target.value = '';
    setTimeout(() => {
      const created = root.current?.querySelector<HTMLInputElement>(`[data-row="${index}"] input.${field}`);
      created?.focus();
      created?.setSelectionRange(typed.length, typed.length);
    }, 0);
  };
  const set = (index: number, key: keyof KV, value: string | boolean): void => edit({ op: 'set', path: [...props.path, index, key], value });
  return (
    <div class="grid" role="group" aria-label={props.label} ref={root}>
      {props.rows.map((row, index) => (
        <div class={row.enabled ? 'grid-row' : 'grid-row off'} key={index} data-row={index}>
          <input type="checkbox" aria-label={`Enable ${row.name || `row ${index + 1}`}`} checked={row.enabled} onChange={event => set(index, 'enabled', (event.target as HTMLInputElement).checked)} />
          <input class="name" aria-label={`Name of row ${index + 1}`} placeholder={props.namePlaceholder ?? 'Name'} value={row.name} spellcheck={false} onInput={event => set(index, 'name', (event.target as HTMLInputElement).value)} />
          <input class="value" aria-label={`Value of row ${index + 1}`} placeholder={props.valuePlaceholder ?? 'Value'} value={row.value} spellcheck={false} onInput={event => set(index, 'value', (event.target as HTMLInputElement).value)} />
          <button type="button" class="icon" aria-label={`Delete row ${index + 1}`} title="Delete" onClick={() => edit({ op: 'remove', path: props.path, index })}>&times;</button>
        </div>
      ))}
      <div class="grid-row ghost" key="ghost">
        <span class="spacer" />
        <input class="name" aria-label="Name of a new row" placeholder={props.namePlaceholder ?? 'Name'} value="" spellcheck={false} onInput={event => addFrom('name', (event.target as HTMLInputElement).value, event.target as HTMLInputElement)} />
        <input class="value" aria-label="Value of a new row" placeholder={props.valuePlaceholder ?? 'Value'} value="" spellcheck={false} onInput={event => addFrom('value', (event.target as HTMLInputElement).value, event.target as HTMLInputElement)} />
        <span class="spacer" />
      </div>
    </div>
  );
}
