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
- **No runtime dependencies.** The package has none; the extension bundle imports only `node:crypto` (the nonce of the panel's page), `node:fs`, `node:os`, `node:path` and `vscode` (checked), and the script of the panel imports nothing.
- **The panel shows text, never markup.** Anything that comes from a collection is put in the panel's page with `textContent`; a test keeps `innerHTML` and its relatives out of `extension/src/webview/`. A message from the page is parsed as untrusted (`src/wizard/protocol.ts`), and no path comes from the page.

## Tests

```sh
npm test                    # compile the tests and run them
UPDATE_GOLDEN=1 npm test    # rewrite test/fixtures/golden/ after a change you mean
npm run mutate              # break the rules one by one; every one must be caught (slow)
npm run ext:host-test       # the extension in an installed VS Code, with a throw-away profile
node extension/test/screenshots.cjs   # the pictures of the panel in docs/images (a real VS Code, made-up data)
```

The goldens are the exact bytes the importer writes for each fixture. **Read the diff of a golden before you accept it**; they are not there to make a test green. When a new rule matters, add a mutation for it to `tools/mutate.cjs` and check that the tests catch it.

Tests that touch the disk create disposable folders and must not operate on a contributor's own data. Fixtures are made up; secrets in them are `CANARY-…` strings that tests look for.

## Publishing the extension

A release is built from a clean checkout of the release commit, so work in progress is never packaged.

```sh
npm run ext:package         # runs npm run check, builds, checks what is in the package, writes .artifacts/http-files-importer-<version>.vsix
API_CLIENT_TEST_VSIX=.artifacts/http-files-importer-<version>.vsix node extension/test/run.cjs   # tries the PACKAGE in a real VS Code
```

`npm run ext:package` refuses a tree with uncommitted changes (`--allow-dirty` makes a trial package) and fails when the package holds a file it should not, a network or process module, a source map, an SVG or relative image in the README, or a manifest that is marked private or has an activation event.

The pictures in `docs/images/` are the images of the Marketplace page and the landing page (`site/img/`, copy them). Take them again with `node extension/test/screenshots.cjs` after a change of the panel, and push the commit before the package is uploaded: the README of the extension links them on the `main` branch.

**Visual Studio Marketplace.** The publisher `longtd` uploads the package on its Manage page (the `...` menu of the extension, then **Update**; the first time, **New extension**). Marketplace scans the upload, which takes some time. Then set `MARKETPLACE_LISTED` to `true` in `scripts/build-site.cjs` (check that `MARKETPLACE_URL` opens the listing first) and run `npm run site:deploy`.

**Open VSX** (VSCodium, Cursor and others) needs the owner's own accounts and token. Once: sign in at <https://open-vsx.org> with GitHub, link an Eclipse account (<https://accounts.eclipse.org/user/register>, with the same GitHub user name) under Settings, sign the **Publisher Agreement** there, and create an access token under Settings, Access Tokens. Keep the token in an environment variable (never in a file or the command history), create the namespace with `npx --yes ovsx@1.2.0 create-namespace longtd -p "$OVSX_PAT"`, and publish each release with `npx --yes ovsx@1.2.0 publish .artifacts/http-files-importer-<version>.vsix -p "$OVSX_PAT"`. The publisher `longtd` also exists on the Visual Studio Marketplace, so until Open VSX has granted ownership of the namespace the listing shows a "not a verified publisher" warning: after the first publish, open an issue in <https://github.com/EclipseFdn/open-vsx.org/issues> with the namespace template and show that the GitHub user `nhech` owns the Marketplace publisher (the extension's repository is under that user).

## Trying the output in the real tools

Compatibility claims come from running the output in REST Client, httpYac and the JetBrains HTTP Client, not from reading their documentation. If you change what is written in a `.http` file, run the runners in `samples/` (see the README) and record what you learn in section 10.3 of the spec.

## Style

Keep changes focused and describe the observable behavior in the commit message (a short imperative first line, then why). Follow the existing code: strict TypeScript, comments that say why, no comments that repeat the code. Keep generated packages (`dist/`, `.artifacts/`, `.test-build/`), logs and credentials out of Git.

By contributing you agree that your contribution is licensed under the [MIT license](LICENSE).
