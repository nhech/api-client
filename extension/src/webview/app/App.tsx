import { useState } from 'preact/hooks';
import { BODY_KINDS, newBody, type Body, type BodyKind, type Part, type Request } from '../../../../src/core/model';
import { AuthEditor } from './AuthEditor';
import { CodeEditor } from './CodeEditor';
import { Choice, Field, KeyValueGrid, Tabs, type TabSpec } from './components';
import { defaultRequestTab } from '../../../../src/view/tabs';
import { DocumentPage } from './Pages';
import { ResponsePane } from './ResponsePane';
import { CodeTab } from './CodeTab';
import { ScriptsForm } from './Scripts';
import { SettingsForm } from './SettingsForm';
import { TestsForm } from './TestsForm';
import { confirmed, edit, flushNow, notice, request, screen, sending, sendNow, type HostPort } from './store';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

const BODY_LABELS: Record<BodyKind, string> = { none: 'None', text: 'Text', json: 'JSON', xml: 'XML', form: 'Form (urlencoded)', multipart: 'Form (multipart)', graphql: 'GraphQL', binary: 'Binary file' };

function Method(props: { value: string }) {
  const options = METHODS.includes(props.value.toUpperCase() as (typeof METHODS)[number]) ? METHODS : [props.value, ...METHODS];
  return (
    <select class="method" aria-label="Method" value={props.value} onChange={event => edit({ op: 'set', path: ['method'], value: (event.target as HTMLSelectElement).value })}>
      {options.map(method => <option value={method}>{method}</option>)}
    </select>
  );
}

const PART_KINDS = [{ value: 'text', label: 'Text' }, { value: 'file', label: 'File' }] as const;

function PartsGrid(props: { parts: readonly Part[] }) {
  const set = (index: number, key: keyof Part, value: string | boolean): void => edit({ op: 'set', path: ['body', 'parts', index, key], value });
  return (
    <div class="grid" role="group" aria-label="Form parts">
      {props.parts.map((part, index) => (
        <div class={part.enabled ? 'grid-row part' : 'grid-row part off'} key={index}>
          <input type="checkbox" aria-label={`Enable part ${index + 1}`} checked={part.enabled} onChange={event => set(index, 'enabled', (event.target as HTMLInputElement).checked)} />
          <input class="name" aria-label={`Name of part ${index + 1}`} placeholder="Name" value={part.name} spellcheck={false} onInput={event => set(index, 'name', (event.target as HTMLInputElement).value)} />
          <select aria-label={`Kind of part ${index + 1}`} value={part.kind} onChange={event => set(index, 'kind', (event.target as HTMLSelectElement).value)}>{PART_KINDS.map(kind => <option value={kind.value}>{kind.label}</option>)}</select>
          <input class="value" aria-label={`${part.kind === 'file' ? 'File' : 'Value'} of part ${index + 1}`} placeholder={part.kind === 'file' ? 'Path of the file, from the collection folder' : 'Value'} value={part.kind === 'file' ? part.file : part.value} spellcheck={false} onInput={event => set(index, part.kind === 'file' ? 'file' : 'value', (event.target as HTMLInputElement).value)} />
          <input class="type" aria-label={`Content type of part ${index + 1}`} placeholder="Content type" value={part.contentType} spellcheck={false} onInput={event => set(index, 'contentType', (event.target as HTMLInputElement).value)} />
          <button type="button" class="icon" aria-label={`Delete part ${index + 1}`} title="Delete" onClick={() => edit({ op: 'remove', path: ['body', 'parts'], index })}>&times;</button>
        </div>
      ))}
      <button type="button" class="link" onClick={() => edit({ op: 'insert', path: ['body', 'parts'], index: props.parts.length, value: { name: '', kind: 'text', value: '', file: '', contentType: '', enabled: true } as never })}>Add a part</button>
    </div>
  );
}

function prettyJson(text: string): string | undefined {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return undefined; }
}

