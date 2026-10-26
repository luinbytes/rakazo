import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

export class IsolationError extends Error {
  constructor(message = "Resource not found") {
    super(message);
    this.name = "IsolationError";
  }
}

export async function requireMembership(prisma: PrismaClient, userId: string): Promise<Actor> {
  return (await resolveMembership(prisma, userId)).actor;
}

/** One authentication snapshot, owned by a single request; never cache across requests. */
export async function resolveMembership(prisma: PrismaClient, userId: string) {
  const member = await prisma.member.findFirst({
    where: { userId },
    select: {
      userId: true,
      organizationId: true,
      user: { select: { email: true, name: true, avatarStyle: true } },
    },
  });
  if (!member) {
    throw new IsolationError("No personal workspace");
  }
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: {
      ownerUserId: true,
      deploymentModelCredentialCipher: true,
      defaultModelProvider: true,
      defaultModelId: true,
      computerHost: true,
    },
  });
  const actor: Actor = {
    userId: member.userId,
    workspaceId: member.organizationId,
    email: member.user.email,
    isDeploymentOwner: settings?.ownerUserId === member.userId,
  };
  return { actor, user: member.user, settings };
}

export type MembershipContext = Awaited<ReturnType<typeof resolveMembership>>;

export function scoped<T extends { workspaceId: string; userId?: string }>(
  actor: Actor,
  record: T | null,
): T {
  if (!record || record.workspaceId !== actor.workspaceId) {
    throw new IsolationError();
  }
  if (record.userId && record.userId !== actor.userId) {
    throw new IsolationError();
  }
  return record;
}
