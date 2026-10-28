import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

/** Keep fonts within the renderer's font-src 'self' policy; other assets retain Vite defaults. */
export const rendererAssetsInlineLimit = (file: string): boolean | undefined => /\.(?:woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined;

export default defineConfig({
  main: {
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
