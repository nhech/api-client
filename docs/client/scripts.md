# Scripts: what runs, what it is given, and who allowed it

Requests, folders and collections can hold two JavaScript scripts: one that runs before the request is sent and one after the answer has come. This page records how they run and the rules that keep a script from the collection of somebody else away from the machine. The rules are enforced by tests; the ones that cannot be tested without VS Code have a section of the host test (`extension/test/suite.cjs`, section 15).

## Where they run

In **QuickJS compiled to WebAssembly**, in a `worker_thread` (`src/script/`). The engine has no process, no files, no network, no `require` of Node, no `eval` of the host. Limits per run: 1 s of computing (waiting for the extension is not counted), 10 s in all, 32 MB soft and 64 MB hard memory, 512 KB of stack, 1 MB of result, 1,000 operations asked of the extension. A run that goes over is stopped (the engine stops itself, and a watchdog ends the worker 500 ms later if it does not); the worker is replaced after any run that ended badly. The details and the numbers of the spike are in `S0-spikes.md`.

`worker_threads` is not a security boundary by itself. What keeps a script in is that the engine can reach nothing, that everything it can ask of the extension is a short list of operations that the extension checks, and that what it gives back is read as data.

## What a script is given

Plain data, made in `src/view/scripts.ts` (nothing in it is a live object):

- **The variables**, by scope and merged: `environment` (the active environment and what scripts set in it), `collection` (the variables of the folders and the collection and what scripts set there), `globals` (the workspace and what scripts set in the session of the collection), `merged` (what a request would resolve a name to). **The values of secret variables are included**: a script that signs a request needs them. This is why consent exists.

**What requests and scripts set never leaves the collection.** The variables that a capture (`global: host = value x`) or a script (`pm.globals.set`, `pm.environment.set`) sets while requests run belong to the collection of the request that set them, in every scope: `global` means the whole session of that collection, `active` the active environment of that collection. A capture is text in a request file, and it runs after every send without a question, so if one collection could set a variable that another collection's requests read, sending a request of a cloned repository would be enough to point `{{host}}` of your own requests at someone else's server with your credentials attached. Use an environment to share a value between collections.
- **Before the request:** the request as it is written (unresolved `{{variables}}`): its method, address, its own enabled headers (not the inherited ones) and the text of a body that is text.
- **After the answer:** the request as it went out and the answer: status, headers, cookies it set, and the body when it is text of at most 1 MB (a note says why when it is not).
- Names of the request and the environment, and the data of an iteration (for the runner, later).

## What a script can do

The API is a subset of Postman's (`src/script/prelude.ts`, generated from the source kept by the author): `pm.variables`, `pm.environment`, `pm.collectionVariables`, `pm.globals`, `pm.request` (changeable before the send), `pm.response`, `pm.test`, `pm.expect` (a Chai subset), `pm.sendRequest`, `pm.cookies`, `pm.info`, `postman.setNextRequest`, `pm.execution.skipRequest`, `console`, `setTimeout`, `btoa` and `atob`, and `require` for `crypto-js` (hashes, HMAC, encodings), `uuid` (v4) and `chai`. Anything else is an error that names what is there.

What it changes comes back as a **change set** and is read as untrusted data (`src/script/outcome.ts`): names are checked, texts are cut, counts are limited, a header with a line break is dropped, a key the format does not have is dropped. The extension then applies it:

- **Variables** go to the in-memory variables of the session (`RuntimeVariables`), by scope. They are **never written into a file of the collection**: a token a script saves is not committed with the requests. (This differs from Postman, where `pm.environment.set` persists.) A name that looks like a secret (token, password, key...) is a secret from then on: hidden in the console, the tests and the list of what was saved.
- **The request** (method, address, the request's own headers, the text of a body that is text) is changed in a **copy** that is only what is sent. The file is not touched.
- **`pm.sendRequest`** goes through the same engine as a request (same redirect rules, certificate check, proxy), at most 10 per run, 30 s each, 1 MB of answer, and only `http://` and `https://` addresses; a request that is not plain is refused whole (`parseHttpArgument`).
- **`pm.test`** results join the Tests tab; the console and what went wrong are in the Console tab. A script that throws before the request stops the request.

## Who allowed it

A script can read every variable and send it anywhere, so nothing runs until **the person has said yes to the text that will run** (`src/script/consent.ts`, `extension/src/scripts.ts`):

1. The workspace has to be trusted (the manifest declares `untrustedWorkspaces: false`, so the extension is off in Restricted Mode; the check is repeated at each send) and `apiClient.scripts.enabled` (machine scope: a repository cannot change it) has to be on.
2. Each script is identified by its stage and the id of the request, folder or collection that holds it. What was agreed to is a list of SHA-256 digests (and the text, when it is at most 64 KB, to show what changed), **kept in the global state of the extension on this computer, never in the collection**. A pull, a branch switch or an import cannot grant it.
3. A script whose exact text was not agreed to is **new** or **changed**. Before the first run the person is asked, in a modal question that names each script, shows its first lines, and can open the code (or a diff against the text that was allowed). "Send without scripts" sends the request as written; closing the question calls the send off.
4. Agreeing to a changed script replaces what was agreed to in its place, so the old text is no longer allowed. "Forget Which Scripts Were Allowed" clears everything.
5. The text that is checked is the text that runs, including the unsaved text of the request being edited.

**Residual risk, stated:** an allowed script can exfiltrate any secret it can read, through `pm.sendRequest`. Consent is the only barrier. A first-contact prompt for a new host is a candidate for 0.3. Scripts typed in the Scripts tab are not auto-allowed: the person who writes a script is asked once for it like anyone else, which keeps one rule for all.

## Differences from Postman worth knowing

- Variables set by scripts live until VS Code is closed and are not written to files.
- `pm.request.headers` is the request's own headers; inherited ones are added after the script.
- `pm.cookies` holds the cookies the answer set (after the answer) and nothing before it.
- A script cannot write files, read files, or use the network except `pm.sendRequest`. No `require` of Node modules, no `xml2js`, `lodash`, `moment`, `cheerio` (the error says what is available).
- `setNextRequest` is read and reported; it takes effect in the collection runner (coming).
