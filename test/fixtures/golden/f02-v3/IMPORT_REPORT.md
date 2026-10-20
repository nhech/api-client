# Thunder Client import report

This report lists names and places only. It never contains a value from your data, so it is safe to commit.

Written for REST Client: dynamic variables such as {{$guid}} are spelled the way that tool reads them. Import again with another target to write them for another tool.

## Summary

| | |
|---|---|
| Collections | 2 |
| Folders | 1 |
| Requests imported | 3 |
| Requests not imported | 0 |
| Environments | 1 |
| Secrets moved to the private file | 0 |
| Values to enter again | 0 |

## Written

| Folder | Requests | Folders |
|---|---|---|
| `Shop/` | 2 | 1 |
| `Unsorted/` | 1 | 0 |

## Environments

- dev: 1 variable (the default in Thunder Client)

### For REST Client

REST Client does not read `http-client.env.json`; it reads the VS Code setting `rest-client.environmentVariables`. The same variables are written for it. The extension fills the settings in for you unless you turned that off; these are the steps for the command line or for doing it by hand:

1. Paste the content of `rest-client.settings.json` into `.vscode/settings.json` of this workspace.
2. Choose an environment with the command "Rest Client: Switch Environment" (or the status bar).

## Needs your attention

### TC-ORPHAN-REQUEST: A request belonged to no known collection or folder. (1 place)

- Unsorted / lost: A request belonged to no known collection and was moved to "Unsorted".

## Notes

### TC-HISTORY-SKIPPED: History entries were skipped. (1 place)

- thunderclient.json: 1 history entry was skipped.

### TC-INHERIT-BASEURL: A base URL inherited from a folder or collection was prefixed to the URL. (1 place)

- Shop: 2 requests got a base URL from a folder or the collection.
