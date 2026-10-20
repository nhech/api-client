import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { entryRole } from './reader/layout';

/**
 * Where Thunder Client keeps its data on this machine (spec 2.4). It only suggests a few paths and never scans: the person can
 * always pick a folder. A suggestion is shown only when the folder exists, with counts taken from file NAMES; no file is opened.
 */
export const THUNDER_EXTENSION_ID = 'rangav.vscode-thunder-client';

export interface DiscoverEnvironment {
  platform: 'win32' | 'darwin' | 'linux';
  /** The user's home folder. */
  home: string;
  /** `%APPDATA%` on Windows. */
  appData?: string | undefined;
  /** The parent of this editor's `globalStorageUri` (it holds the data of every extension of this editor), when known. */
  globalStorageRoot?: string | undefined;
}

/** Names of the applications that keep their settings in a folder of their own, in the order they are suggested. */
const APPLICATIONS = ['Code', 'Code - Insiders', 'VSCodium'] as const;

/** The paths to suggest, most likely first, without duplicates. Pure: nothing is checked on disk. */
export function candidatePaths(env: DiscoverEnvironment): string[] {
  const join = env.platform === 'win32' ? path.win32.join : path.posix.join;
  const found: string[] = [];
  const add = (...parts: string[]): void => {
    const full = join(...parts);
    if (!found.includes(full)) found.push(full);
  };
  if (env.globalStorageRoot !== undefined && env.globalStorageRoot !== '') add(env.globalStorageRoot, THUNDER_EXTENSION_ID);
  const settingsRoot = env.platform === 'win32'
    ? (env.appData !== undefined && env.appData !== '' ? env.appData : join(env.home, 'AppData', 'Roaming'))
    : env.platform === 'darwin' ? join(env.home, 'Library', 'Application Support') : join(env.home, '.config');
  for (const application of APPLICATIONS) add(settingsRoot, application, 'User', 'globalStorage', THUNDER_EXTENSION_ID);
  if (env.platform !== 'win32') add(env.home, '.vscode-server', 'data', 'User', 'globalStorage', THUNDER_EXTENSION_ID);
  return found;
}

export interface Candidate {
  path: string;
  /** Collections and environments of the v4 layout, counted by file name. */
  collections: number;
  environments: number;
  /** Files of the v3 layout are there. */
  v3: boolean;
}

/** The suggestions that exist on disk. A link is not followed and a folder that cannot be listed is left out. */
export async function inspectCandidates(paths: readonly string[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const candidate of paths) {
    try {
      const stats = await fs.lstat(candidate);
      if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
      const top = await fs.readdir(candidate);
      const names = async (sub: string): Promise<string[]> => {
        try {
          const folder = path.join(candidate, sub);
          const info = await fs.lstat(folder);
          return info.isDirectory() && !info.isSymbolicLink() ? await fs.readdir(folder) : [];
        } catch { return []; }
      };
      const collections = (await names('collections')).filter(name => entryRole(name, 'collections') === 'v4-collection').length;
      const environments = (await names('environments')).filter(name => entryRole(name, 'environments') === 'v4-environment').length;
      const v3 = top.some(name => ['thunderclient.json', 'thundercollection.json'].includes(name.toLowerCase()));
      if (collections > 0 || environments > 0 || v3) out.push({ path: candidate, collections, environments, v3 });
    } catch { /* not there, or not readable: not a suggestion */ }
  }
  return out;
}
