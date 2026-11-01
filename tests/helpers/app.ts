import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { createLogger, type GatewayClient } from '@seatlock/shared';
import { createApp } from '../../apps/api/src/app';
import { loadApiConfig, type ApiConfig } from '../../apps/api/src/config/env';
import { createGatewayApp, type Mode } from '../../apps/mock-gateway/src/app';

/** Silent by default. TEST_LOG_LEVEL=error npx jest ... shows server-side errors when debugging. */
const silent = createLogger('test', process.env.TEST_LOG_LEVEL ?? 'silent');

/** A gateway that accepts every charge and never sends webhooks. Tests send them by hand. */
export const acceptingGateway: GatewayClient = {
  charge: async () => ({ kind: 'accepted', chargeId: 'ch_test' }),
  refund: async () => undefined,
};

/** Test env uses HOLD_TTL_SECONDS = 5 so expiry tests are fast; override per test file. */
export function createTestApp(
  pool: Pool,
  overrides: Partial<ApiConfig> = {},
  gateway: GatewayClient = acceptingGateway,
) {
  return createApp({
    pool,
    config: { ...loadApiConfig(), ...overrides },
    logger: silent,
    gateway,
  });
}

/**
 * Listens on a random port. The backlog is raised from Node's default (511) so
 * simultaneous connections queue in the kernel instead of being refused.
 */
function listen(handler: Express | undefined, server = createServer(handler)): Promise<Server> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', 4096, () => resolve(server)));
}

const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** A single listening server, for tests that fire many concurrent requests. */
export function startTestServer(pool: Pool, overrides: Partial<ApiConfig> = {}): Promise<Server> {
  return listen(createTestApp(pool, overrides));
}

export function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * The real API and the real mock gateway, both listening, wired to each other:
 * the API charges via HTTP and the gateway calls back with signed webhooks.
 */
export async function startPaymentStack(pool: Pool, overrides: Partial<ApiConfig> = {}) {
  const gateway = createGatewayApp({
    webhookSecret: process.env.WEBHOOK_SECRET!,
    logger: silent,
    controlEnabled: true,
    webhookDelayMs: 50,
  });
  const gatewayServer = await listen(gateway.app);

  // The API needs its own URL (for the callback) before its app is built
  const apiServer = await listen(undefined);
  const app = createApp({
    pool,
    config: {
      ...loadApiConfig(),
      HOLD_TTL_SECONDS: 300,
      GATEWAY_URL: urlOf(gatewayServer),
      GATEWAY_TIMEOUT_MS: 500,
      API_PUBLIC_URL: urlOf(apiServer),
      ...overrides,
    },
    logger: silent,
  });
  apiServer.on('request', app);

  return {
    api: apiServer,
    apiUrl: urlOf(apiServer),
    gatewayUrl: urlOf(gatewayServer),
    gateway: gateway.state,
    setMode: (mode: Mode, opts: { delayMs?: number; lateMs?: number } = {}) =>
      Object.assign(gateway.state.settings, { mode, ...opts }),
    cancelPendingWebhooks: gateway.stop,
    stop: async () => {
      gateway.stop();
      await Promise.all([stopServer(apiServer), stopServer(gatewayServer)]);
    },
  };
}

/** Polls until check() returns a truthy value, or fails after timeoutMs. */
export async function waitFor<T>(check: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
