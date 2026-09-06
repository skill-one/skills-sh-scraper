'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');

const { runLlmReview, parseReviewResponse } = require('../src/gep/llmReview');

const input = {
  diff: 'diff --git a/example.js b/example.js\n+const safe = true;',
  gene: { id: 'gene_llm_review_test', category: 'repair' },
  signals: ['review-boundary'],
  mutation: { rationale: 'exercise the review boundary' },
};

let previousEnabled;
beforeEach(function () {
  previousEnabled = process.env.EVOLVER_LLM_REVIEW;
  process.env.EVOLVER_LLM_REVIEW = 'true';
});
afterEach(function () {
  if (previousEnabled === undefined) delete process.env.EVOLVER_LLM_REVIEW;
  else process.env.EVOLVER_LLM_REVIEW = previousEnabled;
});

function assertUnavailable(result, reason, attempts) {
  assert.equal(result.approved, false);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, reason);
  assert.equal(result.retryable, true);
  assert.equal(result.attempts, attempts);
  assert.equal(result.trace.length, attempts);
  assert.ok(result.trace.every(entry => entry.status === 'unavailable'));
}

describe('llmReview fail-closed boundary', function () {
  it('does not approve malformed output after retry exhaustion', function () {
    const result = runLlmReview(input, { execute: () => 'not-json', maxAttempts: 2 });
    assertUnavailable(result, 'malformed_output', 2);
  });

  it('does not approve empty output after retry exhaustion', function () {
    const result = runLlmReview(input, { execute: () => '  \n', maxAttempts: 2 });
    assertUnavailable(result, 'empty_output', 2);
  });

  it('does not approve runner errors after retry exhaustion', function () {
    const result = runLlmReview(input, {
      execute: () => { const error = new Error('runner failed'); error.code = 'EIO'; throw error; },
      maxAttempts: 2,
    });
    assertUnavailable(result, 'runner_error', 2);
  });

  it('does not approve timeouts after retry exhaustion', function () {
    const result = runLlmReview(input, {
      execute: () => { const error = new Error('spawnSync node ETIMEDOUT'); error.code = 'ETIMEDOUT'; throw error; },
      maxAttempts: 2,
    });
    assertUnavailable(result, 'timeout', 2);
  });

  it('does not approve truncated or structurally partial responses', function () {
    const truncated = runLlmReview(input, {
      execute: () => '{"approved":true,"confidence":',
      maxAttempts: 1,
    });
    assertUnavailable(truncated, 'partial_response', 1);

    const incomplete = runLlmReview(input, {
      execute: () => JSON.stringify({ approved: true, confidence: 0.8 }),
      maxAttempts: 1,
    });
    assertUnavailable(incomplete, 'partial_response', 1);
  });

  it('retries a recoverable failure and preserves the valid success path', function () {
    let calls = 0;
    const result = runLlmReview(input, {
      execute: () => {
        calls += 1;
        if (calls === 1) return '';
        return JSON.stringify({ approved: true, confidence: 0.9, concerns: [], summary: 'verified' });
      },
      maxAttempts: 2,
    });

    assert.equal(result.approved, true);
    assert.equal(result.status, 'approved');
    assert.equal(result.reason, 'review_approved');
    assert.equal(result.retryable, false);
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.trace, [
      { attempt: 1, status: 'unavailable', reason: 'empty_output' },
      { attempt: 2, status: 'approved', reason: 'review_approved' },
    ]);
  });

  it('preserves explicit rejection and compatibility fields', function () {
    const result = runLlmReview(input, {
      execute: () => JSON.stringify({
        approved: false,
        confidence: 0.95,
        concerns: ['unsafe mutation'],
        summary: 'reject unsafe mutation',
      }),
      maxAttempts: 1,
    });

    assert.deepEqual(
      {
        approved: result.approved,
        confidence: result.confidence,
        concerns: result.concerns,
        summary: result.summary,
        status: result.status,
        reason: result.reason,
      },
      {
        approved: false,
        confidence: 0.95,
        concerns: ['unsafe mutation'],
        summary: 'reject unsafe mutation',
        status: 'rejected',
        reason: 'review_rejected',
      }
    );
  });

  it('is idempotent for the same input and deterministic runner output', function () {
    const prompts = [];
    const execute = ({ prompt }) => {
      prompts.push(prompt);
      return JSON.stringify({ approved: true, confidence: 0.8, concerns: [], summary: 'stable review' });
    };

    const first = runLlmReview(input, { execute, maxAttempts: 1 });
    const second = runLlmReview(input, { execute, maxAttempts: 1 });

    assert.deepEqual(second, first);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1], prompts[0]);
  });

  it('records a real subprocess trace and removes its temporary directory', function () {
    const before = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('evolver-review-')));
    const result = runLlmReview(input, { maxAttempts: 1, timeoutMs: 5000 });
    const after = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('evolver-review-'));

    assert.equal(result.approved, true);
    assert.deepEqual(result.trace, [{ attempt: 1, status: 'approved', reason: 'review_approved' }]);
    assert.deepEqual(after.filter(name => !before.has(name)), []);
  });

  it('does not leak a temp directory when prompt write fails', function () {
    const before = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('evolver-review-')));
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = function (file) {
      if (String(file).includes('evolver-review-') && String(file).endsWith('prompt.txt')) {
        throw new Error('ENOSPC: no space left on device');
      }
      return originalWrite.apply(this, arguments);
    };
    try {
      const result = runLlmReview(input, { maxAttempts: 1, timeoutMs: 5000 });
      assertUnavailable(result, 'runner_error', 1);
    } finally {
      fs.writeFileSync = originalWrite;
    }
    const after = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('evolver-review-'));
    assert.deepEqual(after.filter(name => !before.has(name)), []);
  });

  it('returns null when review is disabled', function () {
    process.env.EVOLVER_LLM_REVIEW = 'false';
    assert.equal(runLlmReview(input, { execute: () => { throw new Error('must not run'); } }), null);
  });
});

describe('parseReviewResponse', function () {
  it('rejects out-of-range confidence', function () {
    const invalid = parseReviewResponse(JSON.stringify({ approved: true, confidence: 2, concerns: [], summary: 'bad' }));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.reason, 'partial_response');
  });
});
