import type { ImpAuth } from '../model/ir';
import type { TcAuth } from '../model/source';
import type { Coercions } from '../normalize/coerce';
import { isRecord } from '../normalize/guards';
import { token } from './body';
import type { Issue } from './body';

/**
 * Authentication of a request, once N16 has decided which one applies (spec 5.5).
 *
 *  - bearer becomes `Authorization: Bearer <token>`;
 *  - basic becomes `Authorization: Basic <username>:<password>`, the form REST Client encodes itself, so no credential is
 *    written as base64 where it would not be recognised as one;
 *  - OAuth 2.0 and the other types are not guessed: a comment says what was there (the names of the settings, never their
 *    values) and the report says it was not converted.
 */
export interface AuthResult {
  auth: ImpAuth | undefined;
  note: string | undefined;
  issue: Issue | undefined;
}

const none = (): AuthResult => ({ auth: undefined, note: undefined, issue: undefined });

export function convertAuth(auth: TcAuth | undefined, coerce: Coercions): AuthResult {
  if (!isRecord(auth)) return none();
  const type = typeof auth.type === 'string' ? auth.type : '';
  if (type === '' || type === 'none' || type === 'inherit') return none();

  if (type === 'bearer') {
    const value = coerce.string(auth.bearer).trim().replace(/^Bearer\s+/i, '');
    return value === '' ? none() : { auth: { kind: 'bearer', token: { value, secret: false } }, note: undefined, issue: undefined };
  }

  if (type === 'basic') {
    const basic = isRecord(auth.basic) ? auth.basic : {};
    const username = coerce.string(basic['username']);
    const password = coerce.string(basic['password']);
    if (username === '' && password === '') return none();
    return { auth: { kind: 'basic', username: { value: username, secret: false }, password: { value: password, secret: false } }, note: undefined, issue: undefined };
  }

  if (type === 'oauth2') {
    const keys = isRecord(auth.oauth2) ? Object.keys(auth.oauth2).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)).sort().slice(0, 20) : [];
    return {
      auth: { kind: 'unsupported', type: 'oauth2' },
      note: `[auth oauth2 not imported${keys.length > 0 ? `; settings: ${keys.join(', ')}` : ''}]`,
      issue: { code: 'TC-AUTH-OAUTH2' }
    };
  }

  const shown = token(type);
  return { auth: { kind: 'unsupported', type: shown }, note: `[auth ${shown} not imported]`, issue: { code: 'TC-AUTH-UNSUPPORTED', message: `The ${shown} authentication type cannot be converted.` } };
}
