# How large a collection can be

Measured on 2026-10-22 on a Windows laptop with the files on an SSD, with another program using the processor (the numbers are a ceiling, not a best case). The script that made them builds a collection of N requests (a method, an address with a query, a header, and a JSON body for a third of them) in folders, and times the same calls that the extension makes (`Store.load`, `collectionsTree`, `syncMirrors`).

| Requests | Reading all the files | The tree of the side bar | The `.http` copies, first time | The `.http` copies, when nothing changed | After one edit (read again + copies) |
|---|---|---|---|---|---|
| 1,000 | 0.3 s | 2 ms | 0.7 s | 0.24 s | 0.5 s |
| 10,000 | 2.6 s | 22 ms | 8 s | 2.5 s | 5 s |

What this says:

- The side bar is not the cost: the tree of 10,000 requests is built in about 20 ms, and a filter in 5 ms.
- The cost is reading and parsing the files, and checking the `.http` copy of each request, and **it is paid again for the whole collection when one file changes** (a save, a pull, a branch switch; the change is waited for a quarter of a second first, and a burst counts once). Up to a thousand requests nobody notices; at ten thousand every edit holds the extension host for several seconds. Splitting such a collection in several does not help (they are all read together); turning the `.http` copies off (`apiClient.mirror.mode` = `off`) takes away about half of that time.
- Memory: 80 to 90 MB for 10,000 requests.
- Limits that keep a hostile folder from being worse than this: 5,000 entries in one folder, 32 levels of folders, 100,000 nodes, 5 MB for one file (`src/storage/fs.ts`).

Not done yet: reading only the file that changed, and skipping the copies that cannot have changed. Both are changes inside `ClientWorkspace.reload` and `syncMirrors`; they matter only for collections of thousands of requests.
