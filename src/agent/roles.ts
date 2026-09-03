/**
 * Which job an agent is doing, and therefore which deployment should serve it.
 *
 * Roles exist so a strong reasoning deployment can back the Coordinator and the
 * Verifier while a cheap fast one does the read-only planning sweeps. That only
 * pays off across separate deployments — several roles pointed at one
 * deployment share its TPM quota, and parallel agents will throttle each other.
 */
export type AgentRole =
  'chat' | 'coordinator' | 'planner' | 'coder' | 'verifier' | 'repair';

export const AGENT_ROLES: readonly AgentRole[] = [
  'chat',
  'coordinator',
  'planner',
  'coder',
  'verifier',
  'repair'
];

export function isAgentRole(value: unknown): value is AgentRole {
  return (
    typeof value === 'string' && (AGENT_ROLES as readonly string[]).includes(value)
  );
}

/** Deployment name per role. An empty or missing entry falls back to the default. */
export type ModelRoles = Partial<Record<AgentRole, string>>;

export interface RoleResolution {
  /** The deployment to call. Never empty when the extension is configured. */
  model: string;
  /** True when the configured name was unusable and the default was used. */
  fellBack: boolean;
  /** Set when `fellBack` is true: why, in words fit for a notice. */
  reason?: string;
}

/**
 * Resolves the deployment for a role.
 *
 * A name that is not among the configured deployments is a configuration
 * mistake, not a routing instruction — calling it would 404 halfway through a
 * task. It falls back and says so, so the turn still runs and the user learns
 * why their routing was ignored.
 */
export function resolveRoleModel(
  role: AgentRole,
  roles: ModelRoles,
  available: readonly string[],
  fallback: string
): RoleResolution {
  const configured = (roles[role] ?? '').trim();
  if (!configured) {
    return { model: fallback, fellBack: false };
  }
  if (!available.includes(configured)) {
    return {
      model: fallback,
      fellBack: true,
      reason: `"${configured}" is set as the ${role} model but is not one of the configured deployments (${
        available.join(', ') || 'none'
      }). Using "${fallback}" instead.`
    };
  }
  return { model: configured, fellBack: false };
}

/**
 * Every role whose configured deployment is unusable. Called once when a task
 * starts so the user gets one clear notice up front rather than a surprise
 * mid-run.
 */
export function invalidRoleAssignments(
  roles: ModelRoles,
  available: readonly string[],
  fallback: string
): string[] {
  const problems: string[] = [];
  for (const role of AGENT_ROLES) {
    const resolved = resolveRoleModel(role, roles, available, fallback);
    if (resolved.fellBack && resolved.reason) {
      problems.push(resolved.reason);
    }
  }
  return problems;
}

/** Distinct deployments in play, so the UI can say whether roles really are separated. */
export function distinctModels(
  roles: ModelRoles,
  available: readonly string[],
  fallback: string
): string[] {
  const seen = new Set<string>();
  for (const role of AGENT_ROLES) {
    seen.add(resolveRoleModel(role, roles, available, fallback).model);
  }
  return [...seen].filter(Boolean);
}
