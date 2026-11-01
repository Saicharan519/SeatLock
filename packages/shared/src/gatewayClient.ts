/**
 * The three things a charge call can tell us (PRD 9.2). The distinction between
 * "rejected" and "ambiguous" is the whole point: only a 4xx proves the charge failed.
 */
export type ChargeOutcome =
  | { kind: 'accepted'; chargeId: string }
  /** The gateway definitively refused (4xx). No money moved. */
  | { kind: 'rejected'; status: number; reason: string }
  /** Timeout, network error or 5xx: the charge may or may not have gone through. */
  | { kind: 'ambiguous'; reason: string };

export interface GatewayClient {
  charge(input: { paymentId: string; amount: number; callbackUrl: string }): Promise<ChargeOutcome>;
  refund(input: { paymentId: string; amount: number; callbackUrl: string }): Promise<void>;
}

export function createHttpGatewayClient(baseUrl: string, timeoutMs: number): GatewayClient {
  const post = (path: string, body: object) =>
    fetch(new URL(path, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

  return {
    async charge(input) {
      let res: Response;
      try {
        res = await post('/charges', input);
      } catch (err) {
        return { kind: 'ambiguous', reason: (err as Error).name || 'network error' };
      }
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { chargeId?: string };
        return { kind: 'accepted', chargeId: body.chargeId ?? '' };
      }
      if (res.status >= 400 && res.status < 500) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return { kind: 'rejected', status: res.status, reason: body.error ?? 'rejected' };
      }
      return { kind: 'ambiguous', reason: `gateway returned ${res.status}` };
    },

    async refund(input) {
      const res = await post('/refunds', input);
      if (!res.ok) throw new Error(`refund failed with status ${res.status}`);
    },
  };
}