function BodyTab(props: { body: Body; send: () => void }) {
  const body = props.body;
  return (
    <div class="form">
      <Choice label="Type" value={body.kind} options={BODY_KINDS.map(kind => ({ value: kind, label: BODY_LABELS[kind] }))} onChange={kind => edit({ op: 'set', path: ['body'], value: newBody(kind) as never })} />
      {body.kind === 'none' ? <p class="hint">This request has no body.</p> : null}
      {body.kind === 'text' ? <Field label="Content type" value={body.contentType} path={['body', 'contentType']} placeholder="text/plain" /> : null}
      {body.kind === 'text' || body.kind === 'json' || body.kind === 'xml' ? (
        <div class="editor-box">
          {body.kind === 'json' ? <div class="editor-tools"><button type="button" class="link" onClick={() => { const pretty = prettyJson(body.text); if (pretty !== undefined) edit({ op: 'set', path: ['body', 'text'], value: pretty }); else notice.value = 'The JSON cannot be formatted until it is valid.'; }}>Format</button></div> : null}
          <CodeEditor value={body.text} language={body.kind === 'json' ? 'json' : body.kind === 'xml' ? 'xml' : 'text'} label="Body" onChange={value => edit({ op: 'set', path: ['body', 'text'], value })} onSubmit={props.send} onBlur={flushNow} />
        </div>
      ) : null}
      {body.kind === 'form' ? <KeyValueGrid rows={body.fields} path={['body', 'fields']} label="Form fields" /> : null}
      {body.kind === 'multipart' ? <PartsGrid parts={body.parts} /> : null}
      {body.kind === 'graphql' ? (
        <>
          <div class="editor-box"><span class="field-label">Query</span><CodeEditor value={body.query} label="GraphQL query" onChange={value => edit({ op: 'set', path: ['body', 'query'], value })} onSubmit={props.send} onBlur={flushNow} /></div>
          <div class="editor-box"><span class="field-label">Variables (JSON)</span><CodeEditor value={body.variables} language="json" label="GraphQL variables" onChange={value => edit({ op: 'set', path: ['body', 'variables'], value })} onSubmit={props.send} onBlur={flushNow} /></div>
        </>
      ) : null}
      {body.kind === 'binary' ? <Field label="File" value={body.file} path={['body', 'file']} placeholder="Path of the file, from the collection folder" wide /> : null}
    </div>
  );
}

const countRows = (rows: readonly { enabled: boolean; name: string }[]): string => {
  const active = rows.filter(row => row.enabled && row.name !== '').length;
  return active === 0 ? '' : String(active);
};

