import { startWorker } from './start';

const worker = startWorker();

const shutdown = () => void worker.stop().finally(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
