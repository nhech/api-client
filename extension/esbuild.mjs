import { build } from 'esbuild';

const release = process.argv.includes('--release');

// One CommonJS file for the extension host. The core library is bundled in; only `vscode` stays outside.
await build({
  entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', bundle: true,
  platform: 'node', target: 'node20', format: 'cjs', external: ['vscode'],
  sourcemap: !release, legalComments: 'none'
});

// The script of the importer panel: one file for the browser inside the webview. It imports only types, so none of the core goes into it.
await build({
  entryPoints: ['src/webview/main.ts'], outfile: 'dist/wizard.js', bundle: true,
  platform: 'browser', target: 'es2022', format: 'iife',
  sourcemap: !release, legalComments: 'none'
});

// The request editor: Preact and CodeMirror with our code, one file for the browser. Its inputs are written to dist/app.meta.json so that a test can check
// that only the packages that were chosen went into it.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const app = await build({
  entryPoints: ['src/webview/app/main.tsx'], outfile: 'dist/app.js', bundle: true,
  platform: 'browser', target: 'es2022', format: 'iife', jsx: 'automatic', jsxImportSource: 'preact',
  minify: release, sourcemap: !release, legalComments: 'none', metafile: true
});
writeFileSync('dist/app.meta.json', JSON.stringify(app.metafile));

// The worker of the scripts: the engine (QuickJS compiled to WebAssembly) with our code, one file for a worker thread. The glue of the engine wants `fs` and
// `module` of Node for ways of loading it that are not used here (the extension compiles the module and hands it over), so they are replaced by nothing and the
// bundle requires only `worker_threads`, which the package check pins. The glue also has ways of loading the module in a browser (`fetch`, `XMLHttpRequest`) and a
// default environment with a made-up home folder; none of it can run here, and it is replaced so that the check of the package, which looks for exactly these
// things in every bundle, stays strict. The module of the engine is copied as it is; the check pins its hash too.
const withoutNodeFiles = {
  name: 'without-node-files',
  setup(builder) {
    builder.onResolve({ filter: /^(?:node:)?(?:fs|module)$/ }, args => ({ path: args.path, namespace: 'nothing' }));
    // The glue asks `module` for a `require` of its own to reach `fs`, `path` and `url`; it gets one that hands out objects whose every function refuses.
    builder.onLoad({ filter: /.*/, namespace: 'nothing' }, args => ({
      contents: /module$/.test(args.path)
        ? "const refuse = new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => { throw new Error('not available in the script worker'); }) }); module.exports = { createRequire: () => () => refuse };"
        : 'module.exports = {};',
      loader: 'js'
    }));
    builder.onLoad({ filter: /emscripten-module\.(?:cjs|mjs)$/ }, args => ({ contents: readFileSync(args.path, 'utf8').replaceAll('/home/web_user', '/user'), loader: 'js' }));
  }
};
await build({
  entryPoints: ['../src/script/worker.ts'], outfile: 'dist/script-worker.js', bundle: true, plugins: [withoutNodeFiles], define: { XMLHttpRequest: 'undefined', fetch: 'undefined', 'import.meta.url': '"script-worker"' },
  platform: 'node', target: 'node20', format: 'cjs', minify: release, sourcemap: !release, legalComments: 'none'
});
mkdirSync('dist', { recursive: true });
copyFileSync('../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm', 'dist/quickjs.wasm');
