# Contributing

Use Node.js 22 or newer.

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` runs the type checks (core and VS Code layer), the linter, all unit tests and the self-test of `tools/thunder-structure.cjs`. It must be green before a change is merged. The Linux check is the same command in a `node:22` container (the tests must pass there too).

## Rules the tests keep

- **Every directory has a zone that says what it may import** (`test/support/zones.ts`, checked by `test/unit/purity.test.ts`). The core (`src/core/`, `src/format/`, the stages `normalize/`, `convert/`, `emit/`, `model/`, and the pure parts around them) imports no Node module and uses no time, randomness, machine information or locale of its own (the clock is injected). Only `src/engine/` uses `node:http`, `node:https`, `node:tls`, `node:dns` and `node:zlib`; only the script zone uses `node:worker_threads` and the QuickJS engine; only `extension/` uses `vscode`. A new directory has to be added to the zones on purpose, and widening a list is done in the commit that needs it, with the reason. Nothing uses `child_process`, `eval`, `new Function`, `node:vm` or a dynamic `import()`.
- **Same data, same bytes.** The output depends on the data alone, whatever the order of the files, keys and arrays. Sort by code point, never by locale.
- **The finding codes match the spec both ways.** Add a code in `src/model/findings.ts` and in the table of section 7 of [docs/SPEC.vi.md](docs/SPEC.vi.md) together, and have a fixture produce it (`test/unit/findings-catalog.test.ts`, `test/unit/fixtures-more.test.ts`).
- **No hidden characters in the code.** Build such characters from numbers (`String.fromCodePoint(0x202e)`), never as escapes that a tool may turn into the real character (`test/unit/hygiene.test.ts`).
- **A report or log never holds a value read from the data**, only names and places.
- **The package is checked, not trusted.** The bundles are built from the sources and `scripts/package-extension.cjs` verifies the `.vsix` against `scripts/package-rules.json`: the exact list of files, the Node modules each bundle may `require`, no network call in a page, a pinned hash for the QuickJS WebAssembly file, a size limit, and the images and links of the README. Raise a limit or add a module in the commit that needs it.
- **The pages show text, never markup.** Anything that comes from a collection or from a server is put in a page as text; a test keeps `innerHTML` and its relatives out of `extension/src/webview/`, and the pages have a Content-Security-Policy with `default-src 'none'`. A message from a page is parsed as untrusted (`src/wizard/protocol.ts`, `src/view/protocol.ts`), and no path comes from a page.
- **A secret is covered by what it is and by what it is called**, wherever something is written down (`src/core/redact.ts`); a test with a made-up secret should fail if a new output forgets to use it.

## Tests

```sh
npm test                    # compile the tests and run them
UPDATE_GOLDEN=1 npm test    # rewrite test/fixtures/golden/ after a change you mean
npm run mutate              # break the rules one by one; every one must be caught (slow)
npm run ext:host-test       # the extension in an installed VS Code, with a throw-away profile
node extension/test/screenshots.cjs   # the pictures of the importer panel in docs/images (a real VS Code, made-up data)
SHOTS_SCENARIO=request node extension/test/screenshots.cjs <folder>   # the request editor, the runner and the other pages, in four themes
```

CI runs the tests on Node 22 on Windows, Linux and macOS. When a test fails there and not on your machine (the words of OpenSSL for a wrong passphrase of a PKCS#12 bundle are one thing that differs between versions), run the compiled tests under the Node 22 that ships with VS Code: after `npm run test:compile`, `ELECTRON_RUN_AS_NODE=1 "<path to Code.exe>" --test .test-build/test/unit/*.test.js`.

The goldens are the exact bytes the converter, the YAML writer and the code generators write for each fixture. **Read the diff of a golden before you accept it**; they are not there to make a test green. When a new rule matters, add a mutation for it to `tools/mutate.cjs` and check that the tests catch it.

Tests that touch the disk create disposable folders and must not operate on a contributor's own data. Fixtures are made up; secrets in them are `CANARY-…` strings that tests look for.

## Publishing the extension

A release is built from a clean checkout of the release commit, so work in progress is never packaged.

```sh
node scripts/package-extension.cjs   # runs npm run check, builds, checks what is in the package, writes .artifacts/api-client-<version>.vsix
API_CLIENT_TEST_VSIX=.artifacts/api-client-<version>.vsix node extension/test/run.cjs   # tries the PACKAGE in a real VS Code
```

The packaging script refuses a tree with uncommitted changes (`--allow-dirty` makes a trial package) and fails when the package holds a file it should not, a module outside the list of its bundle, a source map, an SVG or relative image in the README, a changed QuickJS file, or a package over the size limit.

The pictures in `docs/images/` are the images of the Marketplace page and the landing page (`site/img/`, copy them). Take them again with `node extension/test/screenshots.cjs` after a change of the panel, and push the commit before the package is uploaded: the README of the extension links them on the `main` branch.

**Visual Studio Marketplace.** The publisher `longtd` uploads the package on its Manage page (the `...` menu of the extension, then **Update**; the first time, **New extension**). Marketplace scans the upload, which takes some time. Then set `MARKETPLACE_LISTED` to `true` in `scripts/build-site.cjs` (check that `MARKETPLACE_URL` opens the listing first) and run `npm run site:deploy`.

**Open VSX** (VSCodium, Cursor and others) needs the owner's own accounts and token. Once: sign in at <https://open-vsx.org> with GitHub, link an Eclipse account (<https://accounts.eclipse.org/user/register>, with the same GitHub user name) under Settings, sign the **Publisher Agreement** there, and create an access token under Settings, Access Tokens. Keep the token in an environment variable (never in a file or the command history), create the namespace with `npx --yes ovsx@1.2.0 create-namespace longtd -p "$OVSX_PAT"`, and publish each release with `npx --yes ovsx@1.2.0 publish .artifacts/api-client-<version>.vsix -p "$OVSX_PAT"`. The publisher `longtd` also exists on the Visual Studio Marketplace, so until Open VSX has granted ownership of the namespace the listing shows a "not a verified publisher" warning: after the first publish, open an issue in <https://github.com/EclipseFdn/open-vsx.org/issues> with the namespace template and show that the GitHub user `nhech` owns the Marketplace publisher (the extension's repository is under that user).

## Trying the output in the real tools

Compatibility claims come from running the output in REST Client, httpYac and the JetBrains HTTP Client, not from reading their documentation. If you change what is written in a `.http` file, run the runners in `samples/` (see the README) and record what you learn in section 10.3 of the spec.

## Style

Keep changes focused and describe the observable behavior in the commit message (a short imperative first line, then why). Follow the existing code: strict TypeScript, comments that say why, no comments that repeat the code. Keep generated packages (`dist/`, `.artifacts/`, `.test-build/`), logs and credentials out of Git.

By contributing you agree that your contribution is licensed under the [MIT license](LICENSE).
