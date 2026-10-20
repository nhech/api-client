# Thunder Client import report

This report lists names and places only. It never contains a value from your data, so it is safe to commit.

Written for REST Client: dynamic variables such as {{$guid}} are spelled the way that tool reads them. Import again with another target to write them for another tool.

## Summary

| | |
|---|---|
| Collections | 1 |
| Folders | 0 |
| Requests imported | 7 |
| Requests not imported | 3 |
| Environments | 0 |
| Secrets moved to the private file | 0 |
| Values to enter again | 0 |

## Written

| Folder | Requests | Folders |
|---|---|---|
| `Unsupported/` | 7 | 0 |

## Not imported

These requests use a protocol that a `.http` file cannot express.

- Unsupported / events: sse request
- Unsupported / rpc: grpc request
- Unsupported / socket: ws request

## Needs your attention

### TC-AUTH-OAUTH2: OAuth 2.0 settings were not converted. (1 place)

- Unsupported / oauth

### TC-AUTH-UNSUPPORTED: This authentication type cannot be converted. (3 places)

- Unsupported / aws: The aws authentication type cannot be converted.
- Unsupported / digest: The digest authentication type cannot be converted.
- Unsupported / ntlm: The ntlm authentication type cannot be converted.

### TC-BODY-UNSUPPORTED: This body type cannot be converted. (1 place)

- Unsupported / binary: A binary body cannot be converted.

### TC-REQTYPE-UNSUPPORTED: WebSocket, SSE or gRPC request skipped. (3 places)

- Unsupported / events: A sse request cannot be converted and was skipped.
- Unsupported / rpc: A grpc request cannot be converted and was skipped.
- Unsupported / socket: A ws request cannot be converted and was skipped.

### TC-SCRIPT-SKIPPED: A script was not imported; it is kept as a comment. (1 place)

- Unsupported / script: 2 scripts were not imported and are kept as comments; review them for secrets.

### TC-TEST-UNSUPPORTED: This assertion has no equivalent. (1 place)

- Unsupported / schema test: A res-body \| schema test has no equivalent and was left out.
