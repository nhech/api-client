# Thunder Client import report

This report lists names and places only. It never contains a value from your data, so it is safe to commit.

Written for REST Client: dynamic variables such as {{$guid}} are spelled the way that tool reads them. Import again with another target to write them for another tool.

## Summary

| | |
|---|---|
| Collections | 3 |
| Folders | 10 |
| Requests imported | 15 |
| Requests not imported | 0 |
| Environments | 0 |
| Secrets moved to the private file | 0 |
| Values to enter again | 0 |

## Written

| Folder | Requests | Folders |
|---|---|---|
| `x/` | 11 | 10 |
| `CON_/` | 1 | 0 |
| `con_-2/` | 3 | 0 |

## Notes

### TC-NAME-COLLISION: A name was changed to be unique. (3 places)

- con: Another name is the same ignoring letter case, so this one is written as "con\_-2".
- ../x / index: Another name is the same ignoring letter case, so this one is written as "index-2".
- ../x / same: Another name is the same ignoring letter case, so this one is written as "same-2".

### TC-NAME-SANITIZED: A name was changed to be a valid file name. (8 places)

- ../x: The name is not valid in a file name, so it is written as "x".
- CON: The name is not valid in a file name, so it is written as "CON\_".
- ../x / \<unnamed\>: The name is not valid in a file name, so it is written as "unnamed".
- ../x / CON: The name is not valid in a file name, so it is written as "CON\_".
- ../x / a/b\\c:d\*e?f"g\<h\>i\|j: The name is not valid in a file name, so it is written as "a-b-c-d-e-f-g-h-i-j".
- ../x / aux.txt: The name is not valid in a file name, so it is written as "aux\_.txt".
- ../x / trailing.: The name is not valid in a file name, so it is written as "trailing".
- ../x / xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...: The name is not valid in a file name, so it is written as "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".
