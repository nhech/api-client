import { blankFolder, IMPORT_LIMITS, Notes, type Imported, type ImportedFolder } from './types';

/**
 * The most entries (folders and requests) that one folder of an import holds. The client reads at most 5000 entries of a folder (STORAGE_LIMITS in
 * src/storage/fs.ts) and writing a request looks at the folder it goes in, so that a folder of twenty thousand requests would be written slowly and read
 * back cut short. A folder with more is split: the first ones stay, the others go into folders called `Name (2)`, `Name (3)`, and so on.
 */
export const FOLDER_ENTRIES = 1000;

const named = (name: string, part: number): string => {
  const suffix = ` (${part})`;
  return `${name.slice(0, IMPORT_LIMITS.nameChars - suffix.length)}${suffix}`;
};

function split(folder: ImportedFolder, limit: number, notes: Notes): ImportedFolder {
  const children = folder.folders.map(child => split(child, limit, notes));
  const total = children.length + folder.requests.length;
  if (total <= limit) return { ...folder, folders: children };
  // Folders come first, as they are written; every `limit` entries are one part.
  const entries: ({ folder: ImportedFolder } | { request: ImportedFolder['requests'][number] })[] = [...children.map(child => ({ folder: child })), ...folder.requests.map(request => ({ request }))];
  const kept = entries.slice(0, limit);
  const folders = kept.flatMap(entry => ('folder' in entry ? [entry.folder] : []));
  const requests = kept.flatMap(entry => ('request' in entry ? [entry.request] : []));
  let parts = 1;
  for (let from = limit; from < entries.length; from += limit) {
    parts++;
    const chunk = entries.slice(from, from + limit);
    // The part has the settings of a new folder, so it inherits those of the folder it was cut from.
    folders.push({
      ...blankFolder(named(folder.container.name, parts)),
      folders: chunk.flatMap(entry => ('folder' in entry ? [entry.folder] : [])),
      requests: chunk.flatMap(entry => ('request' in entry ? [entry.request] : []))
    });
  }
  notes.add(folder.container.name, `It holds ${total} folders and requests, more than ${limit}: the first ${limit} stay in it, the others are in ${parts - 1} ${parts === 2 ? 'folder' : 'folders'} called ${named(folder.container.name, 2)}${parts > 2 ? ', ...' : ''}.`);
  return { container: folder.container, folders, requests };
}

/** The import with every folder cut down to what the client can write and read back; the folders that were split are said in the notes. */
export function splitLargeFolders(imported: Imported, limit: number = FOLDER_ENTRIES): Imported {
  const notes = new Notes();
  const collections = imported.collections.map(collection => split(collection, limit, notes));
  const said = notes.done();
  return said.length === 0 ? imported : { ...imported, collections, notes: [...imported.notes, ...said] };
}
