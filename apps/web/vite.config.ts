import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: panel Vite'dan, /api (WS ham) API'ga proxy. API Origin'ni PUBLIC_ORIGIN'ga aynan teng talab qiladi —
// faqat dev'da proxy so'rov Origin'ini shunga almashtiradi. TLS: API sertifikati (NETSCHOOL_DEV_TLS_*).
const api = process.env.NETSCHOOL_DEV_API ?? 'https://localhost:8443';
const cert = process.env.NETSCHOOL_DEV_TLS_CERT;
const key = process.env.NETSCHOOL_DEV_TLS_KEY;
const ca = process.env.NETSCHOOL_DEV_API_CA;

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', assetsDir: 'assets', sourcemap: false },
  server: {
    https: cert && key ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined,
    proxy: {
      '/api': {
        target: api,
        ws: true,
        secure: true,
        ...(ca ? { ca: readFileSync(ca, 'utf8') } : {}),
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => req.setHeader('origin', api));
          proxy.on('proxyReqWs', (req) => req.setHeader('origin', api));
        },
      },
    },
  },
});
