/**
 * All-in-one mode: the API, the background worker and the mock payment gateway in ONE Node
 * process. For hosting that runs a single web service per app on its free plan (Render has
 * no free background workers). Locally and in Docker the three still run as separate
 * processes; this file only changes how they are started, not how they work.
 *
 * - The API listens on the platform's PORT (public).
 * - The mock gateway listens on 127.0.0.1 only (not reachable from outside), and calls the
 *   API's webhook back over localhost, exactly as it would over the network.
 * - The worker runs its loop in the same process.
 *
 * When the platform puts the service to sleep it sends SIGTERM: everything stops cleanly.
 * Nothing is lost: pending work lives in Postgres (the outbox, expiry times, payments)
 * and is picked up on the next start.
 */
import { startApi } from '../../api/src/start';
import { startGateway } from '../../mock-gateway/src/start';
import { startWorker } from '../../worker/src/start';

const port = process.env.PORT ?? process.env.API_PORT ?? '3000';
const gatewayPort = process.env.GATEWAY_PORT ?? '4000';

// The platform's PORT always wins, and the internal addresses are always derived from the
// ports: they describe this process, so a value left in a .env file must not override them
// (a stale API_PUBLIC_URL would send the gateway's webhooks to the wrong place).
process.env.API_PORT = port;
process.env.GATEWAY_PORT = gatewayPort;
process.env.GATEWAY_HOST = '127.0.0.1';
process.env.GATEWAY_URL = `http://127.0.0.1:${gatewayPort}`;
process.env.API_PUBLIC_URL = `http://127.0.0.1:${port}`;

const gateway = startGateway();
const api = startApi();
const worker = startWorker();

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  // API first (no new requests), then the worker's current tick, then the gateway
  void api
    .stop()
    .then(() => worker.stop())
    .then(() => gateway.stop())
    .finally(() => process.exit(0));
  // Never hang the platform's shutdown
  setTimeout(() => process.exit(0), 20_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
