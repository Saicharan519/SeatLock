// Scenario B (PRD 13): 50 virtual users, steady, for 60 s, mixing seat-map reads and holds.
// Each iteration reads the seat map; one in five also holds a random AVAILABLE seat and,
// if it got it, releases it straight away, so seats keep churning and holds keep contending.
// No think time: every user fires its next request as soon as the last one returns.
// G7 targets: p95 seat map < 300 ms, p95 hold < 500 ms.
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const fixture = JSON.parse(open('./data/fixture.json'));
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const HOLD_SHARE = 0.2;

const held = new Counter('holds_won');
const lostRace = new Counter('holds_seat_unavailable');
const unexpected = new Counter('unexpected_responses');

export const options = {
  scenarios: {
    steady: { executor: 'constant-vus', vus: 50, duration: '60s' },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Thresholds make k6 report the per-endpoint latencies; they encode the PRD's G7 targets
  thresholds: {
    'http_req_duration{name:seatmap}': ['p(95)<300'],
    'http_req_duration{name:hold}': ['p(95)<500'],
    // No target: listed only so k6 reports release latency separately
    'http_req_duration{name:release}': ['max>=0'],
    http_req_failed: ['rate<0.01'],
  },
};

// Losing a race for a seat (409) is correct behaviour; only real errors count as failed
http.setResponseCallback(http.expectedStatuses(200, 201, 409));

const auth = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${fixture.tokens[__VU - 1]}`,
});

export default function () {
  const map = http.get(`${BASE_URL}/api/shows/${fixture.steadyShowId}/seats`, {
    tags: { name: 'seatmap' },
  });
  if (map.status !== 200) {
    unexpected.add(1);
    return;
  }
  if (Math.random() >= HOLD_SHARE) return;

  const free = map.json('seats').filter((s) => s.status === 'AVAILABLE');
  if (free.length === 0) return;
  const seat = free[Math.floor(Math.random() * free.length)].label;

  const hold = http.post(
    `${BASE_URL}/api/holds`,
    JSON.stringify({ showId: fixture.steadyShowId, seats: [seat] }),
    {
      headers: { ...auth(), 'Idempotency-Key': `steady-${__VU}-${__ITER}` },
      tags: { name: 'hold' },
    },
  );
  if (hold.status === 201) {
    held.add(1);
    const rel = http.post(`${BASE_URL}/api/holds/${hold.json('bookingId')}/release`, null, {
      headers: auth(),
      tags: { name: 'release' },
    });
    if (rel.status !== 200) unexpected.add(1);
  } else if (hold.status === 409 && hold.json('error.code') === 'SEAT_UNAVAILABLE') {
    lostRace.add(1); // someone grabbed it between our read and our hold: correct behaviour
  } else {
    unexpected.add(1);
    console.warn(`unexpected hold ${hold.status}: ${String(hold.body).slice(0, 200)}`);
  }
}

export function handleSummary(data) {
  const m = data.metrics;
  const ms = (v) => `${v.toFixed(1)} ms`;
  const trend = (key) => {
    const v = m[key] && m[key].values;
    return v
      ? `p50 ${ms(v.med)} / p95 ${ms(v['p(95)'])} / p99 ${ms(v['p(99)'])} (max ${ms(v.max)})`
      : 'n/a';
  };
  const count = (name) => (m[name] ? m[name].values.count : 0);
  const verdict = (key) => {
    const t = m[key] && m[key].thresholds;
    return t ? (Object.values(t).every((x) => x.ok) ? 'MET' : 'MISSED') : 'n/a';
  };
  const lines = [
    'Scenario B: 50 VUs steady for 60 s (seat map + holds)',
    `  requests:            ${m.http_reqs.values.count} (${m.http_reqs.values.rate.toFixed(1)} req/s)`,
    `  iterations:          ${m.iterations.values.count}`,
    `  seat map latency:    ${trend('http_req_duration{name:seatmap}')}  target p95 < 300 ms: ${verdict('http_req_duration{name:seatmap}')}`,
    `  hold latency:        ${trend('http_req_duration{name:hold}')}  target p95 < 500 ms: ${verdict('http_req_duration{name:hold}')}`,
    `  release latency:     ${trend('http_req_duration{name:release}')}`,
    `  holds won:           ${count('holds_won')}`,
    `  holds lost to race:  ${count('holds_seat_unavailable')} (409 SEAT_UNAVAILABLE, expected)`,
    `  unexpected:          ${count('unexpected_responses')}`,
    `  failed requests:     ${(m.http_req_failed.values.rate * 100).toFixed(2)} %`,
  ];
  return {
    stdout: lines.join('\n') + '\n',
    './results/steady-summary.json': JSON.stringify(data, null, 2),
  };
}
