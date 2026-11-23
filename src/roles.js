// lib/roles.js — role namespace policy.
//
// The `roles` config has carried an `enabled` flag that nothing read: the
// console let an owner switch a role off, and capture, retrieval, the always-on
// block and both tools all ignored it. The policy lives here so the call sites
// cannot drift apart and so it can be tested without mounting the plugin.

/**
 * Whether a role namespace is in use.
 *
 * A role that is absent from the list stays enabled: an unknown namespace is a
 * configuration gap, not an instruction to discard its memories.
 *
 * @param {unknown} roles the configured role list
 * @param {unknown} roleId the namespace to check
 * @returns {boolean}
 */
export function isRoleEnabled(roles, roleId) {
  if (!roleId || roleId === "global") return true;
  const list = Array.isArray(roles) ? roles : [];
  const found = list.find((r) => r && r.id === roleId);
  return found ? found.enabled !== false : true;
}

/**
 * The namespaces one agent may read and write: its own, plus the shared global
 * one.
 *
 * A disabled own-role falls back to global alone, so switching a role off hides
 * that role's memories rather than orphaning the agent: it keeps working, it
 * just stops seeing the namespace the owner turned off.
 *
 * @param {unknown} roles the configured role list
 * @param {any} agent the agent whose session carries a roleId
 * @param {string} fallbackRoleId used when the session does not name a role
 * @returns {string[]}
 */
export function roleIdsForAgent(roles, agent, fallbackRoleId) {
  const roleId = agent?.session?.header?.roleId ?? fallbackRoleId;
  if (!roleId || roleId === "global" || !isRoleEnabled(roles, roleId)) return ["global"];
  return [roleId, "global"];
}
