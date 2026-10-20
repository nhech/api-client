# Thunder Client import report

This report lists names and places only. It never contains a value from your data, so it is safe to commit.

Written for JetBrains HTTP Client: dynamic variables such as {{$guid}} are spelled the way that tool reads them. Import again with another target to write them for another tool.

## Summary

| | |
|---|---|
| Collections | 1 |
| Folders | 0 |
| Requests imported | 4 |
| Requests not imported | 0 |
| Environments | 0 |
| Secrets moved to the private file | 0 |
| Values to enter again | 0 |

## Written

| Folder | Requests | Folders |
|---|---|---|
| `Dynamic/` | 4 | 0 |

## Needs your attention

### TC-EXPRESSION-NEUTRALIZED: Text between {{ }} that looked like code was made harmless. (1 place)

- Dynamic: 1 piece of text between {{ }} looked like code or a path, not a variable name; the braces were separated so that no tool runs or reads it.

## Notes

### TC-SYSVAR-UNMAPPED: A dynamic variable was left as it is. (1 place)

- Dynamic: Dynamic variables with no equivalent were left as they are: bool, date, email.
