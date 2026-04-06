import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// ssh2 uses optional native .node bindings that can't be bundled.
// It falls back to JS implementations automatically, so we just
// need esbuild to ignore the .node requires.
const nativeNodePlugin = {
    name: 'native-node-modules',
    setup(build) {
        build.onResolve({ filter: /\.node$/ }, (args) => ({
            path: args.path,
            external: true,
        }));
    },
};

const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'out/extension.js',
    external: ['vscode'],
    logLevel: 'info',
    target: 'node18',
    plugins: [nativeNodePlugin],
});

if (watch) {
    await ctx.watch();
    console.log('Watching for changes...');
} else {
    await ctx.rebuild();
    await ctx.dispose();
}
