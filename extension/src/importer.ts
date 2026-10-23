import * as vscode from 'vscode';
import type { Candidate } from '../../src/discover';
import { looksLikeCurl, parseCurl } from '../../src/importers/curl';
import { OPENAPI_LIMITS, parseOpenApi } from '../../src/importers/openapi';
import { describeOpenApi } from '../../src/importers/openapi-find';
import { parsePostman, POSTMAN_LIMITS } from '../../src/importers/postman';
import { importSummary, renderNotes } from '../../src/importers/report';
import { detectRoutes, isRouteSource, mayHaveRoutes, ROUTE_CONFIG_FILES, ROUTE_EXTENSIONS, ROUTE_LIMITS, ROUTE_SKIPPED_FOLDERS, routesToImported, type SourceFile } from '../../src/importers/routes';
import { findingNotes, thunderToImported } from '../../src/importers/thunder';
import { mayActivateEnvironment } from '../../src/importers/activation';
import { splitLargeFolders } from '../../src/importers/split';
import { countImported, IMPORT_LIMITS, importedChars, type Imported } from '../../src/importers/types';
import { buildTree } from '../../src/normalize/build';
import { readSource, SourceError } from '../../src/reader/fs-reader';
import { hasUserinfo } from '../../src/util/address';
import { compareCodePoints, printable } from '../../src/util/chars';
import { writeImported, writeRequestInto } from '../../src/storage/import';
import type { ContainerNode } from '../../src/storage/store';
import type { ClientWorkspace } from './clientWorkspace';
import { findOpenApiFiles, type OpenApiSearch } from './openApiFinder';
import { OPEN_REQUEST_COMMAND } from './trees';
import type { VscodeHost } from './vscodeHost';

/**
 * Bringing what other tools made into the client: a Thunder Client folder or export, a Postman collection or environment, and one cURL command.
 * Each is read by code in src/importers (which only reads text), shown to the person as a count and confirmed, written through the store, and then
 * the notes (what could not be carried over) are one command away as a document. Nothing is written before the person has said yes.
 */
export const NOTES_SCHEME = 'apiclient-import';

const NO_USERINFO = 'An address with a user name or a password in it is not fetched. Download the description and import the file, or send the request from the client with the credentials in its authentication.';

export class ImportNotes implements vscode.TextDocumentContentProvider {
  readonly uri = vscode.Uri.from({ scheme: NOTES_SCHEME, path: '/IMPORT_NOTES.md' });
  private text = '';
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(): string { return this.text || 'Nothing has been imported yet.\n'; }

  set(text: string): void {
    this.text = text;
    this.changed.fire(this.uri);
  }

  dispose(): void { this.changed.dispose(); }
}

/** What the tests of the extension answer in place of the person. */
export interface ImportAnswers {
  /** The file of a Postman export. */
  postmanFile?: () => Promise<string | undefined>;
  /** The Thunder Client data: a folder or export files. */
  thunderSource?: () => Promise<string | string[] | undefined>;
  /** The cURL command, when the clipboard has none. */
  curlText?: () => Promise<string | undefined>;
  /** Where an OpenAPI or Swagger description is: a file, or an address to fetch it from. */
  openApi?: () => Promise<{ kind: 'file'; path: string } | { kind: 'url'; url: string } | undefined>;
  /** Whether to write what was found; gets the sentence that says what it is. */
  confirm?: (summary: string) => Promise<boolean>;
}

export class ImportService implements vscode.Disposable {
  answers: ImportAnswers = {};
  readonly notes = new ImportNotes();

  /** Fetches the text at an address (the person typed it: it is a request like any other); replaced by the tests of the extension. */
  fetchText: (url: string, signal: AbortSignal) => Promise<string>;

  constructor(
    private readonly workspace: ClientWorkspace,
    private readonly host: VscodeHost,
    private readonly candidates: () => Promise<readonly Candidate[]>,
    fetchText: (url: string, signal: AbortSignal) => Promise<string> = async () => { throw new Error('Fetching is not available.'); }
  ) {
    this.fetchText = fetchText;
  }

  private store(): NonNullable<ClientWorkspace['files']> | undefined {
    if (this.workspace.files === undefined) void vscode.window.showInformationMessage('Open a folder first: the client keeps its files in the folder of the workspace.');
    return this.workspace.files;
  }

