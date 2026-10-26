import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { IsolationError, requireMembership, resolveMembership } from "./scope.js";

function fixture() {
  const member = {
    userId: "user",
    organizationId: "workspace",
    user: { email: "user@example.test", name: "User", avatarStyle: "organic" },
  };
  const prisma = {
    member: { findFirst: vi.fn().mockResolvedValue(member) },
    deploymentSettings: { findUnique: vi.fn().mockResolvedValue({ ownerUserId: "user" }) },
  };
  return { prisma, member, db: prisma as unknown as PrismaClient };
}

describe("request membership snapshot", () => {
  it("keeps the actor contract and selects only auth/me fields without fetching the organization", async () => {
    const { prisma, member, db } = fixture();
    const snapshot = await resolveMembership(db, "user");
    expect(snapshot.actor).toEqual({
      userId: "user",
      workspaceId: "workspace",
      email: member.user.email,
      isDeploymentOwner: true,
    });
    expect(snapshot.user).toBe(member.user);
    expect(prisma.member.findFirst).toHaveBeenCalledWith({
      where: { userId: "user" },
      select: {
        userId: true,
        organizationId: true,
        user: { select: { email: true, name: true, avatarStyle: true } },
      },
    });
    expect(prisma.deploymentSettings.findUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: {
        ownerUserId: true,
        deploymentModelCredentialCipher: true,
        defaultModelProvider: true,
        defaultModelId: true,
        computerHost: true,
      },
    });
    expect(await requireMembership(db, "user")).toEqual(snapshot.actor);
  });

  it("rechecks membership and ownership on every call", async () => {
    const { prisma, db } = fixture();
    expect((await resolveMembership(db, "user")).actor.isDeploymentOwner).toBe(true);
    prisma.deploymentSettings.findUnique.mockResolvedValueOnce(null);
    expect((await resolveMembership(db, "user")).actor.isDeploymentOwner).toBe(false);
    prisma.member.findFirst.mockResolvedValueOnce(null);
    await expect(resolveMembership(db, "user")).rejects.toBeInstanceOf(IsolationError);
    expect(prisma.member.findFirst).toHaveBeenCalledTimes(3);
    expect(prisma.deploymentSettings.findUnique).toHaveBeenCalledTimes(2);
  });
});
