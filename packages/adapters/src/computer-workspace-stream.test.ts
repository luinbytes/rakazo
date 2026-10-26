import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentHomeStore,
  ComputerRef,
  PortableFile,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkpointComputerWorkspace } from "./computer-workspace.js";
import { LocalAgentHomeStore } from "./home.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: vi.fn(fs.rename),
    readFile: vi.fn(fs.readFile),
    writeFile: vi.fn(fs.writeFile),
  };
});
const context = {
  operationId: "test",
  traceId: "test",
  workspaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};
const computer: ComputerRef = { kind: "fake", id: "computer", botId: "bot", providerRef: "fake" };
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(rename).mockRestore();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-checkpoint-"));
  roots.push(root);
  const home = new LocalAgentHomeStore(root);
  await home.writeFile("bot", "previous.txt", "durable", context);
  return { root, home };
}
async function* files(entries: PortableFile[]) {
  yield* entries;
}
function sandbox(exported: AsyncIterable<PortableFile>) {
  return { exportWorkspace: vi.fn(() => exported) } as unknown as SandboxProvider;
}
const file = (name: string, text = "new"): PortableFile => ({
  path: name,
  content: new TextEncoder().encode(text),
});

describe("atomic streamed checkpoints", () => {
  it("preserves the previous home and revision after a partial failed export", async () => {
    const { home, root } = await fixture();
    const revision = await home.revise("bot");
    const provider = sandbox(
      (async function* () {
        yield file("partial.txt");
        throw new Error("export failed");
      })(),
    );
    await expect(
      checkpointComputerWorkspace(home, provider, "bot", computer, context),
    ).rejects.toThrow("export failed");
    expect(await home.readFile("bot", "previous.txt", context)).toBe("durable");
    expect(await readdir(path.dirname(home.pathFor("bot")))).toEqual(["bot"]);
    expect(await readFile(path.join(root, "home-revisions/bot.txt"), "utf8")).toBe(revision);
  });

  it("rejects traversal without replacing the old home", async () => {
    const { home } = await fixture();
    await expect(
      checkpointComputerWorkspace(
        home,
        sandbox(files([file("../../escape")])),
        "bot",
        computer,
        context,
      ),
    ).rejects.toThrow(/escapes/i);
    expect(await home.readFile("bot", "previous.txt", context)).toBe("durable");
  });

  it("rolls back a failed staging rename and removes temporary files", async () => {
    const { home } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(from).includes(".staging-")) throw new Error("rename failed");
      await actual.rename(from, to);
    });
    await expect(
      home.commitPortableFiles("bot", files([file("new.txt")]), context),
    ).rejects.toThrow("rename failed");
    expect(await home.readFile("bot", "previous.txt", context)).toBe("durable");
    expect(await readdir(path.dirname(home.pathFor("bot")))).toEqual(["bot"]);
  });

  it("recovers an interrupted previous commit before a failed export", async () => {
    const { home } = await fixture();
    await rename(home.pathFor("bot"), `${home.pathFor("bot")}.previous`);
    await expect(
      home.commitPortableFiles("bot", files([file("../escape")]), context),
    ).rejects.toThrow();
    expect(await home.readFile("bot", "previous.txt", context)).toBe("durable");
  });

  it("serializes writes behind export and leaves the write chain usable after failure", async () => {
    const { home } = await fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const exporting = home.commitPortableFiles(
      "bot",
      (async function* () {
        entered();
        await barrier;
        yield file("snapshot.txt");
      })(),
      context,
    );
    await started;
    let written = false;
    const writing = home.writeFile("bot", "later.txt", "later", context).then(() => {
      written = true;
    });
    await Promise.resolve();
    expect(written).toBe(false);
    release();
    await Promise.all([exporting, writing]);
    expect(await home.readFile("bot", "later.txt", context)).toBe("later");
    await expect(
      home.commitPortableFiles("bot", files([file("../escape")]), context),
    ).rejects.toThrow();
    await home.writeFile("bot", "later.txt", "after failure", context);
    expect(await home.readFile("bot", "later.txt", context)).toBe("after failure");
  });

  it("retains browser state, executable modes, removals and the Docker fast path", async () => {
    const { home } = await fixture();
    const provider = sandbox(
      files([
        file(".browser-profiles/default/Cookies", "session"),
        { ...file("bin/run"), executable: true },
      ]),
    );
    await checkpointComputerWorkspace(home, provider, "bot", computer, context);
    expect(await home.readFile("bot", ".browser-profiles/default/Cookies", context)).toBe(
      "session",
    );
    expect((await stat(path.join(home.pathFor("bot"), "bin/run"))).mode & 0o777).toBe(0o700);
    await expect(home.readFile("bot", "previous.txt", context)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const exportSpy = vi.mocked(provider.exportWorkspace);
    exportSpy.mockClear();
    await checkpointComputerWorkspace(
      home,
      provider,
      "bot",
      { ...computer, kind: "docker", id: "docker" },
      context,
    );
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it("halves snapshot writes and eliminates the local reread for a 32MiB remote export", async () => {
    const { home } = await fixture();
    const entries = Array.from({ length: 8 }, (_, index) => ({
      path: `data/${index}.bin`,
      content: new Uint8Array(4 * 1024 * 1024).fill(index),
    }));
    // A non-local contract wrapper exercises the unchanged generic staging/commit fallback.
    const generic = { commit: home.commit.bind(home) } as unknown as AgentHomeStore;
    vi.mocked(readFile).mockClear();
    vi.mocked(writeFile).mockClear();
    await checkpointComputerWorkspace(generic, sandbox(files(entries)), "bot", computer, context);
    const baselineReads = vi.mocked(readFile).mock.calls.length;
    const snapshotBytes = () =>
      vi
        .mocked(writeFile)
        .mock.calls.reduce(
          (sum, [, content]) => sum + (content instanceof Uint8Array ? content.byteLength : 0),
          0,
        );
    const baselineWrites = snapshotBytes();
    vi.mocked(readFile).mockClear();
    vi.mocked(writeFile).mockClear();
    await checkpointComputerWorkspace(home, sandbox(files(entries)), "bot", computer, context);
    expect(baselineReads).toBe(8);
    expect(readFile).not.toHaveBeenCalled();
    expect(baselineWrites).toBe(64 * 1024 * 1024);
    expect(snapshotBytes()).toBe(32 * 1024 * 1024);
    console.info(
      "checkpoint evidence: 32MiB export; snapshot writes 64MiB -> 32MiB; file rereads 8 -> 0",
    );
    expect((await stat(path.join(home.pathFor("bot"), "data/7.bin"))).size).toBe(4 * 1024 * 1024);
  });
});
