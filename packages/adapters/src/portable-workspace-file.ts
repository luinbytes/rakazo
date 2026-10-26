import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PortableFile } from "@rakazo/adapter-kit";
import { normalizeWorkspacePath } from "./computer-support.js";

export async function writePortableFile(root: string, file: PortableFile) {
  const relative = normalizeWorkspacePath(file.path);
  if (!relative) throw new Error("Workspace snapshots cannot contain an empty file path");
  const target = path.resolve(root, relative);
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Workspace snapshot path escapes its staging directory");
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, file.content, { mode: file.executable ? 0o700 : 0o600 });
}
