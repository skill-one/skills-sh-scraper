'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  buildClaudeContextSchemaRoutingGene,
  buildClaudeContextGeneFamily,
} = require('../src/gep/contextRoutingGene');
const { extractSignals } = require('../src/gep/signals');
const { selectGene } = require('../src/gep/selector');
const { validateGene } = require('../src/gep/schemas/gene');
const { verifyAssetId } = require('../src/gep/contentHash');
const recallInject = require('../src/gep/recallInject');

const EXPECTED_IDS = [
  'gene_claude_prompt_budget_ledger',
  'gene_claude_context_schema_routing',
  'gene_claude_tool_schema_lazy_load',
  'gene_claude_skill_manual_routing',
  'gene_claude_transcript_handoff_compression',
  'gene_claude_memory_index_budget',
];

function withStableSelector(fn) {
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  try { return fn(); } finally { Math.random = originalRandom; }
}

describe('Claude context schema routing Gene family', () => {
  it('contains a complete, content-addressed context compression family', () => {
    const genes = buildClaudeContextGeneFamily();

    assert.deepEqual(genes.map(g => g.id), EXPECTED_IDS);
    for (const gene of genes) {
      assert.equal(validateGene(gene), true, gene.id);
      assert.equal(verifyAssetId(gene), true, gene.id);
      assert.equal(gene.routing_hint.tier, 'mid');
      assert.ok(gene.summary.length >= 40, gene.id);
      assert.ok(gene.strategy.length >= 5, gene.id);
      assert.ok(gene.validation.length >= 2, gene.id);
    }
  });

  it('keeps the legacy builder available as the dispatcher Gene', () => {
    assert.equal(buildClaudeContextSchemaRoutingGene().id, 'gene_claude_context_schema_routing');
  });

  it('bundled assets carry the same content-addressed Gene family as the module', () => {
    const generated = buildClaudeContextGeneFamily();
    const bundledPath = path.resolve(__dirname, '..', 'assets', 'gep', 'genes.json');
    const publicSeedPath = path.resolve(__dirname, '..', 'assets', 'gep', 'genes.seed.json');
    const bundled = JSON.parse(fs.readFileSync(
      fs.existsSync(bundledPath) ? bundledPath : publicSeedPath,
      'utf8'
    ));

    const usingPublicSeed = !fs.existsSync(bundledPath) && fs.existsSync(publicSeedPath);

    for (const gene of generated) {
      const found = bundled.genes.find((candidate) => candidate && candidate.id === gene.id);
      assert.ok(found, `bundled genes.json must include ${gene.id}`);
      if (usingPublicSeed) {
        assert.equal(validateGene(found), true, found.id);
        assert.equal(found.id, gene.id);
        assert.deepEqual(found.signals_match, gene.signals_match);
        assert.deepEqual(found.strategy, gene.strategy);
        assert.deepEqual(found.validation, gene.validation);
      } else {
        assert.deepEqual(found, gene);
      }
      assert.equal(verifyAssetId(found), true);
    }
  });

  it('extracts deterministic signals from natural Claude Code context-bloat language', () => {
    const signals = extractSignals({
      recentSessionTranscript: [
        'Claude Code context exploded after Available agent types and MCP Server Instructions were injected.',
        'The tool schema is too large, the skill manual descriptions are too long, and we should distill it into a gene with lazy-load schema routing.',
        '工具 schema 太大，mcp/skill 列表太长，随便传一个会话上下文就爆了。',
        'Build a prompt budget ledger and check whether the memory index is still okay before blaming MEMORY.md.',
      ].join('\n'),
      todayLog: '',
      memorySnippet: '',
      userSnippet: '',
      recentEvents: [],
    });

    assert.ok(signals.includes('claude_code_context_bloat'));
    assert.ok(signals.includes('context_explosion'));
    assert.ok(signals.includes('tool_schema_bloat'));
    assert.ok(signals.includes('skill_list_bloat'));
    assert.ok(signals.includes('skill_manual_bloat'));
    assert.ok(signals.includes('lazy_load_schema'));
    assert.ok(signals.includes('schema_routing_gene_request'));
    assert.ok(signals.includes('prompt_budget_measurement'));
    assert.ok(signals.includes('memory_index_budget'));
    assert.ok(signals.includes('conversation_handoff_bloat'));
  });

  it('selector chooses specialized Genes for distinct context-bloat signals', () => {
    const family = buildClaudeContextGeneFamily();
    const generic = {
      type: 'Gene',
      id: 'gene_generic_prompt',
      category: 'optimize',
      signals_match: ['prompt', 'protocol'],
      strategy: ['generic prompt optimization'],
      validation: ['node -e "true"'],
    };

    const cases = [
      [['prompt_budget_measurement', 'token_budget_overflow'], 'gene_claude_prompt_budget_ledger'],
      [['claude_code_context_bloat', 'schema_routing_gene_request'], 'gene_claude_context_schema_routing'],
      [['tool_schema_bloat', 'mcp_tool_schema', 'lazy_load_schema'], 'gene_claude_tool_schema_lazy_load'],
      [['skill_manual_bloat', 'skill_list_bloat'], 'gene_claude_skill_manual_routing'],
      [['transcript_context_bloat', 'conversation_handoff_bloat'], 'gene_claude_transcript_handoff_compression'],
      [['memory_index_budget'], 'gene_claude_memory_index_budget'],
    ];

    withStableSelector(() => {
      for (const [signals, expected] of cases) {
        const result = selectGene([generic].concat(family), signals, {});
        assert.ok(result.selected, expected);
        assert.equal(result.selected.id, expected);
      }
    });
  });

  it('recall injection surfaces local specialized Genes with Hub disabled', async () => {
    const savedHubSemantic = process.env.HUBSEARCH_SEMANTIC;
    const savedRecallMax = process.env.EVOLVER_RECALL_MAX;
    try {
      process.env.HUBSEARCH_SEMANTIC = 'false';
      process.env.EVOLVER_RECALL_MAX = '5';
      const r = await recallInject.recallForTask({
        prompt: 'Claude Code context bloat: tool schema too large, MCP Server Instructions and skill list are too long; distill into genes and lazy-load schema. Also build a prompt budget ledger for the pasted transcript handoff.',
        mode: 'enforce',
        timeoutMs: 500,
      });

      assert.equal(r.inject, true);
      assert.ok(r.decided.some((d) => d.title === 'gene_claude_tool_schema_lazy_load'));
      assert.ok(r.decided.some((d) => d.title === 'gene_claude_prompt_budget_ledger'));
      assert.match(r.text, /gene_claude_/);
      assert.ok(r.text.length <= 800, 'recall hint must stay under the hard injection ceiling');
    } finally {
      if (savedHubSemantic === undefined) delete process.env.HUBSEARCH_SEMANTIC;
      else process.env.HUBSEARCH_SEMANTIC = savedHubSemantic;
      if (savedRecallMax === undefined) delete process.env.EVOLVER_RECALL_MAX;
      else process.env.EVOLVER_RECALL_MAX = savedRecallMax;
    }
  });
});
