# api-client

[![CI](https://github.com/nhech/api-client/actions/workflows/ci.yml/badge.svg)](https://github.com/nhech/api-client/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Import [Thunder Client](https://www.thunderclient.com/) collections and environments into plain **`.http` files** that open in [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client), [httpYac](https://marketplace.visualstudio.com/items?itemName=anweber.vscode-httpyac) and the [JetBrains HTTP Client](https://www.jetbrains.com/help/idea/http-client-in-product-code-editor.html).

Everything runs on your machine: no account, no network, no telemetry. Your requests stay in files you can read, diff and commit.

> Not affiliated with or endorsed by Thunder Client. The name is used only to say which data format is read.

- [What you get](#what-you-get)
- [Quick start](#quick-start)
- [Output layout](#output-layout)
- [Choosing the tool you write for](#choosing-the-tool-you-write-for)
- [What is converted, and what is not](#what-is-converted-and-what-is-not)
- [Safety](#safety)
- [Tried against the real tools](#tried-against-the-real-tools)
- [Known limits](#known-limits)
- [Development](#development)
- [Documentation](#documentation) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [License](#license)

Vietnamese: [README.vi.md](README.vi.md).

## What you get

- **Reads Thunder Client data directly from disk**, read-only: the v4 layout (`collections/tc_col_*.json`, `environments/tc_env_*.json`), the older v3 layout (`thunderclient.json`, `thunderCollection.json`, `thunderEnvironment.json`) and exported `.json` files. You do not need to be signed in to anything.
- **Folders, ordering, inheritance.** Headers, authentication, base URL and tests set on a collection or folder are written into each request, as Thunder Client applies them.
- **Plain `.http` output**, one file per folder, with the environment files each tool reads.
- **Secrets stay out of Git.** Literal tokens, passwords and keys are replaced by `{{variables}}`; their values go to a private file that is added to `.gitignore` and written with mode `0600`.
- **A report** (`IMPORT_REPORT.md`) of what was imported, what was left out and why, and what you still have to do. It lists names and places only, never a value.
- **Safe by construction.** The data of a collection somebody else made cannot add a request to the file, read a file of yours or run code when you press Send (see [Safety](#safety)).
- **Three ways to run it:** a command line, a VS Code command (**API Client: Import from Thunder Client...**), and a library.

## Quick start

Requirements: Node.js 22 or newer. The package is not published to npm yet, so build it from a clone:

```sh
git clone https://github.com/nhech/api-client.git
cd api-client
npm ci --ignore-scripts
npm run build
```

### Command line

Without `--write` nothing is written: you get the report and the list of files.

```sh
# dry run on a Thunder Client data folder (or on exported .json files)
node dist/cli.js "<Thunder Client data folder>"

# write the files into ./api of the current folder, for REST Client (the default)
node dist/cli.js "<Thunder Client data folder>" --write

# other tools, another folder, keep literal secrets where they are
node dist/cli.js export.json --target jetbrains --workspace ~/my-project --out requests --write
node dist/cli.js "<data folder>" --policy skip-existing --no-move-secrets --write
```

| Option | Meaning |
|---|---|
| `--write` | write the files (default: dry run) |
| `--workspace <folder>` | folder the files are written in (default: the current folder) |
| `--out <folder>` | folder inside the workspace that receives the files (default: `api`) |
| `--policy <p>` | `new-folder` (default: a folder that has files is never touched, `api-2` is used), `skip-existing` or `overwrite` |
| `--target <tool>` | `rest-client` (default), `httpyac` or `jetbrains` |
| `--no-move-secrets` | keep literal secrets in the shared files (they are reported) |

Exit code `0` done, `1` the import failed, `2` wrong usage.

Where Thunder Client keeps its data (VS Code; for Cursor, VSCodium and others change `Code`):

| System | Folder |
|---|---|
| Windows | `%APPDATA%\Code\User\globalStorage\rangav.vscode-thunder-client` |
| macOS | `~/Library/Application Support/Code/User/globalStorage/rangav.vscode-thunder-client` |
| Linux | `~/.config/Code/User/globalStorage/rangav.vscode-thunder-client` |

If you use Thunder Client's Git sync, point the command at your `thunder-tests` folder instead. To see the *shape* of your data without exposing any of it, run [`tools/thunder-structure.cjs`](tools/README.md).

### VS Code

Build and install the extension from a clone (it is not on the Marketplace):

```sh
npm run ext:build
cd extension && npm run package        # writes ../.artifacts/api-client-importer.vsix
code --install-extension ../.artifacts/api-client-importer.vsix
```

Run **API Client: Import from Thunder Client...** from the Command Palette. It suggests the Thunder Client folder it finds, shows the report, lets you choose the target folder, the tool and the policy, and writes only after you confirm. Cancelling at any step writes nothing. With REST Client as the target it also fills in the REST Client settings for you (see below).

## Output layout

```
api/
  <Collection>/
    index.http              requests at the top of the collection
    <Folder>.http           requests of a folder
    <Folder>/<Sub>.http     sub-folders
    _bodies/body-0001.txt   a body that cannot stay inside a .http file (see Safety)
  http-client.env.json              shared variables, one entry per environment
  http-client.private.env.json      secrets and machine-local variables (not for Git)
  rest-client.settings.json         REST Client target only: the same variables as a VS Code setting
  rest-client.private.settings.json REST Client target only: the secrets (not for Git)
  IMPORT_REPORT.md                  what was done
```

A request block:

```http
### Create pet
# @name Create_pet
# @capture petId = json $.id
# @assert status == 201
# @assert json $.id isNumber
POST {{baseUrl}}/pets
Accept: application/json
Content-Type: application/json
Authorization: Bearer {{secret_pet_store_bearer_token}}

{
  "name": "Rex"
}
```

Thunder Client tests become `# @assert` and `# @capture` comment lines (grammar in [the spec](docs/SPEC.vi.md), section 6.2a). All three tools ignore them as comments, so the request still runs; a runtime that understands them can check responses and chain values. There is no such runtime in this repository.

## Choosing the tool you write for

The three tools read the same requests but differ in two places, so the files are written for one of them (`--target`, or the "Written for" item in VS Code). Import again to write for another.

| | REST Client | httpYac | JetBrains |
|---|---|---|---|
| Reads `http-client.env.json` | no (see below) | yes | yes |
| `{{#guid}}` of Thunder Client | `{{$guid}}` | `{{$guid}}` | `{{$uuid}}` |
| `{{#number, a, b}}` (both ends included) | `{{$randomInt a b+1}}` | `{{$randomInt a b+1}}` | `{{$random.integer(a, b+1)}}` |
| `{{#dateISO}}` | `{{$datetime iso8601}}` | `{{$datetime iso8601}}` | `{{$isoTimestamp}}` |
| `{{#date}}` (milliseconds) | left as is | `{{$timestamp}}` | left as is |

Other Thunder Client dynamic variables (`#name`, `#string`, `#email`, `#bool`, `#enum`) have no exact equivalent and are left as they are and listed in the report. The `b+1` is deliberate: all three tools stop before the upper bound, Thunder Client does not.

**REST Client keeps its variables in a VS Code setting**, not in `http-client.env.json`. For that target the importer also writes the variables as `rest-client.settings.json` (shareable) and `rest-client.private.settings.json` (secrets), and the VS Code command **fills the settings in for you**: the variables go to the workspace settings, the secrets to your user settings, and that setting is added to `settingsSync.ignoredSettings` so the secrets are not synced. It goes through the VS Code configuration API, so comments in your `settings.json` stay, and nothing you already have is replaced: a variable that exists with another value is kept and named in the final message. From the command line, paste the two files yourself (the report tells you how).

## What is converted, and what is not

| Thunder Client | Result |
|---|---|
| Collections, folders, request order | folders and files, in the order Thunder Client shows them (ties settled by name) |
| Method, URL, query parameters, path parameters | request line; disabled parameters become `# [disabled query]` comments |
| Headers | headers; Thunder Client's own default `Accept` and `User-Agent` are dropped; disabled ones are comments |
| Bodies: JSON, text, XML, form, multipart (with files), GraphQL | bodies; a GraphQL body is a JSON envelope |
| Authentication: bearer, basic | an `Authorization` header (`Bearer <token>`, `Basic <user> <password>`) |
| Tests | `# @assert` lines; `set-env-var` becomes `# @capture` |
| Inheritance from folder and collection | written into each request |
| Environments (shared, named, local, default) | environment files; `global` + `local` variables go to the private file |
| Encrypted variables | an empty entry in the private file to fill in again (never decrypted) |
| Scripts | kept as comments, never run |
| OAuth 2.0, AWS, digest, NTLM | not converted; a note names the setting keys, never their values |
| WebSocket, SSE, gRPC requests | skipped and listed in the report |
| History, responses, cookies, request settings | skipped |

Every finding has a stable code (`TC-…`) listed in the spec, section 7.

## Safety

The data of a collection can come from anyone, so the importer treats it as hostile:

- **Reading** is read-only; it never follows a link out of the folder, and has limits on file size, count, nesting and string length. Data is parsed as plain JSON and never executed.
- **Nothing can add a line to the file.** Values on one line cannot carry a line break; free text in comments can never start a directive; a body is written inline only if no tool would read one of its lines as something else.
- **A body line that starts with `#`, `//`, `<` or `>`** is read by the tools as a comment, a file include or a response handler. REST Client drops the first two silently, and `< ./file` makes REST Client, httpYac and JetBrains send that file. Such a body is therefore saved in `_bodies/` and read from there as it is.
- **Text between `{{ }}` that is not a plain variable name** is made harmless (`{ { … } }`). httpYac runs it as JavaScript and REST Client, httpYac and JetBrains can read environment variables from it.
- **Writing** goes through a staging folder and is undone on failure or cancel; paths cannot leave the target folder; links are never followed; `.gitignore` is updated before a private file appears.
- **Secrets** are moved to the private files and reported by name only.

The core has no network access and does not spawn processes; a test checks that its source and the built extension import neither. Details and how to report a problem: [SECURITY.md](SECURITY.md).

## Tried against the real tools

The output has been run for real, against a local server that records what arrives, in REST Client 0.25.1, httpYac 6.16.7 and the JetBrains HTTP Client command line (`ijhttp` 263.7031). That is how the facts above were found (for example that JetBrains does not encode `Basic user:password`, or that REST Client drops a `#` line from a body). The runners are in [`samples/`](samples/) and need the tools downloaded by you:

```sh
node samples/make-sample.cjs               # made-up Thunder Client data in samples/thunder-data
mkdir samples/workspace
node dist/cli.js samples/thunder-data --workspace samples/workspace --write
node samples/rest-client-check/run.cjs <the humao.rest-client .vsix you downloaded>
```

`samples/httpyac-check/` works the same way with the httpYac `.vsix`; `samples/jetbrains-check/` runs the Docker image `jetbrains/intellij-http-client` on an internal network. Each runner uses a throw-away VS Code profile or container, and `SAMPLE_API` chooses which imported folder it tries (for example one written with `--target httpyac`). Results are in the spec, sections 10.3b to 10.3d.

## Known limits

- **Built from public information and a reading of the extension's code, and tested with data made up to match it.** The maintainers have not had a real Thunder Client v4 data folder to try. Fields the tool does not know are skipped silently; if your data imports wrongly, please open an issue with the output of [`tools/thunder-structure.cjs`](tools/README.md) (it prints structure, not values).
- **No runtime.** `# @assert` and `# @capture` are written but nothing in this repository runs them.
- Variable names with `-` or `.` are kept as Thunder Client has them; httpYac reads them as JavaScript, and the importer neutralises the dotted ones.
- The VS Code extension is a draft: `publisher` is a placeholder and it is not on the Marketplace.

## Development

```sh
npm ci --ignore-scripts
npm run check          # typecheck, extension typecheck, lint, all tests, tool self-test
npm test               # compile the tests and run node --test
npm run mutate         # breaks 33 rules on purpose and demands that the tests fail (slow)
UPDATE_GOLDEN=1 npm test   # rewrite test/fixtures/golden after a change you mean; read the diff
npm run ext:host-test      # runs the extension in an installed VS Code with a throw-away profile
```

```
src/             the core library: reader/, normalize/, convert/, emit/, write/, cli.ts, host.ts
extension/       the VS Code layer: one command, Quick Picks, the report as a read-only document
test/            unit tests, support (a reference .http parser and reference inheritance), fixtures and goldens
tools/           thunder-structure.cjs (describe your data), mutate.cjs (mutation check)
samples/         made-up data and the runners that try the output in the real tools
site/, scripts/  the landing page and the scripts that build, check and deploy it
docs/SPEC.vi.md  the specification (Vietnamese)
```

The stages are pure functions: reader → normaliser → converter → emitter, and only `src/write/` writes to disk. Tests keep that so (`test/unit/purity.test.ts`).

## Documentation

- [docs/SPEC.vi.md](docs/SPEC.vi.md): the specification, in Vietnamese: data format as observed, every rule, the output format, the safety model, the test plan and the open questions.
- [tools/README.md](tools/README.md): describe the structure of your Thunder Client data without sharing it.
- [site/README.md](site/README.md): the landing page, and how to build and deploy it.
- [CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE) © 2026 longtd.
