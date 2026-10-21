import type { Finding, Severity } from '../model/findings';
import { FINDING_CATALOG } from '../model/findings';
import type { ImpSkipped } from '../model/ir';
import { TARGET_LABEL } from '../model/target';
import type { ImportOptions, ImportSummary } from '../pipeline';
import { displayLabel } from '../util/chars';
import type { EmitCollection } from './index';
import type { EnvironmentFiles } from './env';

/**
 * IMPORT_REPORT.md (spec 7): what was imported, what was not, and what the user still has to do. Names and places only, never a
 * value from the data. Pure and deterministic: no date, no absolute path.
 */
export interface ReportInput {
  summary: ImportSummary;
  findings: readonly Finding[];
  collections: readonly EmitCollection[];
  environments: EnvironmentFiles['keys'];
  skipped: readonly ImpSkipped[];
  /** Variables that must be entered again, as environment and variable name. */
  reenter: readonly { environment: string; variable: string }[];
  options: ImportOptions;
  /** The output limit cut the import short. */
  truncated: boolean;
  /** `rest-client.private.settings.json` was written (there are secrets to keep out of Git). */
  restClientPrivate: boolean;
}

const ROWS_PER_CODE = 50;
const ROWS_PER_LIST = 200;

/** Text in markdown: characters that mean something to markdown are escaped, so a name cannot make a link, a table cell or a heading. */
export const escapeMarkdown = (text: string): string => displayLabel(text, 200).replace(/[\\`*_[\]<>|~#&]/g, char => `\\${char}`);

/** Text as inline code: the fence is longer than any run of backticks inside, so nothing in a name can end the span early. */
export function codeSpan(text: string): string {
  const clean = displayLabel(text, 200);
  const longest = (clean.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(longest + 1);
  return clean.startsWith('`') || clean.endsWith('`') ? `${fence} ${clean} ${fence}` : `${fence}${clean}${fence}`;
}

const row = (label: string, value: number | string): string => `| ${label} | ${value} |`;
const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** At most `limit` lines of a list; `total` is the real length when `items` holds only the part that will be shown. */
function list(items: readonly string[], limit = ROWS_PER_LIST, total = items.length): string[] {
  const out = items.slice(0, limit).map(item => `- ${item}`);
  if (total > limit) out.push(`- ... and ${total - limit} more`);
  return out;
}

function findingSection(title: string, findings: readonly Finding[], severities: readonly Severity[]): string[] {
  const chosen = findings.filter(item => severities.includes(item.severity));
  if (chosen.length === 0) return [];
  const byCode = new Map<string, Finding[]>();
  for (const item of chosen) {
    const group = byCode.get(item.code);
    if (group === undefined) byCode.set(item.code, [item]);
    else group.push(item);
  }
  const out: string[] = [`## ${title}`, ''];
  for (const code of [...byCode.keys()].sort()) {
    const items = byCode.get(code) ?? [];
    const catalog = FINDING_CATALOG[code as keyof typeof FINDING_CATALOG];
    out.push(`### ${code}: ${escapeMarkdown(catalog.summary)} (${plural(items.length, 'place')})`, '');
    // Only the lines that will be shown are written out: a hundred thousand places of one kind are counted, not rendered.
    out.push(...list(items.slice(0, ROWS_PER_CODE).map(item => `${escapeMarkdown(item.where)}${item.message === catalog.summary ? '' : `: ${escapeMarkdown(item.message)}`}`), ROWS_PER_CODE, items.length), '');
  }
  return out;
}

export function renderReport(input: ReportInput): string {
  const { summary, findings, options } = input;
  const out: string[] = ['# Thunder Client import report', ''];

  const errors = findings.filter(item => item.severity === 'error').length;
  if (input.truncated || errors > 0) {
    out.push('> **The import is incomplete.** Something went over a limit and was left out; see "Needs your attention" below.', '');
  }
  out.push('This report lists names and places only. It never contains a value from your data, so it is safe to commit.', '');
  out.push(`Written for ${TARGET_LABEL[options.target]}: dynamic variables such as {{$guid}} are spelled the way that tool reads them. Import again with another target to write them for another tool.`, '');

  out.push('## Summary', '', '| | |', '|---|---|');
  out.push(row('Collections', summary.collections), row('Folders', summary.folders), row('Requests imported', summary.requests));
  out.push(row('Requests not imported', summary.skippedRequests), row('Environments', summary.environments));
  out.push(row('Secrets moved to the private file', summary.secretsMoved), row('Values to enter again', summary.variablesToReenter), '');

  if (input.collections.length > 0) {
    out.push('## Written', '', '| Folder | Requests | Folders |', '|---|---|---|');
    for (const collection of input.collections.slice(0, ROWS_PER_LIST)) out.push(`| ${codeSpan(`${collection.dir}/`)} | ${collection.requests} | ${collection.folders} |`);
    if (input.collections.length > ROWS_PER_LIST) out.push(`| ... and ${input.collections.length - ROWS_PER_LIST} more | | |`);
    out.push('');
  }

  if (input.environments.length > 0) {
    out.push('## Environments', '');
    out.push(...list(input.environments.map(environment => {
      const extra = environment.privateVariables > 0 ? `, ${environment.privateVariables} in the private file` : '';
      return `${escapeMarkdown(environment.name)}: ${plural(environment.variables, 'variable')}${extra}${environment.isDefault ? ' (the default in Thunder Client)' : ''}`;
    })), '');
    if (options.moveSecrets && summary.secretsMoved > 0) out.push('The private file is `http-client.private.env.json`. It is added to `.gitignore` and must not be committed.', '');
    if (options.target === 'rest-client') {
      out.push('### For REST Client', '', 'REST Client does not read `http-client.env.json`; it reads the VS Code setting `rest-client.environmentVariables`. The same variables are written for it. The extension fills the settings in for you unless you turned that off; these are the steps for the command line or for doing it by hand:', '');
      out.push('1. Paste the content of `rest-client.settings.json` into `.vscode/settings.json` of this workspace.');
      if (input.restClientPrivate) out.push('2. Paste the content of `rest-client.private.settings.json` into your **user** settings (Preferences: Open User Settings (JSON)). VS Code merges the two. It holds the secrets, so it is kept out of Git: do not commit it.');
      out.push(`${input.restClientPrivate ? '3' : '2'}. Choose an environment with the command "Rest Client: Switch Environment" (or the status bar).`, '');
    }
  }

  if (input.reenter.length > 0) {
    out.push('## Enter these values again', '', 'Thunder Client stores these encrypted, so they cannot be carried over. They are empty in the private file.', '');
    out.push(...list(input.reenter.map(item => `${escapeMarkdown(item.environment)}: ${escapeMarkdown(item.variable)}`)), '');
  }

  if (input.skipped.length > 0) {
    out.push('## Not imported', '', 'These requests use a protocol that a `.http` file cannot express.', '');
    out.push(...list(input.skipped.map(item => `${escapeMarkdown(item.collection)} / ${escapeMarkdown(item.request)}: ${escapeMarkdown(item.reason)}`)), '');
  }

  out.push(...findingSection('Needs your attention', findings, ['error', 'warn']));
  out.push(...findingSection('Notes', findings, ['info']));

  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return `${out.join('\n')}\n`;
}
