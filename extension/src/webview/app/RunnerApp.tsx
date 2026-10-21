import { useState } from 'preact/hooks';
import { formatDuration, formatSize } from '../../../../src/view/response';
import type { ResultView, SummaryView } from '../../../../src/view/runner-protocol';
import { data, dataError, dropped, info, passes, problem, results, running, summary, type RunnerPort } from './runnerStore';

/** The page of the collection runner: what to run and how, the results as they come, and the report. */

const STATUS_TEXT: Record<ResultView['status'], string> = { passed: 'Passed', failed: 'Failed', error: 'Error', skipped: 'Skipped' };
const STATUS_CLASS: Record<ResultView['status'], string> = { passed: 'result-pass nowrap', failed: 'result-fail nowrap', error: 'result-fail nowrap', skipped: 'nowrap' };

const STOP_TEXT: Record<SummaryView['stopped'], string> = {
  finished: 'The run is finished.', cancelled: 'The run was stopped.', failure: 'The run stopped at the first failure.', limit: 'The run stopped at its limit of requests: a script keeps sending it back.'
};

function Config(props: { port: RunnerPort }) {
  const [iterations, setIterations] = useState('1');
  const [delay, setDelay] = useState('0');
  const [stopOnFailure, setStopOnFailure] = useState(false);
  const file = data.value;
  const busy = running.value;
  const count = Number(iterations);
  const wait = Number(delay);
  const valid = Number.isInteger(count) && count >= 1 && count <= 1000 && Number.isInteger(wait) && wait >= 0 && wait <= 60000;
  return (
    <div class="form">
      <div class="field-row">
        <label class="field">
          <span class="field-label">Passes</span>
          <input type="number" min="1" max="1000" value={file === undefined ? iterations : String(file.rows)} disabled={busy || file !== undefined} aria-invalid={!valid} onInput={event => setIterations((event.target as HTMLInputElement).value)} />
          <span class="hint">{file === undefined ? 'How many times the requests are run, one after the other.' : 'The rows of the data file decide.'}</span>
        </label>
        <label class="field">
          <span class="field-label">Pause between requests (ms)</span>
          <input type="number" min="0" max="60000" value={delay} disabled={busy} aria-invalid={!valid} onInput={event => setDelay((event.target as HTMLInputElement).value)} />
        </label>
      </div>
      <label class="check"><input type="checkbox" checked={stopOnFailure} disabled={busy} onChange={event => setStopOnFailure((event.target as HTMLInputElement).checked)} /><span>Stop at the first failure</span></label>
      <div class="field">
        <span class="field-label">Data file</span>
        {file === undefined ? (
          <div class="tools"><button type="button" class="link" disabled={busy} onClick={() => props.port.post({ type: 'chooseData' })}>Choose a CSV or JSON file...</button><span class="hint">One row for each pass; its columns are variables for the requests and <code>pm.iterationData</code> for the scripts.</span></div>
        ) : (
          <div class="tools"><strong>{file.name}</strong><span class="muted">{file.rows} rows, columns {file.columns.join(', ')}</span><button type="button" class="link" disabled={busy} onClick={() => props.port.post({ type: 'clearData' })}>Remove</button></div>
        )}
        {dataError.value !== undefined ? <p class="hint warn" role="alert">{dataError.value}</p> : null}
        {(file?.warnings ?? []).map(warning => <p class="hint">{warning}</p>)}
      </div>
      <div class="tools">
        {busy
          ? <button type="button" class="send cancel" onClick={() => props.port.post({ type: 'stop' })}>Stop</button>
          : <button type="button" class="send" disabled={!valid} onClick={() => props.port.post({ type: 'start', config: { iterations: file === undefined ? count : 1, delayMs: wait, stopOnFailure } })}>Run</button>}
      </div>
    </div>
  );
}

function Details(props: { result: ResultView }) {
  const { result } = props;
  return (
    <tr class="detail">
      <td colSpan={7}>
        {result.error !== undefined ? <p class="log error" role="alert">{result.error}</p> : null}
        {result.tests.length > 0 ? (
          <table class="data" aria-label="Tests of this request">
            <thead><tr><th scope="col">Result</th><th scope="col">Test</th><th scope="col">From</th><th scope="col">Details</th></tr></thead>
            <tbody>{result.tests.map(test => <tr><td class={test.passed ? 'result-pass nowrap' : 'result-fail nowrap'}>{test.passed ? 'Passed' : 'Failed'}</td><td class="cell">{test.name}</td><td class="nowrap">{test.source === 'script' ? 'script' : 'request'}</td><td>{test.message}</td></tr>)}</tbody>
          </table>
        ) : result.error === undefined ? <p class="hint">This request has no tests.</p> : null}
        {result.notes.map(note => <p class="hint">{note}</p>)}
      </td>
    </tr>
  );
}

