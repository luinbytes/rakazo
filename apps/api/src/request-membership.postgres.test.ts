import { randomUUID } from "node:crypto";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { createDb, type PrismaClient, resolveMembership } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("membership/me reads (PostgreSQL)", () => {
  const id = `auth-${randomUUID()}`;
  const created = createDb(process.env.DATABASE_URL ?? "postgres://unused");
  let operations = 0;
  let resultBytes = 0;
  const prisma = created.prisma.$extends({
    query: {
      async $allOperations({ args, query }) {
        operations++;
        const result = await query(args);
        resultBytes += Buffer.byteLength(JSON.stringify(result) ?? "");
        return result;
      },
    },
  }) as unknown as PrismaClient;
  const deps = {
    prisma,
    dataDir: "/tmp/rakazo-auth-test",
    env: { defaultProvider: "fake", defaultModel: "model", sandboxProvider: "fake" },
  } as unknown as RouterDeps;
  beforeAll(async () => {
    await prisma.user.create({
      data: { id, email: `${id}@example.test`, name: "Auth fixture", avatarStyle: "organic" },
    });
    await prisma.organization.create({
      data: {
        id,
        name: "Auth fixture",
        slug: id,
        createdAt: new Date(),
        metadata: "fixture ".repeat(1000),
        members: { create: { id, userId: id, role: "owner", createdAt: new Date() } },
      },
    });
  });
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { id } });
    await prisma.$disconnect();
    await created.pool.end();
  });

  it("matches the original me response and avoids duplicate user/settings reads", async () => {
    let baseline: unknown;
    let baselineOperations: number | undefined;
    let baselineBytes: number | undefined;
    let baselineMs: number | undefined;
    if (process.env.AUTH_BASELINE === "1") {
      const scopeUrl = new URL("../../../packages/db/src/.baseline-scope.ts", import.meta.url).href;
      const routerUrl = new URL("./.baseline-router.ts", import.meta.url).href;
      const oldScope = (await import(scopeUrl)) as {
        requireMembership: (db: PrismaClient, userId: string) => Promise<Actor>;
      };
      const oldRouter = (await import(routerUrl)) as { createRouter: typeof createRouter };
      const handler = new RPCHandler(oldRouter.createRouter(deps));
      operations = 0;
      resultBytes = 0;
      const start = performance.now();
      const actor = await oldScope.requireMembership(prisma, id);
      const { response } = await handler.handle(request(), { prefix: "/rpc", context: { actor } });
      expect(response.status).toBe(200);
      baseline = await response.json();
      baselineMs = performance.now() - start;
      baselineOperations = operations;
      baselineBytes = resultBytes;
    }
    const handler = new RPCHandler(createRouter(deps));
    operations = 0;
    resultBytes = 0;
    const start = performance.now();
    const membership = await resolveMembership(prisma, id);
    const { response } = await handler.handle(request(), {
      prefix: "/rpc",
      context: { actor: membership.actor, membership },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    const elapsedMs = performance.now() - start;
    expect(body).toMatchObject({
      json: {
        name: "Auth fixture",
        avatarStyle: "organic",
        email: `${id}@example.test`,
        workspaceId: id,
      },
    });
    expect(operations).toBe(3);
    if (baseline) expect(body).toEqual(baseline);
    console.info(
      JSON.stringify({
        baselineOperations,
        baselineBytes,
        baselineMs,
        operations,
        resultBytes,
        elapsedMs,
      }),
    );
  });

  it("refreshes profile state and rejects revoked membership on the next request", async () => {
    await prisma.user.update({ where: { id }, data: { name: "Updated fixture" } });
    expect((await resolveMembership(prisma, id)).user.name).toBe("Updated fixture");
    await prisma.member.delete({ where: { id } });
    await expect(resolveMembership(prisma, id)).rejects.toThrow("No personal workspace");
  });
});
function request() {
  return new Request("http://127.0.0.1/rpc/me", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: null }),
  });
}
