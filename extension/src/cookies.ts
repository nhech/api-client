import * as vscode from 'vscode';
import { CookieJar, type Cookie } from '../../src/core/cookies';
import { isoTime } from '../../src/core/vars';
import { printable } from '../../src/util/chars';

/**
 * The cookies that the requests have received: kept for the session in the jar that every send uses, and the ones that outlive the session
 * (they have an end date) written to the secret storage of VS Code, on this computer, so that a login survives closing the window. A cookie
 * is a credential: its value is never shown in a list, never written into a file of the collection, and the person can see which ones there
 * are and delete them.
 */
const STORE_KEY = 'apiClient.cookies';
const SAVE_DELAY_MS = 500;

/** A jar that says when it changed, so that what has to be kept can be kept. */
export class NotifyingJar extends CookieJar {
  onChange: (() => void) | undefined;

  override store(url: URL, setCookies: string[]): void {
    super.store(url, setCookies);
    this.onChange?.();
  }

  override remove(name: string, domain: string, path: string): boolean {
    const removed = super.remove(name, domain, path);
    if (removed) this.onChange?.();
    return removed;
  }

  override clear(domain?: string): void {
    super.clear(domain);
    this.onChange?.();
  }
}

const describe = (cookie: Cookie): string => {
  const flags = [cookie.secure ? 'Secure' : '', cookie.httpOnly ? 'HttpOnly' : '', cookie.sameSite === '' ? '' : `SameSite=${cookie.sameSite}`].filter(flag => flag !== '').join(' ');
  return `${cookie.path} - ${cookie.expires === undefined ? 'session' : `until ${isoTime(cookie.expires).slice(0, 16).replace('T', ' ')}`}${flags === '' ? '' : ` - ${flags}`}`;
};

interface CookieItem extends vscode.QuickPickItem { cookie: Cookie }

export class CookieManager implements vscode.Disposable {
  readonly jar: NotifyingJar;
  private timer: NodeJS.Timeout | undefined;
  /** Set by the tests of the extension to choose, without anybody there, which of the cookies are deleted. */
  pick: ((items: readonly vscode.QuickPickItem[]) => Promise<readonly vscode.QuickPickItem[] | undefined>) | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.jar = new NotifyingJar(() => Date.now());
    void this.restore();
    this.jar.onChange = () => this.schedule();
  }

  private async restore(): Promise<void> {
    try {
      const saved = await this.context.secrets.get(STORE_KEY);
      if (saved !== undefined) this.jar.load(JSON.parse(saved));
    } catch { /* what cannot be read is not kept */ }
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.save(); }, SAVE_DELAY_MS);
  }

  /** Writes what outlives the session; nothing at all when there is nothing, so that no empty secret is kept. */
  async save(): Promise<void> {
    const keep = this.jar.persistent();
    if (keep.length === 0) await this.context.secrets.delete(STORE_KEY);
    else await this.context.secrets.store(STORE_KEY, JSON.stringify(keep));
  }

  /** Lists the cookies, without their values, and deletes the ones that are picked. */
  async show(): Promise<void> {
    const cookies = this.jar.list().sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : a.name < b.name ? -1 : 1));
    if (cookies.length === 0) { void vscode.window.showInformationMessage('There are no cookies: a cookie that a server sets is kept here.'); return; }
    const items: CookieItem[] = cookies.map(cookie => ({ label: printable(cookie.name), description: printable(cookie.domain), detail: describe(cookie), cookie }));
    const picked = this.pick !== undefined ? await this.pick(items) : await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Cookies: pick the ones to delete', placeHolder: 'Values are not shown. Pick none to leave them all.' });
    if (picked === undefined || picked.length === 0) return;
    for (const item of picked as CookieItem[]) this.jar.remove(item.cookie.name, item.cookie.domain, item.cookie.path);
    void vscode.window.setStatusBarMessage(`API Client: ${picked.length} ${picked.length === 1 ? 'cookie' : 'cookies'} deleted.`, 3000);
  }

  clearAll(): void {
    this.jar.clear();
    void vscode.window.setStatusBarMessage('API Client: all cookies are deleted.', 3000);
  }

  dispose(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); void this.save(); }
  }
}