function Editor(props: { request: Request; port: HostPort }) {
  const [tab, setTab] = useState<string>(() => defaultRequestTab(props.request));
  const r = props.request;
  const send = (): void => sendNow();
  const running = sending.value !== undefined;
  const tabs: TabSpec[] = [
    { id: 'query', label: 'Query', badge: countRows(r.query) }, { id: 'headers', label: 'Headers', badge: countRows(r.headers) }, { id: 'auth', label: 'Auth', badge: r.auth.kind === 'inherit' || r.auth.kind === 'none' ? '' : '\u2022' },
    { id: 'body', label: 'Body', badge: r.body.kind === 'none' ? '' : '\u2022' }, { id: 'scripts', label: 'Scripts', badge: r.scripts.pre.trim() === '' && r.scripts.post.trim() === '' ? '' : '\u2022' }, { id: 'tests', label: 'Tests', badge: countRows(r.tests.map(row => ({ enabled: row.enabled, name: row.expr })).concat(r.captures.map(row => ({ enabled: row.enabled, name: row.expr })))) },
    { id: 'settings', label: 'Settings', badge: Object.keys(r.settings).length === 0 ? '' : String(Object.keys(r.settings).length) },
    { id: 'docs', label: 'Docs', badge: r.docs === '' ? '' : '\u2022' }, { id: 'code', label: 'Code' }
  ];
  return (
    <div class="request">
      <input class="title" aria-label="Name of the request" placeholder="Name of the request" value={r.name} spellcheck={false}
        onInput={event => { const value = (event.target as HTMLInputElement).value; if (value.trim() !== '') edit({ op: 'set', path: ['name'], value }); }}
        onBlur={event => { (event.target as HTMLInputElement).value = r.name; flushNow(); }} />
      <div class="bar">
        <Method value={r.method} />
        <CodeEditor value={r.url} oneLine label="Address" placeholder="https://example.com/path or {{baseUrl}}/path" onChange={value => edit({ op: 'set', path: ['url'], value })} onSubmit={send} onBlur={flushNow} />
        {running ? <button type="button" class="send cancel" onClick={() => props.port.post({ type: 'cancel' })}>Cancel</button> : <button type="button" class="send" onClick={send}>Send</button>}
      </div>
      <div class="panes">
      <Tabs tabs={tabs} active={tab} onSelect={setTab} label="Request">
        {tab === 'query' ? <><KeyValueGrid rows={r.query} path={['query']} label="Query parameters" namePlaceholder="Parameter" />{r.pathParams.length > 0 ? <><h3>Path parameters</h3><KeyValueGrid rows={r.pathParams} path={['pathParams']} label="Path parameters" /></> : null}</> : null}
        {tab === 'headers' ? <KeyValueGrid rows={r.headers} path={['headers']} label="Headers" namePlaceholder="Header" /> : null}
        {tab === 'auth' ? <AuthEditor auth={r.auth} what="request" port={props.port} /> : null}
        {tab === 'body' ? <BodyTab body={r.body} send={send} /> : null}
        {tab === 'scripts' ? <ScriptsForm scripts={r.scripts} what="request" /> : null}
        {tab === 'tests' ? <TestsForm tests={r.tests} captures={r.captures} /> : null}
        {tab === 'settings' ? (
          <>
            <label class="check"><input type="checkbox" checked={r.mirror} onChange={event => edit({ op: 'set', path: ['mirror'], value: (event.target as HTMLInputElement).checked })} /><span>Write a .http file next to this request</span></label>
            <p class="hint">For REST Client, JetBrains and httpYac, and for reading in a pull request. The file is made from this request: edit the request, not the file.</p>
            <SettingsForm settings={r.settings} path={['settings']} what="request" />
          </>
        ) : null}
        {tab === 'code' ? <CodeTab request={r} port={props.port} /> : null}
        {tab === 'docs' ? <div class="editor-box"><CodeEditor value={r.docs} language="text" label="Notes on this request" placeholder="Notes for yourself and your team" onChange={value => edit({ op: 'set', path: ['docs'], value })} onBlur={flushNow} /></div> : null}
      </Tabs>
      <ResponsePane port={props.port} />
      </div>
    </div>
  );
}

export function App(props: { port: HostPort }) {
  if (screen !== 'request') return <DocumentPage port={props.port} />;
  const state = confirmed.value;
  const current = request.value;
  if (state === undefined || current === undefined) return <p class="loading">Loading...</p>;
  return (
    <>
      {notice.value !== undefined ? <div class="banner warning" role="alert"><span>{notice.value}</span><button type="button" class="link" onClick={() => { notice.value = undefined; }}>Dismiss</button></div> : null}
      {state.readOnly !== undefined ? <div class="banner error" role="alert"><span>{state.readOnly}</span><button type="button" class="link" onClick={() => props.port.post({ type: 'openAsText' })}>Open as text</button></div> : null}
      {state.findings.filter(finding => finding.severity === 'warning').map(finding => <div class="banner info" role="status"><span>{finding.path === '' ? '' : `${finding.path}: `}{finding.message}</span></div>)}
      <Editor request={current} port={props.port} />
    </>
  );
}
