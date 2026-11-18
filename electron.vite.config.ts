import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';
// @ts-expect-error The companion publisher is shared with the plain-JavaScript release tooling.
import { requireCompanionRecorderGeneration } from './extension/materialize.mjs';

/** Keep fonts within the renderer's font-src 'self' policy; other assets retain Vite defaults. */
export const rendererAssetsInlineLimit = (file: string): boolean | undefined => /\.(?:woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined;

export default defineConfig({
  main: {
    define: { __COS_PACKAGED_READER_PRODUCER__: JSON.stringify(requireCompanionRecorderGeneration(resolve(__dirname, 'extension'))) },
    // Keep node_modules external so the MCP SDK ships as real files in the asar
    // rather than being inlined by the bundler.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      assetsInlineLimit: rendererAssetsInlineLimit,
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
    }
  }
});
