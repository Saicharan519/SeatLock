// Scenario A (PRD 13): a 1,000-user spike on one show's 50 seats.
// Each of 1,000 virtual users sends exactly one hold, all at once. Each seat is wanted
// by 20 users, who fire together. Correct result: 50 x 201 and
// 950 x 409 SEAT_UNAVAILABLE, nothing else. Latency is reported, not asserted.
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const fixture = JSON.parse(open('./data/fixture.json'));
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const LABELS = ROWS.flatMap((r) => Array.from({ length: 10 }, (_, i) => `${r}${i + 1}`));

const won = new Counter('holds_won');
const seatUnavailable = new Counter('holds_seat_unavailable');
const otherOutcome = new Counter('holds_other_outcome');

export const options = {
  scenarios: {
    spike: { executor: 'per-vu-iterations', vus: 1000, iterations: 1, maxDuration: '2m' },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// 409 SEAT_UNAVAILABLE is a correct answer here, not a failure. With this, http_req_failed
// counts only real problems (5xx, timeouts, refused connections).
http.setResponseCallback(http.expectedStatuses(201, 409));

export default function () {
  const i = __VU - 1;
  const res = http.post(
    `${BASE_URL}/api/holds`,
    // 20 consecutive users per seat (VUs 1-20 want A1, 21-40 want A2, ...). VUs start in
    // order at the same instant, so same-seat requests arrive together and truly contend.
    JSON.stringify({ showId: fixture.spikeShowId, seats: [LABELS[Math.floor(i / 20)]] }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${fixture.tokens[i]}`,
        'Idempotency-Key': `spike-${__VU}`,
      },
      tags: { name: 'hold' },
    },
  );
  if (res.status === 201) won.add(1);
  else if (res.status === 409 && res.json('error.code') === 'SEAT_UNAVAILABLE')
    seatUnavailable.add(1);
  else {
    otherOutcome.add(1);
    console.warn(`unexpected ${res.status}: ${res.body && String(res.body).slice(0, 200)}`);
  }
}

export function handleSummary(data) {
  const d = data.metrics.http_req_duration.values;
  const count = (name) => (data.metrics[name] ? data.metrics[name].values.count : 0);
  const ms = (v) => `${v.toFixed(1)} ms`;
  const lines = [
    'Scenario A: 1,000-user spike on 50 seats',
    `  requests:             ${data.metrics.http_reqs.values.count}`,
    `  test duration:        ${(data.state.testRunDurationMs / 1000).toFixed(2)} s`,
    `  throughput:           ${data.metrics.http_reqs.values.rate.toFixed(1)} req/s`,
    `  latency p50/p95/p99:  ${ms(d.med)} / ${ms(d['p(95)'])} / ${ms(d['p(99)'])} (max ${ms(d.max)})`,
    `  201 held:             ${count('holds_won')}`,
    `  409 SEAT_UNAVAILABLE: ${count('holds_seat_unavailable')}`,
    `  anything else:        ${count('holds_other_outcome')}`,
    `  failed requests:      ${data.metrics.http_req_failed ? data.metrics.http_req_failed.values.passes : 0} (5xx, timeouts, refused connections)`,
  ];
  return {
    stdout: lines.join('\n') + '\n',
    './results/spike-summary.json': JSON.stringify(data, null, 2),
  };
}
