import { loadConfig } from './config.js';
import { createCollabServer } from './server.js';

const config = loadConfig();
const server = createCollabServer(config);
await server.listen();
console.log(`[collab] listening on :${config.port}, api ${config.apiUrl}`);
