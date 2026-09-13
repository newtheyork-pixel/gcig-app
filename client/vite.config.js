import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/uploads': 'http://localhost:4000',
      // The desk squawk box is a WebSocket at /ws/hoot, not under /api.
      // Without this, local HOOT talks to Vite and never reaches the API.
      '/ws': {
        target: 'http://localhost:4000',
        ws: true,
      },
    },
  },
});
