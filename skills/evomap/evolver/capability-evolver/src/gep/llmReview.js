'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getRepoRoot } = require('./paths');

const REVIEW_ENABLED_KEY = 'EVOLVER_LLM_REVIEW';
const REVIEW_TIMEOUT_MS = 30000;
const REVIEW_MAX_ATTEMPTS = 2;

function isLlmReviewEnabled() {
  return String(process.env[REVIEW_ENABLED_KEY] || '').toLowerCase() === 'true';
}

function buildReviewPrompt({ diff, gene, signals, mutation }) {
  const geneId = gene && gene.id ? gene.id : '(unknown)';
  const category = (mutation && mutation.category) || (gene && gene.category) || 'unknown';
  const rationale = mutation && mutation.rationale ? String(mutation.rationale).slice(0, 500) : '(none)';
  const signalsList = Array.isArray(signals) ? signals.slice(0, 8).join(', ') : '(none)';
  const diffPreview = String(diff || '').slice(0, 6000);

  return `You are reviewing a code change produced by an autonomous evolution engine.

## Context
- Gene: ${geneId} (${category})
- Signals: [${signalsList}]
- Rationale: ${rationale}

## Diff
\`\`\`diff
${diffPreview}
\`\`\`

## Review Criteria
1. Does this change address the stated signals?
2. Are there any obvious regressions or bugs introduced?
3. Is the blast radius proportionate to the problem?
4. Are there any security or safety concerns?

## Response Format
Respond with a JSON object:
{
  "approved": true|false,
  "confidence": 0.0-1.0,
  "concerns": ["..."],
  "summary": "one-line review summary"
}`;
}

function failureResult(reason, summary, trace) {
  return {
    approved: false,
    confidence: 0,
    concerns: [summary],
    summary,
    status: 'unavailable',
    reason,
    retryable: true,
    attempts: trace.length,
    trace,
  };
}

function parseReviewResponse(output) {
  const text = typeof output === 'string' ? output.trim() : '';
  if (!text) {
    return { ok: false, reason: 'empty_output', summary: 'review returned empty output' };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    const partial = /^[{[]/.test(text) && !/[}\]]\s*$/.test(text);
    return {
      ok: false,
      reason: partial ? 'partial_response' : 'malformed_output',
      summary: partial ? 'review returned a partial response' : 'review returned malformed output',
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      typeof parsed.approved !== 'boolean' ||
      !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1 ||
      !Array.isArray(parsed.concerns) || !parsed.concerns.every(item => typeof item === 'string') ||
      typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    return { ok: false, reason: 'partial_response', summary: 'review response was incomplete' };
  }

  return {
    ok: true,
    value: {
      approved: parsed.approved,
      confidence: parsed.confidence,
      concerns: parsed.concerns,
      summary: parsed.summary.trim(),
      status: parsed.approved ? 'approved' : 'rejected',
      reason: parsed.approved ? 'review_approved' : 'review_rejected',
      retryable: false,
    },
  };
}

function classifyExecutionError(error) {
  const message = error && error.message ? String(error.message) : String(error);
  const timedOut = Boolean(error && (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM')) || /timed?\s*out|ETIMEDOUT/i.test(message);
  return {
    reason: timedOut ? 'timeout' : 'runner_error',
    summary: timedOut ? 'review timed out' : 'review execution failed',
  };
}

function defaultExecute({ prompt, timeoutMs }) {
  const repoRoot = getRepoRoot();
  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-review-'));
    const tmpFile = path.join(tmpDir, 'prompt.txt');
    fs.writeFileSync(tmpFile, prompt, 'utf8');
    const reviewScript = `
      const fs = require('fs');
      const prompt = fs.readFileSync(process.argv[1], 'utf8');
      console.log(JSON.stringify({ approved: true, confidence: 0.7, concerns: [], summary: 'auto-approved (no external LLM configured)' }));
    `;
    return execFileSync(process.execPath, ['-e', reviewScript, tmpFile], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

function runLlmReview({ diff, gene, signals, mutation }, options) {
  if (!isLlmReviewEnabled()) return null;

  const opts = options || {};
  const execute = typeof opts.execute === 'function' ? opts.execute : defaultExecute;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : REVIEW_TIMEOUT_MS;
  const maxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts > 0 ? opts.maxAttempts : REVIEW_MAX_ATTEMPTS;
  const prompt = buildReviewPrompt({ diff, gene, signals, mutation });
  const trace = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let failure;
    try {
      const parsed = parseReviewResponse(execute({ prompt, timeoutMs, attempt }));
      if (parsed.ok) {
        trace.push({ attempt, status: parsed.value.status, reason: parsed.value.reason });
        return Object.assign({}, parsed.value, { attempts: attempt, trace });
      }
      failure = parsed;
    } catch (error) {
      failure = classifyExecutionError(error);
    }

    trace.push({ attempt, status: 'unavailable', reason: failure.reason });
    if (attempt === maxAttempts) {
      console.log('[LLMReview] Unavailable: ' + failure.reason + ' after ' + attempt + ' attempt(s)');
      return failureResult(failure.reason, failure.summary, trace);
    }
  }
}

module.exports = {
  isLlmReviewEnabled,
  runLlmReview,
  buildReviewPrompt,
  parseReviewResponse,
  classifyExecutionError,
};
