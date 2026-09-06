'use strict';

// Regression tests for the v1.69.8 security hardening of sandboxExecutor.
// See GH issue #451 (H1 — shell injection via spawn({shell:true})).

const test = require('node:test');
const assert = require('node:assert');

const { parseCommand, assertNodeCommandSafe, ALLOWED_EXECUTABLES, BLOCKED_NODE_FLAGS } = require('../src/gep/validator/sandboxExecutor');

test('parseCommand splits a simple command', () => {
  const r = parseCommand('node index.js');
  assert.strictEqual(r.executable, 'node');
  assert.deepStrictEqual(r.args, ['index.js']);
});

test('parseCommand handles quoted args with spaces', () => {
  const r = parseCommand('node "my script.js" --flag value');
  assert.strictEqual(r.executable, 'node');
  assert.deepStrictEqual(r.args, ['my script.js', '--flag', 'value']);
});

test('parseCommand rejects shell metacharacters', () => {
  for (const bad of [
    'node idx.js; rm -rf /',
    'node idx.js && echo pwn',
    'node idx.js | tee pwn.log',
    'node idx.js `cat /etc/passwd`',
    'node idx.js $(cat /etc/passwd)',
    'node idx.js > /tmp/x',
    'node idx.js < /tmp/x',
    'node idx.js & background',
  ]) {
    assert.throws(
      () => parseCommand(bad),
      /metacharacter|shell/i,
      'expected ' + bad + ' to be rejected',
    );
  }
});

test('parseCommand rejects empty and non-string input', () => {
  assert.throws(() => parseCommand(''));
  assert.throws(() => parseCommand(null));
  assert.throws(() => parseCommand(123));
});

test('ALLOWED_EXECUTABLES contains only node (GHSA-jxh8-jh77-xh6g: npm/npx removed)', () => {
  const allowed = Array.from(ALLOWED_EXECUTABLES).sort();
  assert.deepStrictEqual(allowed, ['node']);
});

test('ALLOWED_EXECUTABLES rejects npm and npx (lifecycle-script RCE class)', () => {
  // Both npm and npx execute arbitrary code by design (preinstall/install/
  // postinstall lifecycle scripts for npm; remote package bin entry for npx).
  // GHSA-jxh8-jh77-xh6g removes them from the allowlist so a compromised or
  // MitM'd Hub cannot ship `npm install <evil-tgz>` as a validation command.
  for (const binary of ['npm', 'npx']) {
    assert.strictEqual(
      ALLOWED_EXECUTABLES.has(binary),
      false,
      binary + ' must not be in the allowlist (GHSA-jxh8-jh77-xh6g)',
    );
  }
});

test('ALLOWED_EXECUTABLES rejects shell and arbitrary binaries', () => {
  for (const binary of ['bash', 'sh', 'zsh', 'cmd', 'python', 'curl', 'wget', 'rm']) {
    assert.strictEqual(
      ALLOWED_EXECUTABLES.has(binary),
      false,
      binary + ' must not be in the allowlist',
    );
  }
});

test('BLOCKED_NODE_FLAGS contains the eval/require class flags', () => {
  for (const flag of ['-e', '--eval', '-p', '--print', '-r', '--require', '--loader', '--import']) {
    assert.strictEqual(
      BLOCKED_NODE_FLAGS.has(flag),
      true,
      flag + ' must be in BLOCKED_NODE_FLAGS',
    );
  }
});

test('assertNodeCommandSafe rejects inline eval flags', () => {
  assert.throws(
    () => assertNodeCommandSafe({ executable: 'node', args: ['-e', 'console.log(1)'] }),
    /node flag not allowed/,
  );
  assert.throws(
    () => assertNodeCommandSafe({ executable: 'node', args: ['--eval=1+1'] }),
    /node flag not allowed/,
  );
  assert.throws(
    () => assertNodeCommandSafe({ executable: 'node', args: ['-p', '1+1'] }),
    /node flag not allowed/,
  );
  assert.throws(
    () => assertNodeCommandSafe({ executable: 'node', args: ['--require', './preload.js', 'script.js'] }),
    /node flag not allowed/,
  );
});

test('assertNodeCommandSafe rejects node with no positional script', () => {
  assert.throws(
    () => assertNodeCommandSafe({ executable: 'node', args: [] }),
    /script file argument/,
  );
  assert.throws(
    () => assertNodeCommandSafe({ executable: 'node', args: ['--no-warnings'] }),
    /script file argument/,
  );
});

