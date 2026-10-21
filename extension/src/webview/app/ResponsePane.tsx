import { useEffect, useState } from 'preact/hooks';
import { formatDuration, formatSize, type BodyView, type ResponseView } from '../../../../src/view/response';
import type { Language } from './CodeEditor';
import { CodeViewer } from './CodeViewer';
import { Tabs, type TabSpec } from './components';
import { ImageView } from './ImageView';
import { ScriptConsole } from './Scripts';
import { failure, response, sending, type HostPort } from './store';

/** The answer to a request: the status line, the body, the headers, the cookies, what was sent, and where the time went. */

const statusClass = (status: number): string => `status-${Math.floor(status / 100)}xx`;
const viewerLanguage = (language: BodyView['language']): Language => (language === 'json' ? 'json' : language === 'xml' ? 'xml' : language === 'javascript' ? 'js' : 'text');

function Elapsed(props: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  return <span>{formatDuration(Math.max(0, now - props.since))}</span>;
}

function Table(props: { head: string[]; rows: string[][]; label: string; empty: string }) {
  if (props.rows.length === 0) return <p class="hint">{props.empty}</p>;
  return (
    <table class="data" aria-label={props.label}>
      <thead><tr>{props.head.map(name => <th scope="col">{name}</th>)}</tr></thead>
      <tbody>{props.rows.map(row => <tr>{row.map((cell, index) => <td class={index === 0 ? 'key' : 'cell'}>{cell}</td>)}</tr>)}</tbody>
    </table>
  );
}

function BodyPane(props: { body: BodyView; truncated: boolean; port: HostPort }) {
  const body = props.body;
  const [pretty, setPretty] = useState(true);
  const [wrap, setWrap] = useState(true);
  if (body.kind === 'empty') return <p class="hint">The response has no body.</p>;
  if (body.kind === 'image') {
    return (
      <>
        <div class="tools"><button type="button" class="link" onClick={() => props.port.post({ type: 'saveResponse' })}>Save</button></div>
        <ImageView source={body.image ?? ''} />
      </>
    );
  }
  if (body.kind === 'binary') {
    return (
      <>
        <div class="banner info" role="status"><span>This is not text ({formatSize(body.size)}{body.mediaType === '' ? '' : `, ${body.mediaType}`}). The first bytes are shown.</span><button type="button" class="link" onClick={() => props.port.post({ type: 'saveResponse' })}>Save</button></div>
        <pre class="hex" aria-label="The first bytes of the body">{body.hex}</pre>
      </>
    );
  }
  const showPretty = pretty && body.pretty !== undefined;
  const shown = showPretty ? (body.pretty as string) : body.raw;
  return (
    <>
      <div class="tools">
        {body.pretty !== undefined ? (
          <span class="segmented" role="group" aria-label="Layout of the body">
            <button type="button" aria-pressed={showPretty} onClick={() => setPretty(true)}>Pretty</button>
            <button type="button" aria-pressed={!showPretty} onClick={() => setPretty(false)}>Raw</button>
          </span>
        ) : null}
        <button type="button" class="link" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>{wrap ? 'No wrap' : 'Wrap lines'}</button>
        <button type="button" class="link" onClick={() => props.port.post({ type: 'copyResponse', pretty: showPretty })}>Copy</button>
        <button type="button" class="link" onClick={() => props.port.post({ type: 'openResponse' })}>Open in editor</button>
        <button type="button" class="link" onClick={() => props.port.post({ type: 'saveResponse' })}>Save</button>
      </div>
      {body.cut || props.truncated ? <div class="banner warning" role="status"><span>{props.truncated ? `The response was cut at the size limit of the settings; ${formatSize(body.size)} were kept.` : `Only the beginning of the body is shown (${formatSize(body.size)} in all). Open it in an editor or save it to see all of it.`}</span></div> : null}
      <CodeViewer text={shown} language={viewerLanguage(body.language)} label="Body of the response" wrap={wrap} />
    </>
  );
}

const PHASES: { key: 'dnsMs' | 'connectMs' | 'tlsMs' | 'ttfbMs' | 'downloadMs'; label: string; color: string }[] = [
  { key: 'dnsMs', label: 'Name lookup', color: 'var(--vscode-charts-purple)' },
  { key: 'connectMs', label: 'Connection', color: 'var(--vscode-charts-blue)' },
  { key: 'tlsMs', label: 'TLS handshake', color: 'var(--vscode-charts-yellow)' },
  { key: 'ttfbMs', label: 'Waiting for the server', color: 'var(--vscode-charts-orange)' },
  { key: 'downloadMs', label: 'Download', color: 'var(--vscode-charts-green)' }
];

