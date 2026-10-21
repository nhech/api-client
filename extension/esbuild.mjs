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
