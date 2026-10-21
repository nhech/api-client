import { protectBodyText, protectGraphqlQuery, protectJson } from '../convert/body-secrets';
import { SECRET_VARIABLE, SecretStore } from '../convert/secrets';
import { hasLiteral, indexOutsideVariables, splitOutsideVariables } from '../convert/text';
import type { Auth, Body, Container, KV, Request, Var } from '../core/model';
import type { ImportedFolder } from './types';

/**
 * A credential that is typed into what is imported (a token in a header, a password, a key in the body) must not end up in a file that goes into Git.
 * It is replaced by `{{secret_collection_what}}` and its value becomes a secret variable of the collection, whose value the store writes to the file
 * next to `collection.yml` that Git ignores. One value that is used in many requests is one variable. What was already a `{{variable}}` is left as it
 * is, and so is a value that is not a secret by its name.
 */
export class Credentials {
  readonly store: SecretStore;
  /** `existing`: the variables the collection or folder already has, so that a new secret never takes the name of one of them. */
  constructor(private readonly scope: string, existing: readonly Var[] = []) {
    this.store = new SecretStore(true, new Map(existing.map(variable => [variable.name, variable.value])));
  }

  get moved(): number {
    return this.store.moved;
  }

  /** The secret variables that were made, to be added to the collection. */
  vars(): Var[] {
    return [...this.store.variables].map(([name, value]) => ({ name, value, secret: true, enabled: true }));
  }

  private value(label: string, text: string): string {
    return this.store.protect(this.scope, label, text).text;
  }

  /** What stands for a field whose name says it is a secret, or the value as it was. */
  private named(prefix: string): (name: string, value: string) => string {
    return (name, value) => (SECRET_VARIABLE.test(name) && hasLiteral(value) ? this.value(`${prefix}_${name}`, value) : value);
  }

  private rows(list: readonly KV[], prefix: string): KV[] {
    const protect = this.named(prefix);
    return list.map(row => ({ ...row, value: protect(row.name, row.value) }));
  }

  auth(auth: Auth): Auth {
    switch (auth.kind) {
      case 'bearer': return { ...auth, token: this.value('bearer_token', auth.token) };
      case 'basic': return { ...auth, password: this.value('basic_password', auth.password) };
      case 'apikey': return { ...auth, value: this.value(`apikey_${auth.name}`, auth.value) };
      case 'oauth2': return { ...auth, clientSecret: this.value('oauth_client_secret', auth.clientSecret), password: this.value('oauth_password', auth.password), extra: this.rows(auth.extra, 'oauth') };
      default: return auth;
    }
  }

  headers(list: readonly KV[]): KV[] {
    return list.map(row => ({ ...row, value: this.store.protectHeader(this.scope, row.name, row.value).text }));
  }

  private body(body: Body): Body {
    const named = this.named('body');
    switch (body.kind) {
      case 'text': return { ...body, text: protectBodyText(body.text, named) };
      case 'json':
      case 'xml': return { ...body, text: protectBodyText(body.text, named) };
      case 'form': return { ...body, fields: this.rows(body.fields, 'form') };
      case 'multipart': return { ...body, parts: body.parts.map(part => (part.kind === 'text' ? { ...part, value: this.named('form')(part.name, part.value) } : part)) };
      case 'graphql': return { ...body, query: protectGraphqlQuery(body.query, named), variables: body.variables === '' ? '' : protectJson(body.variables, named) };
      default: return body;
    }
  }

  /**
   * `https://user:password@host`: the password, or the whole of a userinfo that has no colon (a token), is protected. A fragment of pairs
   * (`#access_token=...&state=1`, which is how an OAuth redirect carries a token) is protected like a query.
   */
  private url(address: string): string {
    let url = address;
    const found = /^([a-z][a-z0-9+.-]*:\/\/)([^/@?#]*)@/i.exec(url);
    if (found !== null) {
      const [whole, scheme, userinfo] = found as unknown as [string, string, string];
      const colon = userinfo.indexOf(':');
      const replaced = colon < 0 ? this.value('url_token', userinfo) : `${userinfo.slice(0, colon + 1)}${this.value('url_password', userinfo.slice(colon + 1))}`;
      if (replaced !== userinfo) url = `${scheme}${replaced}@${url.slice(whole.length)}`;
    }
    const hash = indexOutsideVariables(url, '#');
    if (hash < 0 || hash === url.length - 1) return url;
    const protect = this.named('fragment');
    const pairs = splitOutsideVariables(url.slice(hash + 1), '&').map(piece => {
      const equals = indexOutsideVariables(piece, '=');
      return equals < 0 ? piece : `${piece.slice(0, equals)}=${protect(piece.slice(0, equals), piece.slice(equals + 1))}`;
    });
    return `${url.slice(0, hash + 1)}${pairs.join('&')}`;
  }

  request(request: Request): Request {
    return {
      ...request, url: this.url(request.url), query: this.rows(request.query, 'query'), pathParams: this.rows(request.pathParams, 'path'),
      headers: this.headers(request.headers), auth: this.auth(request.auth), body: this.body(request.body)
    };
  }

  /** The variables of a collection or a folder: the ones named like a secret are marked, so that their values are kept out of the shared file. */
  private markSecrets(list: readonly Var[]): Var[] {
    return list.map(variable => (SECRET_VARIABLE.test(variable.name) && hasLiteral(variable.value) ? { ...variable, secret: true } : variable));
  }

  container(container: Container): Container {
    return { ...container, headers: this.headers(container.headers), auth: this.auth(container.auth), vars: this.markSecrets(container.vars) };
  }

  /** The folder and everything below it, protected in place of the original (which is not changed). */
  folder(folder: ImportedFolder): ImportedFolder {
    return { container: this.container(folder.container), requests: folder.requests.map(request => this.request(request)), folders: folder.folders.map(child => this.folder(child)) };
  }
}

/** The collection with its credentials moved to secret variables of its own, and how many were moved. */
export function protectCollection(collection: ImportedFolder): { collection: ImportedFolder; moved: number } {
  const credentials = new Credentials(collection.container.name, collection.container.vars);
  const protectedFolder = credentials.folder(collection);
  const made = credentials.vars();
  const known = new Set(protectedFolder.container.vars.map(variable => variable.name));
  protectedFolder.container = { ...protectedFolder.container, vars: [...protectedFolder.container.vars, ...made.filter(variable => !known.has(variable.name))] };
  return { collection: protectedFolder, moved: credentials.moved };
}
