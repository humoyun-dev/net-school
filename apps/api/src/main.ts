import { createApp } from './app.ts';
import { loadConfig } from './config/config.ts';
import { connectPg } from './db/client.ts';

const config = loadConfig(process.env);
const pg = connectPg(config.databaseUrl);
const app = await createApp(config, { db: pg.db });
app.enableShutdownHooks();
await app.listen(config.port, config.host);
process.once('beforeExit', () => void pg.close());
