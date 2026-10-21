import type { ToHost, ToView, WizardFindingView, WizardOptions, WizardView } from '../../../src/wizard/types';

/**
 * The importer panel. It draws the `WizardView` the extension sends and forwards the person's choices; it holds no rule and
 * never reads a file. Everything shown that comes from a collection (names, messages) is put in the page with `textContent`
 * and never as HTML (a test keeps `innerHTML` and its relatives out of this file).
 */
declare function acquireVsCodeApi(): { postMessage(message: ToHost): void };
const api = acquireVsCodeApi();
const send = (message: ToHost): void => api.postMessage(message);

type Child = Node | string | null | undefined | false;
type Attributes = Record<string, string | number | boolean | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Attributes | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === false) continue;
    if (name === 'class') element.className = String(value);
    else if (name === 'text') element.textContent = String(value);
    else element.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) element.append(child);
  return element;
}

const SVG = 'http://www.w3.org/2000/svg';
const ICONS: Readonly<Record<string, string>> = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  warn: 'M12 4 3 19h18zM12 10v4M12 16.5v.5',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8v.5',
  error: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6',
  folder: 'M3.75 6.75a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h7.5a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5z',
  file: 'M7 3.75h7.5L18 7.25v13H7zM14.5 3.75v3.5H18',
  arrow: 'M4 12h13M12 6l6 6-6 6'
};
function icon(name: keyof typeof ICONS, label?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('class', `icon icon-${name}`);
  if (label === undefined) svg.setAttribute('aria-hidden', 'true');
  else { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); }
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ICONS[name] ?? '');
  svg.append(path);
  return svg;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const root = document.getElementById('app');
const status = document.getElementById('status');
let typing: number | undefined;
let lastAnnounced = '';

const TARGETS: ReadonlyArray<{ id: WizardOptions['target']; name: string; note: string }> = [
  { id: 'rest-client', name: 'REST Client', note: 'The VS Code extension humao.rest-client. Its variables live in a VS Code setting.' },
  { id: 'httpyac', name: 'httpYac', note: 'The VS Code extension anweber.vscode-httpyac. Reads http-client.env.json.' },
  { id: 'jetbrains', name: 'JetBrains HTTP Client', note: 'The JetBrains IDEs and their ijhttp command line. Reads http-client.env.json.' }
];
const POLICIES: ReadonlyArray<{ id: WizardOptions['policy']; name: string; note: string }> = [
  { id: 'new-folder', name: 'Use a new folder if the target already has files', note: 'Nothing that is there is touched. Recommended.' },
  { id: 'skip-existing', name: 'Keep the files that already exist', note: 'Only the missing files are added.' },
  { id: 'overwrite', name: 'Replace the files that already exist', note: 'Files with the same name are overwritten.' }
];

function button(label: string, onClick: () => void, options: { primary?: boolean; disabled?: boolean; key: string; title?: string }): HTMLButtonElement {
  const element = h('button', { type: 'button', class: options.primary === true ? 'btn' : 'btn secondary', 'data-key': options.key, disabled: options.disabled, title: options.title }, label);
  element.addEventListener('click', onClick);
  return element;
}

function card(step: number | undefined, title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'card' }, h('h2', null, step === undefined ? null : h('span', { class: 'num', 'aria-hidden': 'true' }, String(step)), title), ...children);
}

function choice(name: string, value: string, checked: boolean, title: string, note: string, onChange: () => void, disabled = false): HTMLElement {
  const input = h('input', { type: 'radio', name, value, checked, disabled, 'data-key': `${name}-${value}` });
  input.addEventListener('change', onChange);
  return h('label', { class: 'choice' }, input, h('span', { class: 'choice-text' }, h('span', { class: 'choice-title' }, title), h('span', { class: 'choice-note' }, note)));
}

function checkbox(key: string, checked: boolean, title: string, note: string, onChange: (checked: boolean) => void, disabled = false): HTMLElement {
  const input = h('input', { type: 'checkbox', checked, disabled, 'data-key': key });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'choice' }, input, h('span', { class: 'choice-text' }, h('span', { class: 'choice-title' }, title), h('span', { class: 'choice-note' }, note)));
}

function header(): HTMLElement {
  return h('header', { class: 'top' },
    h('h1', null, 'HTTP Files Importer'),
    h('p', { class: 'lead' }, 'Move your Thunder Client collections and environments to plain .http files. Nothing is written until you press Import.'));
}

