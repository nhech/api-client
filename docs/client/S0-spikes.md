# S0 spikes: results and decisions (2026-10-21)

Two spikes ran before any product code was written, to settle the two riskiest choices of the client plan: the script sandbox and the webview stack. Both are **go**. The spike code lived in a scratch folder; the numbers and the rules that follow from them are recorded here.

## 1. Script sandbox: QuickJS compiled to WASM, in a worker thread

**Packages:** `quickjs-emscripten-core` 0.32.0 and `@jitl/quickjs-wasmfile-release-sync` 0.32.0 (both MIT; bellard QuickJS 2025-09-13). The quickjs-ng variant (`@jitl/quickjs-ng-wasmfile-release-sync`) behaved the same in every check and is a drop-in alternative.

**Where it ran:** Windows 11 with Node 22 and Electron's Node (VS Code 1.107.1 extension host: Node 22.21.1, Electron 39.2.3), and Linux (`node:22-bookworm` in Docker, no network). Not yet run: macOS, Remote-SSH, WSL, Codespaces, VSCodium, Cursor (CI covers macOS from M1; the rest are checked by hand in M14).

**Size:** the `.wasm` is 503,134 bytes (232 KB gzip); the worker bundled with esbuild is 63,940 bytes (17.8 KB gzip), minified, with no `eval` and no `new Function`.

**Speed:** worker spawn plus QuickJS start 54 ms (97 ms inside the VS Code host, 130 ms on Linux); the first script 10 ms, then 1 to 3 ms per script in a fresh runtime and context.

**What the hostile scripts did:**

| Script | Result |
|---|---|
| `while(true){}` | interrupted at the 200 ms deadline |
| the same loop inside `try/catch` | still interrupted: the interrupt is not catchable |
| ReDoS `/(a+)+$/` | interrupted |
| deep recursion | `InternalError: stack overflow` |
| `"x".repeat(2**30)` | `RangeError` |
| `this.constructor.constructor("return typeof process + typeof require + typeof fetch + typeof Buffer")()` | every one `undefined` |
| `Function("return globalThis.process")()` | `undefined` |
| `import("node:fs")` | rejected: "could not load module" |
| prototype pollution | stays inside the throw-away runtime |
| a host function returning to the script | only strings cross; no live handles |
| `await` on a promise the host resolves later (the shape of `pm.sendRequest`) | works, including two in parallel |
| `worker.terminate()` while a script spins with no interrupt handler, or the host op never returns | the worker dies in about 200 ms |

**Findings that change the plan (rules, not options):**

1. **`setMemoryLimit` is not a memory cap.** Repeated `new Uint8Array(1e6)` or `"x".repeat(1e6)` pushed the worker to 2,082 MB of process memory before QuickJS reported "out of memory", and the string bomb ran 8 s. **Rule:** create the engine with its own `WebAssembly.Memory({ initial: 256, maximum: 1024 })` (16 MB start, 64 MB hard maximum) through `newVariant(variant, { wasmModule, wasmMemory })`. With that, every bomb ended in under 0.5 s and the process grew about 56 MB. Keep `setMemoryLimit` as a second, softer limit.
2. **The interrupt handler is polled every few thousand bytecode ticks, not by time.** A script that spends its time in native built-ins can overshoot the CPU deadline by seconds (the string bomb polled the handler once in 8 s). **Rule:** a main-thread watchdog ends the worker with `worker.terminate()` at the CPU limit plus 500 ms, counting only time when the script is not waiting for a host operation. The wall-clock limit stays as the outer bound. Respawning costs about 55 ms, so a worker may be reused across scripts, with a fresh runtime and context for each one, and is recycled whenever it was terminated or reported any host error.
3. **Dumping an error can itself fail at out-of-memory** (the host saw `Cannot read properties of null`). **Rule:** any exception on the host side of a run counts as a failed script and recycles the worker.
4. **The globals of a fresh context include `SharedArrayBuffer`, `Atomics` (function), `eval`, `Function`, `escape`/`unescape`, `Proxy`, `Reflect` and `FinalizationRegistry`.** **Rule:** the prelude deletes what the API does not need (at least `SharedArrayBuffer`, `Atomics`, `FinalizationRegistry`, `WeakRef`) and a test compares the global names with an allow-list. `structuredClone`, `setTimeout`, `fetch`, `process`, `require` and `WebAssembly` are absent by default.
5. **Output floods are cheap for the script and expensive for the host** (200,000 log calls moved 8.7 MB in 1.3 s). **Rule:** the host stops accepting log output at the cap and the host operation then throws, which ends the script.
6. **The emscripten glue wants Node APIs:** the CJS glue calls `require("node:fs")` and reads `process.argv`, and the ESM glue does `await import("node:module")`. Because the host compiles the module and passes it in, the glue never reads a file. **Rule:** bundle the worker with an esbuild plugin that stubs `node:fs` and `node:module`, so the worker bundle requires only `node:worker_threads` and the package check can pin that.

