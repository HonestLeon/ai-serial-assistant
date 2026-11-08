import { fileURLToPath } from 'node:url'

export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true }
}
