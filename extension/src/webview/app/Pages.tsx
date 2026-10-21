import { useState } from 'preact/hooks';
import type { Container, Environment } from '../../../../src/core/model';
import type { Finding } from '../../../../src/format/schema';
import { AuthEditor } from './AuthEditor';
import { CodeEditor } from './CodeEditor';
import { KeyValueGrid, Tabs, type TabSpec } from './components';
import { SettingsForm } from './SettingsForm';
import { ExpressionList } from './Expressions';
import { checkTest, TestsHelp } from './TestsForm';
import { documentState, edit, flushNow, notice, working, type HostPort } from './store';
import { VarsGrid } from './Variables';

/** The editors of an environment and of a collection or folder. */

export function Banners(props: { readOnly: string | undefined; findings: readonly Finding[]; port: HostPort }) {
  return (
    <>
      {notice.value !== undefined ? <div class="banner warning" role="alert"><span>{notice.value}</span><button type="button" class="link" onClick={() => { notice.value = undefined; }}>Dismiss</button></div> : null}
      {props.readOnly !== undefined ? <div class="banner error" role="alert"><span>{props.readOnly}</span><button type="button" class="link" onClick={() => props.port.post({ type: 'openAsText' })}>Open as text</button></div> : null}
      {props.findings.filter(finding => finding.severity === 'warning').map(finding => <div class="banner info" role="status"><span>{finding.path === '' ? '' : `${finding.path}: `}{finding.message}</span></div>)}
    </>
  );
}

function NameField(props: { name: string; label: string }) {
  return (
    <input class="title" aria-label={props.label} placeholder={props.label} value={props.name} spellcheck={false}
      onInput={event => { const value = (event.target as HTMLInputElement).value; if (value.trim() !== '') edit({ op: 'set', path: ['name'], value }); }}
      onBlur={event => { (event.target as HTMLInputElement).value = props.name; flushNow(); }} />
  );
}

const countRows = (rows: readonly { enabled: boolean; name: string }[]): string => {
  const active = rows.filter(row => row.enabled && row.name !== '').length;
  return active === 0 ? '' : String(active);
};

function EnvironmentPage(props: { environment: Environment; active: boolean; readOnly: boolean; port: HostPort }) {
  const [reveal, setReveal] = useState(false);
  const { environment } = props;
  const hasSecrets = environment.vars.some(variable => variable.secret);
  return (
    <div class="page">
      <NameField name={environment.name} label="Name of the environment" />
      <p class="status-line">
        {props.active ? <strong class="status-2xx">The active environment</strong> : <button type="button" class="send" disabled={props.readOnly} onClick={() => props.port.post({ type: 'activate' })}>Use this environment</button>}
        <span class="muted">{props.active ? 'Its variables are used when a request is sent.' : 'Its variables are used when a request is sent, once it is the active one.'}</span>
      </p>
      <h3>Variables</h3>
      <p class="hint">Write {'{{name}}'} in an address, a header or a body to use one. A variable in a folder or a collection beats one of the same name here.</p>
      <VarsGrid rows={environment.vars} path={['vars']} reveal={reveal} />
      {hasSecrets ? (
        <>
          <label class="check"><input type="checkbox" checked={reveal} onChange={event => setReveal((event.target as HTMLInputElement).checked)} /><span>Show the values of secret variables</span></label>
          <p class="hint">The value of a secret variable is kept on this computer only, in a file next to this one that Git ignores, so nobody gets it from the repository.</p>
        </>
      ) : <p class="hint">Mark a variable as secret (a token, a password) and its value stays on this computer: it is kept in a file next to this one that Git ignores.</p>}
    </div>
  );
}