  /** Shows the notes of the last import as a document that cannot be edited. */
  async showNotes(): Promise<void> {
    const document = await vscode.workspace.openTextDocument(this.notes.uri);
    await vscode.languages.setTextDocumentLanguage(document, 'markdown');
    await vscode.window.showTextDocument(document, { preview: true });
  }

  /** Asks, writes, tells. Returns whether anything was written. */
  private async finish(source: string, found: Imported): Promise<boolean> {
    const store = this.store();
    if (store === undefined) return false;
    // A folder with more entries than the client can write and read back is split before anything is written.
    const imported = splitLargeFolders(found);
    const before = this.workspace.loaded;
    const counts = countImported(imported);
    this.notes.set(renderNotes(source, imported));
    const chars = importedChars(imported);
    if (chars > IMPORT_LIMITS.chars) {
      void vscode.window.showErrorMessage(`API Client: this import would write about ${Math.round(chars / 1_000_000)} MB of files, more than the ${Math.round(IMPORT_LIMITS.chars / 1_000_000)} MB that an import may write. Nothing was written.`);
      return false;
    }
    const summary = `${importSummary(counts)}${chars >= 1_000_000 ? ` (about ${Math.round(chars / 1_000_000)} MB of files)` : ''}`;
    if (counts.requests === 0 && counts.environments === 0) {
      void vscode.window.showWarningMessage(`Nothing to import from ${source}: ${imported.notes.length > 0 ? 'the notes say what was found.' : 'no requests and no environments were found.'}`, ...(imported.notes.length > 0 ? ['Show Notes'] : [])).then(choice => { if (choice === 'Show Notes') void this.showNotes(); });
      return false;
    }
    const yes = this.answers.confirm !== undefined
      ? await this.answers.confirm(summary)
      : (await vscode.window.showInformationMessage(`Import ${summary} from ${source}?`, { modal: true, detail: `They are written as files in the folder of the client in this workspace.${imported.notes.length > 0 ? ` ${imported.notes.length} notes say what could not be carried over; you can read them afterwards.` : ''}` }, 'Import')) === 'Import';
    if (!yes) return false;
    const written = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Importing from ${source}`, cancellable: true }, (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      return writeImported(store, imported, controller.signal);
    });
    await this.workspace.reload();
    // Requests that use {{baseUrl}} send nothing useful until an environment is the active one. The first that came is made the active one only when it
    // cannot send the requests of anything else to its address: see mayActivateEnvironment.
    const hasActive = before?.environments.some(item => item.environment.id === this.workspace.activeEnvironmentId) === true;
    const first = written.environments[0];
    let activated = '';
    if (first !== undefined && !hasActive) {
      const may = mayActivateEnvironment({
        // A workspace that was not loaded is not known to be empty: the person chooses.
        hasActive, collectionsBefore: before?.collections.length ?? 1, workspaceVariables: before?.workspace.file.vars.map(variable => variable.name) ?? [],
        environmentVariables: imported.environments[0]?.vars.map(variable => variable.name) ?? []
      });
      if (may) {
        await this.workspace.setActiveEnvironment(first.id);
        activated = ` The environment ${first.name} is now the active one.`;
      } else activated = ` The environment ${first.name} is not the active one, because the workspace has other collections that it would send to its address: choose it in the status bar when you want it.`;
    }
    void vscode.window.showInformationMessage(`Imported ${importSummary(written.counts)} from ${source}.${activated}`, ...(imported.notes.length > 0 ? ['Show Notes'] : [])).then(choice => { if (choice === 'Show Notes') void this.showNotes(); });
    return true;
  }

  /**
   * The source files of the workspace that can hold routes, and the files that say on which port a program listens, read as text (nothing is run). What is
   * kept is limited as the files are read: the text of a file that has no words of a framework is dropped at once (its name stays, because what a file imports
   * is looked up by name), and the text of all the others together is held to the limit of the scan. A symbolic link is not followed: it can point out of the
   * folder of the workspace.
   */
  private async readSources(signal: AbortSignal): Promise<{ files: SourceFile[]; notes: string[] }> {
    const folder = this.workspace.folder();
    if (folder === undefined) return { files: [], notes: [] };
    const notes: string[] = [];
    const skipped = `**/{${[...ROUTE_SKIPPED_FOLDERS, this.workspace.root()].join(',')}}/**`;
    const searchLimit = ROUTE_LIMITS.files * 2;
    const sources = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, `**/*.{${ROUTE_EXTENSIONS.map(extension => extension.slice(1)).join(',')}}`), skipped, searchLimit);
    if (sources.length >= searchLimit) notes.push(`The search for source files stopped at ${searchLimit} files: the others were not looked at.`);
    const configs = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, `**/{${ROUTE_CONFIG_FILES.join(',')}}`), skipped, 200);
    const relative = (uri: vscode.Uri): string => vscode.workspace.asRelativePath(uri, false);
    // By name, so that which files are read does not depend on the order in which the search found them.
    const chosen = sources.filter(uri => isRouteSource(relative(uri))).sort((a, b) => compareCodePoints(relative(a), relative(b))).slice(0, ROUTE_LIMITS.files + 1);
    const wanted = [...chosen, ...configs];
    const files: SourceFile[] = [];
    let tooLarge = 0;
    let linked = 0;
    let overBudget = 0;
    let retained = 0;
    const decoder = new TextDecoder('utf-8');
    for (let from = 0; from < wanted.length; from += 16) {
      signal.throwIfAborted();
      const batch = await Promise.all(wanted.slice(from, from + 16).map(async uri => {
        try {
          const stats = await vscode.workspace.fs.stat(uri);
          if ((stats.type & vscode.FileType.SymbolicLink) !== 0) return { kind: 'linked' as const };
          if (stats.size > ROUTE_LIMITS.fileChars) return { kind: 'large' as const };
          return { kind: 'read' as const, path: relative(uri), text: decoder.decode(await vscode.workspace.fs.readFile(uri)) };
        } catch { return undefined; }
      }));
      for (const item of batch) {
        if (item === undefined) continue;
        if (item.kind === 'linked') { linked++; continue; }
        if (item.kind === 'large') { tooLarge++; continue; }
        const config = ROUTE_CONFIG_FILES.includes(item.path.split('/').pop() ?? '');
        if (!config && !mayHaveRoutes(item.path, item.text)) { files.push({ path: item.path, text: '' }); continue; }
        if (retained + item.text.length > ROUTE_LIMITS.totalChars) { overBudget++; files.push({ path: item.path, text: '' }); continue; }
        retained += item.text.length;
        files.push({ path: item.path, text: item.text });
      }
    }
    if (tooLarge > 0) notes.push(`${tooLarge} source ${tooLarge === 1 ? 'file is' : 'files are'} larger than ${ROUTE_LIMITS.fileChars / 1_000_000} MB and ${tooLarge === 1 ? 'was' : 'were'} not read.`);
    if (linked > 0) notes.push(`${linked} symbolic ${linked === 1 ? 'link was' : 'links were'} not followed.`);
    if (overBudget > 0) notes.push(`${overBudget} ${overBudget === 1 ? 'file was' : 'files were'} not read because the sources together are too large.`);
    return { files, notes };
  }

  /** The routes of the controllers in the source of the workspace (the code is read as text, never run), as a collection with a folder for each controller. */
  async routes(): Promise<void> {
    const folder = this.workspace.folder();
    if (this.store() === undefined || folder === undefined) return;
    let read: { files: SourceFile[]; notes: string[] };
    try {
      read = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Looking for the routes of the controllers', cancellable: true }, (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return this.readSources(controller.signal);
      });
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) void vscode.window.showErrorMessage(`API Client: the source files could not be read: ${printable(error instanceof Error ? error.message : 'unknown error')}`);
      return;
    }
    const result = detectRoutes(read.files);
    const largeNote = read.notes.map(message => ({ where: '', message }));
    if (result.routes.length === 0) {
      void vscode.window.showInformationMessage(`No routes were found in ${result.filesRead} source files. NestJS, Express, Fastify, Koa, Hono, Spring, ASP.NET Core, FastAPI, Flask, Django, Laravel, Go and Actix are looked for; a program that is running can be imported from its OpenAPI description instead.`, 'Show Notes').then(choice => { if (choice === 'Show Notes') void this.showNotes(); });
      const none = routesToImported(result, folder.name);
      this.notes.set(renderNotes('the source of this workspace', { ...none, notes: [...none.notes, ...largeNote] }));
      return;
    }
    const found = routesToImported(result, `${folder.name} routes`);
    await this.finish('the source of this workspace', { ...found, notes: [...found.notes, ...largeNote] });
  }

  /**
   * Where the description is: the ones that the workspace already holds are listed as soon as they are found (the files named openapi or swagger first), and
   * the last two choices are a file somewhere else and an address.
   */
  private async chooseOpenApi(): Promise<{ kind: 'file'; path: string } | { kind: 'url'; url: string } | undefined> {
    interface Choice extends vscode.QuickPickItem { place?: 'file' | 'url'; path?: string }
    const other: Choice[] = [
      { label: 'Somewhere else', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(folder-opened) Choose another file...', description: 'an OpenAPI or Swagger description, as JSON or YAML', place: 'file' },
      { label: '$(globe) An address...', description: 'for example http://localhost:8080/v3/api-docs of a program that is running; it is fetched like a request', place: 'url' }
    ];
    const picker = vscode.window.createQuickPick<Choice>();
    picker.title = 'Import an OpenAPI or Swagger description';
    picker.placeholder = 'Searching this workspace for descriptions...';
    picker.matchOnDescription = true;
    picker.items = other;
    picker.busy = this.workspace.folder() !== undefined;
    const searching = new AbortController();
    const show = (found: OpenApiSearch, done: boolean): void => {
      const listed: Choice[] = found.files.length === 0 ? [] : [
        { label: `Found in this workspace${found.more > 0 ? ` (${found.more} more are not listed)` : ''}${found.stopped ? ' (the search stopped at its limit)' : ''}`, kind: vscode.QuickPickItemKind.Separator },
        ...found.files.map((file): Choice => ({ label: `$(file-code) ${file.path}`, description: describeOpenApi(file), path: file.uri.fsPath }))
      ];
      picker.items = [...listed, ...other];
      if (done) picker.busy = false;
      picker.placeholder = found.files.length > 0 ? 'Pick a description found in this workspace, or say where it is' : done ? 'No OpenAPI or Swagger file was found in this workspace: say where it is' : 'Searching this workspace for descriptions...';
    };
    const search = this.workspace.folder() === undefined ? Promise.resolve() : this.findOpenApiFiles(searching.signal, found => show(found, false)).then(found => show(found, true), () => { picker.busy = false; });
    const chosen = await new Promise<Choice | undefined>(resolve => {
      picker.onDidAccept(() => resolve(picker.selectedItems[0]));
      picker.onDidHide(() => resolve(undefined));
      picker.show();
    });
    searching.abort();
    picker.dispose();
    void search;
    if (chosen === undefined) return undefined;
    if (chosen.path !== undefined) return { kind: 'file', path: chosen.path };
    if (chosen.place === 'file') {
      const picked = (await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { 'OpenAPI or Swagger': ['json', 'yaml', 'yml'] }, openLabel: 'Import', title: 'An OpenAPI or Swagger description (JSON or YAML)' }))?.[0]?.fsPath;
      return picked === undefined ? undefined : { kind: 'file', path: picked };
    }
    if (chosen.place === 'url') {
      const url = await vscode.window.showInputBox({
        title: 'Import an OpenAPI or Swagger description', prompt: 'The address of the description (it is fetched with a GET request)', placeHolder: 'http://localhost:8080/v3/api-docs', ignoreFocusOut: true,
        validateInput: value => (!/^https?:\/\/[^\s/]+/i.test(value.trim()) ? 'Start with http:// or https://' : hasUserinfo(value) ? NO_USERINFO : undefined)
      });
      return url === undefined || url.trim() === '' ? undefined : { kind: 'url', url: url.trim() };
    }
    return undefined;
  }

  /** The descriptions of OpenAPI and Swagger that the workspace holds (the start of each JSON and YAML file is read, nothing is run). */
  findOpenApiFiles(signal: AbortSignal = new AbortController().signal, onList?: (found: OpenApiSearch) => void): Promise<OpenApiSearch> {
    return findOpenApiFiles(this.workspace.root(), signal, onList);
  }

  /** An OpenAPI or Swagger description, from a file or from an address (a program that is running often serves its own), as a collection with its environment. */
  async openApi(): Promise<void> {
    if (this.store() === undefined) return;
    const where = this.answers.openApi !== undefined ? await this.answers.openApi() : await this.chooseOpenApi();
    if (where === undefined) return;
    if (where.kind === 'url' && hasUserinfo(where.url)) { void vscode.window.showErrorMessage(`API Client: ${NO_USERINFO}`); return; }
    let source: string;
    let content: string;
    try {
      if (where.kind === 'file') {
        const uri = vscode.Uri.file(where.path);
        const stats = await vscode.workspace.fs.stat(uri);
        if (stats.size > OPENAPI_LIMITS.fileChars) { void vscode.window.showErrorMessage('API Client: the file is too large to be an OpenAPI description.'); return; }
        content = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
        source = where.path.split(/[\\/]/).pop() ?? 'OpenAPI';
      } else {
        const address = where.url;
        content = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Fetching the description', cancellable: true }, (_progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          return this.fetchText(address, controller.signal);
        });
        source = (() => { try { return new URL(address).host; } catch { return 'an address'; } })();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`API Client: the description could not be read: ${printable(error instanceof Error ? error.message : 'the request failed')}`);
      return;
    }
    const result = parseOpenApi(content);
    if (!result.ok) { void vscode.window.showErrorMessage(`API Client: ${result.error}`); return; }
    await this.finish(`OpenAPI (${source})`, result.imported);
  }

  async postman(): Promise<void> {
    if (this.store() === undefined) return;
    const path = this.answers.postmanFile !== undefined
      ? await this.answers.postmanFile()
      : (await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { JSON: ['json'] }, openLabel: 'Import', title: 'A Postman collection or environment (exported as JSON)' }))?.[0]?.fsPath;
    if (path === undefined) return;
    const uri = vscode.Uri.file(path);
    const stats = await vscode.workspace.fs.stat(uri);
    if (stats.size > POSTMAN_LIMITS.fileChars) { void vscode.window.showErrorMessage('API Client: the file is too large to be a Postman export.'); return; }
    const result = parsePostman(new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri)));
    if (!result.ok) { void vscode.window.showErrorMessage(`API Client: ${result.error}`); return; }
    await this.finish('Postman', result.imported);
  }

  async thunder(): Promise<void> {
    if (this.store() === undefined) return;
    let input: string | string[] | undefined;
    if (this.answers.thunderSource !== undefined) input = await this.answers.thunderSource();
    else {
      const choice = await this.host.pickSource(await this.candidates());
      if (choice === undefined) return;
      input = choice.kind === 'path' ? choice.path : choice.kind === 'folder' ? await this.host.chooseFolder() : await this.host.chooseFiles();
    }
    if (input === undefined || (Array.isArray(input) && input.length === 0)) return;
    const chosen = input;
    try {
      const imported = await this.host.withProgress('Reading Thunder Client data', async signal => {
        const source = await readSource(chosen, { signal });
        const found = thunderToImported(buildTree(source));
        return { ...found, notes: [...findingNotes(source.findings), ...found.notes] };
      });
      if (imported === undefined) return;
      await this.finish('Thunder Client', imported);
    } catch (error) {
      void vscode.window.showErrorMessage(`API Client: ${error instanceof SourceError ? error.message : 'The data could not be read.'}`);
    }
  }

  /** One request from a cURL command, into `parent`; `given` is the command when a caller has it, else the clipboard or a box. */
  async curl(parent: ContainerNode, given?: string): Promise<void> {
    const store = this.store();
    if (store === undefined) return;
    let text = given;
    if (text === undefined) {
      const clipboard = await vscode.env.clipboard.readText();
      text = looksLikeCurl(clipboard) ? clipboard : (this.answers.curlText !== undefined ? await this.answers.curlText() : await vscode.window.showInputBox({ title: 'New request from cURL', prompt: 'Paste a cURL command (copy it first and it is read from the clipboard, with all its lines)', ignoreFocusOut: true }));
    }
    if (text === undefined || text.trim() === '') return;
    const parsed = parseCurl(text);
    if (!parsed.ok) { void vscode.window.showErrorMessage(`API Client: ${parsed.error}`); return; }
    const { node, moved } = await writeRequestInto(store, parent, parsed.request);
    await this.workspace.reload();
    const notes: Imported = { collections: [], environments: [], skipped: 0, notes: [...parsed.notes.map(message => ({ where: parsed.request.name, message })), ...(moved > 0 ? [{ where: parsed.request.name, message: `${moved} ${moved === 1 ? 'credential was' : 'credentials were'} moved to secret variables of ${parent.container.name}: the values are in a file next to it that Git ignores.` }] : [])] };
    this.notes.set(renderNotes('a cURL command', notes));
    await vscode.commands.executeCommand(OPEN_REQUEST_COMMAND, node.path);
    if (notes.notes.length > 0) void vscode.window.showInformationMessage(`Created "${parsed.request.name}". ${notes.notes[0]?.message ?? ''}`, ...(notes.notes.length > 0 ? ['Show Notes'] : [])).then(choice => { if (choice === 'Show Notes') void this.showNotes(); });
  }

  dispose(): void { this.notes.dispose(); }
}
