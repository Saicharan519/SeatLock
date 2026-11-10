import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The security headers (Content-Security-Policy and friends) that Vercel adds in production,
 * read from vercel.json so `npm run preview` serves the built site under exactly the same
 * policy. That is how the policy is tested before deploying (a too-strict one breaks pages).
 */
function productionHeaders(): Record<string, string> {
  const vercel = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')) as {
    routes: { continue?: boolean; headers?: Record<string, string> }[];
  };
  return vercel.routes.find((r) => r.continue && r.headers)?.headers ?? {};
}

const api = { '/api': process.env.API_URL ?? 'http://localhost:3000' };

// The dev server proxies /api to the API, so the browser talks to one origin (no CORS).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: api },
  preview: { port: 4173, proxy: api, headers: productionHeaders() },
});
