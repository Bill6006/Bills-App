import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Relative base so the same build works at bill6006.github.io/Bills-App/ or any other path.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon-48.png'],
      manifest: {
        id: './',
        name: 'Bills Planner',
        short_name: 'Bills',
        description: 'Paycheck-first planner for bills, spending money, savings and loans. Your data stays on this device.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#0B1310',
        theme_color: '#0B1310',
        categories: ['finance', 'productivity'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,webmanifest}'],
        // Only the Latin font subsets are needed offline; other scripts fall back to system fonts.
        globIgnores: ['**/*-{cyrillic,cyrillic-ext,greek,vietnamese,math,symbols}-*.woff2'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: { target: 'es2022', sourcemap: false },
});
