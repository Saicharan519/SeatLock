import { startApi } from './start';

const api = startApi();

const shutdown = () => void api.stop().finally(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
