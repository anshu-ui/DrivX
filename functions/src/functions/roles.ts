import { onCall } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { USER_ROLES, type AuthClaims } from '@drivx/domain';
import { authAdmin, db, serverTimestamp, writeAuditLog } from '../lib/admin';
import { CALLABLE_OPTIONS } from '../lib/config';
import { invalidArgument, parseInput } from '../lib/errors';
import { requireAdmin } from '../lib/guards';
import { uidSchema, zodEnum } from '../lib/validate';

const roleEnum = zodEnum(USER_ROLES);

const setRoleInput = z.object({
  targetUid: uidSchema,
  /** Primary role; decides which app surface the account lands in. */
  role: roleEnum,
  addRoles: z.array(roleEnum).max(4).default([]),
  removeRoles: z.array(roleEnum).max(4).default([]),
  reason: z.string().trim().min(8, 'A reason of at least 8 characters is required').max(400),
  zoneId: z.string().trim().max(60).nullish(),
  serviceTypeIds: z.array(z.string().max(40)).max(8).default([]),
});

/**
 * Grants or revokes roles. Admin-only, always audited, and never allowed to
 * target the caller's own account, so a session cannot escalate itself or lock
 * the dashboard out.
 */
export const setRole = onCall(CALLABLE_OPTIONS, async (request) => {
  const actor = requireAdmin(request);
  const input = parseInput(setRoleInput, request.data);

  if (input.targetUid === actor.uid) {
    throw invalidArgument('You cannot change your own roles.');
  }

  const userStore = authAdmin();
  const target = await userStore.getUser(input.targetUid).catch(() => null);
  if (!target) throw invalidArgument('No account with that id exists.');

  const previous = (target.customClaims ?? {}) as Partial<AuthClaims>;
  const roles = new Set<string>([...(previous.roles ?? []), ...input.addRoles]);
  for (const role of input.removeRoles) roles.delete(role);
  roles.add(input.role);

  const claims: AuthClaims = {
    role: input.role,
    roles: [...roles] as AuthClaims['roles'],
    admin: roles.has('admin'),
    // Administrators can act as operations staff; the reverse is not true.
    ops: roles.has('ops') || roles.has('admin'),
    // Verification belongs to the driver role, so it survives as long as that
    // role does — an account that keeps driving while its default surface moves
    // back to the customer app is still the approved driver it was.
    driverVerified: previous.driverVerified === true && roles.has('driver'),
    zoneId: input.zoneId ?? previous.zoneId ?? null,
    serviceTypeIds: input.serviceTypeIds as AuthClaims['serviceTypeIds'],
  };

  await userStore.setCustomUserClaims(input.targetUid, claims);

  await db()
    .collection('users')
    .doc(input.targetUid)
    .set({ role: claims.role, updatedAtMs: serverTimestamp() }, { merge: true });

  const auditLogId = await writeAuditLog({
    actorUid: actor.uid,
    actorRole: claims.admin ? 'admin' : 'ops',
    action: 'role_granted',
    targetType: 'customer',
    targetId: input.targetUid,
    before: { roles: previous.roles ?? [], admin: previous.admin === true },
    after: { roles: claims.roles, admin: claims.admin },
    reason: input.reason,
  });

  return { roles: claims.roles, admin: claims.admin, ops: claims.ops, auditLogId };
});
