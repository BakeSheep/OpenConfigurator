import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: '.',
  // Local/prod builds serve from '/'; the GitHub Pages workflow injects
  // VITE_BASE_PATH=/OpenConfigurator/ for the repo-subpath deployment.
  base: process.env.VITE_BASE_PATH || '/',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
})
