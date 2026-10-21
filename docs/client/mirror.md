# The `.http` file next to a request

Each request `list-pets.req.yml` has a copy `list-pets.http` next to it, for people who use the files with REST Client, JetBrains or httpYac, or who only read them in a pull request. **The request is the source; the `.http` file is generated from it, one way.** Two-way sync was rejected: scripts, OAuth, settings and inheritance have no `.http` form, so it would lose data and race with the editor.

## What is in the file

The request as it is in its collection (`src/mirror/generate.ts`, written with the emitter of the importer, `src/emit/http.ts`):

- the address with its base URL, the path parameters filled in and the query appended;
- the headers it inherits and its own, and the authentication as a header (`Authorization: Bearer ...`, `Basic user password`) or a query parameter;
- the body, with the `Content-Type` a send would add;
- the tests and captures as `# @assert` and `# @capture` lines (the same one-line grammar), the notes of the request as comments, the headers and query rows that are switched off as comments;
- one comment line for what a `.http` file cannot say: the scripts, OAuth 2.0, a body that is a file.

Variables stay as `{{variables}}`: nothing is resolved. **The file never holds a secret.** A literal under the name of a secret (a typed token, a password, an API key value, `"password": "..."` in a body, `?token=...` in an address) is written as a variable `{{secret_<collection>_<where>}}` that you define in an environment, and a comment names the variables. The values live only in memory while the file is made (so edits can be taken back, see below).

A body that a `.http` tool would read as something else (a line starting with `###`, `<`, `>` or `//`) is left out with a note, because the emitter would otherwise have to put it in another file.

**What the tools read into the file** (`src/mirror/safe.ts`, `src/mirror/generate.ts`). The tools that read a `.http` file run in a place of trust, and a request can come with a cloned repository, so the file never carries what they would act on:

- httpYac runs the text between `{{` and `}}` as JavaScript, and REST Client and httpYac put an environment variable into the request for `{{$processEnv NAME}}`. In the mirror only a plain variable name (letters, digits, `_` and `-`: **a name with a dot is not written as it is**, because `process.env.X` is a path that is read) and the dynamic words of the client with arguments the client accepts (`{{$guid}}`, `{{$randomInt 1 6}}`) are written as they are. Anything else has its braces separated (`{ {` and `} }`), which every tool reads as text, and so does a `{{` that is never closed.
- The tools read the file that a multipart part names, wherever it is. A file part whose path leaves the folder of the collection (an absolute path, a drive, `~`, `..`) is **not written**: a comment says so. The client itself refuses such a path when it sends.

The first line:

```
# api-client generated v1 src=list-pets.req.yml h=0123456789abcd -- edit the .req.yml, not this file
```

`h` is a 53-bit fingerprint (`src/util/hash.ts`, a change detector, not a defence) of everything below that line as it was written.

## When it is written, and when it is not

After the files are loaded and again whenever they change (a save, a pull, a branch switch), `syncMirrors` (`src/storage/mirror-sync.ts`) compares each file with what the request gives now (`src/mirror/drift.ts`):

| The file | The request | Case | What happens |
|---|---|---|---|
| missing | | `missing` | written |
| no first line of ours | | `foreign` | **never touched**: it is the person's own file |
| as written | as it was | `in-sync` | nothing |
| as written | changed | `regenerate` | written again, silently |
| the right text, an old header | | `stale-header` | the header is renewed |
| changed by hand | as it was | `edited` | **not written over**; offered: take the edits, show the difference, discard them, keep the file |
| changed by hand | changed | `both` | **not written over**; offered: show the difference, use the request, keep the file |

A checkout that turned line feeds into `\r\n` is not a change by hand. A file that is open with unsaved changes is left for the next sync. A generated file whose request is gone (renamed, moved, deleted) is removed with it, unless it was changed by hand.

## The person's side

- **CodeLens** on the first line of a generated file: *Generated from ...: edit the request, not this file* (opens the request), or, when it differs, the choices above. A status bar item counts the files that were edited by hand.
- **Take the edits** (`src/mirror/import.ts`): the file is compared with what it was when it was written, and **only the differences** are applied to the request: method, address (without the base URL; the query pair by pair), headers (a header of the request is replaced where it stood; one it inherits is overridden, or switched off with a disabled row when it is taken out), the text of a body that is text, tests and captures. A person sees the request before and after (a diff of the `.req.yml`) and a list of what is taken and what is **not taken and lost** when the file is written again (the title, comments, a multipart body, a test that comes from the collection). Variables that stand for secrets are put back as the values the request had, so nothing the file did not hold is lost.
- **Keep as my own file**: the first line is taken out and the request gets `mirror: false`; from then on nothing touches the file.

## Settings

- `apiClient.mirror.mode`: `on` (default), `off` (write nothing), `gitignored` (write, but list the generated files in a block of the `.gitignore` of the client folder that the extension owns, between two marker lines; a `.http` file of your own stays visible to Git).
- The Settings tab of a request has *Write a .http file next to this request* (the `mirror` key of the request).

## The cost, plainly

Twice the files in a pull request (use `gitignored` to remove the noise), and a change to the headers or the base URL of a collection rewrites the mirror of every request in it. The extension wakes up in any workspace that has `api-client/workspace.yml` (activation event `workspaceContains:**/api-client/workspace.yml`), because the files are kept in step without the side bar being opened.
