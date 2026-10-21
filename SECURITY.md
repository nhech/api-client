# Security

## Reporting a problem

Please report a vulnerability **privately** through GitHub: *Security* tab of the repository → *Report a vulnerability* ([direct link](https://github.com/nhech/api-client/security/advisories/new)). Do not open a public issue for it. Include a minimal Thunder Client file (made up, without real data) that shows the problem and the tool you ran it in.

Only the latest commit of `main` is supported.

## What the importer defends against

The input of this tool is a Thunder Client collection, and collections are shared between people. The importer therefore treats every value in it as hostile. These are the cases it is built and tested for, and so what counts as a vulnerability:

- **The output file changing shape.** Data that adds a line, a request, a directive, a header or a variable definition to a `.http` file (line breaks in one-line values, `###` or `# @…` inside free text, header names that look like comments).
- **A request that reads a file or runs something when you press Send.** Body lines `< path` (REST Client, httpYac and JetBrains include that file), `> {% … %}` (JetBrains runs it), `{{ expression }}` (httpYac runs it as JavaScript), `{{$processEnv NAME}}` and `{{$env.NAME}}` (they put an environment variable into the request).
- **Secrets reaching Git or a shared file.** A literal credential in a shared file, a private file without `.gitignore`, a secret in the workspace settings of the REST Client target, or in a report or log. A secret is found by its **name**: a header, a query parameter, a form field, a path parameter, the password or token before the `@` of a URL, the pairs of a URL fragment, and the names inside a JSON, XML, query-string or GraphQL body (`"apiKey": "…"`, `<Password>…</Password>`, `client_secret=…`, `password: "…"`).
- **Writing outside the target folder.** `..`, absolute paths, reserved Windows names, links (symlinks and junctions) in the path, a half-written result after a failure or a cancel.
- **Resource exhaustion.** Huge or deeply nested files, long strings, 100,000-folder chains and cycles, inheritance that multiplies a small input into a huge output, and a small input whose output would be huge (shared variables copied into hundreds of environments). The time of every step is meant to be a pass over the input; a test feeds each known worst case (a dynamic variable that cannot match, 50,000 equal names, very long names and runs of spaces, tens of thousands of inherited tests) and a measured audit found no other superlinear step except planning and writing a very large number of files (tens of thousands), which is slow.
- **Prototype pollution** through keys such as `__proto__` or `constructor` in the data, including in the VS Code settings merge.
- **Script or markup in the importer panel.** Names and messages from a collection are shown in a VS Code webview. They are put in the page as text only (a test forbids `innerHTML` and its relatives), the page runs one script under a Content-Security-Policy with a fresh nonce and nothing inline, and it loads only the extension's own folders.
- **A page that asks for more than it was shown.** The panel's messages are parsed as untrusted: only the known shapes are accepted, no path comes from the page (folders and files are chosen with VS Code's own dialogs), and nothing is written until the Import message. Even then it writes only what was shown: it plans again first and writes nothing if the plan is no longer the one on screen. The REST Client settings are filled in only when secrets are moved out of the shared files, so that a literal secret never reaches the workspace settings.

The core has no network access and starts no process; the data is parsed as plain JSON and never evaluated.

## What it does not defend against

- A malicious `.http` file you did not generate with this tool, or a tool that reads a file in another way than the three tried (REST Client 0.25.1, httpYac 6.16.7, JetBrains `ijhttp` 263.7031). The measurements are in section 10.3 of [docs/SPEC.vi.md](docs/SPEC.vi.md).
- What the tools do with the files afterwards: REST Client, for example, tried to reach a telemetry endpoint even with its telemetry setting off.
- A machine where an attacker can already write your files.
- **A secret with no name next to it.** The importer cannot tell a credential from any other text, so a token written alone in a free-text body, or a value under a name that does not say "secret", stays in the file. Review the request bodies of a collection you did not write before you commit them.

## Secrets you move

The REST Client target writes the secrets to your **user** settings (never to the workspace settings) and adds that setting to `settingsSync.ignoredSettings`; the private files are written with mode `0600` where the system has modes (on Windows rely on `.gitignore` and the folder permissions).
