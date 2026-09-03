import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChangeLog } from '../agent/changes';
import { checkScope, describeScope, partitionByArea } from '../agent/scope';
import {
  attributeChanges,
  buildBaseline,
  parseBranch,
  parseStatus,
  preexistingWarning
} from '../git/baseline';

// --- scope enforcement -----------------------------------------------------

test('no scope means unrestricted, so the single-agent path is unchanged', () => {
  assert.equal(checkScope('anything/at/all.ts', undefined).allowed, true);
  assert.equal(checkScope('anything.ts', {}).allowed, true);
  assert.equal(checkScope('anything.ts', { allowedFiles: [] }).allowed, true);
});

test('an exact file in scope is allowed', () => {
  const scope = { allowedFiles: ['src/auth/callback.ts'] };
  assert.equal(checkScope('src/auth/callback.ts', scope).allowed, true);
  assert.equal(checkScope('src/auth/oauth.ts', scope).allowed, false);
});

test('a directory scope covers its subtree but not its siblings', () => {
  const scope = { allowedDirectories: ['src/api'] };
  assert.equal(checkScope('src/api/client.ts', scope).allowed, true);
  assert.equal(checkScope('src/api/deep/nested/file.ts', scope).allowed, true);
  assert.equal(
    checkScope('src/apiary/thing.ts', scope).allowed,
    false,
    'prefix must not leak'
  );
  assert.equal(checkScope('src/components/Form.tsx', scope).allowed, false);
});

test('the glob tail a plan carries is accepted', () => {
  for (const dir of ['src/api/**', 'src/api/*', 'src/api/']) {
    assert.equal(
      checkScope('src/api/client.ts', { allowedDirectories: [dir] }).allowed,
      true,
      `${dir} should behave as src/api`
    );
  }
});

test('separators and prefixes are normalised', () => {
  const scope = { allowedDirectories: ['src/api'] };
  assert.equal(checkScope('src\\api\\client.ts', scope).allowed, true);
  assert.equal(checkScope('./src/api/client.ts', scope).allowed, true);
  assert.equal(checkScope('/src/api/client.ts', scope).allowed, true);
});

