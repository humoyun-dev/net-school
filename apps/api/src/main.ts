import { createApp } from './app.ts';
import { loadConfig } from './config/config.ts';

const config = loadConfig(process.env);
const app = await createApp(config);
app.enableShutdownHooks();
await app.listen(config.port, config.host);
