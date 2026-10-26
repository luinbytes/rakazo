import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import * as client from "./client.js";
import * as contracts from "./index.js";

describe("lightweight client exports", () => {
  it("keeps every client export identical through the existing root entry point", () => {
    for (const [name, value] of Object.entries(client)) {
      // biome-ignore lint/performance/noDynamicNamespaceImportAccess: test all compatibility re-exports
      expect(contracts[name as keyof typeof contracts], name).toBe(value);
    }
  });

  it("imports in a fresh process without loading runtime schema dependencies", () => {
    execFileSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      import { registerHooks } from "node:module";
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === "zod" || specifier.startsWith("zod/") || specifier.startsWith("@orpc/")) {
          throw new Error("Lightweight client entry loaded " + specifier);
        }
        return next(specifier, context);
      }});
      await import(${JSON.stringify(new URL("./client.ts", import.meta.url).href)});
    `,
    ]);
  });

  it("retains profile limits and Unicode/whitespace normalization", () => {
    expect(
      client.normalizeCreateBotProfile({
        name: `  ${"猫".repeat(90)}  `,
        title: ` ${"a".repeat(510)} `,
        description: ` ${"d".repeat(4100)} `,
      }),
    ).toEqual({
      name: "猫".repeat(80),
      title: "a".repeat(500),
      description: "d".repeat(4000),
      instructions: "d".repeat(20000).slice(0, 4100),
    });
    expect(contracts.CreateBotInput.safeParse({ name: "a".repeat(81) }).success).toBe(false);
    expect(contracts.CreateBotInput.safeParse({ name: "Valid" }).success).toBe(true);
    expect(contracts.CreateGroupInput.safeParse({ name: "Team", botIds: ["a"] }).success).toBe(
      false,
    );
  });

  it("keeps runtime model validation for the shared provider ID", () => {
    expect(
      contracts.ModelConnectInputSchema.safeParse({
        provider: client.OPENAI_COMPATIBLE_PROVIDER_ID,
        apiKey: "fake",
      }).success,
    ).toBe(false);
    expect(
      contracts.ModelConnectInputSchema.safeParse({
        provider: client.OPENAI_COMPATIBLE_PROVIDER_ID,
        baseUrl: "http://127.0.0.1:11434",
        modelId: "fake-model",
      }).success,
    ).toBe(true);
  });
});
