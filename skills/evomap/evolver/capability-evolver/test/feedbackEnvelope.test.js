'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  aggregateFeedbackEnvelopes,
  evidenceRef,
  fromOutcomeScalar,
  fromScalarFeedback,
  withConflict,
} = require('../src/gep/feedbackEnvelope');

function evidence(id) {
  return evidenceRef('evolution_outcome', id || 'event-1');
}

describe('feedback envelope', () => {
  it('adapts scalar feedback into typed metadata', () => {
    const envelope = fromScalarFeedback({
      priority_axis: 'user_preference',
      scalar: 0.9,
      evaluator_attention: { level: 'full' },
      evidence_ref: evidence(),
    });

    assert.equal(envelope.priority_axis, 'user_preference');
    assert.equal(envelope.label, 'positive');
    assert.equal(envelope.scalar, 0.9);
    assert.equal(envelope.indecision, false);
    assert.equal(envelope.conflict, false);
    assert.equal(envelope.evaluator_attention.level, 'full');
    assert.equal(envelope.evidence_ref.kind, 'evolution_outcome');
  });

  it('treats midpoint scalar feedback as indecision', () => {
    const envelope = fromScalarFeedback({
      priority_axis: 'task_success',
      scalar: 0.5,
      evidence_ref: evidenceRef('external', 'judge-1'),
    });

    assert.equal(envelope.label, 'mixed');
    assert.equal(envelope.indecision, true);
    assert.ok(envelope.uncertainty > 0.5);
  });

  it('uses the existing effective scalar without replacing outcome score', () => {
    const outcome = { status: 'failed', score: 0.2, user_override: 0.8 };
    const envelope = fromOutcomeScalar(outcome, {
      priority_axis: 'user_preference',
      evidence_ref: evidence(),
    });

    assert.equal(outcome.score, 0.2);
    assert.equal(outcome.user_override, 0.8);
    assert.equal(envelope.scalar, 0.8);
    assert.equal(envelope.label, 'positive');
  });

  it('round-trips as snake_case JSON', () => {
    const envelope = withConflict(fromScalarFeedback({
      priority_axis: 'safety',
      scalar: 0.1,
      evaluator_attention: { level: 'limited' },
      evidence_ref: evidenceRef('review', 'review-1', { summary: 'unsafe patch' }),
    }));

    const encoded = JSON.stringify(envelope);
    assert.match(encoded, /"priority_axis":"safety"/);
    assert.match(encoded, /"evaluator_attention":/);
    assert.match(encoded, /"kind":"review"/);
    assert.deepEqual(JSON.parse(encoded), envelope);
  });

  it('raises uncertainty for conflicted labels instead of forcing a winner', () => {
    const positive = fromScalarFeedback({
      priority_axis: 'quality',
      scalar: 0.9,
      evaluator_attention: { level: 'full' },
      evidence_ref: evidence('positive'),
    });
    const negative = withConflict(fromScalarFeedback({
      priority_axis: 'quality',
      scalar: 0.1,
      evaluator_attention: { level: 'full' },
      evidence_ref: evidence('negative'),
    }));

    const single = aggregateFeedbackEnvelopes([positive]);
    const conflicted = aggregateFeedbackEnvelopes([positive, negative]);

    assert.equal(single.dominant_label, 'positive');
    assert.equal(conflicted.dominant_label, null);
    assert.ok(conflicted.uncertainty > single.uncertainty);
  });

  it('raises uncertainty for low-attention labels without changing the raw label', () => {
    const fullAttention = fromScalarFeedback({
      priority_axis: 'task_success',
      scalar: 0.85,
      evaluator_attention: { level: 'full' },
      evidence_ref: evidence('full'),
    });
    const skimmedAttention = fromScalarFeedback({
      priority_axis: 'task_success',
      scalar: 0.85,
      evaluator_attention: { level: 'skimmed' },
      evidence_ref: evidence('skimmed'),
    });

    assert.equal(fullAttention.label, 'positive');
    assert.equal(skimmedAttention.label, 'positive');
    assert.ok(skimmedAttention.uncertainty > fullAttention.uncertainty);

    const fullAggregate = aggregateFeedbackEnvelopes([fullAttention]);
    const skimmedAggregate = aggregateFeedbackEnvelopes([skimmedAttention]);
    assert.equal(fullAggregate.dominant_label, 'positive');
    assert.equal(skimmedAggregate.dominant_label, null);
    assert.ok(skimmedAggregate.uncertainty > fullAggregate.uncertainty);
  });

  it('is maximally uncertain with no labels', () => {
    const aggregate = aggregateFeedbackEnvelopes([]);

    assert.equal(aggregate.dominant_label, null);
    assert.equal(aggregate.sample_count, 0);
    assert.equal(aggregate.uncertainty, 1);
  });
});
