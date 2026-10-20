# Security

## Reporting a problem

Please report a vulnerability **privately** through GitHub: *Security* tab of the repository → *Report a vulnerability* ([direct link](https://github.com/nhech/api-client/security/advisories/new)). Do not open a public issue for it. Include a minimal Thunder Client file (made up, without real data) that shows the problem and the tool you ran it in.

Only the latest commit of `main` is supported.

## What the importer defends against

The input of this tool is a Thunder Client collection, and collections are shared between people. The importer therefore treats every value in it as hostile. These are the cases it is built and tested for, and so what counts as a vulnerability:

- **The output file changing shape.** Data that adds a line, a request, a directive, a header or a variable definition to a `.http` file (line breaks in one-line values, `###` or `# @…` inside free text, header names that look like comments).
- **A request that reads a file or runs something when you press Send.** Body lines `< path` (REST Client, httpYac and JetBrains include that file), `> {% … %}` (JetBrains runs it), `{{ expression }}` (httpYac runs it as JavaScript), `{{$processEnv NAME}}` and `{{$env.NAME}}` (they put an environment variable into the request).
- **Secrets reaching Git or a shared file.** A literal credential in a shared file, a private file without `.gitignore`, a secret in the workspace settings of the REST Client target, or in a report or log.
- **Writing outside the target folder.** `..`, absolute paths, reserved Windows names, links (symlinks and junctions) in the path, a half-written result after a failure or a cancel.
- **Resource exhaustion.** Huge or deeply nested files, long strings, 100,000-folder chains and cycles, inheritance that multiplies a small input into a huge output.
- **Prototype pollution** through keys such as `__proto__` or `constructor` in the data, including in the VS Code settings merge.

The core has no network access and starts no process; the data is parsed as plain JSON and never evaluated.

## What it does not defend against

- A malicious `.http` file you did not generate with this tool, or a tool that reads a file in another way than the three tried (REST Client 0.25.1, httpYac 6.16.7, JetBrains `ijhttp` 263.7031). The measurements are in section 10.3 of [docs/SPEC.vi.md](docs/SPEC.vi.md).
- What the tools do with the files afterwards: REST Client, for example, tried to reach a telemetry endpoint even with its telemetry setting off.
- A machine where an attacker can already write your files.

## Secrets you move

The REST Client target writes the secrets to your **user** settings (never to the workspace settings) and adds that setting to `settingsSync.ignoredSettings`; the private files are written with mode `0600` where the system has modes (on Windows rely on `.gitignore` and the folder permissions).
