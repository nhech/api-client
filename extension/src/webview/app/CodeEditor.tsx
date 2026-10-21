import { autocompletion, closeBrackets, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { linter, lintGutter } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Annotation, EditorState, RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state';
import { Decoration, drawSelection, EditorView, highlightActiveLine, hoverTooltip, keymap, lineNumbers, placeholder as placeholderExtension, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useSignalEffect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { DYNAMIC_WORDS, isKnownDynamic, tokenize, type Token, type VariableInfo } from '../../../../src/core/vars';
import { variables as variableState } from './store';

/**
 * The text editors of the page (the address, the body, the scripts): CodeMirror 6, coloured from the theme of VS Code. It is
 * created once and kept; a value that arrives from outside replaces the text only when it differs from what is there, so that
 * typing never fights with the extension's answer.
 */
export type Language = 'json' | 'js' | 'xml' | 'text';

/** Marks a change that came from outside, so that it is not sent back as an edit. */
export const External = Annotation.define<boolean>();

export const nonce = document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content') ?? '';

export const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--vscode-debugTokenExpression-name)' },
  { tag: tags.string, color: 'var(--vscode-debugTokenExpression-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--vscode-debugTokenExpression-number)' },
  { tag: tags.keyword, color: 'var(--vscode-debugTokenExpression-name)' },
  { tag: tags.comment, color: 'var(--vscode-descriptionForeground)' }
]);

export const theme = EditorView.theme({
  '&': { color: 'var(--vscode-editor-foreground)', backgroundColor: 'var(--vscode-input-background, var(--vscode-editor-background))', fontFamily: 'var(--vscode-editor-font-family)', fontSize: 'var(--vscode-editor-font-size)' },
  '&.cm-focused': { outline: '1px solid var(--vscode-focusBorder)' },
  '.cm-content': { caretColor: 'var(--vscode-editorCursor-foreground)' },
  '.cm-gutters': { backgroundColor: 'var(--vscode-editorGutter-background)', color: 'var(--vscode-editorLineNumber-foreground)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--vscode-editor-selectionBackground)' },
  '.cm-placeholder': { color: 'var(--vscode-input-placeholderForeground)' },
  '.cm-var': { color: 'var(--vscode-charts-green)', fontWeight: '600' },
  '.cm-var-neutral': { color: 'inherit', fontWeight: '600' },
  '.cm-var-dynamic': { color: 'var(--vscode-charts-blue)' },
  '.cm-var-unknown': { color: 'var(--vscode-editorError-foreground)', textDecoration: 'underline wavy var(--vscode-editorError-foreground)' },
  '.cm-tooltip': { backgroundColor: 'var(--vscode-editorHoverWidget-background)', color: 'var(--vscode-editorHoverWidget-foreground)', border: '1px solid var(--vscode-editorHoverWidget-border)', borderRadius: '3px' },
  '.cm-var-tip': { padding: '4px 8px', maxWidth: '420px', overflowWrap: 'anywhere', fontFamily: 'var(--vscode-font-family)', fontSize: 'var(--vscode-font-size)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--vscode-list-activeSelectionBackground)', color: 'var(--vscode-list-activeSelectionForeground)' }
});

/** Asks the marks of the variables to be made again: the extension sent another list. */
const refreshVariables = StateEffect.define<null>();

let listedFor: VariableInfo[] | undefined;
let listed = new Map<string, VariableInfo>();
/** The variables of the request by name. */
function knownVariables(): Map<string, VariableInfo> {
  const list = variableState.peek().vars;
  if (list !== listedFor) { listedFor = list; listed = new Map(list.map(item => [item.name, item])); }
  return listed;
}

/** The class a `{{...}}` is drawn with: green when the request can see it, blue for a dynamic word, red when nothing defines it (unless the list may be incomplete). */
function markFor(token: Token): string {
  if (token.kind === 'dynamic') return isKnownDynamic(token.name) ? 'cm-var cm-var-dynamic' : 'cm-var cm-var-unknown';
  if (token.kind === 'invalid') return 'cm-var cm-var-unknown';
  if (knownVariables().has(token.name)) return 'cm-var';
  return variableState.peek().complete ? 'cm-var cm-var-unknown' : 'cm-var cm-var-neutral';
}

function markVariables(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (const token of tokenize(view.state.sliceDoc(from, to))) builder.add(from + token.start, from + token.end, Decoration.mark({ class: markFor(token) }));
  }
  return builder.finish();
}

const variables = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = markVariables(view); }
  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshVariables)))) this.decorations = markVariables(update.view);
  }
}, { decorations: instance => instance.decorations });

