import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.argv[2];
if (!output) throw new Error("Pass the output JSON path");
process.env.NODE_ENV = "production";
process.chdir(root);
await build({
  root,
  configFile: `${root}vite.config.ts`,
  plugins: [
    {
      name: "measure-client-bundle",
      // Vite rewrites import/asset references late in generateBundle. Measure after emission.
      async writeBundle(_options, bundle) {
        const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
        const entries = chunks
          .filter((chunk) => chunk.isEntry)
          .map((chunk) => ({
            file: chunk.fileName,
            bytes: Buffer.byteLength(chunk.code),
            gzipBytes: gzipSync(chunk.code).byteLength,
          }));
        const zodModules = new Set(
          chunks.flatMap((chunk) =>
            Object.keys(chunk.modules).filter((id) => id.includes("/zod/")),
          ),
        );
        await writeFile(
          output,
          `${JSON.stringify(
            {
              entries,
              totalJavaScriptBytes: chunks.reduce(
                (sum, chunk) => sum + Buffer.byteLength(chunk.code),
                0,
              ),
              zodModuleCount: zodModules.size,
            },
            null,
            2,
          )}\n`,
        );
      },
    },
  ],
});
