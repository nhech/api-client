import { isoTime } from '../core/vars';
import { printable } from '../util/chars';
import type { ItemResult, RunSummary } from './run';

/**
 * What a run is written down as: a JSON file (the whole of it, for a tool that reads it) and a JUnit XML file (for the systems that show tests).
 * Both are made from the summary alone, with the time it began given in, so the same run gives the same text. What a request answered is never in
 * them (no body, no header, no address with its query): only what ran, how it ended and what the tests said.
 */
export interface ReportContext {
  /** What was run: the name of the collection or folder. */
  name: string;
  /** The active environment, if any. */
  environment: string;
  /** The name of the tool and its version. */
  tool: string;
}

/** A text for XML: no character that XML cannot hold, and the five that mean something escaped. */
export function xmlText(text: string): string {
  return printable(text).replace(/[&<>"']/g, char => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '"' ? '&quot;' : '&apos;'));
}

export function toJson(summary: RunSummary, context: ReportContext): string {
  const body = {
    tool: context.tool,
    format: 1,
    name: printable(context.name),
    environment: printable(context.environment),
    startedAt: isoTime(summary.startedAt),
    durationMs: Math.round(summary.ms),
    stopped: summary.stopped,
    totals: {
      iterations: summary.iterations, requests: summary.requests, passed: summary.passed, failed: summary.failed, errors: summary.errors, skipped: summary.skipped,
      tests: summary.testsPassed + summary.testsFailed, testsPassed: summary.testsPassed, testsFailed: summary.testsFailed
    },
    results: summary.results.map(result => ({
      index: result.index, iteration: result.iteration, name: printable(result.item.name), folder: printable(result.item.folder), method: printable(result.item.method),
      status: result.status, httpStatus: result.httpStatus ?? null, durationMs: Math.round(result.ms), size: result.size ?? null,
      error: result.error === undefined ? null : printable(result.error),
      tests: result.tests.map(test => ({ name: printable(test.name), passed: test.passed, message: printable(test.message), source: test.source })),
      notes: result.notes.map(note => printable(note))
    }))
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

interface Suite { xml: string; tests: number }

function suiteOf(result: ItemResult, context: ReportContext, timestamp: string): Suite {
  const seconds = (result.ms / 1000).toFixed(3);
  const className = [context.name, result.item.folder].filter(part => part !== '').join('.');
  const name = `${result.item.name}${result.iteration > 0 ? ` (iteration ${result.iteration + 1})` : ''}`;
  const cases: string[] = [];
  const caseOf = (title: string, inner: string, time = '0.000'): string => `    <testcase classname="${xmlText(className)}" name="${xmlText(title)}" time="${time}"${inner === '' ? '/>' : `>\n${inner}\n    </testcase>`}`;
  for (const test of result.tests) {
    cases.push(caseOf(test.name, test.passed ? '' : `      <failure message="${xmlText(test.message)}" type="AssertionError">${xmlText(test.message)}</failure>`));
  }
  if (result.status === 'error') {
    const why = xmlText(result.error ?? 'The request failed.');
    cases.push(caseOf(result.tests.length === 0 ? 'request' : 'request (script)', `      <error message="${why}" type="Error">${why}</error>`));
  } else if (result.status === 'skipped') cases.push(caseOf('request', '      <skipped/>'));
  else if (result.tests.length === 0) cases.push(caseOf('request', '', seconds));
  const failed = result.tests.filter(test => !test.passed).length;
  const attributes = `name="${xmlText(name)}" tests="${cases.length}" failures="${failed}" errors="${result.status === 'error' ? 1 : 0}" skipped="${result.status === 'skipped' ? 1 : 0}" time="${seconds}" timestamp="${timestamp}"`;
  return { xml: `  <testsuite ${attributes}>\n${cases.join('\n')}\n  </testsuite>`, tests: cases.length };
}

export function toJUnit(summary: RunSummary, context: ReportContext): string {
  const timestamp = isoTime(summary.startedAt);
  const suites = summary.results.map(result => suiteOf(result, context, timestamp));
  const tests = suites.reduce((total, suite) => total + suite.tests, 0);
  const failures = summary.results.reduce((total, result) => total + result.tests.filter(test => !test.passed).length, 0);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xmlText(context.name)}" tests="${tests}" failures="${failures}" errors="${summary.errors}" skipped="${summary.skipped}" time="${(summary.ms / 1000).toFixed(3)}">\n${suites.map(suite => suite.xml).join('\n')}\n</testsuites>\n`;
}
