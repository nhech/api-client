import { newBody } from '../../core/model';
import { printable } from '../../util/chars';
import { blankFolder, blankRequest, IMPORT_LIMITS, Notes, type Imported, type ImportedFolder } from '../types';
import { row } from '../url';
import { stemOf } from './paths';
import type { DetectedRoute, RoutesResult } from './types';

/**
 * The routes that were found, as a collection of the client: one folder for each controller (or router, or file), one request for each route, and an
 * environment `Local` with the address of the server. A parameter of the path is a variable of its own name, `{{id}}`: it is not defined, so the client
 * shows it as one to fill in, and a request is not sent to a real `/users/1` by a number that was made up here.
 */
const label = (text: string, fallback: string): string => {
  const shown = printable(text).replace(/[\r\n\t]+/g, ' ').trim().slice(0, IMPORT_LIMITS.nameChars);
  return shown === '' ? fallback : shown;
};

function requestOf(route: DetectedRoute) {
  const request = blankRequest(`${route.method} ${route.path}`.slice(0, IMPORT_LIMITS.nameChars));
  request.method = route.method;
  request.url = route.path;
  request.pathParams = route.pathParams.map(name => row(name, `{{${name}}}`));
  request.query = route.queryParams.map(name => row(name, '', false));
  request.headers = route.headerParams.map(name => row(name, '', false));
  if (route.body === 'json') request.body = { kind: 'json', text: '{}' };
  else if (route.body === 'form') request.body = newBody('form');
  request.docs = `Found in ${printable(route.file)}:${route.line} (${printable(route.framework)})${route.handler === undefined ? '' : `, ${printable(route.handler)}`}`;
  return request;
}

export function routesToImported(result: RoutesResult, collectionName: string): Imported {
  const notes = new Notes();
  for (const message of result.notes) notes.add('', message);
  if (result.routes.length === 0) return { collections: [], environments: [], notes: notes.done(), skipped: 0 };

  const collection = blankFolder(label(collectionName, 'Routes'));
  collection.container.baseUrl = '{{baseUrl}}';
  // One folder for each group of each file; a name that two files have gets the name of the file, so that the folders can be told apart.
  const filesOfGroup = new Map<string, Set<string>>();
  for (const route of result.routes) {
    const name = label(route.group, 'routes');
    const set = filesOfGroup.get(name) ?? new Set<string>();
    set.add(route.file);
    filesOfGroup.set(name, set);
  }
  const folders = new Map<string, ImportedFolder>();
  const taken = new Set<string>();
  for (const route of result.routes.slice(0, IMPORT_LIMITS.requests)) {
    const name = label(route.group, 'routes');
    const key = `${name}\u0000${route.file}`;
    let folder = folders.get(key);
    if (folder === undefined) {
      let shown = (filesOfGroup.get(name)?.size ?? 1) > 1 ? `${name} (${label(stemOf(route.file), route.file)})` : name;
      const wanted = shown;
      for (let number = 2; taken.has(shown); number++) shown = `${wanted} ${number}`;
      taken.add(shown);
      folder = blankFolder(shown);
      folders.set(key, folder);
      collection.folders.push(folder);
    }
    folder.requests.push(requestOf(route));
  }
  const environment = { name: 'Local', vars: [{ name: 'baseUrl', value: result.baseUrl ?? 'http://localhost:3000', secret: false, enabled: true }] };
  return { collections: [collection], environments: [environment], notes: notes.done(), skipped: 0 };
}
