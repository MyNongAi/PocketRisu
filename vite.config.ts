import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import wasm from "vite-plugin-wasm";
import strip from '@rollup/plugin-strip';
import tailwindcss from '@tailwindcss/vite'
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

// One id per production build: the commit plus the build time, so a rebuild
// of the same commit (e.g. with local changes) still gets a new id. It is
// compiled into the client and written to dist/build-id.txt, which the server
// reads to refuse writes from tabs still running an older build
// (server/node/build-fence.cjs, src/ts/storage/buildFence.ts).
function makeBuildId() {
  let commit = 'nogit';
  try {
    commit = execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || commit;
  } catch {
    // Not a checkout (release archive): the build time alone keeps ids unique.
  }
  return `${commit}-${Date.now().toString(36)}`;
}

// https://vitejs.dev/config/
export default defineConfig(({command, mode}) => {
  // Empty on the dev server: the client then sends no id and is never fenced.
  const buildId = command === 'build' ? makeBuildId() : '';
  let outDir = 'dist';
  return {
    // Keep optimizer/config metadata in the project workspace instead of
    // assuming node_modules is writable (portable installs and linked
    // dependency runtimes commonly make it read-only).
    cacheDir: '.vite-cache',
    define: {
      '__APP_VERSION__': JSON.stringify(pkg.version),
      '__POCKETRISU_BUILD_ID__': JSON.stringify(buildId),
    },
    plugins: [
      {
        name: 'pocketrisu-build-id',
        apply: 'build',
        configResolved(config) {
          outDir = path.resolve(config.root, config.build.outDir);
        },
        // After every file of the bundle is on disk, so the server never
        // names a build whose index.html is not there yet.
        writeBundle() {
          writeFileSync(path.join(outDir, 'build-id.txt'), `${buildId}\n`);
        },
      },
      svelte({
        preprocess: vitePreprocess(),
        onwarn: (warning, handler) => {
          // disable a11y warnings
          if (warning.code.startsWith("a11y-")) return;
          handler(warning);
        },
      }),
      tailwindcss(),
      wasm(),
      command === 'build' ? strip({
        include: '**/*.(mjs|js|svelte|ts)',
        functions: ['console.log', 'console.debug', 'console.table', 'assert.*'],
      }) : null
    ],

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    // prevent vite from obscuring rust errors
    clearScreen: false,
    // tauri expects a fixed port, fail if that port is not available
    server: {
      host: '0.0.0.0', // listen on all addresses
      port: 5174,
      strictPort: true,
      // hmr: false,
    },
    // to make use of `TAURI_ENV_DEBUG` and other env variables
    // https://v2.tauri.app/reference/environment-variables/
    envPrefix: ["VITE_", "TAURI_"],
    build: {
      // Open tabs still import their content-hashed chunks after an update.
      // Keep previous assets; deployments can retire them once old tabs close.
      emptyOutDir: false,
      target:'baseline-widely-available',
      // don't minify for debug builds
      minify: process.env.TAURI_ENV_DEBUG === 'true' ? false : 'oxc',
      // produce sourcemaps for debug builds
      sourcemap: process.env.TAURI_ENV_DEBUG === 'true',
      chunkSizeWarningLimit: 2000,
    },
    
    optimizeDeps:{
      exclude: [
        "@browsermt/bergamot-translator"
      ],
      needsInterop:[
        "@mlc-ai/web-tokenizers"
      ]
    },

    resolve:{
      alias:{
        'src':'/src',
        '$lib':'/src/lib',
      }
    },
    worker: {
      format: 'es'
    }
}
});
