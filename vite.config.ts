import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function privacyCsp(): Plugin {
  return {
    name: 'openconfigurator-privacy-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(_html, context) {
        const connectSrc = context.server
          ? "connect-src ws://localhost:* ws://127.0.0.1:*"
          : "connect-src 'none'"
        return [{
          tag: 'meta',
          injectTo: 'head-prepend',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: `default-src 'self'; ${connectSrc}; worker-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`,
          },
        }]
      },
    },
  }
}

export default defineConfig({
  plugins: [privacyCsp(), react(), tailwindcss()],
  root: '.',
  // Local/prod builds serve from '/'; the GitHub Pages workflow injects
  // VITE_BASE_PATH=/OpenConfigurator/ for the repo-subpath deployment.
  base: process.env.VITE_BASE_PATH || '/',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
  },
})
