import { defaultKeymap } from '@codemirror/commands';
import { foldGutter, foldKeymap, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { useEffect, useRef } from 'preact/hooks';
import { External, highlight, languageExtensions, nonce, theme, type Language } from './CodeEditor';

/**
 * Shows the body of a response: CodeMirror in read-only mode, with folding, search (Ctrl+F) and the colours of the theme. Characters
 * that hide text or change its direction are drawn as marks, so that a response cannot show one thing and mean another.
 */
export function CodeViewer(props: { text: string; language: Language; label: string; wrap: boolean }) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);

  useEffect(() => {
    const extensions: Extension[] = [
      EditorView.cspNonce.of(nonce), theme, syntaxHighlighting(highlight), highlightSpecialChars(), drawSelection(), highlightSelectionMatches(), lineNumbers(), foldGutter(),
      keymap.of([...defaultKeymap, ...searchKeymap, ...foldKeymap]), EditorState.readOnly.of(true), EditorView.editable.of(true),
      EditorView.contentAttributes.of({ 'aria-label': props.label, 'aria-readonly': 'true' }), ...languageExtensions(props.language, false)
    ];
    if (props.wrap) extensions.push(EditorView.lineWrapping);
    const created = new EditorView({ parent: parent.current as HTMLDivElement, state: EditorState.create({ doc: props.text, extensions }) });
    view.current = created;
    return () => { created.destroy(); view.current = undefined; };
  }, [props.language, props.wrap]);

  useEffect(() => {
    const current = view.current;
    if (current === undefined || current.state.doc.toString() === props.text) return;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: props.text }, annotations: External.of(true) });
  }, [props.text]);

  return <div class="cm-wrap cm-viewer" ref={parent} />;
}
