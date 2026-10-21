# Importing

*Import...* (the Collections view, or the Command Palette) brings in what other tools made. Each way **reads** a file or a text (`src/importers/`, pure and tested without VS Code), tells you what it found as a count, and writes nothing until you say yes. What could not be carried over is a list of notes, one command away (*Show the Notes of the Last Import*). Nothing an importer reads is run: a `{{ ... }}` that looks like code is text, a script is kept as text and runs only after you have allowed it (see `scripts.md`).

| From | Command | What comes across |
|---|---|---|
| **Thunder Client** | *Import Thunder Client Data...* | collections, folders (with what they set: base address, headers, authentication, tests, scripts), requests, environments |
| **Postman** | *Import a Postman Collection or Environment...* | collection v2.0 and v2.1, folders and their order, requests, authentication, scripts, variables; an environment or a globals file |
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

## cURL

The command is read as a shell reads it: single and double quotes, `$'...'`, the line continuations of bash, PowerShell and cmd (and the carets that browsers write for cmd). Copy the command first: it is read from the clipboard with all its lines. The method, the headers, the body (JSON, form, multipart, a file), `-u`, `--oauth2-bearer`, `-G`, `-I`, `-k`, `--max-time`, `--http1.1` and `--http2` are carried over. The query of the address becomes rows of the Query tab. What cURL does with the answer (`-o`, `--proxy`, `--retry`, ...) has no place in a request and is a note. Nothing is run and no file is read: `-d @file` becomes a body that is a file of the collection.

## Limits

A file of at most 64 MB, 20,000 requests, folders 32 deep, 5,000 variables; more is cut, with a note.
