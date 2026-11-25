import * as esbuild from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  minify: true,
  external: ['vscode', 'koffi'],
  logLevel: 'info',
};

await Promise.all([
  esbuild.build({
    ...common,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/extension.js',
  }),
  esbuild.build({
    ...common,
    entryPoints: ['src/sidecar/entry.ts'],
    outfile: 'dist/sidecar.js',
  }),
]);
