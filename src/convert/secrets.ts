import { hasLiteral } from './text';

/**
 * Secrets (spec 8.3). A credential that is a literal in the data (a typed-in token, not just `{{variables}}`) must not end
 * up in a file that goes into Git. With `moveSecrets` (the default) it is replaced by `{{secret_...}}` in the shared files and
 * the value goes to the private environment file, once per distinct value; without it the literal stays and is reported.
 */

/**
 * Headers whose literal value is a credential (spec 8.3): `Authorization`, `X-Api-Key`, `Ocp-Apim-Subscription-Key`,
 * `X-Amz-Security-Token`, `Cookie`... A header is taken for one when a word of its name (words are separated by - or _) says so.
 * Wrongly taking one costs a variable to fill in; wrongly leaving one puts a credential in Git.
 */
export const SECRET_HEADER = /(?:^|[-_])(?:authorization|auth|token|secret|password|passwd|pwd|credentials?|cookie|session|signature|apikey|key)(?:$|[-_])/i;

/** Environment variables whose name says they hold a secret. */
export const SECRET_VARIABLE = /(?:secret|token|password|passwd|pwd|key|credential|auth)/i;

const SCHEME = /^(Bearer|Basic|Digest|Token|OAuth|Negotiate|NTLM)(\s+)([\s\S]*)$/i;

/** An `Authorization` style value split into its scheme word and the credential. */
export function splitCredential(value: string): { prefix: string; credential: string } {
  const found = SCHEME.exec(value);
  return found === null ? { prefix: '', credential: value } : { prefix: `${found[1]}${found[2]}`, credential: found[3] ?? '' };
}

export interface Protected {
  /** What goes in the shared file. */
  text: string;
  /** The literal was replaced by a variable whose value is in the private file. */
  moved: boolean;
  /** The literal is still there, because moving was switched off. */
  literal: boolean;
}

/** A name part from a collection name or a header name: lower case letters and digits joined by "_". */
export function variablePart(text: string, fallback = 'api'): string {
  const part = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return part === '' ? fallback : part.slice(0, 40);
}

export class SecretStore {
  /** The private variables, in the order they were met: name to value. */
  readonly variables = new Map<string, string>();
  moved = 0;
  private readonly named = new Map<string, string>();
  private readonly taken = new Map<string, number>();

  constructor(readonly moveSecrets: boolean) {}

  /** `label` says what the value is (`bearer_token`, `basic_password`, `header_authorization`); `scope` is the collection. */
  protect(scope: string, label: string, value: string): Protected {
    if (!hasLiteral(value)) return { text: value, moved: false, literal: false };
    if (!this.moveSecrets) return { text: value, moved: false, literal: true };
    const base = `secret_${variablePart(scope)}_${variablePart(label, 'value')}`;
    const key = JSON.stringify([base, value]);
    let name = this.named.get(key);
    if (name === undefined) {
      const count = (this.taken.get(base) ?? 0) + 1;
      this.taken.set(base, count);
      name = count === 1 ? base : `${base}_${count}`;
      this.named.set(key, name);
      this.variables.set(name, value);
    }
    this.moved++;
    return { text: `{{${name}}}`, moved: true, literal: false };
  }

  /** A header value: for a credential header only the credential part is protected, so `Bearer {{x}}` keeps its scheme. */
  protectHeader(scope: string, headerName: string, value: string): Protected {
    if (!SECRET_HEADER.test(headerName)) return { text: value, moved: false, literal: false };
    const { prefix, credential } = splitCredential(value);
    const result = this.protect(scope, `header_${headerName}`, credential);
    return { ...result, text: `${prefix}${result.text}` };
  }
}
