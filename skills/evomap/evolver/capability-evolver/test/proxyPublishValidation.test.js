'use strict';

// Issues EvoMap/evolver#607 / #608 / #609.
//
// The MCP publish path (`_assetPublish` → `_buildBundleFromLooseAsset`) used to
// default a gene's `validation` to `node -e "if (![1].length) process.exit(1)"`.
// GHSA-jxh8-jh77-xh6g hardened the validator sandbox to refuse inline `node -e`
// before spawn, so every gene published this way carried a validation command
// that NO validator could execute: validators burned a task slot, reported
// `sandbox_block_node_flag`, and the asset never reached consensus (reporters
// measured a ~91% failure rate).
//
// These tests lock in that the publish path can only ever emit validation
// commands the sandbox will actually run.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { EvoMapProxy } = require('../src/proxy/index');
const {
  parseCommand,
  assertNodeCommandSafe,
} = require('../src/gep/validator/sandboxExecutor');

function makeProxy() {
  return new EvoMapProxy({ hubUrl: 'https://hub.invalid', dataDir: null });
}

// Mirror of what the validator daemon does to a Hub-issued command.
function sandboxWouldRun(cmd) {
  try {
    assertNodeCommandSafe(parseCommand(String(cmd)));
    return true;
  } catch (_) {
    return false;
  }
}

const LONG_CONTENT =
  'Detect the failing lifecycle probe and restart the supervised worker. ' +
  'Confirm the restart cleared the stale socket before adopting the change.';

describe('MCP publish validation commands (#607/#608/#609)', () => {
  it('defaults to a validation command the sandbox can actually run', () => {
    const proxy = makeProxy();
    const { gene } = proxy._buildBundleFromLooseAsset({ content: LONG_CONTENT });

    assert.ok(Array.isArray(gene.validation) && gene.validation.length > 0);
    for (const cmd of gene.validation) {
      assert.ok(
        sandboxWouldRun(cmd),
        'default validation must be sandbox-runnable, got ' + JSON.stringify(cmd),
      );
    }
  });

  it('never emits an inline `node -e` default', () => {
    const proxy = makeProxy();
    const { gene } = proxy._buildBundleFromLooseAsset({ content: LONG_CONTENT });
    for (const cmd of gene.validation) {
      assert.doesNotMatch(String(cmd), /(^|\s)(-e|--eval|-p|--print)(\s|=|$)/);
    }
  });

  it('preserves caller-supplied sandbox-runnable validation', () => {
    const proxy = makeProxy();
    const { gene } = proxy._buildBundleFromLooseAsset({
      content: LONG_CONTENT,
      validation: ['node scripts/check.js --quiet'],
    });
    assert.deepStrictEqual(gene.validation, ['node scripts/check.js --quiet']);
  });

  it('rejects caller-supplied commands the sandbox would refuse, with a 400', () => {
    const proxy = makeProxy();
    for (const bad of [
      'node -e "process.exit(0)"',
      'node --eval "1"',
      'node -r ./preload.js check.js',
      'node --inspect check.js',
      'node "--inspect" check.js',
      'node "--require=./preload.js" check.js',
      'node "-r" "./preload.js" check.js',
      'node --watch check.js',
      'node "--watch" check.js',
      'npm test',
      'node --test',
      'node check.js && echo pwn',
    ]) {
      let err = null;
      try {
        proxy._buildBundleFromLooseAsset({ content: LONG_CONTENT, validation: [bad] });
      } catch (e) {
        err = e;
      }
      assert.ok(err, 'expected a rejection for ' + JSON.stringify(bad));
      assert.strictEqual(err.statusCode, 400, 'must be a clean 400 for ' + bad);
      assert.match(err.message, /validator sandbox cannot run/);
    }
  });

  it('rejects a mixed batch when any single command is unrunnable', () => {
    const proxy = makeProxy();
    assert.throws(
      () => proxy._buildBundleFromLooseAsset({
        content: LONG_CONTENT,
        validation: ['node --version', 'node -e "1"'],
      }),
      (e) => e.statusCode === 400 && /node -e/.test(e.message),
    );
  });

  it('falls back to the default when validation is empty or blank', () => {
    const proxy = makeProxy();
    for (const validation of [[], ['', '   ']]) {
      const { gene } = proxy._buildBundleFromLooseAsset({ content: LONG_CONTENT, validation });
      assert.ok(gene.validation.length > 0);
      assert.ok(gene.validation.every(sandboxWouldRun));
    }
  });
});
