# Building CrabMeat

This document describes the build procedure that produces the `dist/`
tree shipped in a release. Following it on a clean machine should yield
byte-identical output to a CI build of the same commit, modulo
filesystem timestamps embedded by the TypeScript compiler.

## Pinned environment

| Component | Version | Why pinned |
|---|---|---|
| Node.js | **22.x LTS** (any patch release) | The project uses Node 22 ESM with `NodeNext` module resolution. Older majors lack `import.meta.dirname` and the modern Web Fetch API used by `web_fetch`. Newer majors are not yet validated against the test matrix. |
| npm | **bundled with Node 22** (10.x) | npm patch releases occasionally change lockfile resolution. Using the npm that ships with the pinned Node version keeps `npm ci` deterministic. |
| TypeScript | **as pinned in `package.json`** | Compiler version is part of the build output. Don't run with a globally-installed `tsc`. |

The CI workflow at `.github/workflows/ci.yml` runs against
`actions/setup-node@v4` with `node-version: 22` on `ubuntu-latest`.
Local builds on the same Node major + same OS family produce equivalent
output.

## Reproducible build sequence

Run from the repo root (this folder when published, `crabmeat/` in the
internal workspace):

```bash
# 1. Verify Node version
node --version    # must report v22.x.x

# 2. Clean install: uses package-lock.json verbatim, refuses if drift
npm ci --ignore-scripts

# 3. Typecheck: should be silent
npm run typecheck

# 4. Test suite: should be all green, zero FINDING lines
npm test

# 5. Build
npm run build

# 6. Release-gate validator: exits non-zero on any release blocker
node dist/entry.js doctor --strict --config crabmeat.example.json
```

The `--ignore-scripts` flag on `npm ci` is intentional: it proves the
project does not require any postinstall network hop or native build
step to function. CI runs with the same flag.

This differs from the cold-install runbook (`.red_team/COLD_VM_TEST.md`),
which uses a plain `npm install`, and that difference is deliberate.
`--ignore-scripts` skips Playwright's browser-binary postinstall, so a
build done this way leaves the `browser` tool non-functional until
`npx playwright install chromium` is run. Use plain `npm install` to
*run* CrabMeat with every tool working; use `npm ci --ignore-scripts`
to *verify* a reproducible build.

## What "reproducible" means here

Same Node 22 major + same OS family + same git commit + clean
`node_modules/` produces a `dist/` tree that:

- Has identical file count and identical relative paths
- Has identical file *contents* for every `.js` file the TypeScript
  compiler emits
- Has identical `.d.ts` declaration content
- May differ in source-map `sourcesContent` paths if the absolute build
  directory differs (build at the same path to eliminate this)
- Differs in mtime / ctime (filesystem metadata is not part of the
  artifact)

CrabMeat does not currently ship signed binaries or build attestations.
The reproducible build procedure is what stands in for a signature: any
operator who can re-run the procedure on the tagged commit can verify
that the published `dist/` matches what's in source.

## Verifying a published release

```bash
# Fetch a tagged commit
git clone --branch v0.1.0 --depth 1 https://github.com/mr-gl00m/crabmeat.git
cd crabmeat

# Run the build
node --version    # v22.x.x
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build

# Compare
diff -r dist/ /path/to/published/dist/
```

A clean `diff -r` (modulo source-map absolute paths if your clone is at
a different filesystem location) means your local build matches the
published build.

## Known non-reproducibility sources

These exist and are not currently considered ship blockers; call them
out if you start tracking build attestations:

- **Source-map `sources` paths** are absolute. A build at
  `/home/alice/crabmeat` and a build at `C:\Users\bob\crabmeat` will
  produce different `.js.map` files. The runtime behavior is identical.
- **TypeScript compiler version drift** between minor releases sometimes
  changes emitted helper code (e.g. `__esDecorate`). Pinning the
  compiler in `package.json` covers this; updating the compiler will
  change the output even on the same source.
- **npm 10 vs npm 11** can reorder transitively-installed packages
  inside `node_modules/` even with a clean `package-lock.json`. The
  build output is unaffected because `npm run build` only consumes
  packages by name, but `node_modules/` itself isn't reproducible
  across npm major versions.

## Why no signed binaries (yet)

Code-signing is a v0.2 ask, not v0.1. The reproducible-build procedure
above lets a sufficiently motivated operator verify the published
artifact themselves. For most consumers, "I cloned the repo and built
it" is the trust story; for the rest, this document is the recipe.
