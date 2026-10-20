# Thunder Client import report

This report lists names and places only. It never contains a value from your data, so it is safe to commit.

Written for REST Client: dynamic variables such as {{$guid}} are spelled the way that tool reads them. Import again with another target to write them for another tool.

## Summary

| | |
|---|---|
| Collections | 1 |
| Folders | 0 |
| Requests imported | 5 |
| Requests not imported | 0 |
| Environments | 1 |
| Secrets moved to the private file | 8 |
| Values to enter again | 1 |

## Written

| Folder | Requests | Folders |
|---|---|---|
| `Secrets/` | 5 | 0 |

## Environments

- dev: 1 variable, 9 in the private file

The private file is `http-client.private.env.json`. It is added to `.gitignore` and must not be committed.

### For REST Client

REST Client does not read `http-client.env.json`; it reads the VS Code setting `rest-client.environmentVariables`. The same variables are written for it. The extension fills the settings in for you unless you turned that off; these are the steps for the command line or for doing it by hand:

1. Paste the content of `rest-client.settings.json` into `.vscode/settings.json` of this workspace.
2. Paste the content of `rest-client.private.settings.json` into your **user** settings (Preferences: Open User Settings (JSON)). VS Code merges the two. It holds the secrets, so it is kept out of Git: do not commit it.
3. Choose an environment with the command "Rest Client: Switch Environment" (or the status bar).

## Enter these values again

Thunder Client stores these encrypted, so they cannot be carried over. They are empty in the private file.

- dev: old\_secret

## Needs your attention

### TC-ENV-ENCRYPTED: An encrypted variable must be entered again. (1 place)

- Environment dev: 1 encrypted variable was not decrypted; type its value in again in the private file.

## Notes

### TC-SECRET-MOVED: A secret was moved to the private environment file. (2 places)

- Secrets: 7 literal secrets were moved to the private environment file.
- Environment dev: 1 secret-looking variable was moved to the private environment file.
