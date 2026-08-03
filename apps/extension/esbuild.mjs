import esbuild from 'esbuild'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

const config = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  // Matches the Node version shipped with VS Code 1.90+.
  target: 'node18',
  outfile: 'dist/extension.js',
  // Provided by the VS Code runtime; bundling it would break activation.
  external: ['vscode'],
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
}

if (watch) {
  const ctx = await esbuild.context(config)
  await ctx.watch()
} else {
  await esbuild.build(config)
}
