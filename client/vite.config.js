import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // The whole app shipped as one 2.68 MB hashed file, which meant
        // every deploy — a one-line copy change included — invalidated
        // maplibre, recharts and React along with it, and every member
        // re-downloaded the lot. Splitting the libraries out gives them
        // their own stable hashes: with the year-long immutable header
        // on /assets/*, a routine deploy now re-downloads only the app
        // chunk. maplibre alone is 29% of the bundle and serves one
        // radar panel and one map page.
        //
        // This does NOT make them load lazily; they are still imported
        // eagerly from registry.js. Doing that properly needs a Suspense
        // boundary around the panel host, which is a change to the
        // render tree rather than to the build.
        manualChunks: {
          maplibre: ['maplibre-gl'],
          charts: ['recharts'],
          calendar: ['react-big-calendar'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/uploads': 'http://localhost:4000',
    },
  },
});