test('assertNodeCommandSafe is a no-op for non-node executables', () => {
  assert.doesNotThrow(() => assertNodeCommandSafe({ executable: 'npm', args: ['test'] }));
  assert.doesNotThrow(() => assertNodeCommandSafe({ executable: 'npx', args: ['-y', 'eslint', '.'] }));
});

test('assertNodeCommandSafe accepts well-formed node invocations', () => {
  assert.doesNotThrow(() => assertNodeCommandSafe({ executable: 'node', args: ['index.js'] }));
  assert.doesNotThrow(() => assertNodeCommandSafe({ executable: 'node', args: ['--no-warnings', 'index.js'] }));
  assert.doesNotThrow(() => assertNodeCommandSafe({ executable: 'node', args: ['scripts/validate-suite.js', '--quiet'] }));
});

// PR #206 (Security Agent): the predictable sandbox base under os.tmpdir()
// must refuse a pre-existing symlink — on a shared host another local user
// could pre-create it to redirect every sandbox workdir.
test('createSandboxDir refuses a symlinked base path', (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createSandboxDir } = require('../src/gep/validator/sandboxExecutor');

  const fixtureTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-symlink-'));
  const realTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-target-'));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  try {
    try {
      fs.symlinkSync(realTarget, path.join(fixtureTmp, 'evolver-validator'));
    } catch (e) {
      t.skip('symlinks unavailable: ' + (e && e.code)); // e.g. Windows without privilege
      return;
    }
    process.env.TMPDIR = fixtureTmp; // POSIX
    process.env.TEMP = fixtureTmp;   // Windows
    process.env.TMP = fixtureTmp;
    assert.throws(() => createSandboxDir(), /Refusing sandbox base/);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(fixtureTmp, { recursive: true, force: true });
    fs.rmSync(realTarget, { recursive: true, force: true });
  }
});

test('createSandboxDir still works against a clean base (positive control)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createSandboxDir, cleanupDir } = require('../src/gep/validator/sandboxExecutor');

  const fixtureTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-clean-'));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  try {
    process.env.TMPDIR = fixtureTmp;
    process.env.TEMP = fixtureTmp;
    process.env.TMP = fixtureTmp;
    const dir = createSandboxDir();
    assert.ok(fs.statSync(dir).isDirectory());
    assert.ok(dir.startsWith(fs.realpathSync(fixtureTmp) + path.sep) || dir.startsWith(fixtureTmp + path.sep));
    cleanupDir(dir);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(fixtureTmp, { recursive: true, force: true });
  }
});