function banners(state: WizardView): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (!state.workspace.open) {
    out.push(h('div', { class: 'banner warn', role: 'alert' }, icon('warn'), h('span', { class: 'banner-text' }, 'Open a folder first: the imported files are written inside it.'),
      button('Open folder', () => send({ type: 'openWorkspace' }), { key: 'open-workspace' })));
  }
  if (state.message !== undefined) {
    out.push(h('div', { class: `banner ${state.message.kind === 'error' ? 'error' : 'info'}`, role: state.message.kind === 'error' ? 'alert' : 'status' }, icon(state.message.kind === 'error' ? 'error' : 'info'), h('span', { class: 'banner-text' }, state.message.text)));
  }
  return out;
}

function sourceCard(state: WizardView): HTMLElement {
  if (state.step !== 'source' && state.source !== undefined) {
    return h('section', { class: 'card compact' },
      h('div', { class: 'source-line' }, icon('folder'), h('span', { class: 'source-title' }, state.source.title), h('span', { class: 'mono muted' }, state.source.detail)),
      state.step === 'review' ? button('Choose another source', () => send({ type: 'startOver' }), { key: 'start-over', disabled: state.busy === 'writing' }) : null);
  }
  const scanning = state.busy === 'scanning';
  const list = state.candidates.length === 0
    ? h('p', { class: 'muted' }, 'Thunder Client data was not found in the usual places. Choose the folder, or files you exported from Thunder Client.')
    : h('div', { class: 'candidates', role: 'group', 'aria-label': 'Thunder Client data found on this computer' }, ...state.candidates.map(candidate => {
      const element = h('button', { type: 'button', class: 'candidate', 'data-key': `candidate-${candidate.id}`, disabled: scanning },
        icon('folder'),
        h('span', { class: 'candidate-text' }, h('span', { class: 'choice-title' }, candidate.title, candidate.counts === '' ? null : h('span', { class: 'pill' }, candidate.counts)), h('span', { class: 'mono muted' }, candidate.detail)),
        icon('arrow'));
      element.addEventListener('click', () => send({ type: 'useCandidate', id: candidate.id }));
      return element;
    }));
  return card(1, 'Where is your Thunder Client data?',
    scanning ? h('div', { class: 'working', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', null, `Reading ${state.source?.detail ?? 'the data'}...`), button('Cancel', () => send({ type: 'cancelScan' }), { key: 'cancel-scan' })) : list,
    h('div', { class: 'row' },
      button('Choose a folder...', () => send({ type: 'chooseFolder' }), { key: 'choose-folder', disabled: scanning, primary: state.candidates.length === 0 }),
      button('Choose export files...', () => send({ type: 'chooseFiles' }), { key: 'choose-files', disabled: scanning })),
    h('p', { class: 'muted small' }, 'The data is only read. Nothing in that folder is changed.'));
}

function stat(value: number, label: string, tone?: string): HTMLElement {
  return h('div', { class: `stat${tone === undefined ? '' : ` ${tone}`}` }, h('div', { class: 'stat-value' }, String(value)), h('div', { class: 'stat-label' }, label));
}

function findingRow(finding: WizardFindingView): HTMLElement {
  return h('li', { class: `finding ${finding.severity}` },
    icon(finding.severity, finding.severity),
    h('div', { class: 'finding-text' },
      h('div', null, h('span', { class: 'mono code' }, finding.code), ' ', h('span', null, finding.message)),
      h('div', { class: 'muted small' }, finding.where)));
}

function foundCard(state: WizardView): HTMLElement | null {
  const summary = state.summary;
  if (summary === undefined) return null;
  const stats = h('div', { class: 'stats' },
    stat(summary.collections, summary.collections === 1 ? 'collection' : 'collections'),
    stat(summary.requests, summary.requests === 1 ? 'request' : 'requests'),
    stat(summary.environments, summary.environments === 1 ? 'environment' : 'environments'),
    summary.secretsMoved > 0 ? stat(summary.secretsMoved, 'secrets to a private file', 'good') : null,
    summary.skippedRequests > 0 ? stat(summary.skippedRequests, 'not imported', 'warn') : null,
    summary.variablesToReenter > 0 ? stat(summary.variablesToReenter, 'values to enter again', 'warn') : null);
  const counts = (severity: string): number => state.findings.filter(finding => finding.severity === severity).length;
  const attention = state.findings.filter(finding => finding.severity !== 'info');
  const rest = state.findings.filter(finding => finding.severity === 'info');
  const section = (title: string, items: WizardFindingView[], open: boolean): HTMLElement | null => (items.length === 0 ? null : h('details', { class: 'findings', open }, h('summary', null, title), h('ul', null, ...items.map(findingRow))));
  const hidden = state.findingsTotal - state.findings.length;
  return card(2, 'What was found', stats,
    attention.length === 0 && rest.length === 0 ? h('p', { class: 'muted' }, 'Nothing needs your attention.') : null,
    section(`Needs your attention (${plural(counts('error'), 'error')}, ${plural(counts('warn'), 'warning')})`, attention, counts('error') > 0),
    section(`Details (${rest.length})`, rest, false),
    hidden > 0 ? h('p', { class: 'muted small' }, `${plural(hidden, 'more finding')} not shown here.`) : null,
    h('div', { class: 'row' }, button('Open the full report', () => send({ type: 'openReportPreview' }), { key: 'open-report-preview' })));
}

function optionsCard(state: WizardView): HTMLElement | null {
  if (state.summary === undefined || state.summary.requests + state.summary.environments === 0) return null;
  const options = state.options;
  const set = (partial: Partial<WizardOptions>): void => send({ type: 'setOptions', options: partial });
  const input = h('input', { type: 'text', value: options.targetDir, class: 'text', id: 'target-dir', 'data-key': 'target-dir', spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'target-dir-note', 'aria-invalid': state.optionsError === undefined ? undefined : 'true' });
  input.addEventListener('input', () => {
    if (typing !== undefined) window.clearTimeout(typing);
    typing = window.setTimeout(() => { typing = undefined; set({ targetDir: input.value }); }, 300);
  });
  return card(3, 'How to write it',
    h('fieldset', { class: 'group' }, h('legend', null, 'Write the files for'),
      ...TARGETS.map(target => choice('target', target.id, options.target === target.id, target.name, target.note, () => set({ target: target.id })))),
    h('div', { class: 'group' },
      h('label', { for: 'target-dir', class: 'label' }, 'Folder in this workspace'),
      input,
      h('div', { id: 'target-dir-note', class: state.optionsError === undefined ? 'muted small' : 'error-text small' }, state.optionsError ?? 'The folder that receives the files.')),
    h('fieldset', { class: 'group' }, h('legend', null, 'If that folder already has files'),
      ...POLICIES.map(policy => choice('policy', policy.id, options.policy === policy.id, policy.name, policy.note, () => set({ policy: policy.id })))),
    h('div', { class: 'group' },
      checkbox('move-secrets', options.moveSecrets, 'Move secrets to a private file that Git ignores', options.moveSecrets ? 'Recommended. Tokens and passwords are replaced by variables in the shared files.' : 'Literal secrets stay in the shared files. They are listed in the report.', checked => set({ moveSecrets: checked })),
      options.target === 'rest-client'
        ? checkbox('apply-rest-client', options.applyRestClientSettings && state.restClientInstalled && options.moveSecrets, 'Fill in the REST Client settings for me', !state.restClientInstalled ? 'REST Client is not installed, so its settings cannot be filled in. The two settings files are still written.' : !options.moveSecrets ? 'Only when secrets are moved to the private file: otherwise a literal secret would be written to the workspace settings too.' : 'Variables go to the workspace settings, secrets to your user settings (kept out of Settings Sync). Nothing you have is replaced.', checked => set({ applyRestClientSettings: checked }), !state.restClientInstalled || !options.moveSecrets)
        : null));
}

function planCard(state: WizardView): HTMLElement | null {
  if (state.summary === undefined || state.summary.requests + state.summary.environments === 0) return null;
  const plan = state.plan;
  const notes: string[] = [];
  if (plan !== undefined) {
    if (plan.renamed) notes.push(`The folder you chose already has files, so ${plan.targetDir}/ is used.`);
    if (plan.kept > 0) notes.push(`${plural(plan.kept, 'existing file')} kept.`);
    if (plan.replaced > 0) notes.push(`${plural(plan.replaced, 'file')} replaced.`);
    if (plan.gitignore === 'created' || plan.gitignore === 'updated') notes.push(`.gitignore ${plan.gitignore === 'created' ? 'is created' : 'gets a line'} for the private file.`);
  }
  const files = plan === undefined ? null : h('details', { class: 'files' }, h('summary', null, `The files (${plan.fileTotal})`),
    h('ul', null, ...plan.files.map(file => h('li', { class: 'file' }, icon('file'), h('span', { class: 'mono' }, file.path), file.action === 'create' ? null : h('span', { class: `pill ${file.action}` }, file.action === 'skip' ? 'kept' : 'replaced')))),
    plan.fileTotal > plan.files.length ? h('p', { class: 'muted small' }, `and ${plural(plan.fileTotal - plan.files.length, 'more file')}.`) : null);
  return card(4, 'What will be written',
    plan === undefined
      ? h('p', { class: state.optionsError === undefined ? 'muted' : 'error-text' }, state.optionsError ?? (state.workspace.open ? 'Nothing to write yet.' : 'Open a folder to see what would be written.'))
      : h('p', null, 'It will write ', h('strong', null, plural(plan.writes, 'file')), ' into ', h('span', { class: 'mono' }, `${plan.targetDir}/`), '.'),
    ...notes.map(note => h('p', { class: 'muted small' }, note)),
    files);
}

/** The Import button stays at the bottom of the window while the page scrolls, so the person never has to look for it. */
function actionBar(state: WizardView): HTMLElement | null {
  if (state.summary === undefined || state.summary.requests + state.summary.environments === 0) return null;
  const plan = state.plan;
  const working = state.busy === 'writing';
  const canImport = plan !== undefined && state.workspace.open && !working && plan.writes > 0;
  const text = plan !== undefined ? `Ready to write ${plural(plan.writes, 'file')} into ${plan.targetDir}/` : state.optionsError ?? (state.workspace.open ? 'Nothing to write yet' : 'Open a folder to import');
  return h('div', { class: 'actionbar' },
    h('span', { class: plan === undefined ? 'error-text' : 'muted' }, text),
    h('div', { class: 'row tight' },
      button('Start over', () => send({ type: 'startOver' }), { key: 'start-over-2', disabled: working }),
      button(working ? 'Writing...' : plan === undefined ? 'Import' : `Import ${plural(plan.writes, 'file')}`, () => send({ type: 'import' }), { primary: true, key: 'import', disabled: !canImport })));
}

function doneCard(state: WizardView): HTMLElement | null {
  const result = state.result;
  if (result === undefined) return null;
  return h('section', { class: 'card done' },
    h('h2', null, icon('check'), `Imported ${plural(result.requests, 'request')}`),
    h('p', null, 'The files are in ', h('span', { class: 'mono' }, `${result.targetDir}/`), `. ${plural(result.written, 'file')} written${result.overwritten > 0 ? `, ${result.overwritten} replaced` : ''}${result.skipped > 0 ? `, ${result.skipped} kept as they were` : ''}.`),
    ...result.notes.map(note => h('p', { class: 'muted' }, note)),
    h('div', { class: 'row' },
      button('Open the folder', () => send({ type: 'openFolder' }), { primary: true, key: 'open-folder' }),
      button('Open the report', () => send({ type: 'openWrittenReport' }), { key: 'open-report' }),
      button('Import another', () => send({ type: 'startOver' }), { key: 'import-another' })));
}

function render(state: WizardView): void {
  if (root === null) return;
  const active = document.activeElement;
  const key = active instanceof HTMLElement ? active.dataset['key'] : undefined;
  const selection = active instanceof HTMLInputElement && active.type === 'text' ? [active.selectionStart, active.selectionEnd] as const : undefined;
  const scroll = window.scrollY;

  const content = h('div', { class: 'wrap' }, header(), ...banners(state), sourceCard(state),
    state.step === 'done' ? doneCard(state) : null,
    state.step === 'review' ? foundCard(state) : null, state.step === 'review' ? optionsCard(state) : null, state.step === 'review' ? planCard(state) : null,
    state.step === 'review' ? actionBar(state) : null);
  root.replaceChildren(content);
  window.scrollTo(0, scroll);

  if (key !== undefined) {
    const again = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (again !== null && !(again instanceof HTMLButtonElement && again.disabled)) {
      again.focus({ preventScroll: true });
      if (selection !== undefined && again instanceof HTMLInputElement) again.setSelectionRange(selection[0], selection[1]);
    }
  }

  // Said once for a screen reader when the step or the busy state changes.
  const announcement = state.busy === 'scanning' ? 'Reading the data.' : state.busy === 'writing' ? 'Writing the files.' : state.step === 'done' ? `Imported ${plural(state.result?.requests ?? 0, 'request')}.` : state.step === 'review' && state.summary !== undefined ? `Read ${plural(state.summary.requests, 'request')}. Choose how to write them.` : '';
  if (status !== null && announcement !== lastAnnounced) { status.textContent = announcement; lastAnnounced = announcement; }
}

window.addEventListener('message', event => {
  const data = event.data as ToView | undefined;
  if (data !== undefined && data !== null && typeof data === 'object' && data.type === 'state') render(data.view);
});
send({ type: 'ready' });
