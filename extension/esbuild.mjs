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
import { writeFileSync } from 'node:fs';
const app = await build({
  entryPoints: ['src/webview/app/main.tsx'], outfile: 'dist/app.js', bundle: true,
  platform: 'browser', target: 'es2022', format: 'iife', jsx: 'automatic', jsxImportSource: 'preact',
  minify: release, sourcemap: !release, legalComments: 'none', metafile: true
});
writeFileSync('dist/app.meta.json', JSON.stringify(app.metafile));
