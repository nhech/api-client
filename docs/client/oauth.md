# OAuth 2.0: how a request gets its access token

A request, a folder or a collection can have OAuth 2.0 authentication (the **Auth** tab). Before the request is sent the extension makes sure it has an access token, and sends it as `Authorization: Bearer ...`. The requests to the token server and the reading of its answers are in `src/engine/oauth.ts` (pure, tested without a server), the one-shot server for the sign-in answer is `src/engine/loopback.ts`, and the part that keeps tokens and asks the person is `extension/src/oauth.ts`.

## Grants

- **Client credentials** and **password**: the extension asks the token server by itself.
- **Authorization code**, with PKCE (S256) on by default: the browser opens the sign-in page of the provider, the provider sends the person back to a server on this computer, the extension exchanges the code (with the PKCE verifier) for a token.
- A **refresh token**, when the server gives one, renews the access token before it runs out (30 seconds in hand) without asking the person again.

The client credentials go in an `Authorization: Basic` header (form-encoded as RFC 6749 says) or in the body (`clientAuth`). A client with no secret is a public one: it sends `client_id` in the body and nothing to authenticate with. `scope`, `audience` and extra parameters go with the request; a refresh and the exchange of a code do not repeat the scope.

## Where the token lives

In the **secret storage of VS Code**, on this computer, under a key made from what the token is for: the collection, the grant, the token URL, the client ID, the scope, the audience (and the username for the password grant). Change any of them and a new token is asked for. A token is never written into a file of the collection, a `.http` mirror, the history, a response view or anything the page is told (the page only learns "valid for 54 min" or "expired", and the scope). The secret values in the settings (client secret, password) should be `{{variables}}`: if they are typed in, they are in the file of the request, and the `.http` mirror writes them as `{{secret_...}}` variables instead of as typed.

"Forget Access Tokens and Allowed Token Servers" (command palette) deletes every token that was kept, and the list of servers that were allowed.

## Who is asked, and what is refused

The address of the token server comes from the collection, which can come from somebody else, and the client secret goes there. So:

1. **The first time a collection is to send credentials to a server, or to open a sign-in page of one, the person is asked**, naming the server (host and port). The answer is kept for that server in that collection; a different server asks again. An answer of no sends nothing.
2. **Only https**, except on this computer (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`): credentials are not sent in the clear.
3. What the server answers is **read as data**, field by field. A refusal is told with the `error` word and a short description, never with the body, which may hold a token. A token or a field that is far too large is not one.

## The sign-in answer (authorization code)

A server on this computer, bound to `127.0.0.1` only, that waits for one answer and closes (`src/engine/loopback.ts`). It accepts a request for the one agreed path, with the `Host` header of the agreed address (a page of the web cannot reach it through a name that points here), and the `state` made for this attempt (compared in constant time); anything else is answered and ignored, it does not end the wait. It reads no body, answers with a fixed page that repeats nothing of the request, and gives up after 5 minutes or when the person cancels. A redirect address registered with the provider is used as it is, but only on this computer, with a port.

## In the page

The Auth tab of a request whose authentication (its own or inherited) is OAuth 2.0 shows whether there is a token, with **Get a token** (without sending the request) and **Forget the token**. A failure is told there with the reason. For a folder or a collection the token is fetched when a request that uses the authentication is sent.

## Residual risk, stated

A collection that the person allowed can ask its server for tokens with the client secret it names, and a script that was allowed can read the token (`pm.request`, `pm.variables`) and send it anywhere; consent is the barrier in both cases. The browser sign-in trusts the provider's own page.
