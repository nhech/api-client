import { parseAssertion, parseCapture } from '../../../../src/core/assert';
import type { Assertion, Capture } from '../../../../src/core/model';
import { ExpressionList, type Suggestion } from './Expressions';

const TEST_SUGGESTIONS: readonly Suggestion[] = [
  { label: 'Status is 200', expr: 'status == 200' },
  { label: 'Body is JSON', expr: 'body isJson' },
  { label: 'Responds in under 500 ms', expr: 'duration < 500' },
  { label: 'A field exists', expr: 'json $.id exists' },
  { label: 'Content type is JSON', expr: 'header content-type includes json' }
];
const CAPTURE_SUGGESTIONS: readonly Suggestion[] = [
  { label: 'Save a field', expr: 'token = json $.access_token' },
  { label: 'Save a header', expr: 'etag = header etag' }
];

export const checkTest = (expr: string): string | undefined => { const parsed = parseAssertion(expr); return parsed.ok ? undefined : parsed.error; };
export const checkCapture = (expr: string): string | undefined => { const parsed = parseCapture(expr); return parsed.ok ? undefined : parsed.error; };

export function TestsHelp() {
  return (
    <details class="help">
      <summary>How to write a test</summary>
      <p>One line each, with a subject, an operator and a value:</p>
      <ul>
        <li><code>status == 200</code>, <code>duration &lt; 500</code> (milliseconds)</li>
        <li><code>header content-type includes json</code>, <code>header x-id exists</code></li>
        <li><code>body includes ok</code>, <code>body isJson</code>, <code>body matches /^ok/i</code></li>
        <li><code>json $.id == 7</code>, <code>json $.items count &gt;= 1</code>, <code>json $.name startsWith R</code>, <code>json $.tags isArray</code></li>
      </ul>
      <p>Operators: <code>==</code> <code>!=</code> <code>&lt;</code> <code>&lt;=</code> <code>&gt;</code> <code>&gt;=</code> <code>includes</code> <code>excludes</code> <code>startsWith</code> <code>endsWith</code> <code>matches</code> <code>exists</code> <code>notExists</code> <code>isNumber</code> <code>isString</code> <code>isBoolean</code> <code>isArray</code> <code>isJson</code> <code>count</code>. A value can use {'{{variables}}'}.</p>
      <p>To save a value for the next requests: <code>token = json $.access_token</code>, <code>etag = header etag</code>, <code>sid = cookie sid</code>, <code>whole = body</code>. Saved values live until VS Code is closed; they are never written into your files.</p>
    </details>
  );
}

/** The tests and the captures of a request. */
export function TestsForm(props: { tests: readonly Assertion[]; captures: readonly Capture[] }) {
  return (
    <div class="form wide-form">
      <h3>Tests</h3>
      <p class="hint">Checked after every send; the folders and the collection above can have tests of their own.</p>
      <ExpressionList rows={props.tests} path={['tests']} label="Test" placeholder="status == 200" check={checkTest} suggestions={TEST_SUGGESTIONS} />
      <h3>Save from the response</h3>
      <p class="hint">Each line saves a value of the response in a variable that the next requests can use as {'{{name}}'}.</p>
      <ExpressionList rows={props.captures} path={['captures']} label="Capture" placeholder="token = json $.access_token" check={checkCapture} suggestions={CAPTURE_SUGGESTIONS} />
      <TestsHelp />
    </div>
  );
}