function ContainerPage(props: { container: Container; kind: 'collection' | 'folder'; port: HostPort }) {
  const [tab, setTab] = useState('general');
  const [reveal, setReveal] = useState(false);
  const c = props.container;
  const tabs: TabSpec[] = [
    { id: 'general', label: 'General' }, { id: 'headers', label: 'Headers', badge: countRows(c.headers) }, { id: 'auth', label: 'Auth', badge: c.auth.kind === 'inherit' || c.auth.kind === 'none' ? '' : '•' },
    { id: 'vars', label: 'Variables', badge: countRows(c.vars) }, { id: 'tests', label: 'Tests', badge: countRows(c.tests.map(row => ({ enabled: row.enabled, name: row.expr }))) }, { id: 'settings', label: 'Settings', badge: Object.keys(c.settings).length === 0 ? '' : String(Object.keys(c.settings).length) }
  ];
  const where = props.kind === 'collection' ? 'the collection' : 'the folder';
  return (
    <div class="page">
      <NameField name={c.name} label={`Name of the ${props.kind}`} />
      <p class="hint">What is set here applies to every request in {where}, unless a request or a folder below sets its own.</p>
      <Tabs tabs={tabs} active={tab} onSelect={setTab} label="Settings of the collection or folder">
        {tab === 'general' ? (
          <div class="form">
            <label class="field wide">
              <span class="field-label">Base URL</span>
              <input type="text" placeholder="https://api.example.com or {{baseUrl}}" value={c.baseUrl} spellcheck={false} onInput={event => edit({ op: 'set', path: ['baseUrl'], value: (event.target as HTMLInputElement).value })} onBlur={flushNow} />
              <span class="hint">Put in front of the address of a request that does not start with http:// or https://.</span>
            </label>
            <div class="editor-box"><span class="field-label">Notes</span><CodeEditor value={c.docs} language="text" label={`Notes on the ${props.kind}`} placeholder="Notes for yourself and your team" onChange={value => edit({ op: 'set', path: ['docs'], value })} onBlur={flushNow} /></div>
          </div>
        ) : null}
        {tab === 'headers' ? <><p class="hint">Sent with every request below; a request can replace one by using the same name.</p><KeyValueGrid rows={c.headers} path={['headers']} label="Headers" namePlaceholder="Header" /></> : null}
        {tab === 'auth' ? <AuthEditor auth={c.auth} what={props.kind} /> : null}
        {tab === 'vars' ? (
          <>
            <p class="hint">Available to every request in {where}, and beating the variables of the active environment.</p>
            <VarsGrid rows={c.vars} path={['vars']} reveal={reveal} />
            {c.vars.some(variable => variable.secret) ? <label class="check"><input type="checkbox" checked={reveal} onChange={event => setReveal((event.target as HTMLInputElement).checked)} /><span>Show the values of secret variables</span></label> : null}
          </>
        ) : null}
        {tab === 'tests' ? (
          <>
            <p class="hint">Checked after every request in {where}, together with the tests of the request itself.</p>
            <ExpressionList rows={c.tests} path={['tests']} label="Test" placeholder="status < 500" check={checkTest} suggestions={[{ label: 'Status is not an error', expr: 'status < 400' }, { label: 'Responds in under 2 s', expr: 'duration < 2000' }]} />
            <TestsHelp />
          </>
        ) : null}
        {tab === 'settings' ? <SettingsForm settings={c.settings} path={['settings']} what={props.kind} /> : null}
      </Tabs>
    </div>
  );
}

/** The editor of an environment or of a collection or folder, whichever the extension gave this page. */
export function DocumentPage(props: { port: HostPort }) {
  const state = documentState.value;
  const model = working.value;
  if (state === undefined || model === undefined) return <p class="loading">Loading...</p>;
  return (
    <>
      <Banners readOnly={state.readOnly} findings={state.findings} port={props.port} />
      {state.screen === 'environment'
        ? <EnvironmentPage environment={model as Environment} active={state.active} readOnly={state.readOnly !== undefined} port={props.port} />
        : <ContainerPage container={model as Container} kind={state.kind} port={props.port} />}
    </>
  );
}
