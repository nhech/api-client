# Thunder Client import report

This report lists names and places only. It never contains a value from your data, so it is safe to commit.

Written for REST Client: dynamic variables such as {{$guid}} are spelled the way that tool reads them. Import again with another target to write them for another tool.

## Summary

| | |
|---|---|
| Collections | 1 |
| Folders | 4 |
| Requests imported | 3 |
| Requests not imported | 0 |
| Environments | 0 |
| Secrets moved to the private file | 0 |
| Values to enter again | 0 |

## Written

| Folder | Requests | Folders |
|---|---|---|
| `Broken/` | 3 | 4 |

## Needs your attention

### TC-CYCLE: A folder cycle was cut. (2 places)

- Broken / A: A folder cycle was cut at this folder, which now sits at the top of the collection.
- Broken / Self: A folder cycle was cut at this folder, which now sits at the top of the collection.

### TC-ORPHAN-FOLDER: A folder pointed to a missing parent and moved to the top. (1 place)

- Broken / Lost: A folder pointed to a missing parent and was moved to the top of the collection.

### TC-ORPHAN-REQUEST: A request belonged to no known collection or folder. (1 place)

- Broken / nowhere: A request pointed to a missing folder and was moved to the top of the collection.

## Notes

### TC-HISTORY-SKIPPED: History entries were skipped. (1 place)

- collections/tc\_col\_a.json: 1 history entry was skipped.
