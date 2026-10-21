# Changelog

## Unreleased

A full API client, in the same extension: a request editor with the answer beside it, collections, folders and environments in native trees, requests as plain YAML files with a generated `.http` copy, variables and secrets kept out of Git, authentication including OAuth 2.0, tests and captures, JavaScript scripts that run in a sandbox only after you allowed their exact text, a collection runner with JSON and JUnit reports, imports from Thunder Client, Postman and cURL, a Code tab, cookies and history. The extension is now **API Client** (`longtd.api-client`).

## 0.1.0 (as HTTP Files Importer)

First preview release.

- **HTTP Files Importer: Import from Thunder Client...** opens a panel that reads a Thunder Client data folder (v4 and v3 layouts) or exported files, shows what was found, and writes plain `.http` files when you press Import. An Explorer section opens the same panel, and **Import from Thunder Client (step by step)...** asks the same questions in the Command Palette.
- Folders, request order, parameters, headers, bodies (JSON, text, XML, form, multipart, GraphQL), bearer and basic authentication, and the inheritance of headers, authentication, base URL and tests from folders and collections.
- Tests as `# @assert` lines and `set-env-var` as `# @capture` lines; scripts kept as comments.
- Output for REST Client, httpYac or the JetBrains HTTP Client, with each tool's own spelling of Thunder Client's dynamic variables.
- Secrets moved to private files that are added to `.gitignore` first; for REST Client the settings are filled in (workspace and user scope, nothing replaced, secrets kept out of Settings Sync).
- Hostile-data protections, a safe writer with rollback, and a report that never contains a value.
