/**
 * The model of the client: what a request, a folder, a collection and an environment are, as the editor, the engine and the
 * storage all see them. It holds no file format and no VS Code: src/format/schema turns it into files and back, and
 * src/core/inherit walks a request up through its folders. Every scalar is a string or a number or a flag; nothing here is code.
 */
export type Id = string;

/** A row of headers, query parameters, path parameters or form fields. */
export interface KV {
  name: string;
  value: string;
  enabled: boolean;
  description: string;
}

/** A variable of an environment, a folder, a collection or the workspace. A secret keeps its value out of the shared files. */
export interface Var {
  name: string;
  value: string;
  secret: boolean;
  enabled: boolean;
}

export type HttpVersion = '1.1' | '2' | 'auto';

export interface Settings {
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  rejectUnauthorized: boolean;
  httpVersion: HttpVersion;
  responseLimitBytes: number;
  encodeUrl: boolean;
  cookies: boolean;
}
/** A level (workspace, collection, folder, request) sets only the fields it changes. */
export type SettingsOverride = Partial<Settings>;

export const DEFAULT_SETTINGS: Settings = {
  timeoutMs: 30_000,
  followRedirects: true,
  maxRedirects: 10,
  rejectUnauthorized: true,
  httpVersion: '1.1',
  responseLimitBytes: 10 * 1024 * 1024,
  encodeUrl: true,
  cookies: true
};

export type OAuthGrant = 'authorization_code' | 'client_credentials' | 'password';

export type Auth =
  | { kind: 'inherit' }
  | { kind: 'none' }
  | { kind: 'bearer'; token: string; prefix: string }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'apikey'; name: string; value: string; in: 'header' | 'query' }
  | {
      kind: 'oauth2';
      grant: OAuthGrant;
      pkce: boolean;
      authUrl: string;
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      scope: string;
      audience: string;
      username: string;
      password: string;
      redirectUrl: string;
      clientAuth: 'header' | 'body';
      extra: KV[];
    };

/** A part of a multipart body: a text field, or a file named by a path relative to the collection's folder. */
export interface Part {
  name: string;
  kind: 'text' | 'file';
  value: string;
  file: string;
  contentType: string;
  enabled: boolean;
}

export type Body =
  | { kind: 'none' }
  | { kind: 'text'; contentType: string; text: string }
  | { kind: 'json'; text: string }
  | { kind: 'xml'; text: string }
  | { kind: 'form'; fields: KV[] }
  | { kind: 'multipart'; parts: Part[] }
  | { kind: 'graphql'; query: string; variables: string }
  | { kind: 'binary'; file: string };

/** JavaScript run by the script sandbox around a request; empty means none. */
export interface Scripts {
  pre: string;
  post: string;
}

/** A line of the assertion grammar (`status == 200`, `json $.id exists`), with a switch. */
export interface Assertion {
  expr: string;
  enabled: boolean;
}
/** A line of the capture grammar (`token = json $.access_token`), with a switch. */
export interface Capture {
  expr: string;
  enabled: boolean;
}

export interface Request {
  id: Id;
  name: string;
  docs: string;
  method: string;
  url: string;
  query: KV[];
  pathParams: KV[];
  headers: KV[];
  auth: Auth;
  body: Body;
  scripts: Scripts;
  tests: Assertion[];
  captures: Capture[];
  settings: SettingsOverride;
  /** Whether a `.http` file is written next to this request's file. */
  mirror: boolean;
}

/** What a collection and a folder have in common: what their requests inherit, and the order of what they hold. */
export interface Container {
  id: Id;
  name: string;
  docs: string;
  /** Used for a request URL that is not absolute. */
  baseUrl: string;
  headers: KV[];
  auth: Auth;
  vars: Var[];
  scripts: Scripts;
  tests: Assertion[];
  settings: SettingsOverride;
  /** File or folder names (slugs) in the order they are shown; whatever is not listed follows, sorted. */
  order: string[];
}

export interface Environment {
  id: Id;
  name: string;
  vars: Var[];
}

/** `workspace.yml`: the settings and the global variables of the whole folder, and the order of its collections. */
export interface WorkspaceFile {
  settings: SettingsOverride;
  vars: Var[];
  collections: string[];
}

export const emptyScripts = (): Scripts => ({ pre: '', post: '' });

export type AuthKind = Auth['kind'];
export type BodyKind = Body['kind'];
export const AUTH_KINDS: readonly AuthKind[] = ['inherit', 'none', 'bearer', 'basic', 'apikey', 'oauth2'];
export const BODY_KINDS: readonly BodyKind[] = ['none', 'text', 'json', 'xml', 'form', 'multipart', 'graphql', 'binary'];

/** An authentication of a kind with its fields empty, for when the person chooses the kind. */
export function newAuth(kind: AuthKind): Auth {
  switch (kind) {
    case 'bearer': return { kind, token: '', prefix: 'Bearer' };
    case 'basic': return { kind, username: '', password: '' };
    case 'apikey': return { kind, name: '', value: '', in: 'header' };
    case 'oauth2':
      return { kind, grant: 'authorization_code', pkce: true, authUrl: '', tokenUrl: '', clientId: '', clientSecret: '', scope: '', audience: '', username: '', password: '', redirectUrl: '', clientAuth: 'header', extra: [] };
    default: return { kind };
  }
}

/** A body of a kind, empty, for when the person chooses the kind. */
export function newBody(kind: BodyKind): Body {
  switch (kind) {
    case 'text': return { kind, contentType: 'text/plain', text: '' };
    case 'json':
    case 'xml': return { kind, text: '' };
    case 'form': return { kind, fields: [] };
    case 'multipart': return { kind, parts: [] };
    case 'graphql': return { kind, query: '', variables: '' };
    case 'binary': return { kind, file: '' };
    default: return { kind };
  }
}

export const newRequest = (id: Id, name: string): Request => ({
  id, name, docs: '', method: 'GET', url: '', query: [], pathParams: [], headers: [], auth: { kind: 'inherit' }, body: { kind: 'none' },
  scripts: emptyScripts(), tests: [], captures: [], settings: {}, mirror: true
});

export const newContainer = (id: Id, name: string): Container => ({
  id, name, docs: '', baseUrl: '', headers: [], auth: { kind: 'inherit' }, vars: [], scripts: emptyScripts(), tests: [], settings: {}, order: []
});

export const newEnvironment = (id: Id, name: string): Environment => ({ id, name, vars: [] });
export const newWorkspaceFile = (): WorkspaceFile => ({ settings: {}, vars: [], collections: [] });
