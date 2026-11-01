#!/usr/bin/env bash
# Runs one k6 scenario end to end:  bash tests/k6/run.sh spike|steady
#
# Everything under test runs in Linux containers on the compose network: Postgres (compose),
# the API (node:24-alpine, started here) and k6 (grafana/k6). So the numbers measure the
# system, not the host's network stack. Requires `docker compose up -d` and a prior
# `npm ci` inside the seatlock_linux_modules volume (see docs/results.md).
set -euo pipefail

SCENARIO="${1:?usage: run.sh spike|steady}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
MOUNT="$(pwd -W 2>/dev/null || pwd)"     # Docker Desktop on Windows needs the Windows path
export MSYS_NO_PATHCONV=1                 # stop Git Bash rewriting /app style paths

set -a; source .env; set +a               # JWT_SECRET and WEBHOOK_SECRET shared with the API
API=seatlock-api-load
PSQL="docker compose exec -T postgres psql -U seatlock -d seatlock_load -tA"

echo "== fresh fixture"
LOAD_DATABASE_URL=postgres://seatlock:seatlock@localhost:5433/seatlock_load npx tsx tests/k6/setup.ts

echo "== starting the API container (rate limiting OFF for load tests)"
docker rm -f "$API" >/dev/null 2>&1 || true
docker run -d --name "$API" --network seatlock_default \
  -v "$MOUNT:/app" -v seatlock_linux_modules:/app/node_modules -w /app \
  -e NODE_ENV=production -e LOG_LEVEL=warn \
  -e DATABASE_URL=postgres://seatlock:seatlock@postgres:5432/seatlock_load \
  -e REDIS_URL=redis://redis:6379 -e RATE_LIMIT_ENABLED=false \
  -e PG_POOL_MAX="${PG_POOL_MAX:-20}" -e API_PORT=3000 \
  -e JWT_SECRET="$JWT_SECRET" -e WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  node:24-alpine node --import tsx apps/api/src/server.ts >/dev/null
trap 'docker rm -f "$API" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do
  docker run --rm --network seatlock_default curlimages/curl:latest -sf "http://$API:3000/api/health" >/dev/null 2>&1 && break
  sleep 1
done

echo "== k6 $SCENARIO"
mkdir -p tests/k6/results
docker run --rm --network seatlock_default -v "$MOUNT/tests/k6:/scripts" -w /scripts \
  -e BASE_URL="http://$API:3000" grafana/k6:latest run --quiet "/scripts/$SCENARIO.js" || true

echo "== database invariants after the run"
if [ "$SCENARIO" = spike ]; then
  $PSQL -c "SELECT 'held seats: ' || count(*) || ', distinct bookings: ' || count(DISTINCT booking_id)
            FROM seats s JOIN shows sh ON sh.id = s.show_id
            WHERE sh.title LIKE 'Spike%' AND s.status = 'HELD';"
fi
$PSQL -c "SELECT 'seats in two live bookings: ' || count(*) FROM (
            SELECT i.seat_id FROM booking_items i JOIN bookings b ON b.id = i.booking_id
            WHERE b.status = 'PENDING' GROUP BY i.seat_id HAVING count(*) > 1) d;"
$PSQL -c "SELECT 'HELD seats: ' || (SELECT count(*) FROM seats WHERE status = 'HELD')
              || ', live booking items: ' || (SELECT count(*) FROM booking_items i
                 JOIN bookings b ON b.id = i.booking_id WHERE b.status = 'PENDING');"
$PSQL -c "SELECT 'deadlocks so far in this database: ' || deadlocks FROM pg_stat_database
          WHERE datname = 'seatlock_load';"