function Timeline(props: { view: ResponseView }) {
  const { timings, tls, redirects } = props.view;
  const total = Math.max(timings.totalMs, 1);
  return (
    <div class="timeline">
      <div class="bars" role="img" aria-label={`Total ${formatDuration(timings.totalMs)}`}>
        {PHASES.filter(phase => timings[phase.key] > 0).map(phase => <span class="bar-part" style={`width:${Math.max(1, (timings[phase.key] / total) * 100)}%;background:${phase.color}`} title={`${phase.label}: ${formatDuration(timings[phase.key])}`} />)}
      </div>
      <table class="data" aria-label="Time by phase">
        <tbody>
          {PHASES.map(phase => <tr><td class="key"><span class="swatch" style={`background:${phase.color}`} />{phase.label}</td><td class="cell">{formatDuration(timings[phase.key])}</td></tr>)}
          <tr><td class="key">Total</td><td class="cell">{formatDuration(timings.totalMs)}</td></tr>
        </tbody>
      </table>
      {redirects.length > 0 ? <><h3>Redirects</h3><Table head={['Status', 'From']} rows={redirects.map(hop => [String(hop.status), hop.url])} label="Redirects" empty="" /><p class="hint">The final address is {props.view.finalUrl}</p></> : null}
      {tls !== undefined ? (
        <>
          <h3>Connection security</h3>
          <Table head={['Property', 'Value']} label="TLS" empty="" rows={[
            ['Protocol', `${tls.protocol}${tls.cipher === '' ? '' : `, ${tls.cipher}`}`],
            ['Certificate', tls.authorized ? 'Trusted' : `Not trusted${tls.authorizationError === undefined ? '' : `: ${tls.authorizationError}`}`],
            ...(tls.subject === undefined ? [] : [['Subject', tls.subject]]), ...(tls.issuer === undefined ? [] : [['Issuer', tls.issuer]]), ...(tls.validTo === undefined ? [] : [['Valid until', tls.validTo]])
          ]} />
        </>
      ) : null}
    </div>
  );
}

function SentPane(props: { view: ResponseView }) {
  const { sent } = props.view;
  return (
    <div class="sent">
      <p class="request-line"><strong>{sent.method}</strong> {sent.url}</p>
      <Table head={['Header', 'Value']} rows={sent.headers} label="Headers sent" empty="No headers were sent." />
      {sent.body !== '' ? <><h3>Body</h3><pre class="plain" aria-label="Body sent">{sent.body}</pre></> : null}
      <p class="hint">Passwords, tokens and the values of secret variables are hidden here.</p>
    </div>
  );
}

/** The tests of the request and of the scripts together: how many ran and how many passed (a test a script skipped is neither). */
export function countTests(view: ResponseView): { total: number; passed: number } {
  const scripted = (view.scripts?.tests ?? []).filter(test => !test.skipped);
  return { total: view.tests.length + scripted.length, passed: view.tests.filter(test => test.ok).length + scripted.filter(test => test.passed).length };
}

function TestsPane(props: { view: ResponseView }) {
  const { tests } = props.view;
  const scripted = props.view.scripts?.tests ?? [];
  const saved = [...props.view.saved, ...(props.view.scripts?.saved ?? [])];
  const { total, passed } = countTests(props.view);
  return (
    <>
      {total === 0 && scripted.length === 0 ? <p class="hint">This request has no tests. Add some in the Tests tab of the request.</p> : (
        <>
          <p class="status-line" role="status"><strong class={passed === total ? 'result-pass' : 'result-fail'}>{passed} of {total} passed</strong></p>
          <table class="data" aria-label="Test results">
            <thead><tr><th scope="col">Result</th><th scope="col">Test</th><th scope="col">From</th><th scope="col">Details</th></tr></thead>
            <tbody>
              {tests.map(test => <tr><td class={test.ok ? 'result-pass nowrap' : 'result-fail nowrap'}>{test.ok ? 'Passed' : 'Failed'}</td><td class="cell">{test.expr}</td><td class="nowrap">{test.from}</td><td>{test.message}</td></tr>)}
              {scripted.map(test => <tr><td class={test.skipped ? 'nowrap' : test.passed ? 'result-pass nowrap' : 'result-fail nowrap'}>{test.skipped ? 'Skipped' : test.passed ? 'Passed' : 'Failed'}</td><td class="cell">{test.name}</td><td class="nowrap">script {test.phase === 'pre' ? 'before' : 'after'}</td><td>{test.skipped ? '' : test.message}</td></tr>)}
            </tbody>
          </table>
        </>
      )}
      {saved.length > 0 ? (
        <>
          <h3>Saved variables</h3>
          <table class="data" aria-label="Saved variables">
            <thead><tr><th scope="col">Result</th><th scope="col">Variable</th><th scope="col">Value</th></tr></thead>
            <tbody>{saved.map(item => (
              <tr>
                <td class={item.ok ? 'result-pass nowrap' : 'result-fail nowrap'}>{item.ok ? (item.action === 'delete' ? 'Removed' : 'Saved') : 'Not saved'}</td>
                <td class="cell">{item.variable === '' ? item.expr : item.variable}{item.scope === 'active' ? '' : ` (${item.scope})`}</td>
                <td class="cell">{!item.ok ? item.message : item.action === 'delete' ? '' : item.secret ? '(a secret: not shown)' : item.value}</td>
              </tr>
            ))}</tbody>
          </table>
        </>
      ) : null}
    </>
  );
}

