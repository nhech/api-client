import { autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { linter, lintGutter } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Annotation, EditorState, type Extension } from '@codemirror/state';
import { Decoration, drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers, MatchDecorator, placeholder as placeholderExtension, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'preact/hooks';

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
  '.cm-var': { color: 'var(--vscode-charts-green)', fontWeight: '600' }
});

const variableMatcher = new MatchDecorator({ regexp: /\{\{[^{}\n]{1,120}\}\}/g, decoration: Decoration.mark({ class: 'cm-var' }) });
const variables = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = variableMatcher.createDeco(view); }
  update(update: ViewUpdate): void { this.decorations = variableMatcher.updateDeco(update, this.decorations); }
}, { decorations: instance => instance.decorations });

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
      EditorView.cspNonce.of(nonce), theme, syntaxHighlighting(highlight), variables, history(), drawSelection(), closeBrackets(), bracketMatching(), highlightSelectionMatches(), indentOnInput(), autocompletion(),
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

  useEffect(() => {
    const current = view.current;
    if (current === undefined || current.state.doc.toString() === props.value) return;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: props.value }, annotations: External.of(true) });
  }, [props.value]);

  return <div class={props.oneLine === true ? 'cm-wrap cm-one-line' : 'cm-wrap'} ref={parent} />;
}

