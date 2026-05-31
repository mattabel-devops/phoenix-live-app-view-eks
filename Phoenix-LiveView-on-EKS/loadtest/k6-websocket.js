// =============================================================================
// k6 WebSocket load test for the Phoenix LiveView demo.
//
// What this exercises:
//   - The initial GET that returns the LiveView HTML (the bootstrap path).
//   - The WebSocket upgrade to /live/websocket?_csrf_token=...&vsn=2.0.0
//   - phx_join on the LiveView channel.
//   - A sustained heartbeat (Phoenix sends one every ~30s; clients echo).
//
// What this does NOT exercise:
//   - Authenticated routes (the example app is open).
//   - LiveView event handlers ("phx-click", "phx-submit", etc) — adding
//     them is straightforward once the channel is joined; see the
//     ws.send block below for the shape.
//
// Run modes (set via -e MODE=...):
//   warmup    - 50 VUs ramping over 30s; sanity check.
//   sustained - 1000 VUs steady for 5m; tests baseline pod sizing.
//   burst     - spike from 200 to 3000 VUs in 60s; tests HPA reaction.
//   soak      - 1500 VUs for 30m; tests memory drift + connection churn.
//
// Usage:
//   k6 run -e MODE=burst -e HOST=https://liveview.example.gov loadtest/k6-websocket.js
// =============================================================================

import ws from 'k6/ws';
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// --------------------------------------------------------------------------
// Configurable knobs
// --------------------------------------------------------------------------
const MODE = __ENV.MODE || 'warmup';
const HOST = __ENV.HOST || 'http://localhost:4000';
const WS_HOST = HOST.replace(/^http/, 'ws');

// Per-VU connection lifetime (seconds). Set to 0 to hold for the full
// stage duration — matches the "long-lived" property of LiveView.
const HOLD_SECONDS = parseInt(__ENV.HOLD_SECONDS || '60', 10);

// --------------------------------------------------------------------------
// Custom metrics — k6's built-ins are good but don't carve out the
// LiveView-specific signals a platform engineer wants to see.
// --------------------------------------------------------------------------
const wsConnectErrors  = new Counter('ws_connect_errors');
const phxJoinDuration  = new Trend('phx_join_duration_ms', true);
const phxHeartbeatRtt  = new Trend('phx_heartbeat_rtt_ms', true);

// --------------------------------------------------------------------------
// Scenarios
// --------------------------------------------------------------------------
const scenarios = {
  warmup: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '15s', target: 25 },
      { duration: '15s', target: 50 },
      { duration: '30s', target: 50 },
    ],
    gracefulStop: '30s',
  },
  sustained: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '1m', target: 500 },
      { duration: '1m', target: 1000 },
      { duration: '5m', target: 1000 },
      { duration: '30s', target: 0 },
    ],
    gracefulStop: '30s',
  },
  burst: {
    executor: 'ramping-vus',
    startVUs: 200,
    stages: [
      { duration: '30s', target: 200 },
      { duration: '60s', target: 3000 },   // the burst
      { duration: '2m',  target: 3000 },
      { duration: '30s', target: 200 },    // the snapback
    ],
    gracefulStop: '60s',
  },
  soak: {
    executor: 'constant-vus',
    vus: 1500,
    duration: '30m',
    gracefulStop: '60s',
  },
};

export const options = {
  scenarios: { [MODE]: scenarios[MODE] },
  thresholds: {
    // P95 latency on the initial HTML render. >2s means the cluster is
    // either provisioning under us or rejecting connections.
    'http_req_duration{name:bootstrap}': ['p(95)<2000'],
    // Connection errors should be a rounding error even under burst.
    'ws_connect_errors': ['count<10'],
    // Heartbeat RTT is the closest proxy for end-to-end LiveView health.
    'phx_heartbeat_rtt_ms': ['p(95)<500'],
  },
  // Don't truncate the per-VU request list — we want to see WS errors.
  noConnectionReuse: false,
  discardResponseBodies: false,
};

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

// Extract an HTML attribute value by name. Phoenix 1.6 emits:
//   data-csrf="..."           — the CSRF token used in the WS URL
//   data-phx-session="..."    — the signed session blob
//   data-phx-static="..."     — the signed static blob
//   id="phx-XXXX"             — the LiveView id; topic is `lv:phx-XXXX`
function extractAttr(html, attr) {
  const m = html.match(new RegExp(`${attr}="([^"]+)"`));
  return m ? m[1] : null;
}

