# Fixtures

Each fixture is a function in [cases.ts](cases.ts) that builds a `TcSource` in memory (or, where the reader has to be tried on a real disk, a temporary folder in `test/unit/fixtures-more.test.ts`), with the exact bytes the importer must write in [golden/](golden/). **All names and values are made up**; secrets are `CANARY-…` strings that tests look for.

| Code | Content | Checked by |
|---|---|---|
| F1 | An export of a collection and an environment (7 requests, 4 folders, `set-env-var`, `bearer`, `formencoded`, the query in the URL). Built to the same shape as a real export, not copied from one | golden `f01-export` |
| F2 | v3: `thunderclient.json` + `thunderCollection.json` + `thunderEnvironment.json`, with a history entry and a request that belongs to no collection | golden `f02-v3`; `fixtures-more.test.ts` on disk |
| F3 | v4 with a path parameter, `formencoded`, `basic`, `formdata` with files (relative and absolute) | golden `f03-v4` |
| F4 | Environments with `encrypted`, `global`, `local`, `default`, `envFile` and a repeated variable | golden `f04-environments` |
| F5, F6 | `body.raw` and `docs` as a list of lines or as one string give the same output | `fixtures-more.test.ts` |
| F7 | Bad names: `../x`, `CON`, `aux.txt`, a trailing dot, emoji, 500 characters, names that differ only in letter case, `index` | golden `f07-names` |
| F8 | A broken tree: a cycle, a missing parent, a folder that is its own parent, requests in folders that do not exist, a history entry | golden `f08-broken` |
| F9 | Not supported: `ws`/`sse`/`grpc`, `digest`/`aws`/`ntlm`/`oauth2` authentication, a `binary` body, scripts, a `schema` assertion | golden `f09-unsupported` |
| F10 | Secrets everywhere: bearer, basic password, `Authorization` header, key header, disabled header, query, form, variable, encrypted variable | golden `f10-secrets`; the canary tests |
| F11 | Hostile files: `__proto__`/`constructor`, BOM, invalid UTF-8, deep nesting, a 6 MiB string, a link out of the folder | `fixtures-more.test.ts` on disk |
| F12 | Determinism: equal `sortNum`, names and `_id`, shuffled | `fixtures-more.test.ts` |
| F13 | Inheritance over three levels: headers, authentication (`inherit`/`none`/bearer), `baseUrl`, tests that repeat and tests that do not, absolute URLs, URLs that start with `{{`, relative URLs | golden `f13-inheritance` |
| F14 | Text between `{{ }}` that looks like code (httpYac would run it) or reads the environment | golden `f14-expressions` |
| F15 | Thunder Client's dynamic variables written for each of the three tools | golden `f15-dynamic-rest-client`, `-httpyac`, `-jetbrains` |

## Conventions

- Each `golden/<code>/` holds the files the importer writes (paths as in the target folder) and `findings.txt` (one finding per line: severity, code, place, message).
- Rewrite the goldens only after a change you mean: `UPDATE_GOLDEN=1 npm test`, then **read the diff** before you accept it. A golden is not there to make a test green.
- Do not copy anybody's real data here. Write characters that tools might alter (invisible, direction-changing, emoji) as code points (`String.fromCodePoint`), not as `\uXXXX` escapes that a tool could turn into the real character.
