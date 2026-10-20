# Tools

## thunder-structure: describe your Thunder Client data without sharing it

One Node script with no dependencies (Node 18 or newer) that **describes the structure** of a Thunder Client data folder and prints no free-form content. Use it to see what your data looks like, or to attach to an issue when an import goes wrong. You do **not** need to be signed in to Thunder Client: it only reads files on disk.

Run the commands from the root of the repository.

```sh
# 1. Self-test: builds a made-up folder with "canary" strings and proves that none of them reaches the report
node tools/thunder-structure.cjs --selftest

# 2. See which candidate folders exist (checks existence only, reads nothing)
node tools/thunder-structure.cjs

# 3. Read the data folder and write the report to a file (an existing file is never overwritten)
node tools/thunder-structure.cjs --auto --out thunder-report.md
#    or name the folder:
node tools/thunder-structure.cjs --root "<Thunder Client data folder>" --out thunder-report.md
```

Options: `--json report.json` (machine-readable copy) and `--strict` (unknown keys are printed as `<key-N>` instead of their names; use it if you worry that keys you invented could be revealing).

Default folders: Windows `%APPDATA%\Code\User\globalStorage\rangav.vscode-thunder-client` (replace `Code` by `Cursor`, `VSCodium`, ... for other editors); macOS `~/Library/Application Support/<App>/User/globalStorage/...`; Linux `~/.config/<App>/User/globalStorage/...`.

### What it does and does not do

- **Read-only, no network.** It never writes into the source folder; it writes `--out` and `--json` only when you give them, and never over an existing file.
- **No free-form content.** Values are described by *shape* (empty, only a `{{variable}}`, absolute URL, JWT-like, JSON-like, text). Only a short list of fields prints a real value: `method`, `body.type`, `auth.type`, `reqType`, `version`, the type and action of tests, boolean flags, the MIME of a `Content-Type` header, and the names of Thunder Client's own dynamic variables such as `{{#guid}}`.
- **No names** of collections, folders, requests, variables or files (other than Thunder Client's own data files). A header name is printed only if it is in a list of common ones, otherwise `<other>`.
- **It does print JSON key names**, because finding unknown fields is the point. Keys the importer does not know are marked `*new`.
- It skips symbolic links, limits each file to 50 MiB and the count to 5,000 files, reads only the size of `thunderResponses.json`, and does not read `files/`, `res-files/` or `_db-backup*`. The root path it prints has your home folder replaced by `~` and your user name by `<user>`.

**Read the report before you send it to anyone.** The self-test proves the point for made-up data, not for every real one; an unusual key name is the only place where something you wrote could appear (use `--strict` if you worry).

## mutate: check that the tests catch broken rules

```sh
npm run mutate          # all mutations (slow: the whole suite runs once per mutation)
node tools/mutate.cjs M3 M7
```

It breaks one rule of the importer at a time (inheritance, secret handling, line-break safety, name collisions, the writer's checks, ...), runs the tests, puts the file back (also when interrupted) and demands that the tests fail. A mutation that survives is a rule no test protects; one that does not compile is a wrong mutation. Not part of `npm run check`.
