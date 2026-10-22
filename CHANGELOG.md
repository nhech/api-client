# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

The extension is now a full API client (extension id `longtd.api-client`); the importer of 0.1.0 is part of it.

### Added

- **A request editor and a response pane** in VS Code (beside each other, or one above the other as in Postman: two buttons at the top of a request, kept in the setting `apiClient.layout`): method and address, Query, Headers, Auth, Body (JSON, text, XML, form, multipart with files, GraphQL, binary), Scripts, Tests, Settings, Docs and Code tabs; the answer with its body (pretty, raw, pictures), headers, cookies, tests, console, the request as it was sent and a timeline of the phases.
- **Collections, folders and environments** in native trees (drag and drop, rename, duplicate, move, filter), with what a folder or collection sets (base address, headers, authentication, variables, tests, scripts, settings) inherited by its requests, and an environment picker in the status bar.
- **Requests as files:** one YAML file per request in a strict, versioned subset of YAML (`schema: 1`), folders, the order kept in the folder's file, secret values in `*.local.yml` files that a `.gitignore` of the client folder keeps out of Git.
- **Variables** with the nearest scope winning, dynamic words from a fixed table (`{{$guid}}`, `{{$randomInt a b}}`...), marks and hover in the editor, secret variables hidden wherever something is shown or written down.
- **The HTTP engine** on `node:http` and `node:https`: redirects (credentials stay with their origin, never https to http, never from the internet to this machine or network unless allowed), timeouts, gzip, deflate and Brotli with limits, large answers to a file, cookies, the proxy of VS Code and of the environment, TLS verification on by default.
- **Authentication:** bearer, basic, API key and OAuth 2.0 (client credentials, password, authorization code with PKCE, refresh), tokens in the secret storage of VS Code, a question before credentials go to a token server for the first time.
- **Tests and captures** in a one-line grammar; **JavaScript scripts** (a subset of the Postman `pm` API) in QuickJS compiled to WebAssembly in a worker thread, with limits, run only after the exact text was allowed.
- **A collection runner** (passes, pause, stop at the first failure, a CSV or JSON data file, `setNextRequest`, JSON and JUnit reports).
- **A `.http` copy** next to each request for REST Client, httpYac and the JetBrains client, generated one way, never holding a secret or anything those tools would run, never written over once you edited it.
- **Imports** from OpenAPI and Swagger descriptions (Swagger 2.0, OpenAPI 3.0 and 3.1, JSON or YAML, from a file or from an address: a folder for each tag, a request for each operation, bodies from examples or schemas, security schemes as authentication, servers as environments), from the routes of the controllers in the source of the workspace, from Thunder Client data, Postman collections (v2.0, v2.1) and environments, and from cURL commands; credentials typed into an imported request become secret variables.
- **The Code tab** (cURL, PowerShell, JavaScript with fetch or axios, Python, Go, C#, PHP, Java), **cookies** and **history** (a line for each send by default; 200 entries for 30 days).
- Security notes in `SECURITY.md` and three audits: two independent reviewers attacked the whole client, a third attacked their fixes; every finding that was fixed is covered by tests and by mutations.

### Changed

- Extension id, display name and description: **API Client**, `longtd.api-client`. The older commands that write `.http` files for Thunder Client data are still there under *Convert Thunder Client Data to .http Files...*, and documented in `docs/converter.md`.
- The claim "no network" is replaced by what is true: the extension sends the requests you send (and, for OAuth 2.0, the requests to the token server you configured) and nothing else; the converter and the readers of other tools' files still have no network access.

## 0.1.0 - 2026-10-21

### Added

- Importer for Thunder Client data: the v4 and v3 data folders and exported files, read-only and with limits on size, count, nesting and string length.
- Conversion to `.http` files with folders, request order, query and path parameters, headers, bodies (JSON, text, XML, form, multipart with files, GraphQL), bearer and basic authentication, and the inheritance of headers, authentication, base URL and tests from folders and collections.
- Thunder Client tests as `# @assert` lines and `set-env-var` as `# @capture` lines, with a documented grammar. Scripts are kept as comments.
- Environment files for httpYac and JetBrains (`http-client.env.json`, `http-client.private.env.json`) and, for REST Client, the same variables as `rest-client.settings.json` and `rest-client.private.settings.json`.
- Choice of the tool the files are written for (`--target rest-client|httpyac|jetbrains`) with each tool's own spelling of Thunder Client's dynamic variables.
- Secrets moved to private files (also from query parameters, form fields, disabled headers, path parameters, the password or token in a URL, URL fragments, and JSON, XML, query-string and GraphQL bodies, found by the names inside them), reported by name only; encrypted variables are never decrypted.
- Protection against hostile data: line breaks, `###`, `#`, `//`, `<` and `>` lines in bodies, `{{ }}` text that httpYac would run, environment variables read through `$processEnv` or `$env`, `__proto__` keys.
- A safe writer (staging folder, rollback, no links, `.gitignore` updated before a private file appears) and the conflict policies `new-folder`, `skip-existing` and `overwrite`.
- `IMPORT_REPORT.md` with every finding, grouped by code (`TC-…`).
- Command line (`thunder-import`, dry run by default).
- VS Code extension: an importer panel (a webview that follows your theme) with the data it found, what was read and what needs attention, the choices, and a sticky Import button; an Explorer section that opens it; and a step-by-step command for the keyboard. It also fills in the REST Client settings (workspace and user scope, comments kept, nothing replaced, secrets kept out of Settings Sync).
- `tools/thunder-structure.cjs` to describe the structure of your Thunder Client data without exposing its content.
- Unit tests, byte-exact goldens, a mutation check, and runners that try the output in real REST Client, httpYac and the JetBrains HTTP Client.
- Linear time on hostile data, measured: a name or a string chosen by a stranger costs a pass over it (a dynamic variable such as `{{#a, , , !}}` used to take a minute, 50,000 requests with the same name four minutes, a very long run of spaces hours), environments that would go over the output limit are refused before they are built, and the report lists only the first lines of a long list.
- A landing page in `site/` (static, no dependencies) with its build, validation and deploy scripts in `scripts/`.
