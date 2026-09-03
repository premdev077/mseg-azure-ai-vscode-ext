import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { AgentState, describeState, isActive, stateForTool } from '../agent/state';

const ALL_STATES: AgentState[] = [
  'idle',
  'analyzing',
  'planning',
  'searching',
  'reading',
  'editing',
  'testing',
  'fixing',
  'completed',
  'failed',
  'cancelled'
];

test('every state has a non-empty label', () => {
  for (const state of ALL_STATES) {
    assert.ok(describeState(state).length > 0, `${state} has no label`);
  }
});

test('labels are distinct, so the UI never shows two phases the same way', () => {
  const labels = ALL_STATES.map(describeState);
  assert.equal(new Set(labels).size, labels.length);
});

test('terminal states are not active', () => {
  for (const state of ['idle', 'completed', 'failed', 'cancelled'] as AgentState[]) {
    assert.equal(isActive(state), false, `${state} should not be active`);
  }
});

test('working states are active', () => {
  for (const state of [
    'analyzing',
    'planning',
    'searching',
    'reading',
    'editing',
    'testing',
    'fixing'
  ] as AgentState[]) {
    assert.equal(isActive(state), true, `${state} should be active`);
  }
});

test('tools map to the phase they actually represent', () => {
  assert.equal(stateForTool('read_file'), 'reading');
  assert.equal(stateForTool('search_workspace'), 'searching');
  assert.equal(stateForTool('list_files'), 'searching');
  assert.equal(stateForTool('write_file'), 'editing');
  assert.equal(stateForTool('apply_patch'), 'editing');
  assert.equal(stateForTool('run_validation'), 'testing');
  assert.equal(stateForTool('get_diagnostics'), 'testing');
});

test('an unknown tool degrades to analyzing rather than misreporting', () => {
  assert.equal(stateForTool('some_future_tool'), 'analyzing');
  assert.equal(stateForTool(''), 'analyzing');
});

test('no tool maps to a terminal state', () => {
  for (const tool of [
    'read_file',
    'list_files',
    'search_workspace',
    'write_file',
    'apply_patch',
    'run_command',
    'run_validation',
    'get_diagnostics',
    'git_status',
    'git_diff',
    'record_session',
    'unknown'
  ]) {
    assert.ok(isActive(stateForTool(tool)), `${tool} should map to an active state`);
  }
});