// LiveView topic format is `lv:<liveview-id>`. The id is generated
// server-side and emitted as the `id` attribute on the <div data-phx-main>
// element, or as `id="phx-XXXX"` on any LiveView root container.
function extractLiveViewTopic(html) {
  // Prefer the explicit data-phx-main element if the page has multiple LVs.
  const mainMatch = html.match(/data-phx-main[^>]*\bid="([^"]+)"/);
  if (mainMatch) return `lv:${mainMatch[1]}`;
  // Fallback: first phx-* id we see.
  const idMatch = html.match(/id="(phx-[^"]+)"/);
  return idMatch ? `lv:${idMatch[1]}` : null;
}

// --------------------------------------------------------------------------
// Main VU function
// --------------------------------------------------------------------------
export default function () {
  // 1. Bootstrap GET — fetches the HTML that the browser would render
  //    before the JS opens the WebSocket.
  const bootRes = http.get(`${HOST}/`, { tags: { name: 'bootstrap' } });
  const ok = check(bootRes, {
    'bootstrap 200': (r) => r.status === 200,
  });
  if (!ok) {
    wsConnectErrors.add(1);
    return;
  }

  const csrf    = extractAttr(bootRes.body, 'data-csrf');
  const session = extractAttr(bootRes.body, 'data-phx-session');
  const stat    = extractAttr(bootRes.body, 'data-phx-static');
  const topic   = extractLiveViewTopic(bootRes.body);

  if (!csrf || !topic) {
    // No CSRF or no LiveView id means either we hit a non-LiveView page
    // or the app's HTML shape has changed. Either way: noise, not signal.
    return;
  }

  // 2. WebSocket upgrade. Phoenix LiveView socket path is /live/websocket.
  const wsUrl = `${WS_HOST}/live/websocket?_csrf_token=${encodeURIComponent(csrf)}&vsn=2.0.0`;
  const joinStart = Date.now();

  const res = ws.connect(wsUrl, null, function (socket) {
    socket.on('open', function () {
      // 3. phx_join — Phoenix v2 wire format is a JSON array:
      //    [join_ref, msg_ref, topic, event, payload]
      // The LiveView channel expects `session` and `static` tokens in the
      // payload (it uses them to verify and rehydrate the live process).
      const joinRef = '1';
      const msgRef  = '1';
      socket.send(JSON.stringify([
        joinRef, msgRef, topic, 'phx_join',
        { url: `${HOST}/`, session: session, static: stat, params: { _csrf_token: csrf } },
      ]));
    });

    socket.on('message', function (raw) {
      let frame;
      try { frame = JSON.parse(raw); } catch { return; }

      // First message back should be the join ack.
      if (frame[3] === 'phx_reply' && frame[4]?.status === 'ok') {
        phxJoinDuration.add(Date.now() - joinStart);
      }

      // Heartbeat — Phoenix sends phx_reply for heartbeats sent by the
      // client, but we can also just measure round-trip on our own ping.
      if (frame[3] === 'phx_reply' && frame[1] === 'hb') {
        const sent = parseInt(frame[4]?._k6_sent_at || '0', 10);
        if (sent > 0) phxHeartbeatRtt.add(Date.now() - sent);
      }
    });

    socket.on('error', function (e) {
      wsConnectErrors.add(1);
      console.error(`ws error: ${e.error()}`);
    });

    // Periodic heartbeat. Phoenix's own client does this every 30s; we
    // do it every 5s to get a tighter latency signal during the test.
    socket.setInterval(function () {
      const sentAt = Date.now();
      socket.send(JSON.stringify([null, 'hb', 'phoenix', 'heartbeat', { _k6_sent_at: String(sentAt) }]));
    }, 5000);

    // Hold the connection. The VU exits at HOLD_SECONDS; for scenarios
    // like `soak`, set HOLD_SECONDS to the stage length.
    socket.setTimeout(function () {
      socket.close();
    }, HOLD_SECONDS * 1000);
  });

  check(res, { 'ws connect 101': (r) => r && r.status === 101 });
  if (!res || res.status !== 101) wsConnectErrors.add(1);
}
