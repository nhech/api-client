# Thunder Client import report

This report lists names and places only. It never contains a value from your data, so it is safe to commit.

Written for REST Client: dynamic variables such as {{$guid}} are spelled the way that tool reads them. Import again with another target to write them for another tool.

## Summary

| | |
|---|---|
| Collections | 1 |
| Folders | 0 |
| Requests imported | 6 |
| Requests not imported | 0 |
| Environments | 1 |
| Secrets moved to the private file | 0 |
| Values to enter again | 0 |

## Written

| Folder | Requests | Folders |
|---|---|---|
| `Expressions/` | 6 | 0 |

## Environments

- dev: 3 variables

### For REST Client

REST Client does not read `http-client.env.json`; it reads the VS Code setting `rest-client.environmentVariables`. The same variables are written for it. The extension fills the settings in for you unless you turned that off; these are the steps for the command line or for doing it by hand:

1. Paste the content of `rest-client.settings.json` into `.vscode/settings.json` of this workspace.
2. Choose an environment with the command "Rest Client: Switch Environment" (or the status bar).

## Needs your attention

### TC-EXPRESSION-NEUTRALIZED: Text between {{ }} that looked like code was made harmless. (2 places)

- Expressions: 14 pieces of text between {{ }} looked like code or a path, not a variable name; the braces were separated so that no tool runs or reads it.
- Environment dev: 1 value has text between {{ }} that looked like code or a path, not a variable name; the braces were separated so that no tool runs or reads it.
