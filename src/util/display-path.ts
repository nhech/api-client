/**
 * A path as it is shown to the person: the home folder becomes "~". The comparison ignores letter case (on Windows an editor reports
 * `c:\Users\me` where the system says `C:\Users\me`) and only cuts at a folder boundary, so `/home/me` is not taken for the start of `/home/media`.
 */
export function shortenHome(fsPath: string, home: string): string {
  const base = home.replace(/[\\/]+$/, '');
  if (base === '' || fsPath.length < base.length) return fsPath;
  if (fsPath.slice(0, base.length).toLowerCase() !== base.toLowerCase()) return fsPath;
  const next = fsPath.charAt(base.length);
  return next === '' || next === '/' || next === '\\' ? `~${fsPath.slice(base.length)}` : fsPath;
}
