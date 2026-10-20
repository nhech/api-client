import { build } from 'esbuild';

// One CommonJS file for the extension host. The core library is bundled in; only `vscode` stays outside.
await build({
  entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', bundle: true,
  platform: 'node', target: 'node20', format: 'cjs', external: ['vscode'],
  sourcemap: !process.argv.includes('--release'), legalComments: 'none'
});
