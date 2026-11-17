# Test job storage

`re-use-blender-tests.yaml` registers this action before checkout so its `post`
entry point runs after artifact/report uploads, uv cache saving, and checkout's
credential cleanup. It uses the runner's bundled Node and has no npm dependencies.
The calling addon repositories need no changes.

At startup the action removes only the checkout directories named by `base` and
`extra`, plus the old `ci-wheels` directory, directly under `GITHUB_WORKSPACE`.
This recovers checkouts left by interrupted jobs and prevents stale diagnostics.
The same directories, including their `.venv` and Git LFS data, are removed in
the post action. Fresh checkouts may increase network traffic and setup time.

Each job gets a unique directory under `RUNNER_TEMP` containing:

- `tmp`: `TMPDIR`, `TMP`, `TEMP`, and `PYTEST_DEBUG_TEMPROOT` for Python, Blender,
  DNA working copies and child processes;
- `pytest`: an explicit `--basetemp`, separate because pytest clears this path;
- `uv-cache`: the package cache, retained until setup-uv's post action completes;
- `wheels`: only the artifacts downloaded for the current job.

The workflow preserves its existing reports and also uploads `reports/pytest-console.log`
before cleanup. It does not upload large temporary DNA or Blender working files.
Python installations, tool caches, other checkouts, and files outside these owned
directories are not removed. Top-level symbolic links/junctions and changed runner
roots are refused; nested links are unlinked rather than traversed. Cleanup errors
fail the post action instead of silently accumulating files.

The optional `minimum-free-space-gib` workflow input defaults to 20. It checks both
workspace and temporary volumes on self-hosted runners after reclaiming old checkouts
and before dependency installation. Set it to 0 to report without enforcement.
GitHub-hosted runners only report space. Logs and the job summary show free space
before setup, after recovery, before final cleanup, and after cleanup.

Normal failure and cancellation use the `always()` post action. A runner crash,
forced shutdown or exhausted job timeout can prevent any post action from running.
GitHub clears `RUNNER_TEMP` at the next job start when file permissions allow it;
the next use of this workflow in the same workspace reclaims its named checkouts.
This is not a machine-wide sweep of other repositories, caches, installations or
historical system temporary directories. The runner must own the generated files.

Run the filesystem regression tests with:

```sh
node --test tests/runner-storage.test.cjs
```

The shared repository's `test-runner-storage.yaml` runs them with Node 24 on Linux,
Windows and macOS. A branch that tests the reusable workflow itself must also point
its `runner-storage` action reference at that branch; production callers continue
using the existing shared workflow at `main`.
