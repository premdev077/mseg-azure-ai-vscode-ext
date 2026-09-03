import * as assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * `prompt.ts` imports `vscode`, which only exists inside the extension host,
 * so it is stubbed here. That is worth the trouble: the prompt assembly is the
 * most load-bearing new path in the extension, and a missing interpolation or
 * a mode advertising the wrong tools is invisible to the type checker.
 *
 * The stub is installed before `prompt.js` is required, so the require must be
 * lazy rather than a top-level import.
 */
const stub = {
  workspace: {
    workspaceFolders: [{ name: 'proj', uri: { fsPath: 'C:\\Users\\me\\proj' } }],
    getConfiguration: () => ({ get: () => undefined }),
    asRelativePath: (u: unknown) => String(u)
  },
  window: { activeTextEditor: undefined }
};

interface LoaderInternals {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}

// `require`, not `import`: a namespace import compiles to a getter-only
// object, and the loader hook has to replace `_load` on the real one.
const loader = require('node:module') as LoaderInternals;
const originalLoad = loader._load;
loader._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return stub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { buildSystemPrompt, withUserPrompt } =
  require('../prompt') as typeof import('../prompt');

type TestSettings = Parameters<typeof buildSystemPrompt>[0];

const settings = {
  bashPath: '',
  requireApprovalForAll: false,
  systemPrompt: '',
  maxFileBytes: 200_000
} as unknown as TestSettings;

const HARNESS = '# Working in this extension';
const MODES = ['fast', 'thinking', 'agent'] as const;

const prompts = {
  fast: buildSystemPrompt(settings, 'fast'),
  thinking: buildSystemPrompt(settings, 'thinking'),
  agent: buildSystemPrompt(settings, 'agent')
};

/** The layers this module builds itself, excluding the engineering document. */
function ownLayers(text: string): Array<[string, string]> {
  return [
    ['environment', text.slice(0, text.indexOf('\n\n---\n\n'))],
    ['harness', text.slice(text.indexOf(HARNESS))]
  ];
}

function advertisedTools(text: string): string[] {
  const match = text.match(/Tools available this turn: (.+?)\./);
  return match ? match[1].split(', ') : [];
}

test('every mode assembles a prompt with all four layers', () => {
  for (const mode of MODES) {
    const text = prompts[mode];
    assert.ok(text.length > 500, `${mode} produced only ${text.length} chars`);
    assert.ok(text.includes('# Environment'), `${mode} lost the environment layer`);
    assert.ok(text.includes('## ROLE'), `${mode} lost the engineering layer`);
    assert.ok(text.includes(HARNESS), `${mode} lost the harness layer`);
    assert.ok(text.includes('# Mode: '), `${mode} lost the mode guidance`);
  }
});

test('the layers this module builds are fully interpolated', () => {
  // The engineering document legitimately contains escaped `${...}` inside
  // code examples and the word "undefined" in prose, so only our own layers
  // can be checked for holes.
  for (const mode of MODES) {
    for (const [name, layer] of ownLayers(prompts[mode])) {
      assert.ok(
        !layer.includes('${'),
        `${mode}: ${name} layer has an unresolved interpolation`
      );
      assert.ok(
        !layer.includes('undefined'),
        `${mode}: ${name} layer contains a literal "undefined"`
      );
    }
  }
});

test('live environment facts are substituted, not left generic', () => {
  for (const mode of MODES) {
    const [, environment] = ownLayers(prompts[mode])[0];
    assert.ok(
      environment.includes('/c/Users/me/proj'),
      `${mode} did not convert the workspace path to a Git Bash path`
    );
    assert.match(
      environment,
      /Shell for run_command: \S/,
      `${mode} did not report a resolved shell`
    );
  }
});

test('the harness block follows the engineering standards it overrides', () => {
  for (const mode of MODES) {
    const text = prompts[mode];
    assert.ok(
      text.indexOf(HARNESS) > text.indexOf('## ROLE'),
      `${mode} puts the harness rules before the general ones, so the general ones would win`
    );
  }
});

test("the advertised tool list matches the mode's real permissions", () => {
  const fast = advertisedTools(prompts.fast);
  const agent = advertisedTools(prompts.agent);

  assert.ok(fast.length > 0, 'fast mode advertised no tools at all');
  for (const mutating of [
    'write_file',
    'apply_patch',
    'run_command',
    'run_validation'
  ]) {
    assert.ok(
      !fast.includes(mutating),
      `fast mode advertises ${mutating}, which it cannot call`
    );
  }
  assert.ok(agent.includes('write_file'), 'agent mode should advertise write_file');
  assert.ok(agent.includes('run_command'), 'agent mode should advertise run_command');
});

test('fast mode tells the user how to escalate instead of failing silently', () => {
  assert.match(prompts.fast, /Thinking or Agent mode/);
});

test('prompt cost rises with mode, so fast is genuinely cheaper', () => {
  assert.ok(
    prompts.fast.length * 2 < prompts.agent.length,
    `fast (${prompts.fast.length}) should be far below agent (${prompts.agent.length})`
  );
  assert.ok(
    prompts.fast.length < prompts.thinking.length &&
      prompts.thinking.length < prompts.agent.length,
    `expected fast < thinking < agent, got ${prompts.fast.length} / ${prompts.thinking.length} / ${prompts.agent.length}`
  );
});

test('the approval rule reflects the requireApprovalForAll setting', () => {
  const lenient = buildSystemPrompt(settings, 'agent');
  const strict = buildSystemPrompt(
    { ...settings, requireApprovalForAll: true } as TestSettings,
    'agent'
  );

  assert.match(lenient, /run immediately/);
  assert.match(strict, /Every command waits for the user to approve it\./);
  assert.ok(
    !strict.includes('run immediately'),
    'strict mode should not also claim commands run immediately'
  );
});

test("the user's own instructions are appended last of all", () => {
  const withExtra = withUserPrompt(prompts.agent, {
    ...settings,
    systemPrompt: 'Always use tabs.'
  } as TestSettings);

  assert.ok(withExtra.trimEnd().endsWith('Always use tabs.'));
  assert.ok(withExtra.includes('# Additional instructions from the user'));
});

test('an empty user instruction adds nothing', () => {
  assert.equal(withUserPrompt(prompts.fast, settings), prompts.fast);
});
