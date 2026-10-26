# Lightweight client contract imports

Compared with shared prerequisite #16 (`7f95a6e57becf7b0e0496dfa52afc5973e5ee87d`), whose web source is unchanged from main `14bc82178b593f3575bbc023a441b9de4cd85e66`, using Node 24.19.0, the same installed dependency tree, production Vite configuration, and identical measurement code:

| Measure | Prerequisite #16 | This change | Reduction |
| --- | ---: | ---: | ---: |
| Main JS entry bytes | 805,975 | 704,783 | 101,192 (12.6%) |
| Main JS gzip bytes | 244,226 | 217,722 | 26,504 (10.9%) |
| Total emitted JS bytes | 1,484,188 | 1,382,996 | 101,192 |
| Zod modules in emitted chunks | 17 | 0 | 17 |

The new `@rakazo/contracts/client` export contains existing constants and pure helpers. Runtime imports used by web/desktop, mobile, and shared client helpers now use that export. Existing root exports remain compatible, with the same helper objects and constant values. Server runtime schemas still import their shared limits and validate inputs as before. The client entry's only reference to schema-derived types is erased at build time.

## Reproduce

After `pnpm install --frozen-lockfile`:

```sh
pnpm exec tsx apps/web/tools/measure-client-bundle.ts /tmp/client-bundle.json
pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/web --filter @rakazo/mobile test
pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/web --filter @rakazo/mobile check
pnpm lint
```

Copy the measurement script into an otherwise unchanged baseline checkout and run the same command with the same dependencies to obtain the comparison. The script invokes the normal Vite production build and measures final emitted JavaScript and gzip output in `writeBundle`, after Vite rewrites its import/asset references; it also inspects emitted chunk module graphs for Zod. Keep generated `dist` files out of commits.

The compatibility tests compare every lightweight export with the existing root export, verify normalization and schema limits, and import the client entry in a fresh process whose module resolver rejects Zod/oRPC. Existing runtime-schema tests still run. This change removes schema initialization from client bundles, not runtime server validation.

The build still emits the existing large-chunk warning. Bundle savings do not predict exact device startup time. Native Metro output has not been measured separately.
