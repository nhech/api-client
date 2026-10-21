import { newContainer, newRequest, type Container, type Environment, type Request, type Var } from '../core/model';

/**
 * What an importer finds, in the model of the client: collections with their folders and requests, and environments. The identifiers are
 * empty and the order is the order of the lists: whoever writes it down (src/storage/import.ts) gives the identifiers, the file names and the
 * order. An importer reads text and returns this; it touches no file, and it says in `notes` what it could not carry over, so that nothing is
 * lost without the person being told.
 */
export interface ImportedFolder {
  /** The name and the settings of the collection or the folder: what its requests inherit. */
  container: Container;
  requests: Request[];
  folders: ImportedFolder[];
}

export interface ImportedEnvironment {
  name: string;
  vars: Var[];
}

export interface ImportNote {
  /** Where it was found: a collection, a folder or a request, by name. */
  where: string;
  message: string;
}

export interface Imported {
  collections: ImportedFolder[];
  environments: ImportedEnvironment[];
  notes: ImportNote[];
  /** Requests that were left out because there is no way to send them from here (WebSocket, gRPC...). */
  skipped: number;
}

export const emptyImported = (): Imported => ({ collections: [], environments: [], notes: [], skipped: 0 });

export const blankFolder = (name: string): ImportedFolder => ({ container: newContainer('', name), requests: [], folders: [] });
export const blankRequest = (name: string): Request => newRequest('', name);
export const blankEnvironment = (name: string): Environment => ({ id: '', name, vars: [] });

export interface ImportedCounts {
  collections: number;
  folders: number;
  requests: number;
  environments: number;
}

/** What an import holds, in numbers, for the sentence that tells the person what happened. */
export function countImported(imported: Imported): ImportedCounts {
  let folders = 0;
  let requests = 0;
  const visit = (folder: ImportedFolder, top: boolean): void => {
    requests += folder.requests.length;
    if (!top) folders++;
    for (const child of folder.folders) visit(child, false);
  };
  for (const collection of imported.collections) visit(collection, true);
  return { collections: imported.collections.length, folders, requests, environments: imported.environments.length };
}

/** The limits of what an importer takes from one file: more than this is not a collection that somebody made. */
export const IMPORT_LIMITS = { requests: 20_000, folderDepth: 32, nameChars: 200, variables: 5000, notes: 200 } as const;

/** A note list that does not grow without end: the first ones are kept and the rest are counted. */
export class Notes {
  readonly list: ImportNote[] = [];
  private more = 0;

  add(where: string, message: string): void {
    if (this.list.length >= IMPORT_LIMITS.notes) { this.more++; return; }
    this.list.push({ where, message });
  }

  /** The notes, with a last line for the ones that were not kept. */
  done(): ImportNote[] {
    return this.more === 0 ? this.list : [...this.list, { where: '', message: `${this.more} more notes are not listed.` }];
  }
}
