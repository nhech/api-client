# History

The *History* view lists what you sent from a request editor, by day, newest first. It is kept on **this computer, for this workspace** (in the storage VS Code gives the workspace, never in a file of the collection: it is not committed and not shared), at most **200 entries for 30 days**, and it can be cleared at any time (*Clear History*, with a question first).

## How much is kept

The setting `apiClient.history.mode` (user or remote settings only: a workspace cannot change it):

- `metadata` (the default): one line for each send: the method, the address, the status, the time, the size, the name of the request and of the environment. **No headers and no bodies.**
- `full`: the line, and the headers and the first 64 KB of the request body and of the response body.
- `off`: nothing is written down. What is already there stays until you clear it.

## What is covered

Whatever is kept has been made safe first, by text rules:

- a value that the request was built from as a secret (a secret variable, a token from OAuth) is `[redacted]` wherever it shows up;
- a header whose name says it is secret (`Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Amz-Security-Token`, ...) is `[redacted]`;
- a query parameter, a field of a JSON body or of a form whose name says it is secret (`api_key`, `access_token`, `accessToken`, `password`, `client_secret`, ...) is `[redacted]`;
- the user name and the password in an address, and a fragment, are not kept.

This cannot know a token that a **server** invents and sends back under an innocent name. That is why `full` is a choice and `metadata` is what is on by default. The file is written with the mode 0600 where the system has modes.

Not recorded at all: the exchanges of OAuth (the request for a token), the requests that scripts send with `pm.sendRequest`, and the requests that the collection runner sends.

## Using it

Click an entry to read it as a document (the request line, how it ended, the headers and the bodies when they were kept). *Open the Request* goes to the file of the request (if it is still there), *Remove from History* removes one entry.