function Answer(props: { view: ResponseView; port: HostPort }) {
  const [tab, setTab] = useState('body');
  const view = props.view;
  const { total, passed } = countTests(view);
  const report = view.scripts;
  const hasTests = total > 0 || view.saved.length > 0 || (report?.tests.length ?? 0) > 0 || (report?.saved.length ?? 0) > 0;
  const hasConsole = report !== undefined && (report.logs.length > 0 || report.errors.length > 0 || report.skipped);
  const tabs: TabSpec[] = [
    { id: 'body', label: 'Body' }, { id: 'headers', label: 'Headers', badge: String(view.headers.length) }, { id: 'cookies', label: 'Cookies', badge: view.cookies.length === 0 ? '' : String(view.cookies.length) },
    ...(hasTests ? [{ id: 'tests', label: 'Tests', badge: total === 0 ? '' : `${passed}/${total}` }] : []),
    ...(hasConsole ? [{ id: 'console', label: 'Console', badge: (report?.errors.length ?? 0) > 0 ? '!' : '' }] : []),
    { id: 'request', label: 'Request' }, { id: 'timeline', label: 'Timeline' }
  ];
  return (
    <>
      <p class="status-line" role="status">
        <strong class={statusClass(view.status)}>{view.status} {view.statusText}</strong>
        <span>{formatDuration(view.timings.totalMs)}</span>
        <span>{formatSize(view.size)}</span>
        <span class="muted">HTTP/{view.httpVersion}</span>
        {view.onDisk ? <span class="muted">kept in a file</span> : null}
        {total > 0 ? <span class={passed === total ? 'result-pass' : 'result-fail'}>{passed === total ? 'All' : `${passed} of`} {total} {total === 1 ? 'test' : 'tests'} passed</span> : null}
        {(report?.errors.length ?? 0) > 0 ? <span class="result-fail">{report?.errors.length} {report?.errors.length === 1 ? 'script failed' : 'scripts failed'}</span> : null}
      </p>
      {view.warnings.map(warning => <div class="banner warning" role="status"><span>{warning}</span></div>)}
      {(report?.notes ?? []).map(note => <div class="banner warning" role="status"><span>{note}</span></div>)}
      <Tabs tabs={tabs} active={tab} onSelect={setTab} label="Response">
        {tab === 'body' ? <BodyPane body={view.body} truncated={view.truncated} port={props.port} /> : null}
        {tab === 'headers' ? <Table head={['Name', 'Value']} rows={view.headers} label="Response headers" empty="The response has no headers." /> : null}
        {tab === 'cookies' ? <Table head={['Name', 'Value', 'Domain', 'Path', 'Expires', 'Flags']} label="Cookies set by the response" empty="The response sets no cookies."
          rows={view.cookies.map(cookie => [cookie.name, cookie.value, cookie.domain, cookie.path, cookie.expires, [cookie.secure ? 'Secure' : '', cookie.httpOnly ? 'HttpOnly' : '', cookie.sameSite === '' ? '' : `SameSite=${cookie.sameSite}`].filter(flag => flag !== '').join(' ')])} /> : null}
        {tab === 'tests' ? <TestsPane view={view} /> : null}
        {tab === 'console' && report !== undefined ? <ScriptConsole report={report} /> : null}
        {tab === 'request' ? <SentPane view={view} /> : null}
        {tab === 'timeline' ? <Timeline view={view} /> : null}
      </Tabs>
    </>
  );
}

export function ResponsePane(props: { port: HostPort }) {
  const waiting = sending.value;
  const failed = failure.value;
  const answer = response.value;
  return (
    <section class="response" aria-label="Response" aria-live="polite">
      {waiting !== undefined ? <p class="status-line"><strong>Sending...</strong><Elapsed since={waiting.since} /><button type="button" class="link" onClick={() => props.port.post({ type: 'cancel' })}>Cancel</button></p> : null}
      {failed !== undefined ? (
        <div class="failure" role="alert">
          <p><strong>{failed.message}</strong></p>
          {failed.hint !== '' ? <p>{failed.hint}</p> : null}
          {failed.warnings.map(warning => <p class="hint">{warning}</p>)}
          {failed.scripts !== undefined ? <ScriptConsole report={failed.scripts} /> : null}
        </div>
      ) : null}
      {answer !== undefined ? <Answer view={answer} port={props.port} /> : null}
      {waiting === undefined && failed === undefined && answer === undefined ? <p class="hint">Press Ctrl+Enter, or Send, to send the request. The response appears here.</p> : null}
    </section>
  );
}
