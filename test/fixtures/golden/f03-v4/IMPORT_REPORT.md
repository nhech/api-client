# Thunder Client import report

This report lists names and places only. It never contains a value from your data, so it is safe to commit.

Written for REST Client: dynamic variables such as {{$guid}} are spelled the way that tool reads them. Import again with another target to write them for another tool.

## Summary

| | |
|---|---|
| Collections | 1 |
| Folders | 1 |
| Requests imported | 4 |
| Requests not imported | 0 |
| Environments | 1 |
| Secrets moved to the private file | 1 |
| Values to enter again | 0 |

## Written

| Folder | Requests | Folders |
|---|---|---|
| `Orders/` | 4 | 1 |

## Environments

- default: 0 variables, 1 in the private file

The private file is `http-client.private.env.json`. It is added to `.gitignore` and must not be committed.

### For REST Client

REST Client does not read `http-client.env.json`; it reads the VS Code setting `rest-client.environmentVariables`. The same variables are written for it. The extension fills the settings in for you unless you turned that off; these are the steps for the command line or for doing it by hand:

1. Paste the content of `rest-client.settings.json` into `.vscode/settings.json` of this workspace.
2. Paste the content of `rest-client.private.settings.json` into your **user** settings (Preferences: Open User Settings (JSON)). VS Code merges the two. It holds the secrets, so it is kept out of Git: do not commit it.
3. Choose an environment with the command "Rest Client: Switch Environment" (or the status bar).

## Needs your attention

### TC-FILE-PATH: An attached file is outside the repository or has an absolute path. (1 place)

- Orders / Upload

### TC-PARAM-NOT-IN-URL: An enabled query parameter was missing from the URL and was appended. (1 place)

- Orders / Search: 2 enabled query parameters were missing from the URL and were appended.

### TC-PATHPARAM-EMPTY: A path parameter has no value; the placeholder was kept. (1 place)

- Orders / Get item

## Notes

### TC-SECRET-MOVED: A secret was moved to the private environment file. (1 place)

- Orders: 1 literal secret was moved to the private environment file.