/** What hovering a variable says: its value and where it comes from, or that nothing defines it. Built from text nodes only. */
function describeToken(token: Token): HTMLElement {
  const box = document.createElement('div');
  box.className = 'cm-var-tip';
  const line = (text: string, strong = false): void => {
    const element = document.createElement(strong ? 'strong' : 'div');
    element.textContent = text;
    box.append(element);
  };
  if (token.kind === 'dynamic') {
    line(token.name, true);
    line(isKnownDynamic(token.name) ? 'A value made at every send.' : 'This is not a dynamic value that is known.');
    return box;
  }
  const found = token.kind === 'variable' ? knownVariables().get(token.name) : undefined;
  line(token.name === '' ? '{{ }}' : token.name, true);
  if (found !== undefined) {
    line(found.secret ? 'A secret: its value is not shown.' : found.value === '' ? '(empty)' : found.value.length > 200 ? `${found.value.slice(0, 200)}...` : found.value);
    line(`From ${found.source}`);
  } else if (token.kind === 'invalid') line('This is not a name a variable can have.');
  else line(variableState.peek().complete ? 'No variable of this name is defined here. Add it to an environment, the collection or the workspace.' : 'The variables of this file are not known: it is not in a collection.');
  return box;
}

const variableHover = hoverTooltip((view, position) => {
  const line = view.state.doc.lineAt(position);
  for (const token of tokenize(line.text)) {
    const from = line.from + token.start;
    const to = line.from + token.end;
    if (position >= from && position <= to) return { pos: from, end: to, above: true, create: () => ({ dom: describeToken(token) }) };
  }
  return null;
});

const NAME_BEFORE_CURSOR = /\{\{[A-Za-z0-9_.$ -]*$/;

/** After `{{`: the variables of the request and the dynamic words. Accepting one writes the closing braces when they are not there. */
function completeVariables(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(NAME_BEFORE_CURSOR);
  if (before === null) return null;
  const closing = context.state.sliceDoc(context.pos, context.pos + 2) === '}}';
  const apply = (name: string) => (view: EditorView, _completion: Completion, from: number, to: number): void => {
    view.dispatch({ changes: { from, to: closing ? to + 2 : to, insert: `${name}}}` }, selection: { anchor: from + name.length + 2 } });
  };
  const options: Completion[] = [
    ...variableState.peek().vars.map(item => ({ label: item.name, type: 'variable', detail: item.source, info: item.secret ? 'A secret.' : item.value, apply: apply(item.name) })),
    ...DYNAMIC_WORDS.map(word => ({ label: word, type: 'keyword', detail: 'dynamic', apply: apply(word) }))
  ];
  return { from: before.from + 2, options, validFor: /^[A-Za-z0-9_.$ -]*$/ };
}

export function languageExtensions(language: Language, lint = true): Extension[] {
  if (language === 'json') return lint ? [json(), linter(jsonParseLinter())] : [json()];
  if (language === 'js') return [javascript()];
  if (language === 'xml') return [xml()];
  return [];
}

export interface CodeEditorProps {
  value: string;
  language?: Language;
  /** One line: no line numbers, and a pasted line break is dropped. */
  oneLine?: boolean;
  readOnly?: boolean;
  /** What a screen reader says for the field. */
  label: string;
  placeholder?: string;
  onChange?: (value: string) => void;
  /** Ctrl+Enter or Cmd+Enter inside the field. */
  onSubmit?: () => void;
  onBlur?: () => void;
}

export function CodeEditor(props: CodeEditorProps) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const extensions: Extension[] = [
      EditorView.cspNonce.of(nonce), theme, syntaxHighlighting(highlight), variables, variableHover, history(), drawSelection(), closeBrackets(), bracketMatching(), highlightSelectionMatches(), indentOnInput(), autocompletion({ override: [completeVariables], icons: false }),
      keymap.of([{ key: 'Mod-Enter', run: () => { latest.current.onSubmit?.(); return latest.current.onSubmit !== undefined; } }, ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
      EditorView.contentAttributes.of({ 'aria-label': props.label }),
      EditorView.updateListener.of(update => { if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(External) === true)) latest.current.onChange?.(update.state.doc.toString()); }),
      EditorView.domEventHandlers({ blur: () => { latest.current.onBlur?.(); return false; } }),
      EditorState.readOnly.of(props.readOnly === true), ...languageExtensions(props.language ?? 'text')
    ];
    if (props.placeholder !== undefined) extensions.push(placeholderExtension(props.placeholder));
    if (props.oneLine === true) extensions.push(EditorState.transactionFilter.of(transaction => (transaction.newDoc.lines > 1 ? [] : transaction)));
    else extensions.push(lineNumbers(), foldGutter(), highlightActiveLine(), lintGutter());
    const created = new EditorView({ parent: parent.current as HTMLDivElement, state: EditorState.create({ doc: props.value, extensions }) });
    view.current = created;
    return () => { created.destroy(); view.current = undefined; };
  }, [props.language, props.readOnly, props.oneLine]);

  // Another list of variables arrived: the marks are made again.
  useSignalEffect(() => {
    void variableState.value;
    view.current?.dispatch({ effects: refreshVariables.of(null) });
  });

  useEffect(() => {
    const current = view.current;
    if (current === undefined || current.state.doc.toString() === props.value) return;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: props.value }, annotations: External.of(true) });
  }, [props.value]);

  return <div class={props.oneLine === true ? 'cm-wrap cm-one-line' : 'cm-wrap'} ref={parent} />;
}

