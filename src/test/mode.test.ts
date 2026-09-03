import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AGENT_MODES,
  isAgentMode,
  MODE_PROFILES,
  modeProfile,
  READ_ONLY_TOOLS
} from '../agent/mode';
import {
  composeEngineeringPrompt,
  PROMPT_SECTIONS,
  PromptStack
} from '../prompt/systemPrompt';

test('isAgentMode accepts only the three modes', () => {
  for (const mode of AGENT_MODES) {
    assert.ok(isAgentMode(mode));
  }
  for (const bad of ['', 'Fast', 'auto', undefined, null, 0, {}]) {
    assert.equal(isAgentMode(bad), false, `${String(bad)} should be rejected`);
  }
});

test('every mode has a profile keyed by its own name', () => {
  for (const mode of AGENT_MODES) {
    assert.equal(modeProfile(mode).mode, mode);
  }
});

test('fast mode is the only one that restricts tools, and only to read-only ones', () => {
  assert.deepEqual(modeProfile('fast').allowedTools, READ_ONLY_TOOLS);
  assert.equal(modeProfile('thinking').allowedTools, undefined);
  assert.equal(modeProfile('agent').allowedTools, undefined);

  // A mutating tool slipping into the read-only list would let Fast mode edit
  // files, which is the one thing it must not do.
  for (const name of ['write_file', 'apply_patch', 'run_command', 'run_validation']) {
    assert.equal(
      READ_ONLY_TOOLS.includes(name),
      false,
      `${name} must not be available in fast mode`
    );
  }
});

test('only fast mode caps tool rounds, and auto-fix is agent-only', () => {
  assert.equal(modeProfile('fast').toolRoundCap, 3);
  assert.equal(modeProfile('thinking').toolRoundCap, undefined);
  assert.equal(modeProfile('agent').toolRoundCap, undefined);

  assert.equal(modeProfile('fast').autoFix, false);
  assert.equal(modeProfile('thinking').autoFix, false);
  assert.equal(modeProfile('agent').autoFix, true);
});

test('every prompt section declares a tier, and only stack sections a stack', () => {
  assert.ok(PROMPT_SECTIONS.length > 0);
  for (const section of PROMPT_SECTIONS) {
    assert.ok(section.body.trim().length > 0, `${section.id} has an empty body`);
    if (section.tier === 'stack') {
      assert.ok(section.stack, `${section.id} is a stack section with no stack`);
    } else {
      assert.equal(
        section.stack,
        undefined,
        `${section.id} is ${section.tier} but declares a stack`
      );
    }
  }
});

test('section ids are unique', () => {
  const ids = PROMPT_SECTIONS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('each mode composes a strictly larger prompt than the one below it', () => {
  const sizes = AGENT_MODES.map(
    (mode) => composeEngineeringPrompt({ tiers: modeProfile(mode).tiers }).length
  );
  const [fast, thinking, agent] = sizes;

  assert.ok(fast > 0, 'fast mode must still get the core sections');
  assert.ok(thinking > fast, `thinking (${thinking}) should exceed fast (${fast})`);
  assert.ok(agent > thinking, `agent (${agent}) should exceed thinking (${thinking})`);
});

test('composing a tier includes exactly that tier', () => {
  const core = composeEngineeringPrompt({ tiers: ['core'] });
  const coreSections = PROMPT_SECTIONS.filter((s) => s.tier === 'core');
  const otherSections = PROMPT_SECTIONS.filter((s) => s.tier !== 'core');

  for (const section of coreSections) {
    assert.ok(core.includes(section.body), `core is missing ${section.id}`);
  }
  for (const section of otherSections) {
    assert.equal(
      core.includes(section.body),
      false,
      `core should not include ${section.tier} section ${section.id}`
    );
  }
});

test('stack filtering keeps only the requested technologies', () => {
  const stacks: PromptStack[] = ['python'];
  const composed = composeEngineeringPrompt({ tiers: ['stack'], stacks });

  for (const section of PROMPT_SECTIONS.filter((s) => s.tier === 'stack')) {
    const expected = stacks.includes(section.stack as PromptStack);
    assert.equal(
      composed.includes(section.body),
      expected,
      `${section.id} (${section.stack}) should ${expected ? '' : 'not '}be present`
    );
  }
});

test('omitting stacks keeps every stack section', () => {
  const all = composeEngineeringPrompt({ tiers: ['stack'] });
  for (const section of PROMPT_SECTIONS.filter((s) => s.tier === 'stack')) {
    assert.ok(all.includes(section.body), `${section.id} should be present`);
  }
});

test('sections are composed in document order', () => {
  const composed = composeEngineeringPrompt({
    tiers: ['core', 'deep', 'session', 'stack']
  });
  let cursor = -1;
  for (const section of PROMPT_SECTIONS) {
    const at = composed.indexOf(section.body);
    assert.ok(at > cursor, `${section.id} is out of order`);
    cursor = at;
  }
});

test('the role section leads, so the model is told who it is first', () => {
  assert.equal(PROMPT_SECTIONS[0].id, 'role');
  assert.equal(PROMPT_SECTIONS[0].tier, 'core');
});

test('mode profiles carry guidance naming their own mode', () => {
  for (const profile of Object.values(MODE_PROFILES)) {
    assert.match(profile.guidance, /^# Mode: /);
    assert.ok(
      profile.guidance.includes(profile.label),
      `${profile.mode} guidance should name itself`
    );
    assert.ok(profile.description.length > 0);
  }
});
