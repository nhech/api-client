# Thunder Client import report

This report lists names and places only. It never contains a value from your data, so it is safe to commit.

Written for REST Client: dynamic variables such as {{$guid}} are spelled the way that tool reads them. Import again with another target to write them for another tool.

## Summary

| | |
|---|---|
| Collections | 1 |
| Folders | 2 |
| Requests imported | 7 |
| Requests not imported | 0 |
| Environments | 0 |
| Secrets moved to the private file | 0 |
| Values to enter again | 0 |

## Written

| Folder | Requests | Folders |
|---|---|---|
| `Shop/` | 7 | 2 |

## Needs your attention

### TC-HEADER-DUP: Two headers differ only in letter case; the later one was kept. (5 places)

- Shop / absolute
- Shop / own auth none
- Shop / own header wins
- Shop / relative
- Shop / variable

## Notes

### TC-INHERIT-AUTH: Authentication inherited from a folder or collection. (1 place)

- Shop: 5 requests use authentication set on a folder or the collection.

### TC-INHERIT-BASEURL: A base URL inherited from a folder or collection was prefixed to the URL. (1 place)

- Shop: 5 requests got a base URL from a folder or the collection.

### TC-INHERIT-HEADERS: Headers inherited from a folder or collection were added to the request. (1 place)

- Shop: 7 requests received headers from a folder or the collection.

### TC-INHERIT-TESTS: Tests inherited from a folder or collection were added to the request. (1 place)

- Shop: 7 requests received tests from a folder or the collection.
