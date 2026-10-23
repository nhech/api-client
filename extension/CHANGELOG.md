# Changelog

## 0.2.2

- **The address of a page of documentation works for the import.** Paste the address of a Swagger UI, Redoc or Scalar page (for example `https://host/docs/admin`) into *Import an OpenAPI or Swagger Description... > An address*: the page and its start-up scripts are read for the description (swagger-ui-express writes it into `swagger-ui-init.js`), then the addresses that programs usually serve it at are tried (NestJS `/docs/admin-json`, Spring `/v3/api-docs`, FastAPI `/openapi.json`), only on the origin you typed. When nothing is found, the message says so and asks for the address of the .json or .yaml file.
- A description that names no server (NestJS writes none) gets the address it was fetched from as `baseUrl`, and a relative server such as `/api/v1` is put after it.
- A YAML description written with anchors (what NestJS serves at `-yaml`) is refused with a hint to use the JSON of the program.

## 0.2.1

- **The OpenAPI and Swagger files of your workspace are found and listed.** *Import an OpenAPI or Swagger Description...* opens a list that fills in as the workspace is searched: the files named `openapi`, `swagger` or `api-docs` at once, then the other JSON and YAML files, each with its kind, version and title. Pick one to import it.
- **Hardened after a fourth independent review of the importers.** A large or hostile description or project can no longer freeze VS Code (the work and the text of one import are limited, and the route scan reads each part of a file once); credentials given as examples in a description move to secret variables; an imported environment no longer takes over the requests of your other collections; a host named in `launchSettings.json` or `appsettings.json` and `{{variables}}` in a route are not carried into requests; a folder with thousands of requests is split; a folder called `x.local.yml` is no longer ignored by Git. The full list is in the changelog of the repository and in SECURITY.md.

## 0.2.0

A full API client, in the same extension: a request editor with the answer beside it, collections, folders and environments in native trees, requests as plain YAML files with a generated `.http` copy, variables and secrets kept out of Git, authentication including OAuth 2.0, tests and captures, JavaScript scripts that run in a sandbox only after you allowed their exact text, a collection runner with JSON and JUnit reports, imports from OpenAPI and Swagger, from the routes of your controllers, from Thunder Client, Postman and cURL, a Code tab, cookies and history. The extension is now **Local API Client** (`longtd.local-api-client`).

## 0.1.0 (as HTTP Files Importer)

First preview release.

- **HTTP Files Importer: Import from Thunder Client...** opens a panel that reads a Thunder Client data folder (v4 and v3 layouts) or exported files, shows what was found, and writes plain `.http` files when you press Import. An Explorer section opens the same panel, and **Import from Thunder Client (step by step)...** asks the same questions in the Command Palette.
- Folders, request order, parameters, headers, bodies (JSON, text, XML, form, multipart, GraphQL), bearer and basic authentication, and the inheritance of headers, authentication, base URL and tests from folders and collections.
- Tests as `# @assert` lines and `set-env-var` as `# @capture` lines; scripts kept as comments.
- Output for REST Client, httpYac or the JetBrains HTTP Client, with each tool's own spelling of Thunder Client's dynamic variables.
- Secrets moved to private files that are added to `.gitignore` first; for REST Client the settings are filled in (workspace and user scope, nothing replaced, secrets kept out of Settings Sync).
- Hostile-data protections, a safe writer with rollback, and a report that never contains a value.