test('createSandboxDir self-heals loose permissions on an owned base', (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createSandboxDir, cleanupDir } = require('../src/gep/validator/sandboxExecutor');

  if (process.platform === 'win32') { t.skip('POSIX mode bits only'); return; }

  const fixtureTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-perms-'));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  try {
    // Pre-create the base as OUR dir but world-writable (e.g. older evolver
    // or a permissive umask) — must be tightened back to 0700, not refused.
    const base = path.join(fixtureTmp, 'evolver-validator');
    fs.mkdirSync(base);
    fs.chmodSync(base, 0o777);
    process.env.TMPDIR = fixtureTmp;
    process.env.TEMP = fixtureTmp;
    process.env.TMP = fixtureTmp;
    const dir = createSandboxDir();
    assert.ok(fs.statSync(dir).isDirectory());
    assert.strictEqual(fs.statSync(base).mode & 0o077, 0,
      'a loose owned base must be chmod-ed back to owner-only');
    cleanupDir(dir);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(fixtureTmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Issues #607/#608/#609: validation commands the Hub issues must actually be
// runnable in the sandbox, and the two independent gate implementations
// (validator/sandboxExecutor.js and gep/policyCheck.js) must agree.
// ---------------------------------------------------------------------------

const policyCheck = require('../src/gep/policyCheck');
const {
  SCRIPTLESS_NODE_FLAGS,
} = require('../src/gep/validator/sandboxExecutor');

test('assertNodeCommandSafe allows info-only node flags without a script file', () => {
  // runInSandbox() hands each command a FRESH EMPTY directory and provisions no
  // gene files, so `node --version` is the only shape that can succeed there.
  // It is also what skillDistiller's prompts tell the LLM to emit. Requiring a
  // script file here made every Hub-issued validation unrunnable.
  for (const args of [['--version'], ['-v'], ['--help'], ['-h']]) {
    assert.doesNotThrow(
      () => assertNodeCommandSafe({ executable: 'node', args }),
      'expected node ' + args.join(' ') + ' to be allowed',
    );
  }
});

test('assertNodeCommandSafe still blocks eval/preload/inspector/watch flags', () => {
  for (const args of [
    ['-e', '1'], ['--eval', '1'], ['-p', '1'], ['--print', '1'],
    ['-r', './p.js', 's.js'], ['--require=./p.js', 's.js'],
    ['--import', './p.js', 's.js'], ['--loader', './l.js', 's.js'],
    ['--env-file', '.env', 's.js'],
    ['--inspect', 's.js'], ['--inspect-brk', 's.js'],
    ['--watch', 's.js'], ['--watch-path', './x', 's.js'],
    ['--conditions', 'prod', 's.js'], ['-C', 'prod', 's.js'],
  ]) {
    assert.throws(
      () => assertNodeCommandSafe({ executable: 'node', args }),
      /node flag not allowed/,
      'expected node ' + args.join(' ') + ' to be blocked',
    );
  }
});

test('assertNodeCommandSafe still requires a script for non-info flags', () => {
  assert.throws(
    () => assertNodeCommandSafe({ executable: 'node', args: [] }),
    /script file argument/,
  );
  assert.throws(
    () => assertNodeCommandSafe({ executable: 'node', args: ['--no-warnings'] }),
    /script file argument/,
  );
});

test('sandbox gate and policyCheck.isValidationCommandAllowed agree', () => {
  // Drift between these two lists is exactly what shipped genes that passed
  // publish-side checks and then died in every validator sandbox.
  const cases = [
    'node --version', 'node -v', 'node --help', 'node validate.js',
    'node scripts/check.js --quiet',
    'node -e "1"', 'node --eval x', 'node -p x', 'node -r ./p.js s.js',
    'node --require=./p.js s.js', 'node --import ./p.js s.js',
    'node --loader ./l.js s.js', 'node --env-file .env s.js',
    'node --inspect s.js', 'node --inspect-brk s.js', 'node --inspect-port=9229 s.js',
    'node "--inspect" check.js', 'node "--require=./p.js" check.js',
    'node "-r" "./p.js" check.js', 'node "--watch" check.js',
    'node --watch s.js', 'node --watch-path ./x s.js',
    'node --conditions prod s.js', 'node -C prod s.js',
    'node --no-warnings', 'node --test',
  ];
  for (const cmd of cases) {
    let sandboxOk = true;
    try {
      assertNodeCommandSafe(parseCommand(cmd));
    } catch (_) {
      sandboxOk = false;
    }
    const policyOk = policyCheck.isValidationCommandAllowed(cmd);
    assert.strictEqual(
      sandboxOk, policyOk,
      'gate disagreement for ' + JSON.stringify(cmd) +
      ': sandbox=' + sandboxOk + ' policyCheck=' + policyOk,
    );
  }
});

test('BLOCKED_NODE_FLAGS and SCRIPTLESS_NODE_FLAGS are identical in both modules', () => {
  assert.deepStrictEqual(
    [...BLOCKED_NODE_FLAGS].sort(),
    [...policyCheck.BLOCKED_NODE_FLAGS].sort(),
  );
  assert.deepStrictEqual(
    [...SCRIPTLESS_NODE_FLAGS].sort(),
    [...policyCheck.SCRIPTLESS_NODE_FLAGS].sort(),
  );
  // A flag can never be both blocked and script-exempt.
  for (const f of SCRIPTLESS_NODE_FLAGS) {
    assert.ok(!BLOCKED_NODE_FLAGS.has(f), f + ' must not be in both sets');
  }
});

test('a scriptless info command actually runs in a real sandbox', async () => {
  // End-to-end against the real binary: proves the gate change restores a
  // validation path that genuinely exits 0 in the empty sandbox workdir,
  // not just one that passes the static checks.
  const { runInSandbox } = require('../src/gep/validator/sandboxExecutor');
  const r = await runInSandbox(['node --version'], {});
  assert.strictEqual(r.overallOk, true, 'stderr: ' + (r.results[0] && r.results[0].stderr));
  assert.strictEqual(r.results[0].exitCode, 0);
  assert.match(r.results[0].stdout, /^v\d+\./);
});
