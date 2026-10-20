/**
 * An independent reading of spec N15 to N19, written from the text of the spec and kept deliberately plain (arrays,
 * loops, no limits), to be compared with the real code on random cases (property P8). It does not share a line with
 * src/convert/inherit.ts.
 */
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RefHeader { name: string; value: string; disabled: boolean }

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const asList = (value: unknown): Any[] => (Array.isArray(value) ? value : []);

/** `levels` is nearest first and the collection is the last one. */
export function refBaseUrl(url: string, levels: Any[]): { url: string; from?: number } {
  for (let i = 0; i < levels.length; i++) {
    const options = levels[i]?.options;
    const base = options && typeof options === 'object' ? options.baseUrl : undefined;
    if (isText(base)) {
      if (url === '') return { url, from: i };
      const lower = url.toLowerCase();
      const absolute = lower.indexOf('http://') === 0 || lower.indexOf('https://') === 0 || url.indexOf('{{') === 0;
      return { url: absolute ? url : base + url, from: i };
    }
  }
  return { url };
}

export function refAuth(own: Any, levels: Any[]): { source: string; type?: string; from?: number } {
  const typeOf = (auth: Any): string => (auth && isText(auth.type) ? auth.type : 'inherit');
  if (typeOf(own) !== 'inherit') return { source: 'own', type: typeOf(own) };
  for (let i = 0; i < levels.length; i++) {
    const auth = levels[i]?.auth && typeof levels[i].auth === 'object' ? levels[i].auth : undefined;
    const type = typeOf(auth);
    if (type === 'none') return { source: 'none' };
    if (type !== 'inherit') return { source: 'inherited', type, from: i };
  }
  return { source: 'none' };
}

export function refHeaders(own: RefHeader[], levels: Any[]): { header: RefHeader; from: number }[] {
  const all: RefHeader[] = own.slice();
  const added: { header: RefHeader; from: number }[] = [];
  for (let i = 0; i < levels.length; i++) {
    for (const h of asList(levels[i]?.headers)) {
      if (!h || typeof h !== 'object' || !isText(h.name)) continue;
      const blocked = all.some(existing => existing.name === h.name && existing.disabled === false);
      if (blocked) continue;
      const header: RefHeader = { name: h.name, value: typeof h.value === 'string' ? h.value : '', disabled: h.isDisabled === true };
      all.push(header);
      added.push({ header, from: i });
    }
  }
  return added;
}

export function refTests(own: Any[], levels: Any[]): { test: Any; from: number }[] {
  const checked = ['equal', '<', '<=', '>', '>=', 'schema', 'istype', 'count', 'isjson'];
  const all: Any[] = own.slice();
  const added: { test: Any; from: number }[] = [];
  for (let i = 0; i < levels.length; i++) {
    for (const t of asList(levels[i]?.tests)) {
      if (!t || typeof t !== 'object') continue;
      const duplicate = checked.indexOf(t.action) >= 0 && all.some(e => e.type === t.type && e.custom === t.custom && e.action === t.action);
      if (duplicate) continue;
      all.push(t);
      added.push({ test: t, from: i });
    }
  }
  return added;
}

export function refScripts(own: { preReq?: Any; postReq?: Any }, levels: Any[]): { pre: string[]; post: string[]; runRequests: boolean; skipRequest: boolean } {
  const pre: string[] = [];
  const post: string[] = [];
  let runRequests = false;
  let skipRequest = false;
  const read = (target: string[], scripts: Any, label: string): void => {
    for (const inline of asList(scripts?.inlineScripts)) {
      const lines = asList(inline?.script).filter(line => typeof line === 'string');
      if (lines.some(line => line.trim() !== '')) target.push(`${label}:${lines.join('\n')}`);
    }
  };
  const flags = (preReq: Any): void => {
    if (!preReq || typeof preReq !== 'object') return;
    if (asList(preReq.runRequests).length > 0) runRequests = true;
    if (preReq.options && typeof preReq.options === 'object' && preReq.options.skipRequest === true) skipRequest = true;
  };
  for (let i = levels.length - 1; i >= 0; i--) {
    read(pre, levels[i]?.preReq, `L${i}`);
    read(post, levels[i]?.postReq, `L${i}`);
    flags(levels[i]?.preReq);
  }
  read(pre, own.preReq, 'own');
  read(post, own.postReq, 'own');
  flags(own.preReq);
  return { pre, post, runRequests, skipRequest };
}
