# Load test plan

The brief asks for a load-test plan or a working test. This directory
contains both: `k6-websocket.js` is a runnable k6 script, and this file
is the plan around it.

## Goals

A load test for this workload has to answer four questions, in order:

1. **Capacity per pod.** How many concurrent LiveView sockets can one
   pod hold at our configured resource footprint before message-roundtrip
   p95 degrades past the SLO?
2. **HPA reaction time.** When traffic doubles in 60 seconds, how long
   until the new replicas are healthy and absorbing connections? Is the
   reaction dominated by metric staleness, pod startup, or node
   provisioning?
3. **Graceful shutdown integrity.** During a rolling update under
   sustained load, do existing WebSocket clients see clean reconnects
   (LiveView's auto-reconnect kicks in) or hard drops (500s, RST)?
4. **Failure modes.** What happens when we cross the limits — RDS
   connection-pool exhaustion? BEAM port exhaustion? Node memory
   pressure?

A load test that doesn't tell us those four things is just expensive
noise.

## Scenarios

| name        | shape                                | tests                                |
| ----------- | ------------------------------------ | ------------------------------------ |
| `warmup`    | 0 → 50 VUs over 60s                  | Smoke: does anything respond at all? |
| `sustained` | 1000 VUs for 5 min                   | Per-pod capacity at baseline replica count. |
| `burst`     | 200 → 3000 VUs over 60s, hold 2m     | HPA + Karpenter reaction.            |
| `soak`      | 1500 VUs for 30 min                  | Memory drift, file-descriptor leaks. |

Run with:

```sh
k6 run -e MODE=burst -e HOST=https://liveview.example.gov loadtest/k6-websocket.js
```

For local kind verification, point `HOST` at a `kubectl port-forward`.

## What to watch while it runs

| dashboard                            | what bad looks like                          |
| ------------------------------------ | -------------------------------------------- |
| `phx_heartbeat_rtt_ms` (k6 metric)   | p95 climbing past 500ms = server-side queue. |
| `ws_connect_errors` (k6 metric)      | Anything > a handful = upstream backpressure or HPA too slow. |
| Pod CPU / memory utilisation         | A pod above 80% memory before HPA kicks in = limits too tight. |
| HPA `currentReplicas` vs `desiredReplicas` | Gap that persists > 60s = metric pipeline lag. |
| Karpenter `nodeclaims`               | Time from "claim created" to "node ready" = cold-start cost. |
| RDS `DatabaseConnections`            | Approaching `max_connections` = raise `DATABASE_POOL_SIZE` or pgBouncer. |

## Acceptance criteria

A green run is one where all of these hold:

- `bootstrap` p95 latency < 2000ms throughout `burst`.
- Zero hard WebSocket disconnects (Phoenix's `phx_close` initiated by the
  server is fine — clients reconnect).
- HPA reaches `desiredReplicas` within 90s of the burst starting.
- No pod is OOM-killed.
- No node Karpenter-provisioned during the test fails to register.

## What to run before a real load test in prod

1. **Synthetic-RDS staging.** Don't load test against the prod RDS — use
   a snapshot-restored copy or a smaller replica. The point is to find
   *your* limits, not DBA's.
2. **DNS warmup.** The first round-robin DNS query for the headless
   service can cold-cache the kube-dns resolver. Pre-warm with a couple
   of curl loops.
3. **CloudWatch alarm freeze.** Burst scenarios can page the on-call
   for elevated 5xx that's actually-the-test. Suppress for the duration
   in the runbook.

## Out of scope (would do with more time)

- Replaying real production traffic patterns from a captured trace.
  k6's `ramping-vus` is a synthetic curve; a Locust + recorded sessions
  setup would tell us about traffic *shape*, not just volume.
- WebSocket connection migration tests — verify that
  `terminationGracePeriodSeconds` + `preStop` actually let in-flight
  events finish vs. just dropping the socket. Need a custom test harness
  that issues a `kubectl rollout restart` mid-run and verifies the k6
  clients' state transitions.
- A negative test: kill a random pod with `pkill -9` and confirm the
  PDB prevents a second eviction inside the recovery window.
