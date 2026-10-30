# Release

## Canonical source and version

Maintain the plugin in the
[`wn0x00/dsh-a2a`](https://github.com/wn0x00/dsh-a2a) repository on GitHub.
`package.json`, the lockfile's root package and `manifest.json` must have the
same version. Use Node 22.19+ and a DSH host in the package's declared range.
The package is public and distributed through the npm registry as
`@guanzhu.me/dsh-a2a`; there is no `private` flag and no other release channel.

```sh
npm ci
npm test
npm run pack:release
```

`npm test` compiles the host, bundles the settings client and runs the Node test
suite. `pack:release` rebuilds through npm's `prepack` hook and writes these
files to `<package-root>/release/`:

- `guanzhu.me-dsh-a2a-<version>.tgz`
- `release-manifest.json` with package, version, filename, size, SHA-256 and time
- `README.md` with installation and operating instructions

The staged archive is a local convenience for manual installation and
verification; the registry tarball published by CI is the canonical artifact.
Build inputs are the pinned source, lockfile and Node version. No platform
origin is a build input — the published package contains no default platform
address. Verify any archive against its recorded size and SHA-256 (local
staging) or the npm `dist.integrity` (registry) before distributing.

A failed package build leaves the previous staged release intact. Successful
staging replaces the manifest and removes only this package's previous archive
recorded in it; unrelated tarballs are preserved. The output directory is
generated material, not the canonical source repository. `XBOT_RELEASE_DIR`
chooses an output directory; relative values are resolved from the package
root, not the caller's current directory.

## npm publication with OIDC trusted publishing

Publication runs only in GitHub Actions (`.github/workflows/publish.yml`) when
a GitHub Release is published whose tag is `v<version>` matching
`package.json`. The job runs the full test suite, then publishes with an
OIDC-issued short-lived credential; provenance is attached automatically
(`publishConfig.provenance` is set). No `NPM_TOKEN` or any other long-lived
npm credential exists in the repository or its secrets.

One-time setup, because npm can only attach a trusted publisher to a package
that already exists:

1. Publish the first version by hand from a maintainer machine logged in with
   publish rights to the `@guanzhu.me` organization:
   ```sh
   npm login
   npm publish --access public
   ```
2. On npmjs.com, open the package settings → **Trusted Publisher** and add the
   GitHub Actions publisher:
   - Organization or user: `wn0x00`
   - Repository: `dsh-a2a`
   - Workflow filename: `publish.yml`
   - Environment name: leave empty (unless a `release` environment is added
     later; then set it in both places)
   - Allowed actions: allow `npm publish`
3. After that, every release is: bump `package.json` + `manifest.json`
   versions, merge, create a GitHub Release tagged `v<version>`. The workflow
   refuses tags that do not match `package.json`.

Trusted publishing requires GitHub-hosted runners (self-hosted runners cannot
mint the OIDC token npm accepts) and npm CLI ≥ 11.5.1; the workflow upgrades
npm explicitly before publishing.

## Continuous integration

`.github/workflows/ci.yml` runs `npm ci`, `npm test` and
`npm run pack:release` on pushes to `main` and on pull requests. It requires no
platform database, service containers, deployment secrets or host mounts. It
verifies a release but does not publish or deploy. Use its status as the merge
gate.
