import { startGateway } from './start';

const gateway = startGateway();

const shutdown = () => void gateway.stop().finally(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
