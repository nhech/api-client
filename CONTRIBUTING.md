# Contributing

Use Node.js 22 or newer.

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` runs the type checks (core and VS Code layer), the linter, all unit tests and the self-test of `tools/thunder-structure.cjs`. It must be green before a change is merged.

## Rules the tests keep

- **The core is pure and offline.** `src/` never imports `vscode`, a network module, `child_process` or an evaluator, and the stages that decide the output (`normalize/`, `convert/`, `emit/`, `model/`) use no time, randomness, machine information or locale (`test/unit/purity.test.ts`). Only `src/write/` writes to disk, and nothing but `extension/` talks to VS Code.
- **Same data, same bytes.** The output depends on the data alone, whatever the order of the files, keys and arrays. Sort by code point, never by locale.
- **The finding codes match the spec both ways.** Add a code in `src/model/findings.ts` and in the table of section 7 of [docs/SPEC.vi.md](docs/SPEC.vi.md) together, and have a fixture produce it (`test/unit/findings-catalog.test.ts`, `test/unit/fixtures-more.test.ts`).
- **No hidden characters in the code.** Build such characters from numbers (`String.fromCodePoint(0x202e)`), never as escapes that a tool may turn into the real character (`test/unit/hygiene.test.ts`).
- **A report or log never holds a value read from the data**, only names and places.
- **No runtime dependencies.** The package has none; the extension bundle imports only `node:fs`, `node:os`, `node:path` and `vscode` (checked).

## Tests

```sh
npm test                    # compile the tests and run them
UPDATE_GOLDEN=1 npm test    # rewrite test/fixtures/golden/ after a change you mean
npm run mutate              # break 33 rules one by one; every one must be caught (slow)
npm run ext:host-test       # the extension in an installed VS Code, with a throw-away profile
```

The goldens are the exact bytes the importer writes for each fixture. **Read the diff of a golden before you accept it**; they are not there to make a test green. When a new rule matters, add a mutation for it to `tools/mutate.cjs` and check that the tests catch it.

Tests that touch the disk create disposable folders and must not operate on a contributor's own data. Fixtures are made up; secrets in them are `CANARY-…` strings that tests look for.

## Trying the output in the real tools

Compatibility claims come from running the output in REST Client, httpYac and the JetBrains HTTP Client, not from reading their documentation. If you change what is written in a `.http` file, run the runners in `samples/` (see the README) and record what you learn in section 10.3 of the spec.

## Style

Keep changes focused and describe the observable behavior in the commit message (a short imperative first line, then why). Follow the existing code: strict TypeScript, comments that say why, no comments that repeat the code. Keep generated packages (`dist/`, `.artifacts/`, `.test-build/`), logs and credentials out of Git.

By contributing you agree that your contribution is licensed under the [MIT license](LICENSE).
