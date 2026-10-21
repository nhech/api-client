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

/** The text with every value of `secrets` replaced, longest first so that a value that contains another is covered whole. Linear in the size of the text for each value. */
export function redactValues(text: string, secrets: readonly string[]): string {
  const values = [...new Set(secrets.filter(value => value.length >= MIN_SECRET_LENGTH))].sort((a, b) => b.length - a.length);
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
