'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { checkoutNames, removeChildren, diskSnapshot } = require('../.github/actions/runner-storage/storage.cjs');

const action = path.resolve(__dirname, '../.github/actions/runner-storage');

async function fixture(t, overrides = {}) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'runner-storage-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^runner-storage-test-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, 'workspace with spaces');
  const temporary = path.join(root, 'runner temp');
  await fs.mkdir(workspace);
  await fs.mkdir(temporary);
  const env = {
    ...process.env,
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: temporary,
    GITHUB_STATE: path.join(root, 'state'),
    GITHUB_OUTPUT: path.join(root, 'output'),
    GITHUB_ENV: path.join(root, 'environment'),
    GITHUB_STEP_SUMMARY: path.join(root, 'summary'),
    INPUT_BASE: 'character-dna',
    INPUT_EXTRA: 'character-control-rig',
    'INPUT_RUNNER-ENVIRONMENT': 'self-hosted',
    'INPUT_MINIMUM-FREE-SPACE-GIB': '0',
    STATE_storage: '',
    ...overrides,
  };
  for (const name of ['GITHUB_STATE', 'GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_STEP_SUMMARY']) await fs.writeFile(env[name], '');
  const run = (script, additions = {}) => spawnSync(process.execPath, [path.join(action, script)], {
    env: { ...env, ...additions }, encoding: 'utf8', cwd: workspace,
  });
  const start = () => run('main.cjs');
  const finish = async () => run('post.cjs', { STATE_storage: (await commands(env.GITHUB_STATE)).storage || '' });
  return { root, workspace, temporary, env, start, finish };
}

async function commands(file) {
  const lines = (await fs.readFile(file, 'utf8')).split('\n');
  const values = {};
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]) continue;
    const [name, delimiter] = lines[index].split('<<');
    assert.ok(delimiter);
    const content = [];
    while (lines[++index] !== delimiter) {
      assert.ok(index < lines.length, 'unterminated command');
      content.push(lines[index]);
    }
    values[name] = content.join('\n');
  }
  return values;
}

async function put(directory, file = 'sentinel', contents = 'keep') {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, file), contents);
}

async function absent(target) {
  await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
}

