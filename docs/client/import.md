# Importing

*Import...* (the Collections view, or the Command Palette) brings in what other tools made. Each way **reads** a file or a text (`src/importers/`, pure and tested without VS Code), tells you what it found as a count, and writes nothing until you say yes. What could not be carried over is a list of notes, one command away (*Show the Notes of the Last Import*). Nothing an importer reads is run: a `{{ ... }}` that looks like code is text, a script is kept as text and runs only after you have allowed it (see `scripts.md`).

| From | Command | What comes across |
|---|---|---|
| **Thunder Client** | *Import Thunder Client Data...* | collections, folders (with what they set: base address, headers, authentication, tests, scripts), requests, environments |
| **The controllers of your code** | *Find the Routes of the Controllers in This Workspace...* | the routes found in the source files of the workspace (NestJS, Express, Spring, ASP.NET Core, FastAPI, Flask, Django, Laravel, Go, Actix and more), a folder for each controller, a request for each route |
| **Postman** | *Import a Postman Collection or Environment...* | collection v2.0 and v2.1, folders and their order, requests, authentication, scripts, variables; an environment or a globals file |
| **OpenAPI or Swagger** | *Import an OpenAPI or Swagger Description...* | a JSON or YAML file, or the address of a program that is running: a folder for each tag, a request for each operation with its parameters, body, authentication and a status test, and the servers as environments |
| **cURL** | *New Request from cURL...* | one request, read from the clipboard (a command copied from a browser, from documentation or from a terminal) |

The older command that writes `.http` files for REST Client, httpYac or the JetBrains client is still there as *Convert Thunder Client Data to .http Files...*.

## Folders stay folders

A folder or a collection keeps what it sets, and its requests inherit it the way they do in the client. The conversion to `.http` files has to copy a folder's headers into every request; here they stay on the folder. The order of the source is kept (its folders, then its requests, as they were listed), and the names of the files are made from the names as everywhere else.

## Credentials do not go into the files

A credential that is typed into a request (a token in a header, a password, a key in the query or in the body, the password of an address, a client secret) is replaced by `{{secret_collection_what}}`, and its value becomes a **secret variable** of the collection. Its value is written to `collection.local.yml` next to `collection.yml`, a file that Git ignores. One value that is used in many requests is one variable; a value that a variable of the collection already holds is used as it is, and a new value never takes the name of a variable that is already there. What is already a `{{variable}}` is left alone, and so is a value that is not secret by its name. Environment variables that are secret (by what the file says, or by their name) are written the same way, to the file next to the environment.

This is done with text, by names: a token that is called `data` in a body, or an address that holds a key under a name that says nothing, is not found. Read the files before you commit them, as you would any file.

## Thunder Client

The data folder (the version 4 and the older layouts) or exported files. Thunder's dynamic variables become the ones of the client where there is an equivalent (`{{#guid}}` is `{{$guid}}`, `{{#number, 1, 6}}` is `{{$randomInt 1 6}}`, `{{#dateISO}}` is `{{$isoTimestamp}}`); the others are left as they are and named in the notes. Tests become lines of the grammar of the client (`status == 200`, `json $.id exists`) and the tests that save a variable become captures. Scripts are kept as written: they use Thunder's `tc` API, of which only a part exists here.

Left out, with a note: requests of another kind (WebSocket, server-sent events, gRPC), authentication other than bearer and basic (OAuth 2.0 settings are listed by name, not guessed), a body that is a binary file, the cookies and settings of a request, the environment that a folder is linked to, encrypted values (type them in again: the variable is made, empty).

## Postman

A collection (`info` and `item`), or an environment or globals file (`values`). Variables that Postman writes `{{$randomUUID}}` and the like are mapped where the client has the word. Authentication: none, bearer, basic, API key and OAuth 2.0 (client credentials, password, authorization code with or without PKCE); the others (digest, Hawk, AWS, NTLM, ...) are left to be inherited, with a note. Bodies: raw (JSON, XML or text), form, multipart, a file, GraphQL. Scripts (`pm`) are kept as they are. A collection of the first version (`requests` and `folders` at the top) is refused: export it again as v2.1.

The files that a request sends (`src` of a form file, a binary body) are named by their file names only, not by the folders of the machine that made the export: put them in the folder of the collection.

## OpenAPI and Swagger

A description of an API (Swagger 2.0, OpenAPI 3.0 and 3.1, as JSON or YAML) becomes one collection: **a folder for each tag** (in the order the description lists them; an operation with no tag is in the collection itself, one with several tags in the folder of its first), **a request for each operation** (named by its summary, else its operation ID, else `GET /path`), and **an environment for each server** with the address in `baseUrl`, the first of which becomes the active environment when there is none. Choose *An address* instead of *A file* to fetch the description from a program that is running (`http://localhost:8080/v3/api-docs`, `/swagger.json`): it is fetched with a GET request through the same engine as a request you send, with the same redirect rules, certificate check and proxy, and nothing else is fetched.