**Decision:** go. Ship QuickJS-WASM in a worker thread; never fall back to `node:vm`.

## 2. Webview stack: Preact + signals + CodeMirror 6

A mini request editor (method select, one-line URL editor with `{{variable}}` highlighting, JSON body editor with line numbers, folding, search, lint and autocomplete) was bundled with esbuild and loaded in a real VS Code webview with this policy: `default-src 'none'; script-src 'nonce-N'; style-src <cspSource> 'nonce-N'; img-src <cspSource> data:; font-src <cspSource>; base-uri 'none'; form-action 'none'` (no `connect-src`, no `frame-src`, no `unsafe-eval`).

- **Result:** rendered in 56 ms, zero CSP violations, 2 editors, variable decorations present, CodeMirror's injected `<style>` carried the nonce (`EditorView.cspNonce`).
- **Size (minified):** 606 KB, 209 KB gzip, with languages for JSON, JavaScript, XML and HTML. By package: `@codemirror/view` 185 KB, `@lezer/javascript` 76 KB, `@codemirror/state` 46 KB, `@codemirror/autocomplete` 34 KB, `@lezer/common` and `lr` 54 KB, `@codemirror/language` 25 KB, `commands` 23 KB, `search` 20 KB, `lint` 14 KB, the HTML language with its CSS and HTML grammars about 55 KB, `preact` 12.8 KB, `@preact/signals` plus core 8 KB, our own code 3 KB. Dropping the HTML language (responses in HTML are shown as plain text) saves about 55 KB.
- **Versions in the spike:** preact 11.0.1, @preact/signals 2.11.3, @codemirror/view 6.43.15, state 6.7.6, language 6.13.1, commands 6.11.1, autocomplete 6.20.4, search 6.7.2, lint 6.9.7, lang-json 6.0.2, lang-javascript 6.2.5, lang-xml 6.1.0, @lezer/highlight 1.2.5. Pin exact versions and commit the lockfile when they are added to the repo.
- **Risky APIs in the bundle:** no `eval`, no `new Function`, no `fetch`, no `XMLHttpRequest`, no `document.write`. `innerHTML` appears once, inside Preact's handling of `dangerouslySetInnerHTML`, a path our code never takes (the bundle audit bans our own use of that prop). CodeMirror itself does not use `innerHTML`.

**Decision:** go. The size budget for `dist/app.js` starts at 650 KB minified; the package budget is measured in M1 from the real bundles plus the QuickJS pair (about 0.57 MB), not guessed.

## 3. Activation (not a spike; a decision)

Contributed views, commands and custom editors activate the extension by themselves. For the `.http` CodeLens (M10), `onLanguage:http` would not fire when no installed extension provides the `http` language id, so the CodeLens activates on `workspaceContains:**/api-client/workspace.yml` instead, and the guard that requires `activationEvents` to be empty is replaced by a check against an explicit allow-list. To be confirmed in M10.
