import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AGENT_ROLES,
  distinctModels,
  invalidRoleAssignments,
  isAgentRole,
  ModelRoles,
  resolveRoleModel
} from '../agent/roles';

const DEPLOYMENTS = ['sol', 'luna', 'terra'];

test('isAgentRole accepts only the declared roles', () => {
  for (const role of AGENT_ROLES) {
    assert.ok(isAgentRole(role));
  }
  for (const bad of ['Coordinator', 'planning', '', undefined, null, 7, {}]) {
    assert.equal(isAgentRole(bad), false, `${String(bad)} should be rejected`);
  }
});

test('an unset role uses the default deployment', () => {
  const resolved = resolveRoleModel('planner', {}, DEPLOYMENTS, 'sol');
  assert.equal(resolved.model, 'sol');
  assert.equal(resolved.fellBack, false);
});

test('an empty or whitespace role value is treated as unset', () => {
  for (const value of ['', '   ']) {
    const resolved = resolveRoleModel(
      'planner',
      { planner: value },
      DEPLOYMENTS,
      'sol'
    );
    assert.equal(resolved.model, 'sol');
    assert.equal(resolved.fellBack, false, 'blank is not a misconfiguration');
  }
});

test('a configured role routes to its own deployment', () => {
  const roles: ModelRoles = { coordinator: 'sol', planner: 'luna', verifier: 'terra' };

  assert.equal(resolveRoleModel('coordinator', roles, DEPLOYMENTS, 'sol').model, 'sol');
  assert.equal(resolveRoleModel('planner', roles, DEPLOYMENTS, 'sol').model, 'luna');
  assert.equal(resolveRoleModel('verifier', roles, DEPLOYMENTS, 'sol').model, 'terra');
  // Roles left unset still fall back.
  assert.equal(resolveRoleModel('coder', roles, DEPLOYMENTS, 'sol').model, 'sol');
});

test('a deployment that is not configured falls back and says why', () => {
  const resolved = resolveRoleModel(
    'verifier',
    { verifier: 'nebula' },
    DEPLOYMENTS,
    'sol'
  );

  assert.equal(resolved.model, 'sol', 'the turn must still run');
  assert.equal(resolved.fellBack, true);
  assert.match(String(resolved.reason), /"nebula" is set as the verifier model/);
  assert.match(String(resolved.reason), /sol, luna, terra/);
  assert.match(String(resolved.reason), /Using "sol" instead/);
});

test('role names are matched exactly, not loosely', () => {
  // A near-miss is a typo the user needs told about, not something to guess at.
  const resolved = resolveRoleModel('planner', { planner: 'Luna' }, DEPLOYMENTS, 'sol');
  assert.equal(resolved.fellBack, true);
});

test('every misrouted role is reported, once each', () => {
  const problems = invalidRoleAssignments(
    { coordinator: 'ghost', planner: 'luna', verifier: 'phantom' },
    DEPLOYMENTS,
    'sol'
  );

  assert.equal(problems.length, 2);
  assert.ok(
    problems.some((p) => p.includes('"ghost" is set as the coordinator model'))
  );
  assert.ok(problems.some((p) => p.includes('"phantom" is set as the verifier model')));
  // "luna" appears inside every message, because each one lists the available
  // deployments — so check no message is *about* the planner.
  assert.ok(
    !problems.some((p) => p.includes('as the planner model')),
    'a correctly routed role should not be reported'
  );
});

test('a fully valid configuration reports no problems', () => {
  assert.deepEqual(
    invalidRoleAssignments({ coordinator: 'sol', planner: 'luna' }, DEPLOYMENTS, 'sol'),
    []
  );
});

test('distinctModels shows whether roles are really separated', () => {
  const spread = distinctModels(
    { coordinator: 'sol', planner: 'luna', coder: 'luna', verifier: 'terra' },
    DEPLOYMENTS,
    'sol'
  );
  assert.deepEqual(spread.sort(), ['luna', 'sol', 'terra']);

  // Everything pointed at one deployment means one TPM quota, however many
  // roles are named.
  const collapsed = distinctModels(
    { coordinator: 'sol', planner: 'sol', verifier: 'sol' },
    DEPLOYMENTS,
    'sol'
  );
  assert.deepEqual(collapsed, ['sol']);
});

test('resolution is safe when nothing is configured at all', () => {
  const resolved = resolveRoleModel('chat', {}, [], '');
  assert.equal(resolved.model, '');
  assert.equal(resolved.fellBack, false);

  const problems = invalidRoleAssignments({ chat: 'sol' }, [], '');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not one of the configured deployments \(none\)/);
});
