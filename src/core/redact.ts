import { printable } from '../util/chars';

/**
 * Which names and values are secret, for everything that writes a request or a response down: history, logs, reports, code
 * snippets. A header or a parameter is secret by its name; a variable is secret because it says so; and whatever value of a
 * secret variable shows up in text is covered, wherever it came from.
 */
const SECRET_NAME = /(?:^|[-_.\s])(?:authorization|auth|token|secret|password|passwd|pwd|api[-_]?key|apikey|key|credential|cookie|session|signature|bearer)(?:$|[-_.\s]|s$)|^(?:authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;

export const isSecretName = (name: string): boolean => SECRET_NAME.test(name.trim());

/** Headers that never cross to another origin on a redirect, whatever their name. */
export const CREDENTIAL_HEADERS: readonly string[] = ['authorization', 'proxy-authorization', 'cookie'];

export const REDACTED = '[redacted]';

/** Values shorter than this are not searched for in text: a secret of two characters would hide half of everything. */
export const MIN_SECRET_LENGTH = 4;

/** A value longer than this is searched for as it is and in no other form: nobody types a secret of that size, and a hostile file could make the forms of a very long one cost a lot. */
const MAX_DERIVED_CHARS = 8192;
const FORMS_CACHE_SIZE = 256;
const formsCache = new Map<string, string[]>();

/**
 * The ways a value is written once it is in an address, a form or a JSON text: percent-encoded (`a/b=c` is `a%2Fb%3Dc`), with a plus for a space, with the
 * characters that a form also encodes (`!'()~`), the way an address is written with its slashes kept (`encodeURI`), encoded twice, with the escapes of JSON,
 * and in lower case hex, which some servers and tools write. A secret that was put into a query or a path by a send is in the text in one of these forms, not
 * as the person typed it. The forms of a value are made once and kept (a bounded number of them).
 */
export function secretForms(value: string): string[] {
  const known = formsCache.get(value);
  if (known !== undefined) return known;
  const forms = new Set<string>([value]);
  if (value.length <= MAX_DERIVED_CHARS) {
    const strict = (text: string): string => text.replace(/[!'()~]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    try {
      const encoded = encodeURIComponent(value);
      const plus = encoded.replace(/%20/g, '+');
      for (const form of [encoded, plus, strict(encoded), strict(plus), encodeURIComponent(encoded)]) forms.add(form);
    } catch { /* a lone surrogate has no encoding */ }
    try {
      const address = encodeURI(value);
      forms.add(address);
      forms.add(address.replace(/'/g, '%27'));
    } catch { /* the same */ }
    forms.add(JSON.stringify(value).slice(1, -1));
    for (const form of [...forms]) forms.add(form.replace(/%[0-9A-F]{2}/g, escape => escape.toLowerCase()));
  }
  forms.delete('');
  const list = [...forms];
  if (formsCache.size >= FORMS_CACHE_SIZE) formsCache.clear();
  formsCache.set(value, list);
  return list;
}

/** The text with every value of `secrets` replaced (as typed and as put into an address or a form), longest first so that a value that contains another is covered whole. Linear in the size of the text for each form. */
export function redactValues(text: string, secrets: readonly string[]): string {
  const values = [...new Set(secrets.filter(value => value.length >= MIN_SECRET_LENGTH).flatMap(secretForms))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) if (out.includes(value)) out = out.split(value).join(REDACTED);
  return out;
}

/** The value to show for a header or parameter: the value, or `[redacted]` when its name is secret or it holds a known secret value. */
export function redactedValue(name: string, value: string, secrets: readonly string[]): string {
  return isSecretName(name) ? REDACTED : redactValues(value, secrets);
}

/** The base64 of "user:password", which is how a Basic credential travels: it is a secret value too. */
export function basicCredential(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ---- covering the secrets of an address and of a body, by what they are called ----

/** A name written in camel case ("accessToken") as the words that the rule for secret names knows ("access_token"). */
const words = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
export const secretField = (name: string): boolean => isSecretName(words(name));

function decoded(text: string): string {
  try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch { return text; }
}

/** The address without what is secret in it: the user and password, the secret values, and the value of a parameter whose name is secret. */
export function hideUrl(url: string, redactions: readonly string[]): string {
  let out = redactValues(url, redactions);
  out = out.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, (_match, scheme: string) => `${scheme}${REDACTED}@`);
  const hash = out.indexOf('#');
  const fragment = hash < 0 ? '' : '#';
  if (hash >= 0) out = out.slice(0, hash);
  const question = out.indexOf('?');
  if (question >= 0) {
    const query = out.slice(question + 1).split('&').map(piece => {
      const equals = piece.indexOf('=');
      return equals < 0 || !secretField(decoded(piece.slice(0, equals))) ? piece : `${piece.slice(0, equals + 1)}${REDACTED}`;
    });
    out = `${out.slice(0, question + 1)}${query.join('&')}`;
  }
  return printable(out + fragment);
}

/** A string value of a JSON text whose key says it is secret: `"access_token": "..."`. */
const JSON_FIELD = /"((?:[^"\\\r\n]|\\.){1,100})"(\s*:\s*)"(?:[^"\\\r\n]|\\.)*"/g;

/** The text of a body with the secrets covered: the values that are known, and the fields (of JSON or of a form) whose names say they are secret. */
export function hideSecrets(text: string, redactions: readonly string[]): string {
  const covered = redactValues(text, redactions);
  const json = covered.replace(JSON_FIELD, (match, key: string, separator: string) => (secretField(key) ? `"${key}"${separator}"${REDACTED}"` : match));
  const pieces = json.trim().split('&');
  if (json.length > 0 && pieces.every(piece => /^[^\s=]{1,100}=\S*$/.test(piece))) {
    return pieces.map(piece => {
      const equals = piece.indexOf('=');
      return secretField(decoded(piece.slice(0, equals))) ? `${piece.slice(0, equals + 1)}${REDACTED}` : piece;
    }).join('&');
  }
  return json;
}
