import { useEffect, useState } from 'preact/hooks';
import type { Request } from '../../../../src/core/model';
import { CODE_LANGUAGES } from '../../../../src/view/code-languages';
import { CodeViewer } from './CodeViewer';
import { codeResult, type HostPort } from './store';

/**
 * The request written as code that sends it: the request as it would be sent now, in a language, with the secrets left out (the extension makes
 * the code; this only asks for it again whenever the request or the language changes, and shows it).
 */
export function CodeTab(props: { request: Request; port: HostPort }) {
  const [language, setLanguage] = useState('curl');
  const snapshot = JSON.stringify(props.request);
  useEffect(() => {
    const timer = setTimeout(() => props.port.post({ type: 'code', language }), 120);
    return () => clearTimeout(timer);
  }, [language, snapshot]);
  const written = codeResult.value;
  const shown = written !== undefined && written.language === language ? written : undefined;
  const choice = CODE_LANGUAGES.find(item => item.id === language);
  return (
    <div class="code-tab">
      <div class="tools">
        <label class="field inline">
          <span class="field-label">Language</span>
          <select aria-label="Language of the code" value={language} onChange={event => setLanguage((event.target as HTMLSelectElement).value)}>
            {CODE_LANGUAGES.map(item => <option value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <button type="button" class="link" disabled={shown === undefined || shown.text === ''} onClick={() => props.port.post({ type: 'copyCode' })}>Copy</button>
      </div>
      {(shown?.notes ?? []).map(note => <p class="hint">{note}</p>)}
      {shown === undefined ? <p class="hint">Writing the code...</p> : shown.text === '' ? null : <CodeViewer text={shown.text} language={choice?.highlight ?? 'text'} label={`Code in ${choice?.label ?? language}`} wrap={false} />}
    </div>
  );
}
