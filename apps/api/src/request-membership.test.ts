import { RPCHandler } from "@orpc/server/fetch";
import type { MembershipContext, PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const membership: MembershipContext = {
  actor: {
    userId: "user",
    workspaceId: "workspace",
    email: "user@example.test",
    isDeploymentOwner: true,
  },
  user: { email: "user@example.test", name: "User", avatarStyle: "organic" },
  settings: {
    ownerUserId: "user",
    deploymentModelCredentialCipher: "fake-cipher",
    defaultModelProvider: "fake",
    defaultModelId: "model",
    computerHost: "this-mac",
  },
};
function fixture() {
  const prisma = {
    user: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ ...membership.user, avatarStyle: "robot" }),
      update: vi.fn().mockResolvedValue({}),
    },
    deploymentSettings: { findUnique: vi.fn().mockResolvedValue(membership.settings) },
    userModelCredential: { findFirst: vi.fn().mockResolvedValue(null) },
    bot: { findMany: vi.fn().mockResolvedValue([]) },
    botSection: { findMany: vi.fn().mockResolvedValue([]) },
    chatGroup: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    dataDir: "/tmp/rakazo-auth-test",
    env: { defaultProvider: "fake", defaultModel: "model", sandboxProvider: "docker" },
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function request(
    path: string,
    input: unknown,
    snapshot: MembershipContext | undefined = membership,
  ) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: membership.actor, membership: snapshot } },
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { json: Record<string, unknown> }).json;
  }
  return { prisma, request };
}

describe("request-scoped me reads", () => {
  for (const path of ["me", "bootstrap"])
    it(`reuses authentication reads for ${path}`, async () => {
      const { prisma, request } = fixture();
      const result = await request(path, path === "me" ? null : {});
      const me = path === "me" ? result : result.me;
      expect(me).toMatchObject({
        avatarStyle: "organic",
        name: "User",
        email: "user@example.test",
        needsModel: false,
        computerHost: "this-mac",
        defaultProvider: "fake",
        defaultModel: "model",
      });
      expect(prisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(prisma.deploymentSettings.findUnique).not.toHaveBeenCalled();
      expect(prisma.userModelCredential.findFirst).toHaveBeenCalledTimes(1);
    });

  it("rereads mutable profile state after a preference update", async () => {
    const { prisma, request } = fixture();
    const result = await request("preferences/update", { avatarStyle: "robot" });
    expect(result.avatarStyle).toBe("robot");
    expect(prisma.user.update).toHaveBeenCalledOnce();
    expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledOnce();
    expect(prisma.deploymentSettings.findUnique).toHaveBeenCalledOnce();
  });

  it("handles absent deployment settings without a redundant read", async () => {
    const { prisma, request } = fixture();
    const result = await request("me", null, { ...membership, settings: null });
    expect(result).toMatchObject({ needsModel: true, computerHost: null });
    expect(prisma.deploymentSettings.findUnique).not.toHaveBeenCalled();
  });
});
