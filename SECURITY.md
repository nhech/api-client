# Security

## Reporting a problem

Please report a vulnerability **privately** through GitHub: *Security* tab of the repository → *Report a vulnerability* ([direct link](https://github.com/nhech/api-client/security/advisories/new)). Do not open a public issue for it. Include a minimal file that shows the problem (made up, with no real data): a request file, a collection, an export of another tool, or a command, and what you did with it.

Only the latest commit of `main` is supported.

## What this is

A free API client for VS Code that works on files: requests are YAML files in your repository, secrets are kept next to them in files that Git ignores or in the secret storage of VS Code, and requests are sent from the extension host with Node's `http` and `https`. There is no account, no server of ours, no telemetry and no update check of its own. The extension does not run in Restricted Mode (an untrusted workspace).

The extension sends the requests **you** send (a request editor, the collection runner, a script you allowed with `pm.sendRequest`) and, for a request that uses OAuth 2.0, the requests to the token server and the sign-in that you configured. Nothing else leaves the machine.

## What it defends against

The data it reads comes from other people: a cloned repository, the answers of servers, files exported by other tools, text copied from a web page. These are the cases it is built and tested for, and so what counts as a vulnerability.

**A cloned repository** (YAML, `.http` copies, `workspace.yml`, settings in `.vscode`):

- The files are data. The YAML reader is a strict subset (no anchors, aliases, tags or flow collections, no duplicate keys) with limits on size, depth and number of nodes; a key such as `__proto__` is a key like any other.
- Links and special files are never followed; every name is checked (no `..`, no names that Windows reserves); a file is written to a temporary file and renamed. The folder named by the setting `apiClient.root` is a plain folder of the workspace, never `.git` or `node_modules`.
- Nothing in a request runs without you: a script needs your consent, given for the exact text (a SHA-256 digest kept on your machine, never in the repository), and a pull, a branch switch or an import cannot grant it. The settings `apiClient.scripts.enabled` and `apiClient.history.mode` are machine settings, which a workspace cannot set.
- What requests and scripts set while they run (a capture, `pm.environment.set`, `pm.globals.set`) belongs to the collection that set it, in every scope, and is never seen by another collection: otherwise a capture in a cloned repository could point `{{host}}` of your own requests at a server of someone else.
- The `.http` copy of a request is read by other tools (REST Client, httpYac, JetBrains), which run in a place of trust. It never carries what they would act on: text between `{{ }}` that is not a plain variable name or a dynamic word of the client is written with its braces separated (httpYac would run it as JavaScript; `{{$processEnv NAME}}` would put an environment variable into the request), and a multipart file part whose path leaves the folder of the collection is not written (the tools would read the file). A file you changed by hand is never written over.

**Servers and their answers:**

- A redirect never takes your credentials to another origin (`Authorization`, `Cookie`, `Proxy-Authorization` and every header named like a secret are dropped), never goes from https to http, and, from a public address, never goes to this machine or a private network (loopback, `0.0.0.0`, link-local addresses where cloud metadata services are, 10/8, 172.16/12, 192.168/16, 100.64/10, `fc00::/7`) unless the settings of the request allow it. The address that a name resolves to is checked too, after a redirect to another name, so a name that points at `127.0.0.1` does not get around it.
- Compressed answers are limited in size and in ratio; a large answer goes to a file in a private place (mode 0600) and is deleted with the request; a cookie is scoped to the site that set it (`Secure` and `__Host-` prefixes are honoured, a `Domain` that is a public suffix or the second level of a country is refused).
- The certificate of an https server is verified unless a setting of the request says otherwise, and the settings page says what that means. A proxy sees only the name and port of an https request (a tunnel).
- A response is shown as text, as a picture (`data:image` only) or as a dump of bytes. There is no page of the server in the extension.

**Files from other tools and copied text** (Thunder Client, Postman, cURL): they are read as text and never run; a path that leaves the folder of the collection is cut to the name of the file; a credential that is typed into a request is moved to a secret variable of the collection, kept next to it in a file that Git ignores; limits on size, number of requests and depth.

**Scripts** run in QuickJS compiled to WebAssembly, in a worker thread, with limits on computing time (1 s), time on the clock (10 s), memory (32 MB soft, 64 MB hard), stack, output and calls to the extension. The engine has no `process`, no `require`, no files and no network of its own; the only things a script can ask for are in a short list that the extension checks (`pm.sendRequest` to http and https addresses, a pause, hashes and random bytes). What comes back from the engine is data that the extension validates. A run that is cut off recycles the worker.

**The pages** (request editor, collection runner, import panel) have a Content-Security-Policy with `default-src 'none'`, no network, one script with a fresh nonce; names and answers are put in the page as text; a message from the page is read as untrusted (only known shapes; no path ever comes from the page).

**Other processes on the machine:** the OAuth sign-in waits on a one-shot server on `127.0.0.1` (and on `::1` too when the address you registered says `localhost`; if another process holds the port on `::1`, the sign-in is refused), accepts one path, the `Host` that was agreed and the `state` of this attempt (compared in constant time), and gives up after five minutes. Authorization code grants use PKCE (on by default). Tokens and persistent cookies are in the secret storage of VS Code.

**Secrets.** A secret is covered by what it is and by what it is called: the values of secret variables and tokens (as typed, and as put into an address or a form: percent-encoded, with a plus for a space, in lower case hex), a header, a query parameter or a field of a JSON or form body named like a secret (`Authorization`, `Cookie`, `api_key`, `access_token`, `accessToken`, `password`, `client_secret`...), and the user and password of an address. That is applied wherever something is written down: the history, the Code tab, the `.http` copy, the reports of the runner, the console of a script, the view of the request that was sent, error messages. Values of secret variables live in `*.local.yml` files next to the shared ones (mode 0600 where the system has modes), and the `.gitignore` of the client folder is kept effective (a later line that takes the pattern back is overridden).

## What it does not defend against

- **A script you allowed can read every variable it is given, secrets included, and send them anywhere.** Consent, given for the exact text, is the only barrier. Read a script before you allow it; do not allow one you do not understand.
- **Tests and captures run without a question** (they are lines of a small grammar, not code, and cannot send anything or read a secret), and only change variables of their own collection.
- **What the other tools do with the `.http` copy.** The copy is made so that it holds nothing they would run or read, but their behaviour is theirs; the three that were tried are REST Client 0.25.1, httpYac 6.16.7 and the JetBrains `ijhttp` 263.7031 (see [docs/SPEC.vi.md](docs/SPEC.vi.md), section 10.3). Use `apiClient.mirror.mode = off` if you do not use them.
- **A secret that has no name next to it, and a token that a server invents.** Covering is done with text: a token written alone in a free-text body, a value under a name that does not say "secret", or a token a server sends back under an innocent name stays in what is written. The history keeps only a line by default for this reason; `full` is a choice.
- **Files that are already in Git.** The `*.local.yml` files are ignored by the `.gitignore` of the client folder, but Git keeps tracking a file that was committed before; check `git status` after the first secret is saved in a repository that had such files.
- **The first address of a request.** What you write is where the request goes, whatever it resolves to; only a redirect is held to the rule above. A proxy resolves names itself, so the check of the resolved address does not apply behind one.
- **A machine where an attacker can already write your files, or run code as you,** and the secret storage of a remote machine (Remote SSH, WSL, Codespaces) was not verified by hand.

## Audits

| Date | What | Result |
|---|---|---|
| 2026-10-22 | Two independent audits of the whole client by separate reviewers (one as an attacker who controls input data, one as an attacker who controls code or a compromised component), each trying real attacks against the built extension | 14 reports of 13 distinct problems (the redirect to private networks was found by both). **3 high:** the `.http` copy wrote file includes that other tools read; the `.http` copy wrote expressions that other tools run; a capture in one collection could change what the requests of another collection are sent to. **6 medium:** redirects to private networks and to names that resolve to this machine; a secret that was percent-encoded into an address was not covered; the Code tab covered secrets by value only; a `.gitignore` that takes the pattern back; a sign-in answer that could be taken on `::1`; a request file that froze the editor (quadratic bookkeeping). **4 low or informational:** the redirect table of the response showed secrets; the preview of a script in the question to allow it lost its line breaks; the worker aborted after a cut-off run; `apiClient.root` could name `.git`. The country-level cookie domains and the message of a script that failed in an unusual way were fixed too. Every one is fixed and covered by tests and by mutations M628 to M663. The sandbox itself was attacked directly (escape, limits, forged answers) and held. |

The suite of tests includes mutation checks (`node tools/mutate.cjs`): each rule that protects something is broken on purpose, and the tests must notice.