- **Parameters** become rows: path parameters get their example, default or first value (or a `{{name}}` variable, which shows as missing until you define it: a made-up id could hit a real record), the required query and header parameters are on, the optional ones are off with a value to start from. Cookie parameters are left out; `Accept`, `Content-Type` and `Authorization` are not parameters.
- **The body** is the example of the description, or is made from its schema (the example, default or first enum value of each property, a value of the type or format otherwise; what the server makes, `readOnly`, is left out; a schema that contains itself is cut; the size is limited). The kinds: JSON (and vendor types such as `application/vnd.api+json`), forms, multipart (a file field is a file part: choose the file in the Body tab), XML, text, and any other type as a file. When several are described, JSON is used first and the others are named in the notes.
- **Authentication** comes from the security schemes: bearer, basic, API key (header or query), and OAuth 2.0 (authorization code, client credentials, password). The credentials are **secret variables of the collection with no value** (`token`, `apiKey`, `clientId`, `clientSecret`...; a second scheme of a kind gets its own, `second_token`): fill them in, and the values go to the file that Git ignores. The scheme named for all the operations is the collection's; an operation can use another, none (`security: []`) or inherit. Implicit OAuth 2.0 flows, OpenID Connect, digest and API keys in a cookie are not supported and said in the notes.
- **A test**: `status == 200`, the first success status of the responses.
- **Left out, and said**: callbacks, webhooks, the TRACE method, cookie parameters, and every `$ref` that is not inside the file (a reference to another file or an address is never fetched; download the files and bundle them first).
- **Safe to read**: only the references inside the file are followed, a loop of references is cut, the YAML reader has no anchors, aliases or tags (a file that uses them is refused with the line), and the size of what is made from a schema is limited.

## The controllers of your code

*Find the Routes of the Controllers in This Workspace...* reads the **source files of the workspace as text** (the code is never run) and makes a collection of the routes it finds, so that you can start from the program you are writing without writing a request for each route. It is a good guess, not a map: see below what it cannot know.

- **What is read**: the files with the extensions `.js .jsx .mjs .cjs .ts .tsx .mts .cts .java .kt .cs .py .php .go .rs`, except what is under `node_modules`, `dist`, `build`, `out`, `target`, `bin`, `obj`, `vendor`, `venv`, `.git` and the like, and the files of tests (`*.test.*`, `*.spec.*`, `*_test.go`, `*Test.java`, `test_*.py`...). At most 5,000 files of at most 1 MB each. `application.properties`, `application.yml`, `launchSettings.json`, `appsettings.json` and `.env` are read for the port.
- **What is found**: Express, Fastify, Koa, Hono, Elysia and Restify; NestJS (`@Controller` and the method decorators, with `setGlobalPrefix`); Spring (`@RestController`, `@RequestMapping`, `@GetMapping`..., in Java and Kotlin); ASP.NET Core (controllers with `[Route]` and `[HttpGet]`..., and minimal APIs with `MapGet` and `MapGroup`); FastAPI, Flask and Django; Laravel (`Route::get`, groups with prefixes, `Route::resource`); Go (gin, echo, fiber, chi, gorilla/mux, httprouter and `net/http`); Actix and Rocket. A router that is mounted with a prefix in another file of the workspace gets that prefix.
- **The collection**: named after the folder (`<folder> routes`), with **a folder for each controller** (or router, or file), **a request for each route** named `GET /users/{id}`, the parameters of the path as `{{id}}` variables (which show as missing until you define them: a made-up id could hit a real record), the query and header parameters that a controller names (NestJS, Spring, ASP.NET Core, FastAPI) as rows that are off, a JSON body `{}` or a form where a parameter says there is one, and in the notes of the request the file and the line where the route is. The environment `Local` has `baseUrl`: the port found in the configuration or in the code (`listen(4000)`, `server.port=8081`, `applicationUrl`), else the default of the framework.
- **What it cannot know**, and says: a prefix that is added by something that is not in the text (a proxy, the configuration of a framework, versioning, a module that registers routes by itself), a path that is computed (a constant, a concatenation: these are counted and left out), the methods of a Django `path` (they are listed as GET), the routers of Django REST framework, and the types of the parameters. A route that answers for every method is listed once, as GET. If the program is running, importing its OpenAPI description is exact where this is a guess.
- **Safe to read**: only text is read, a line of more than 2,000 characters is skipped (a minified file), the time is linear in the size of a file, and a path that grows beyond 2,000 characters is not a route.

## cURL

The command is read as a shell reads it: single and double quotes, `$'...'`, the line continuations of bash, PowerShell and cmd (and the carets that browsers write for cmd). Copy the command first: it is read from the clipboard with all its lines. The method, the headers, the body (JSON, form, multipart, a file), `-u`, `--oauth2-bearer`, `-G`, `-I`, `-k`, `--max-time`, `--http1.1` and `--http2` are carried over. The query of the address becomes rows of the Query tab. What cURL does with the answer (`-o`, `--proxy`, `--retry`, ...) has no place in a request and is a note. Nothing is run and no file is read: `-d @file` becomes a body that is a file of the collection.

## Limits

A file of at most 64 MB, 20,000 requests, folders 32 deep, 5,000 variables; more is cut, with a note.