test('a hard-exiting test leaves diagnostics and caches available until the separate post action', async t => {
  const f = await fixture(t);
  const names = checkoutNames('character-dna', 'character-control-rig');
  for (const name of names) await put(path.join(f.workspace, name), 'stale-report');
  await put(path.join(f.workspace, 'unrelated-checkout'));
  await put(path.join(f.temporary, 'other-action'));
  const result = f.start();
  assert.equal(result.status, 0, result.stderr);
  for (const name of names) await absent(path.join(f.workspace, name));

  const environment = await commands(f.env.GITHUB_ENV);
  const output = await commands(f.env.GITHUB_OUTPUT);
  const state = JSON.parse((await commands(f.env.GITHUB_STATE)).storage);
  const scratch = path.join(f.temporary, state.scratchName);
  for (const directory of [...Object.values(output), ...Object.values(environment)]) {
    assert.equal(path.dirname(directory), scratch);
    assert.ok((await fs.stat(directory)).isDirectory());
  }
  assert.equal(environment.TMP, environment.TMPDIR);
  assert.equal(environment.TEMP, environment.TMPDIR);
  assert.equal(environment.PYTEST_DEBUG_TEMPROOT, environment.TMPDIR);
  assert.notEqual(output['pytest-directory'], environment.TMPDIR);

  // Simulate pytest's hard exit: no destructor/exit cleanup, but the runner still owns the post action.
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    fs.mkdirSync(path.join(process.env.TMPDIR, 'character-dna-working'));
    fs.writeFileSync(path.join(process.env.TMPDIR, 'character-dna-working', 'copy.dna'), 'disposable');
    fs.writeFileSync(path.join(process.env.PYTEST_BASETEMP, '.lock'), String(process.pid));
    process.exit(7);
  `], { env: { ...f.env, ...environment, PYTEST_BASETEMP: output['pytest-directory'] } });
  assert.equal(child.status, 7);
  await put(path.join(f.workspace, 'character-control-rig-addon', 'reports'), 'pytest-console.log', 'failure diagnostics');
  await put(output['cache-directory'], 'cache-to-upload');
  await put(output['wheels-directory'], 'current.whl');
  assert.equal(await fs.readFile(path.join(f.workspace, 'character-control-rig-addon', 'reports', 'pytest-console.log'), 'utf8'), 'failure diagnostics');
  assert.equal(await fs.readFile(path.join(output['cache-directory'], 'cache-to-upload'), 'utf8'), 'keep');

  const cleanup = await f.finish();
  assert.equal(cleanup.status, 0, cleanup.stderr);
  for (const name of names) await absent(path.join(f.workspace, name));
  await absent(scratch);
  assert.equal(await fs.readFile(path.join(f.workspace, 'unrelated-checkout', 'sentinel'), 'utf8'), 'keep');
  assert.equal(await fs.readFile(path.join(f.temporary, 'other-action', 'sentinel'), 'utf8'), 'keep');
  assert.match(await fs.readFile(f.env.GITHUB_STEP_SUMMARY, 'utf8'), /After cleanup/);
  assert.equal((await f.finish()).status, 0, 'cleanup can be retried');
});

test('the next job reclaims an interrupted checkout and uses new scratch paths', async t => {
  const f = await fixture(t);
  assert.equal(f.start().status, 0);
  const previous = await commands(f.env.GITHUB_OUTPUT);
  await put(path.join(f.workspace, 'character-dna-addon', '.venv'));
  await put(path.join(f.workspace, 'character-control-rig-addon', 'reports'), 'old.xml');
  // No post action, as after a runner crash. GitHub owns recovery of RUNNER_TEMP at job start.
  assert.equal(f.start().status, 0);
  const current = await commands(f.env.GITHUB_OUTPUT);
  assert.notEqual(previous['pytest-directory'], current['pytest-directory']);
  await absent(path.join(f.workspace, 'character-dna-addon'));
  await absent(path.join(f.workspace, 'character-control-rig-addon'));
  assert.equal((await f.finish()).status, 0);
});

test('standalone addons need no base checkout', async t => {
  const f = await fixture(t, { INPUT_BASE: '', INPUT_EXTRA: 'standalone' });
  await put(path.join(f.workspace, 'standalone-addon'));
  await put(path.join(f.workspace, 'character-dna-addon'));
  assert.equal(f.start().status, 0);
  await absent(path.join(f.workspace, 'standalone-addon'));
  assert.equal((await f.finish()).status, 0);
  assert.equal(await fs.readFile(path.join(f.workspace, 'character-dna-addon', 'sentinel'), 'utf8'), 'keep');
});

test('a self-hosted low-space failure still leaves post cleanup runnable', async t => {
  const f = await fixture(t, { 'INPUT_MINIMUM-FREE-SPACE-GIB': '1000000000' });
  await put(path.join(f.workspace, 'character-dna-addon'));
  const result = f.start();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Insufficient free space/);
  await absent(path.join(f.workspace, 'character-dna-addon'));
  assert.deepEqual(await commands(f.env.GITHUB_OUTPUT), {});
  assert.equal((await f.finish()).status, 0);
});

test('hosted runners report space without applying the self-hosted minimum', async t => {
  const f = await fixture(t, { 'INPUT_RUNNER-ENVIRONMENT': 'github-hosted', 'INPUT_MINIMUM-FREE-SPACE-GIB': '1000000000' });
  assert.equal(f.start().status, 0);
  assert.equal((await f.finish()).status, 0);
});

test('unsafe inputs and runner roots fail before deleting any checkout', async t => {
  const f = await fixture(t);
  await put(path.join(f.workspace, 'character-dna-addon'));
  for (const overrides of [
    { INPUT_EXTRA: '../outside' },
    { INPUT_BASE: 'character/dna' },
    { INPUT_EXTRA: 'C:\\outside' },
    { 'INPUT_MINIMUM-FREE-SPACE-GIB': '-1' },
    { 'INPUT_MINIMUM-FREE-SPACE-GIB': 'NaN' },
    { GITHUB_ACTIONS: 'false' },
    { RUNNER_TEMP: f.workspace },
    { RUNNER_TEMP: f.root },
    { RUNNER_TEMP: path.parse(f.root).root },
    { GITHUB_WORKSPACE: '' },
  ]) {
    const result = spawnSync(process.execPath, [path.join(action, 'main.cjs')], { env: { ...f.env, ...overrides }, encoding: 'utf8' });
    assert.equal(result.status, 1, JSON.stringify(overrides));
    assert.equal(await fs.readFile(path.join(f.workspace, 'character-dna-addon', 'sentinel'), 'utf8'), 'keep');
  }
  assert.equal((await f.finish()).status, 0, 'post is a no-op when ownership was never established');
});

test('root links and traversal are refused, nested links do not delete their external targets', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'protected');
  await put(outside);
  const linked = path.join(f.workspace, 'character-dna-addon');
  await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.start().status, 1);
  assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'keep');
  await fs.unlink(linked);
  await fs.mkdir(linked);
  await fs.symlink(outside, path.join(linked, 'nested-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removeChildren(f.workspace, ['../protected']), /outside its owned/);
  await removeChildren(f.workspace, ['character-dna-addon']);
  assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'keep');
});

test('post refuses changed runner roots and a checkout replaced by a junction', async t => {
  const f = await fixture(t);
  assert.equal(f.start().status, 0);
  const state = (await commands(f.env.GITHUB_STATE)).storage;
  const other = path.join(f.root, 'other-workspace');
  await put(other);
  const changed = spawnSync(process.execPath, [path.join(action, 'post.cjs')], {
    env: { ...f.env, STATE_storage: state, GITHUB_WORKSPACE: other }, encoding: 'utf8',
  });
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /roots changed/);
  await fs.symlink(other, path.join(f.workspace, 'character-dna-addon'), process.platform === 'win32' ? 'junction' : 'dir');
  const cleanup = await f.finish();
  assert.equal(cleanup.status, 1);
  assert.match(cleanup.stderr, /link or is not a directory/);
  assert.equal(await fs.readFile(path.join(other, 'sentinel'), 'utf8'), 'keep');
  await absent(path.join(f.temporary, JSON.parse(state).scratchName));
});

test('space on both volumes is checked, including a full temporary volume', async t => {
  const f = await fixture(t);
  t.mock.method(fs, 'statfs', async directory => ({ bavail: directory === f.temporary ? 1 : 100, bsize: 1024 ** 3 }));
  await assert.rejects(diskSnapshot('Test', f.workspace, f.temporary, 20), /Temporary 1.00 GiB/);
});

test('a deletion error is reported while cleanup continues for other owned directories', async t => {
  const f = await fixture(t);
  const locked = path.join(f.workspace, 'character-dna-addon');
  const other = path.join(f.workspace, 'character-dna-bindings');
  await put(locked);
  await put(other);
  const realRemove = fs.rm;
  const mock = t.mock.method(fs, 'rm', async (target, options) => {
    if (target === locked) throw new Error(`Access denied: ${target}`);
    return realRemove(target, options);
  });
  await assert.rejects(removeChildren(f.workspace, ['character-dna-addon', 'character-dna-bindings']), /Access denied/);
  mock.mock.restore();
  await absent(other);
  assert.equal(await fs.readFile(path.join(locked, 'sentinel'), 'utf8'), 'keep');
});
