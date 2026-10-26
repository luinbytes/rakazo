import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { teamBotWorkspaceDirectory } from "./computer-support.js";
import { LocalAgentHomeStore } from "./home.js";
import { writePortableFile } from "./portable-workspace-file.js";

export const PORTABLE_BROWSER_STOP_COMMAND =
  "pkill -f '[g]oogle-chrome|[c]hromium|[f]irefox' || true";
export const PORTABLE_TRANSFER_BATCH_BYTES = 8 * 1024 * 1024;

const skippedBrowserProfileDirectories = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Crashpad",
]);
const skippedBrowserProfileFiles = new Set([
  "BrowserMetrics",
  "DevToolsActivePort",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  ".parentlock",
  "lock",
]);

/** Excludes transient browser state that is unsafe or wasteful to restore. */
export function shouldSkipPortableWorkspaceFile(relative: string) {
  if (!relative.startsWith(".browser-profiles/")) return false;
  const segments = relative.split("/");
  const name = segments.at(-1) ?? "";
  return (
    segments.some((segment) => skippedBrowserProfileDirectories.has(segment)) ||
    skippedBrowserProfileFiles.has(name)
  );
}

export async function restoreComputerWorkspace(
  home: AgentHomeStore,
  sandbox: SandboxProvider,
  homeKey: string,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<void> {
  if (computer.kind === "docker" && home instanceof LocalAgentHomeStore) return;
  await sandbox.importWorkspace(computer, home.exportHome(homeKey, context), context);
}

export async function ensureComputerWorkspaceLayout(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  scope: ComputerMode,
  botId: string | undefined,
  context: AdapterContext,
): Promise<void> {
  if (scope !== "team" || !botId) return;
  let exitCode: number | undefined;
  let stderr = "";
  for await (const event of sandbox.execute(
    computer,
    { argv: ["mkdir", "-p", "shared", teamBotWorkspaceDirectory(botId)] },
    context,
  )) {
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") exitCode = event.code;
  }
  if (exitCode !== 0) {
    throw new Error(`Could not prepare Team Computer folders${stderr ? `: ${stderr.trim()}` : ""}`);
  }
}

export async function checkpointComputerWorkspace(
  home: AgentHomeStore,
  sandbox: SandboxProvider,
  homeKey: string,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<string> {
  if (computer.kind === "docker" && home instanceof LocalAgentHomeStore) {
    return home.revise(homeKey);
  }
  if (home instanceof LocalAgentHomeStore) {
    return home.commitPortableFiles(homeKey, sandbox.exportWorkspace(computer, context), context);
  }
  const staging = await mkdtemp(path.join(tmpdir(), "rakazo-workspace-"));
  try {
    for await (const file of sandbox.exportWorkspace(computer, context)) {
      await writePortableFile(staging, file);
    }
    return await home.commit(homeKey, staging, context);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function checkpointAndRecordComputerWorkspace(
  deps: { home: AgentHomeStore; sandbox: SandboxProvider; prisma: PrismaClient },
  computerRecord: { id: string; homeKey: string },
  computer: ComputerRef,
  context: AdapterContext,
): Promise<string> {
  const revision = await checkpointComputerWorkspace(
    deps.home,
    deps.sandbox,
    computerRecord.homeKey,
    computer,
    context,
  );
  await deps.prisma.computer.updateMany({
    where: { id: computerRecord.id },
    data: { homeRevision: revision },
  });
  return revision;
}
