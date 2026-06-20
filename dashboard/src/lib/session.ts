import { permissionsForRoles, canUseTool, can, type Permission } from "@/lib/rbac";

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
export function forbidden(): Response {
  return Response.json({ error: "forbidden" }, { status: 403 });
}

/** Pure: returns a 403 Response if `roles` cannot use `tool`, else null. */
export function denyTool(roles: string[], tool: string): Response | null {
  return canUseTool(permissionsForRoles(roles), tool) ? null : forbidden();
}
/** Pure: returns a 403 Response if `roles` lacks `perm`, else null. */
export function denyPerm(roles: string[], perm: Permission): Response | null {
  return can(permissionsForRoles(roles), perm) ? null : forbidden();
}

/** Resolve the caller's roles from the session, or null if unauthenticated.
 * `auth` is imported lazily so this module stays unit-testable without pulling
 * next-auth (and next/server) into the test runtime. */
export async function callerRoles(): Promise<string[] | null> {
  const { auth } = await import("@/auth");
  const session = await auth();
  if (!session?.user) return null;
  return session.user.roles ?? [];
}