function Results() {
  const [open, setOpen] = useState<number | undefined>(undefined);
  const list = results.value;
  if (list.length === 0) return null;
  return (
    <>
      {dropped.value > 0 ? <p class="hint">The first {dropped.value} results are not listed here; the report has them all.</p> : null}
      <table class="data" aria-label="Results of the run">
        <thead><tr><th scope="col">#</th><th scope="col">Pass</th><th scope="col">Request</th><th scope="col">Result</th><th scope="col">Status</th><th scope="col">Time</th><th scope="col">Tests</th></tr></thead>
        <tbody>
          {list.map(result => {
            const passed = result.tests.filter(test => test.passed).length;
            return (
              <>
                <tr class="clickable" onClick={() => setOpen(open === result.index ? undefined : result.index)}>
                  <td class="nowrap">{result.index + 1}</td>
                  <td class="nowrap">{result.iteration + 1}</td>
                  <td class="cell"><button type="button" class="link" aria-expanded={open === result.index} onClick={event => { event.stopPropagation(); setOpen(open === result.index ? undefined : result.index); }}>{result.folder === '' ? '' : `${result.folder} / `}{result.name}</button> <span class="muted">{result.method}</span></td>
                  <td class={STATUS_CLASS[result.status]}>{STATUS_TEXT[result.status]}</td>
                  <td class="nowrap">{result.httpStatus === undefined ? '' : result.httpStatus}</td>
                  <td class="nowrap">{formatDuration(result.ms)}{result.size === undefined ? '' : `, ${formatSize(result.size)}`}</td>
                  <td class="nowrap">{result.tests.length === 0 ? '' : `${passed}/${result.tests.length}`}</td>
                </tr>
                {open === result.index ? <Details result={result} /> : null}
              </>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function Summary(props: { port: RunnerPort }) {
  const done = summary.value;
  if (done === undefined) return null;
  const bad = done.failed + done.errors;
  return (
    <div class="summary" role="status">
      <p class="status-line"><strong class={bad === 0 ? 'result-pass' : 'result-fail'}>{done.passed} of {done.requests} requests passed</strong><span>{done.failed} failed, {done.errors} with an error, {done.skipped} skipped</span><span>{done.testsPassed} of {done.testsPassed + done.testsFailed} tests passed</span><span class="muted">{formatDuration(done.ms)}</span></p>
      <p class="hint">{STOP_TEXT[done.stopped]}</p>
      <div class="tools"><button type="button" class="link" onClick={() => props.port.post({ type: 'save', format: 'json' })}>Save the report (JSON)</button><button type="button" class="link" onClick={() => props.port.post({ type: 'save', format: 'junit' })}>Save the report (JUnit XML)</button></div>
    </div>
  );
}

export function RunnerApp(props: { port: RunnerPort }) {
  const about = info.value;
  if (about === undefined && problem.value === undefined) return <p class="loading">Loading...</p>;
  const shown = results.value.length + dropped.value;
  return (
    <div class="page">
      {problem.value !== undefined ? <div class="banner error" role="alert"><span>{problem.value}</span></div> : null}
      {about !== undefined ? (
        <>
          <h2>Run {about.kind === 'collection' ? 'the collection' : 'the folder'} {about.name}</h2>
          <p class="hint">{about.requests} {about.requests === 1 ? 'request' : 'requests'} in the order of the side bar{about.environment === '' ? ', with no environment' : `, with the environment ${about.environment}`}. Scripts and tests run as when a request is sent alone.</p>
          <Config port={props.port} />
        </>
      ) : null}
      {running.value ? <p class="status-line" role="status"><strong>Running...</strong><span>{shown} {shown === 1 ? 'request' : 'requests'} done{passes.value > 1 ? `, ${passes.value} passes` : ''}</span></p> : null}
      <Summary port={props.port} />
      <Results />
    </div>
  );
}
