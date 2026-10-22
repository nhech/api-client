import type { SourceFile } from './types';

/**
 * The address a project listens on: from its configuration (`server.port`, `launchSettings.json`, `.env`), else from the code (`listen(3000)`), else from
 * what the framework does when it is not told. It is always a guess about the machine of the person, so it goes into an environment of its own, `Local`.
 */
const DEFAULT_PORTS: Record<string, number> = {
  Express: 3000, NestJS: 3000, Fastify: 3000, Koa: 3000, Hono: 3000, Elysia: 3000, Restify: 3000,
  Spring: 8080, FastAPI: 8000, Flask: 5000, Django: 8000, Laravel: 8000,
  Gin: 8080, Echo: 8080, Fiber: 8080, chi: 8080, 'gorilla/mux': 8080, httprouter: 8080, 'net/http': 8080, Actix: 8080, Rocket: 8000
};

const base = (path: string): string => path.split('/').pop() ?? path;

/** The first of the files with this name: the one nearest the root, then by path, so that the choice does not depend on the order of the list. */
function pick(files: readonly SourceFile[], name: string): SourceFile | undefined {
  return files
    .filter(file => base(file.path) === name)
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))[0];
}

const portOf = (text: string | undefined): number | undefined => {
  const port = text === undefined ? NaN : Number(text);
  return port >= 1 && port <= 65535 ? port : undefined;
};

/** The dotted keys of a YAML file of Spring, and their values: only what a person writes in `application.yml`, nested mappings of plain values. */
function yamlKeys(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const stack: { indent: number; key: string }[] = [];
  for (const raw of text.split('\n')) {
    if (/^---/.test(raw) && found.size > 0) break;
    const line = raw.replace(/\r$/, '');
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = /^(\s*)([A-Za-z0-9_.-]{1,80})\s*:\s*(.{0,200}?)\s*$/.exec(line);
    if (match === null) continue;
    const indent = (match[1] as string).length;
    while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent) stack.pop();
    const value = (match[3] as string).replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
    const key = [...stack.map(item => item.key), match[2] as string].join('.');
    if (value === '') stack.push({ indent, key: match[2] as string });
    else found.set(key, value);
  }
  return found;
}

/** A context path is a path: letters, digits and a few marks. It goes into the address of every request, so braces, a host or anything that changes the address are not taken. */
const plainContext = (context: string): string => (/^[\w./~-]{1,200}$/.test(context) && !context.includes('..') ? context : '');

function springBase(files: readonly SourceFile[]): string | undefined {
  const properties = pick(files, 'application.properties');
  const yaml = pick(files, 'application.yml') ?? pick(files, 'application.yaml');
  let port: number | undefined;
  let context = '';
  if (properties !== undefined) {
    port = portOf(/^\s*server\.port\s*[=:]\s*(\d{2,5})\s*$/m.exec(properties.text)?.[1]);
    context = plainContext(/^\s*server\.(?:servlet\.)?context-path\s*[=:]\s*(\S{1,200})\s*$/m.exec(properties.text)?.[1] ?? '');
  }
  if (yaml !== undefined && (port === undefined || context === '')) {
    const keys = yamlKeys(yaml.text);
    port ??= portOf(keys.get('server.port'));
    if (context === '') context = plainContext(keys.get('server.servlet.context-path') ?? keys.get('server.context-path') ?? '');
  }
  if (port === undefined && context === '') return undefined;
  const path = context === '' || context === '/' ? '' : `/${context.replace(/^\/+|\/+$/g, '')}`;
  return `http://localhost:${port ?? 8080}${path}`;
}

function dotnetBase(files: readonly SourceFile[], notes: string[]): string | undefined {
  const launch = pick(files, 'launchSettings.json');
  const urls: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') urls.push(...value.split(';'));
  };
  if (launch !== undefined) {
    try {
      const parsed = JSON.parse(launch.text) as { profiles?: Record<string, { applicationUrl?: unknown }> };
      const profiles = parsed.profiles;
      if (typeof profiles === 'object' && profiles !== null) for (const key of Object.keys(profiles).sort()) collect(Object.hasOwn(profiles, key) ? profiles[key]?.applicationUrl : undefined);
    } catch { /* a file that is not JSON says nothing */ }
  }
  const settings = pick(files, 'appsettings.json');
  if (urls.length === 0 && settings !== undefined) {
    try {
      const parsed = JSON.parse(settings.text) as { Urls?: unknown; Kestrel?: { Endpoints?: Record<string, { Url?: unknown }> } };
      collect(parsed.Urls);
      const endpoints = parsed.Kestrel?.Endpoints;
      if (typeof endpoints === 'object' && endpoints !== null) for (const key of Object.keys(endpoints).sort()) collect(Object.hasOwn(endpoints, key) ? endpoints[key]?.Url : undefined);
    } catch { /* the same */ }
  }
  const valid = urls.map(url => url.trim()).filter(url => /^https?:\/\/[A-Za-z0-9.*+_[\]:-]{1,100}(?::\d{2,5})?\/?$/.test(url));
  const chosen = valid.find(url => url.startsWith('http://')) ?? valid[0];
  if (chosen === undefined) return undefined;
  // The address is the one the program listens on, on this machine: a host that is not this machine (a file in a repository can say anything) is not taken,
  // because every request would be sent to it. Only the scheme and the port are.
  const parts = /^(https?):\/\/([^:/[]+|\[[^\]]+\])(?::(\d{2,5}))?\/?$/.exec(chosen);
  if (parts === null) return undefined;
  const host = (parts[2] as string).toLowerCase();
  if (!LOOPBACK.has(host) && !WILDCARD.has(host)) notes.push(`The configuration of the program names the host ${host.slice(0, 60)}: only its port is used, on localhost.`);
  return `${parts[1]}://${LOOPBACK.has(host) ? host : 'localhost'}${parts[3] === undefined ? '' : `:${parts[3]}`}`;
}

/** The hosts that mean this machine, and the ones a server listens on to be reached by any address (they mean this machine to whoever starts it). */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const WILDCARD = new Set(['*', '+', '0.0.0.0', '[::]']);

/** `http://localhost:<port>`, from the configuration of the project, from the code or from the default of the framework. */
export function guessBaseUrl(primary: string, files: readonly SourceFile[], codePort: number | undefined, notes: string[] = []): string {
  let fromConfig: string | undefined;
  if (primary === 'Spring') fromConfig = springBase(files);
  else if (primary === 'ASP.NET Core') fromConfig = dotnetBase(files, notes);
  else {
    const env = pick(files, '.env');
    const port = env === undefined ? undefined : portOf(/^\s*(?:export\s+)?PORT\s*=\s*["']?(\d{2,5})["']?\s*(?:#.*)?$/m.exec(env.text)?.[1]);
    // Laravel is told its address by APP_URL, not PORT.
    if (port !== undefined && primary !== 'Laravel') fromConfig = `http://localhost:${port}`;
  }
  if (fromConfig !== undefined) return fromConfig;
  if (codePort !== undefined) return `http://localhost:${codePort}`;
  if (primary === 'ASP.NET Core') return 'http://localhost:5000';
  return `http://localhost:${DEFAULT_PORTS[primary] ?? 3000}`;
}
