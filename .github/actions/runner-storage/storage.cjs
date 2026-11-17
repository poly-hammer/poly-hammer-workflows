'use strict';

// Node built-ins only: the action runs with GitHub's bundled Node on all three platforms.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const GIB = 1024 ** 3;
const TEMP_PREFIX = 'poly-hammer-tests-';

function fail(error) {
  const message = String(error.stack || error).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.error(`::error::${message}`);
  process.exitCode = 1;
}

async function command(file, name, value) {
  if (!process.env[file]) throw new Error(`${file} is required; run this action inside GitHub Actions.`);
  const delimiter = `storage_${randomUUID()}`;
  await fs.appendFile(process.env[file], `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function checkoutNames(base = '', extra = '') {
  for (const prefix of [base, extra]) {
    if (prefix && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(prefix)) {
      throw new Error(`Invalid repository prefix: ${JSON.stringify(prefix)}`);
    }
  }
  if (!base && !extra) throw new Error('At least one of base or extra is required.');
  return [...new Set([
    ...(base ? [`${base}-addon`, `${base}-bindings`] : []),
    ...(extra ? [`${extra}-addon`] : []),
    // Reclaim wheel downloads left in the workspace by the previous workflow version.
    'ci-wheels',
  ])];
}

async function canonicalRoot(value, name) {
  if (!value || !path.isAbsolute(value) || path.resolve(value) === path.parse(value).root) {
    throw new Error(`${name} must be an absolute, non-root directory.`);
  }
  const root = await fs.realpath(value);
  if (root === path.parse(root).root || !(await fs.stat(root)).isDirectory()) {
    throw new Error(`${name} must resolve to a non-root directory.`);
  }
  return root;
}

async function validateChild(root, name) {
  if (!name || path.basename(name) !== name || name === '.' || name === '..') {
    throw new Error(`Refusing a path outside its owned directory: ${JSON.stringify(name)}`);
  }
  // Recheck the parent at deletion time, including in the separate post-job process.
  if (await fs.realpath(root) !== root) throw new Error(`Storage root changed: ${root}`);
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root) throw new Error(`Refusing to remove ${target}`);
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return target;
    throw error;
  }
  // Refuse top-level links/junctions; recursive rm unlinks nested links without following them.
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(target) !== target) {
    throw new Error(`Owned directory is a link or is not a directory: ${target}`);
  }
  return target;
}

async function removeChildren(root, names) {
  // Validate every target before starting so a bad input cannot cause a partial sweep.
  for (const name of names) await validateChild(root, name);
  const errors = [];
  for (const name of names) {
    try {
      const target = await validateChild(root, name);
      console.log(`Removing job-owned directory: ${target}`);
      await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, `Could not remove all job-owned directories: ${errors.map(error => error.message).join('; ')}`);
  }
}

async function diskSnapshot(stage, workspace, temporary, minimum = 0) {
  const readings = [];
  for (const [label, directory] of [['Workspace', workspace], ['Temporary', temporary]]) {
    const stat = await fs.statfs(directory);
    const available = stat.bavail * stat.bsize / GIB;
    console.log(`${stage}: ${label} has ${available.toFixed(2)} GiB available (${directory}).`);
    readings.push({ label, available });
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = readings.map(({ label, available }) => `| ${stage} | ${label} | ${available.toFixed(2)} |`).join('\n');
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
      `\n| Storage checkpoint | Volume | Available GiB |\n| --- | --- | ---: |\n${rows}\n`);
  }
  const low = readings.filter(({ available }) => available < minimum);
  if (low.length) {
    throw new Error(`Insufficient free space: ${low.map(({ label, available }) => `${label} ${available.toFixed(2)} GiB`).join(', ')}; ` +
      `at least ${minimum} GiB is required. Free runner disk space or adjust minimum-free-space-gib.`);
  }
}

async function prepare() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Storage cleanup is only allowed inside GitHub Actions.');
  const base = process.env.INPUT_BASE || '';
  const extra = process.env.INPUT_EXTRA || '';
  const names = checkoutNames(base, extra);
  const minimum = Number(process.env['INPUT_MINIMUM-FREE-SPACE-GIB'] || '20');
  if (!Number.isFinite(minimum) || minimum < 0) throw new Error('minimum-free-space-gib must be a nonnegative number.');
  const environment = process.env['INPUT_RUNNER-ENVIRONMENT'];
  if (!['github-hosted', 'self-hosted'].includes(environment)) throw new Error('runner-environment must come from runner.environment.');
  const workspace = await canonicalRoot(process.env.GITHUB_WORKSPACE, 'GITHUB_WORKSPACE');
  const temporary = await canonicalRoot(process.env.RUNNER_TEMP, 'RUNNER_TEMP');
  // The two roots must be separate: neither deletion scope may contain the other root.
  const relative = path.relative(workspace, temporary);
  const reverse = path.relative(temporary, workspace);
  const inside = value => !value || (!path.isAbsolute(value) && value !== '..' && !value.startsWith(`..${path.sep}`));
  if (inside(relative) || inside(reverse)) throw new Error('GITHUB_WORKSPACE and RUNNER_TEMP must be separate directories.');

  for (const name of names) await validateChild(workspace, name);
  // Save cleanup ownership before operations that can fail (including the free-space guard).
  const state = { workspace, temporary, base, extra };
  await command('GITHUB_STATE', 'storage', JSON.stringify(state));
  await diskSnapshot('Before setup', workspace, temporary);
  // Fresh checkouts also prevent stale reports being uploaded if installation or tests fail early.
  await removeChildren(workspace, names);
  await diskSnapshot('After workspace recovery', workspace, temporary, environment === 'self-hosted' ? minimum : 0);

  const scratch = await fs.mkdtemp(path.join(temporary, TEMP_PREFIX));
  state.scratchName = path.basename(scratch);
  await command('GITHUB_STATE', 'storage', JSON.stringify(state));
  for (const name of ['tmp', 'pytest', 'uv-cache', 'wheels']) await fs.mkdir(path.join(scratch, name));
  for (const name of ['TMPDIR', 'TMP', 'TEMP', 'PYTEST_DEBUG_TEMPROOT']) {
    await command('GITHUB_ENV', name, path.join(scratch, 'tmp'));
  }
  await command('GITHUB_ENV', 'UV_CACHE_DIR', path.join(scratch, 'uv-cache'));
  for (const [output, directory] of [['pytest-directory', 'pytest'], ['cache-directory', 'uv-cache'], ['wheels-directory', 'wheels']]) {
    await command('GITHUB_OUTPUT', output, path.join(scratch, directory));
  }
}

async function finish() {
  if (!process.env.STATE_storage) return; // Setup failed before establishing ownership.
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Storage cleanup is only allowed inside GitHub Actions.');
  const state = JSON.parse(process.env.STATE_storage);
  // Compare with runner-provided paths as well as the saved canonical roots.
  if (await canonicalRoot(process.env.GITHUB_WORKSPACE, 'GITHUB_WORKSPACE') !== state.workspace ||
      await canonicalRoot(process.env.RUNNER_TEMP, 'RUNNER_TEMP') !== state.temporary) {
    throw new Error('Runner storage roots changed; refusing post-job deletion.');
  }
  const errors = [];
  try { await diskSnapshot('After job, before cleanup', state.workspace, state.temporary); } catch (error) { errors.push(error); }
  try { await removeChildren(state.workspace, checkoutNames(state.base, state.extra)); } catch (error) { errors.push(error); }
  try {
    if (state.scratchName) {
      if (!state.scratchName.startsWith(TEMP_PREFIX)) throw new Error('Invalid job temporary directory in cleanup state.');
      await removeChildren(state.temporary, [state.scratchName]);
    }
  } catch (error) { errors.push(error); }
  try { await diskSnapshot('After cleanup', state.workspace, state.temporary); } catch (error) { errors.push(error); }
  if (errors.length) {
    throw new AggregateError(errors, `Storage cleanup failed: ${errors.map(error => error.message).join('; ')}`);
  }
}

module.exports = { prepare, finish, fail, checkoutNames, canonicalRoot, validateChild, removeChildren, diskSnapshot };
