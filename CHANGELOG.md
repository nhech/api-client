# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

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
