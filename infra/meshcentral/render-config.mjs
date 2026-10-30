// Konteyner ishga tushganda: sanitized shablon + secret fayldagi DB paroli → meshcentral-data/config.json.
// Parol faqat konteyner ichidagi config faylga yoziladi; repo va compose faylida sir yo'q.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function renderConfig(template, { dbPassword, certName }) {
  const config = structuredClone(template);
  config.settings = {
    ...config.settings,
    cert: certName,
    port: 4430,
    redirPort: 0,
    selfUpdate: false,
    autoBackup: false,
    // Gateway api konteynerida: X-Forwarded-For faqat undan ishoniladi. Bitta satrli nomni MeshCentral
    // ishga tushishda DNS orqali IP'ga aylantiradi (webserver.js:7216-7217). Shablon (contract harness) 127.0.0.1 qoladi.
    trustedProxy: 'api',
    // createdatabase: false — database init skriptda yaratilgan; MeshCentral `postgres` DB'ga ulanmaydi (db.js:945).
    postgres: {
      host: 'postgres',
      port: 5432,
      user: 'meshcentral',
      password: dbPassword,
      database: 'meshcentral',
      createdatabase: false,
    },
  };
  return config;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const template = JSON.parse(readFileSync(join(here, 'config.template.json'), 'utf8'));
  const dbPassword = readFileSync(process.env.MESHCENTRAL_DB_PASSWORD_FILE, 'utf8').trim();
  const dataDir = process.env.MESHCENTRAL_DATA_DIR ?? '/opt/meshcentral/meshcentral-data';
  const config = renderConfig(template, { dbPassword, certName: process.env.MESHCENTRAL_CERT_NAME ?? 'meshcentral' });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
}
