import type { Scripts } from '../../../../src/core/model';
import type { ScriptReport } from '../../../../src/view/scripts';
import { CodeEditor } from './CodeEditor';
import { edit, flushNow } from './store';

/** The scripts of a request, a folder or a collection, and what the scripts of a send wrote. */

export function ScriptsHelp() {
  return (
    <details class="help">
      <summary>What a script can do</summary>
      <p>Scripts are JavaScript in the style of Postman: <code>pm.environment.set('token', value)</code>, <code>pm.variables.get('host')</code>, <code>pm.request.headers.add({'{'} key, value {'}'})</code> (before the request), <code>pm.response.json()</code> and <code>pm.test('name', () =&gt; {'{'} pm.expect(pm.response.code).to.equal(200) {'}'})</code> (after the answer), <code>pm.sendRequest(...)</code>, <code>console.log(...)</code>.</p>
      <p>They run on this computer in a closed engine: no files, no network except <code>pm.sendRequest</code>, 1 second of computing and 10 seconds in all. What they set is kept until VS Code is closed and is never written into your files.</p>
      <p>A script can read all your variables, secrets included, and send them anywhere, so the first time scripts of a collection are about to run you are asked, and asked again when a script changes. Scripts of a folder or a collection run before those of the request.</p>
    </details>
  );
}

/** The two scripts of one request, folder or collection. */
export function ScriptsForm(props: { scripts: Scripts; what: 'request' | 'folder' | 'collection' }) {
  const where = props.what === 'request' ? 'this request' : `every request in the ${props.what}`;
  return (
    <div class="form wide-form">
      <div class="editor-box">
        <span class="field-label">Before the request is sent</span>
        <span class="hint">Runs for {where}, and can set variables and change the request that is sent.</span>
        <CodeEditor value={props.scripts.pre} language="js" label="Script before the request" placeholder="pm.environment.set('stamp', Date.now());" onChange={value => edit({ op: 'set', path: ['scripts', 'pre'], value })} onBlur={flushNow} />
      </div>
      <div class="editor-box">
        <span class="field-label">After the answer has come</span>
        <span class="hint">Runs for {where}, and can save variables and write tests with <code>pm.test</code>.</span>
        <CodeEditor value={props.scripts.post} language="js" label="Script after the answer" placeholder="pm.test('is ok', () => pm.expect(pm.response.code).to.equal(200));" onChange={value => edit({ op: 'set', path: ['scripts', 'post'], value })} onBlur={flushNow} />
      </div>
      <ScriptsHelp />
    </div>
  );
}

const STAGE = { pre: 'before the request', post: 'after the answer' } as const;

/** What the scripts of a send wrote to the console, what went wrong in them, and what was said about them as a whole. */
export function ScriptConsole(props: { report: ScriptReport }) {
  const { report } = props;
  const empty = report.logs.length === 0 && report.errors.length === 0 && report.notes.length === 0;
  return (
    <div class="console" aria-label="Console of the scripts">
      {report.notes.map(note => <p class="hint">{note}</p>)}
      {report.errors.map(error => <p class="log error" role="alert"><strong>{error.name}</strong> in the script {STAGE[error.phase]}{error.from === '' ? '' : ` (${error.from})`}: {error.message}</p>)}
      {report.skipped ? <p class="hint">A script asked not to send this request.</p> : null}
      {report.logs.length > 0 ? (
        <pre class="plain log-list" aria-label="Console output">{report.logs.map(entry => <span class={`log ${entry.level}`}>{entry.level === 'log' ? '' : `${entry.level}: `}{entry.text}{'\n'}</span>)}</pre>
      ) : null}
      {empty ? <p class="hint">The scripts wrote nothing to the console.</p> : null}
    </div>
  );
}
