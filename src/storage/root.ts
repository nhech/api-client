import { DEFAULT_ROOT } from './store';

/**
 * The folder of the workspace that holds the client's files, from the setting `apiClient.root`. A repository can set it (it is a setting of the workspace, so that a team can keep
 * its files where it likes), which is why it is held to a folder that is plainly a place for such files: a relative path of ordinary names inside the workspace folder, and
 * not the folder in which a version control system keeps its own files, nor the one of the installed packages.
 */
const FORBIDDEN = new Set(['.', '..', '.git', '.hg', '.svn', '.bzr', 'node_modules']);

export function clientRoot(configured: string): string {
  const cleaned = configured.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(cleaned)) return DEFAULT_ROOT;
  return cleaned.split('/').some(segment => FORBIDDEN.has(segment.toLowerCase()) || /^\.+$/.test(segment)) ? DEFAULT_ROOT : cleaned;
}
