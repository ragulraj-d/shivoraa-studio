import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    proxy: {
      // Dev-only: keeps the browser on one origin so cookies behave exactly as
      // they will in production behind nginx, without CORS preflights in dev.
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        // Split vendor code so an app-only change doesn't invalidate the whole
        // cached bundle for returning users.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
          // Firebase is the single largest dependency. Splitting auth from
          // firestore lets the login screen load without paying for the
          // database SDK, and keeps app-code changes from invalidating a
          // cached vendor chunk that rarely changes.
          'firebase-auth': ['firebase/auth'],
          'firebase-db': ['firebase/firestore'],
        },
      },
    },
  },
})
