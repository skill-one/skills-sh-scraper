'use strict';

// Issues EvoMap/evolver#606 and #594 (SSE reconnect loop).
//
// GET /a2a/events/stream on the Hub clamps `duration_ms` to 300_000 and then
// ends the stream deliberately with `event: close` / `{"reason":"max_duration"}`
// before dropping the socket. Two client-side defects turned that scheduled
// rotation into what reporters saw as a runaway reconnect loop:
//
//   1. _startManagedEventStream() requested durationMs: 600000 -- double the
//      Hub's ceiling -- so the fetch fallback armed a 615s abort timer for a
//      stream the Hub always ended at 300s.
//   2. The `close` event had no listener, so the following socket teardown
//      reached onerror as a generic failure and was charged to the exponential
//      backoff. A node whose stream rotated perfectly normally still climbed
//      5s -> 10s -> ... -> 120s, and the widening gaps read as "SSE drops
//      every few minutes and takes two minutes to come back".
//
// A planned close must reconnect at the base interval.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const a2a = require('../src/gep/a2aProtocol');
const {
  _emitFetchSseFrameForTesting,
  _handleHubEventStreamCloseForTesting,
  _takeSsePlannedCloseForTesting,
  _sseStreamDurationMsForTesting,
  _resetSseReconnectBackoffForTesting,
  _getHeartbeatInternalsForTesting,
} = a2a._testing;

describe('SSE planned close (#606 / #594)', () => {
  afterEach(() => {
    // Drain any latched planned-close flag and reset backoff so cases in this
    // process cannot leak state into one another.
    _takeSsePlannedCloseForTesting();
    _resetSseReconnectBackoffForTesting();
    try { a2a.stopEventStream(); } catch (_) {}
  });

  it('requests a duration within the Hub 300s ceiling', () => {
    // The Hub does Math.min(duration_ms, 300_000); asking for more only
    // desynchronizes our abort timer from the Hub's real close time.
    assert.ok(
      _sseStreamDurationMsForTesting <= 300000,
      'requested SSE duration must not exceed the Hub cap; got ' + _sseStreamDurationMsForTesting,
    );
    assert.ok(_sseStreamDurationMsForTesting > 0);
  });

  it('latches a planned close and reports it exactly once', () => {
    _handleHubEventStreamCloseForTesting({ data: JSON.stringify({ reason: 'max_duration' }) });
    assert.equal(_takeSsePlannedCloseForTesting(), true, 'first read must see the planned close');
    assert.equal(_takeSsePlannedCloseForTesting(), false, 'flag must be consumed, not sticky');
  });

  it('treats a non-JSON close frame as a planned close too', () => {
    _handleHubEventStreamCloseForTesting({ data: 'bye' });
    assert.equal(_takeSsePlannedCloseForTesting(), true);
  });

  it('treats a close frame with no data as a planned close', () => {
    _handleHubEventStreamCloseForTesting({});
    assert.equal(_takeSsePlannedCloseForTesting(), true);
  });

  it('reports no planned close when the Hub never sent one', () => {
    assert.equal(_takeSsePlannedCloseForTesting(), false);
  });

  it('fetch fallback dispatches named close frames to addEventListener handlers', () => {
    const listeners = {};
    const es = {
      onmessage: () => { throw new Error('named close must not be delivered through onmessage'); },
      addEventListener(type, fn) {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(fn);
      },
      _dispatchEvent(type, ev) {
        for (const fn of listeners[type] || []) fn(ev);
      },
    };
    let seen = null;
    es.addEventListener('close', (ev) => { seen = ev; });

    _emitFetchSseFrameForTesting(es, 'event: close\ndata: {"reason":"max_duration"}\n\n');

    assert.ok(seen, 'fetch fallback must dispatch named close events');
    assert.equal(seen.type, 'close');
    assert.equal(seen.data, '{"reason":"max_duration"}');
  });

  it('fetch fallback still dispatches ordinary message frames through onmessage', () => {
    const seen = [];
    const es = {
      onmessage: (ev) => { seen.push(ev); },
      _dispatchEvent: () => {},
    };

    _emitFetchSseFrameForTesting(es, 'data: hello\n\n');

    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'message');
    assert.equal(seen[0].data, 'hello');
  });

  it('a planned close resets a saturated backoff to the base interval', () => {
    // Inflate the backoff the same way heartbeatResilienceRound3 does: with no
    // hub URL, startEventStream() fails to open and _scheduleSseReconnect()
    // doubles _sseReconnectMs each time. Stub setTimeout so no timer fires.
    const origHubUrl = process.env.A2A_HUB_URL;
    delete process.env.A2A_HUB_URL;
    const origSetTimeout = global.setTimeout;
    global.setTimeout = function () { return { unref: function () {} }; };
    try {
      for (let i = 0; i < 6; i++) a2a.startEventStream();
    } finally {
      global.setTimeout = origSetTimeout;
      if (origHubUrl === undefined) delete process.env.A2A_HUB_URL;
      else process.env.A2A_HUB_URL = origHubUrl;
    }

    const inflated = _getHeartbeatInternalsForTesting().sseReconnectMs;
    assert.equal(inflated, 120000, 'precondition: backoff must be saturated; got ' + inflated);

    // This is what onerror does on a planned close.
    _handleHubEventStreamCloseForTesting({ data: JSON.stringify({ reason: 'max_duration' }) });
    if (_takeSsePlannedCloseForTesting()) _resetSseReconnectBackoffForTesting();

    assert.equal(
      _getHeartbeatInternalsForTesting().sseReconnectMs, 5000,
      'a scheduled max_duration rotation must not inherit the failure backoff',
    );
  });
});
