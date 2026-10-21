import { AUTH_KINDS, newAuth, type Auth, type AuthKind } from '../../../../src/core/model';
import { Check, Choice, Field } from './components';
import { edit } from './store';

const AUTH_LABELS: Record<AuthKind, string> = { inherit: 'Inherit from parent', none: 'No authentication', bearer: 'Bearer token', basic: 'Basic', apikey: 'API key', oauth2: 'OAuth 2.0' };

/** The authentication of a request, a folder or a collection: the same form, with the words for what it inherits from. */
export function AuthEditor(props: { auth: Auth; what: 'request' | 'folder' | 'collection' }) {
  const auth = props.auth;
  return (
    <div class="form">
      <Choice label="Type" value={auth.kind} options={AUTH_KINDS.map(kind => ({ value: kind, label: AUTH_LABELS[kind] }))} onChange={kind => edit({ op: 'set', path: ['auth'], value: newAuth(kind) as never })} />
      {auth.kind === 'inherit' ? <p class="hint">{props.what === 'collection' ? 'Nothing is above a collection: its requests are sent without authentication unless they have their own.' : `The authentication of the folder or the collection above this ${props.what} is used.`}</p> : null}
      {auth.kind === 'none' ? <p class="hint">{props.what === 'request' ? 'This request is sent without authentication, whatever its folder says.' : `What is in this ${props.what} is sent without authentication, unless a request or a folder has its own.`}</p> : null}
      {auth.kind === 'bearer' ? <><Field label="Token" value={auth.token} path={['auth', 'token']} placeholder="{{token}}" wide /><Field label="Prefix" value={auth.prefix} path={['auth', 'prefix']} placeholder="Bearer" /></> : null}
      {auth.kind === 'basic' ? <><Field label="Username" value={auth.username} path={['auth', 'username']} /><Field label="Password" value={auth.password} path={['auth', 'password']} type="password" /></> : null}
      {auth.kind === 'apikey' ? (
        <>
          <Field label="Name" value={auth.name} path={['auth', 'name']} placeholder="X-Api-Key" />
          <Field label="Value" value={auth.value} path={['auth', 'value']} placeholder="{{apiKey}}" wide />
          <Choice label="Add to" value={auth.in} options={[{ value: 'header', label: 'Header' }, { value: 'query', label: 'Query parameter' }]} onChange={where => edit({ op: 'set', path: ['auth', 'in'], value: where })} />
        </>
      ) : null}
      {auth.kind === 'oauth2' ? (
        <>
          <Choice label="Grant type" value={auth.grant} options={[{ value: 'authorization_code', label: 'Authorization code' }, { value: 'client_credentials', label: 'Client credentials' }, { value: 'password', label: 'Password' }]} onChange={grant => edit({ op: 'set', path: ['auth', 'grant'], value: grant })} />
          {auth.grant === 'authorization_code' ? <Check label="Use PKCE" checked={auth.pkce} path={['auth', 'pkce']} /> : null}
          {auth.grant === 'authorization_code' ? <Field label="Authorization URL" value={auth.authUrl} path={['auth', 'authUrl']} wide /> : null}
          <Field label="Token URL" value={auth.tokenUrl} path={['auth', 'tokenUrl']} wide />
          <Field label="Client ID" value={auth.clientId} path={['auth', 'clientId']} />
          <Field label="Client secret" value={auth.clientSecret} path={['auth', 'clientSecret']} type="password" />
          {auth.grant === 'password' ? <><Field label="Username" value={auth.username} path={['auth', 'username']} /><Field label="Password" value={auth.password} path={['auth', 'password']} type="password" /></> : null}
          <Field label="Scope" value={auth.scope} path={['auth', 'scope']} />
          <Field label="Audience" value={auth.audience} path={['auth', 'audience']} />
          <p class="hint">Getting a token comes with the next version of this screen.</p>
        </>
      ) : null}
    </div>
  );
}