test('a refusal says what is allowed and tells the agent to ask', () => {
  const verdict = checkScope('tests/auth.test.ts', {
    allowedDirectories: ['src/api'],
    allowedFiles: ['src/index.ts']
  });

  assert.equal(verdict.allowed, false);
  const reason = verdict.allowed ? '' : verdict.reason;
  assert.match(reason, /outside this agent's assigned scope/);
  assert.match(reason, /src\/api\/\*\*/);
  assert.match(reason, /src\/index\.ts/);
  assert.match(reason, /let the Coordinator assign it/);
});

test('describeScope reads sensibly in both directions', () => {
  assert.equal(describeScope(undefined), 'any file in the workspace');
  assert.equal(describeScope({}), 'any file in the workspace');
  assert.equal(
    describeScope({ allowedDirectories: ['src/api/**'], allowedFiles: ['a.ts'] }),
    'src/api/**, a.ts'
  );
});

// --- partitioning ----------------------------------------------------------

test('files split into non-overlapping areas', () => {
  const groups = partitionByArea(
    ['src/api/client.ts', 'src/api/routes.ts', 'src/ui/Form.tsx', 'tests/api.test.ts'],
    4
  );

  const areas = groups.map((g) => g.area).sort();
  assert.deepEqual(areas, ['src/api', 'src/ui', 'tests']);

  // No file may appear in two groups, or two agents would contend for it.
  const seen = new Set<string>();
  for (const group of groups) {
    for (const file of group.files) {
      assert.ok(!seen.has(file), `${file} is in two groups`);
      seen.add(file);
    }
  }
});

test('areas beyond the group limit are merged, never dropped', () => {
  const files = [
    'a/one/1.ts',
    'a/one/2.ts',
    'a/one/3.ts',
    'b/two/1.ts',
    'b/two/2.ts',
    'c/three/1.ts',
    'd/four/1.ts'
  ];
  const groups = partitionByArea(files, 2);

  assert.equal(groups.length, 2);
  const all = groups.flatMap((g) => g.files).sort();
  assert.deepEqual(all, [...files].sort(), 'every file must survive the merge');
});

test('partitioning handles empty input and root files', () => {
  assert.deepEqual(partitionByArea([], 3), []);
  assert.deepEqual(partitionByArea(['README.md'], 3), [
    { area: '.', files: ['README.md'] }
  ]);
});

// --- change log ------------------------------------------------------------

test('the change log answers who changed a file and why', () => {
  const log = new ChangeLog();
  log.record({
    agentId: 'coder-a',
    taskId: 't1',
    filePath: 'src/auth.ts',
    operation: 'modify',
    added: 10,
    removed: 2,
    applied: true
  });
  log.record({
    agentId: 'coder-b',
    taskId: 't1',
    filePath: 'src/ui.tsx',
    operation: 'create',
    added: 40,
    removed: 0,
    applied: true
  });

  assert.equal(log.byFile('src/auth.ts')[0].agentId, 'coder-a');
  assert.equal(log.byAgent('coder-b').length, 1);
  assert.deepEqual(log.changedFiles(), ['src/auth.ts', 'src/ui.tsx']);
  assert.equal(log.all()[0].changeId, 'chg-1', 'ids are stable and ordered');
});

test('rejected edits are recorded, not discarded', () => {
  const log = new ChangeLog();
  log.record({
    agentId: 'a',
    taskId: 't',
    filePath: 'x.ts',
    operation: 'modify',
    added: 5,
    removed: 1,
    applied: false
  });

  assert.equal(log.all().length, 1, 'the attempt is on the record');
  assert.equal(log.applied().length, 0);
  assert.equal(log.rejected().length, 1);
  assert.deepEqual(log.changedFiles(), [], 'a rejected edit changed no file');
});

test('the summary counts only what reached disk', () => {
  const log = new ChangeLog();
  log.record({
    agentId: 'a',
    taskId: 't',
    filePath: 'a.ts',
    operation: 'modify',
    added: 10,
    removed: 3,
    applied: true
  });
  log.record({
    agentId: 'a',
    taskId: 't',
    filePath: 'b.ts',
    operation: 'create',
    added: 20,
    removed: 0,
    applied: true
  });
  log.record({
    agentId: 'a',
    taskId: 't',
    filePath: 'c.ts',
    operation: 'modify',
    added: 99,
    removed: 99,
    applied: false
  });

  const summary = log.summary();
  assert.equal(summary.files, 2);
  assert.equal(summary.added, 30);
  assert.equal(summary.removed, 3);
  assert.equal(summary.created, 1);
  assert.equal(summary.modified, 1);
  assert.match(log.describe(), /2 files changed, \+30 −3/);
});

test('the same file edited twice counts once', () => {
  const log = new ChangeLog();
  log.record({
    agentId: 'a',
    taskId: 't',
    filePath: 'a.ts',
    operation: 'modify',
    added: 5,
    removed: 0,
    applied: true
  });
  log.record({
    agentId: 'a',
    taskId: 't',
    filePath: './a.ts',
    operation: 'modify',
    added: 3,
    removed: 1,
    applied: true
  });

  assert.equal(log.summary().files, 1);
  assert.equal(log.summary().added, 8);
  assert.equal(log.byFile('a.ts').length, 2);
});

// --- git status parsing ----------------------------------------------------

test('porcelain status is parsed into staged and unstaged entries', () => {
  const files = parseStatus(
    [
      '## main...origin/main',
      ' M src/auth.ts',
      'M  src/staged.ts',
      'MM src/both.ts',
      'A  src/added.ts',
      ' D src/gone.ts',
      '?? src/new.ts',
      'R  old.ts -> new.ts'
    ].join('\n')
  );

  const find = (p: string) => files.filter((f) => f.filePath === p);

  assert.deepEqual(find('src/auth.ts'), [
    { filePath: 'src/auth.ts', state: 'modified', staged: false }
  ]);
  assert.deepEqual(find('src/staged.ts'), [
    { filePath: 'src/staged.ts', state: 'modified', staged: true }
  ]);
  assert.equal(
    find('src/both.ts').length,
    2,
    'staged and unstaged are separate entries'
  );
  assert.equal(find('src/added.ts')[0].state, 'added');
  assert.equal(find('src/gone.ts')[0].state, 'deleted');
  assert.equal(find('src/new.ts')[0].state, 'untracked');
  assert.equal(
    find('new.ts')[0].state,
    'renamed',
    'a rename is recorded at its new path'
  );

  // The `## branch` header is not a file.
  assert.equal(find('main').length, 0);
  assert.ok(!files.some((f) => f.filePath.startsWith('#')));
});

test('conflicts are recognised rather than read as ordinary edits', () => {
  const files = parseStatus('UU src/conflict.ts\nAA src/both-added.ts');
  assert.equal(files[0].state, 'conflicted');
  assert.equal(files[1].state, 'conflicted');
});

test('quoted paths are unquoted', () => {
  const files = parseStatus(' M "src/has space.ts"');
  assert.equal(files[0].filePath, 'src/has space.ts');
});

test('the branch is read from the porcelain header', () => {
  assert.equal(parseBranch('## main...origin/main [ahead 1]\n M a.ts'), 'main');
  assert.equal(parseBranch('## feature/thing'), 'feature/thing');
  assert.equal(parseBranch('## HEAD (no branch)'), 'HEAD (detached)');
  assert.equal(parseBranch(' M a.ts'), undefined);
});

test('a non-repository degrades to an empty baseline rather than failing', () => {
  const baseline = buildBaseline('', { isRepo: false });
  assert.equal(baseline.isRepo, false);
  assert.deepEqual(baseline.dirtyFiles, []);
});

// --- attribution: the guarantee that matters -------------------------------

test('a file the run changed that was already dirty is flagged', () => {
  const baseline = buildBaseline('## main\n M src/auth.ts\n M src/untouched.ts');
  const attribution = attributeChanges(
    baseline,
    parseStatus('## main\n M src/auth.ts\n M src/untouched.ts\n M src/new-work.ts'),
    ['src/auth.ts', 'src/new-work.ts']
  );

  assert.deepEqual(
    attribution.touchedPreexisting,
    ['src/auth.ts'],
    "the user's in-progress work and the agent's edit are now mixed in this file"
  );
  assert.deepEqual(attribution.preservedPreexisting, ['src/untouched.ts']);
  assert.deepEqual(attribution.claimed, ['src/auth.ts', 'src/new-work.ts']);
  assert.deepEqual(attribution.unexpected, []);
});

test('a file that changed but no agent claimed is reported as unexpected', () => {
  const baseline = buildBaseline('## main');
  const attribution = attributeChanges(
    baseline,
    parseStatus('## main\n M src/claimed.ts\n M src/mystery.ts'),
    ['src/claimed.ts']
  );

  assert.deepEqual(attribution.unexpected, ['src/mystery.ts']);
});

test('a clean run over a clean tree reports nothing unexpected', () => {
  const baseline = buildBaseline('## main');
  const attribution = attributeChanges(
    baseline,
    parseStatus('## main\n M a.ts\n M b.ts'),
    ['a.ts', 'b.ts']
  );

  assert.deepEqual(attribution.unexpected, []);
  assert.deepEqual(attribution.touchedPreexisting, []);
  assert.deepEqual(attribution.claimed, ['a.ts', 'b.ts']);
});

test('an agent is warned before it edits a file the user was working on', () => {
  const baseline = buildBaseline('## main\nM  src/auth.ts');
  const warning = preexistingWarning(baseline, 'src/auth.ts');

  assert.ok(warning);
  assert.match(String(warning), /already had uncommitted changes/);
  assert.match(String(warning), /staged/);
  assert.match(String(warning), /never revert or rewrite/);

  assert.equal(preexistingWarning(baseline, 'src/clean.ts'), undefined);
});
