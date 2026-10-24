# Release and platform synchronization

## Canonical source and version

Maintain the plugin in the private
[`xbot/deepseek-harness-a2a`](https://gitea.guanzhu.me/xbot/deepseek-harness-a2a)
repository. `package.json`, the lockfile's root package and `manifest.json` must
have the same version. Use Node 22.19+ and a DSH host in the package's declared
range. The package is distributed as a `.tgz`; `private: true` prevents accidental
publication to a public npm registry.

```sh
npm ci
npm test
npm run pack:release
```

`npm test` compiles the host, bundles the settings client and runs the Node test
suite. `pack:release` rebuilds through npm's `prepack` hook and writes these files
to `<package-root>/release/`:

- `xbot-deepseek-harness-a2a-<version>.tgz`
- `release-manifest.json` with package, version, filename, size, SHA-256 and time
- `README.md` with installation and operating instructions

The archive contains the declared package files and runtime dependencies are
resolved by the installer. Build inputs are the pinned source, lockfile, Node
version and gateway origin; the release manifest's generation time is not a
reproducible build identifier. Verify the actual archive against its recorded
size and SHA-256 before distributing or replacing a vendored release.

Set `XBOT_DEFAULT_GATEWAY_URL=https://agent.guanzhu.me` when building the hosted
platform download. The default remains `http://127.0.0.1:8000` for local source
builds. `XBOT_RELEASE_DIR` chooses an output directory; relative values are
resolved from the package root, not the caller's current directory. For example,
from a source checkout adjacent to a platform checkout:

```sh
XBOT_DEFAULT_GATEWAY_URL=https://agent.guanzhu.me \
XBOT_RELEASE_DIR=../xbot-market-agents/frontend/public/downloads/deepseek-harness-a2a \
  npm run pack:release
```

A failed package build leaves the previous staged release intact. Successful
staging replaces the manifest and removes only this package's previous archive
recorded in it; unrelated tarballs are preserved. The output directory is
generated material, not the canonical source repository.

## Gitea Generic package publication

The current standalone distribution is the private `xbot` Generic package
`deepseek-harness-a2a`. Build with
`XBOT_DEFAULT_GATEWAY_URL=https://agent.guanzhu.me npm run pack:release`, then
publish the exact verified tarball and `release-manifest.json` under the package
version. Upload the manifest last, after the archive is available:

```text
PUT /api/packages/xbot/generic/deepseek-harness-a2a/<version>/<filename>.tgz
PUT /api/packages/xbot/generic/deepseek-harness-a2a/<version>/release-manifest.json
```

Authenticate with a publication credential that can write packages. Do not put
credentials in Git, command arguments, release files or logs. Link the package
to the `deepseek-harness-a2a` repository; preserve private organization visibility.
Gitea package files are immutable: use a new version for a replacement. Download
both published files with authentication and verify their size, hash, package
version and intended gateway before reporting a release complete.

End users create a separate token with only `read:package` for the plugin's
in-app update feature. The updater lists exact matching Generic versions and
reads the chosen version's manifest and tarball. No platform deployment or
platform pipeline is required for this publication. Platform synchronization is
a separate, explicit rollout using the procedure below.

## Pinned platform snapshot

The platform needs both the source snapshot under
`integrations/deepseek-harness-a2a/` and its release artifacts. Its backend serves
a source ZIP, Docker builds package the plugin, and its download UI serves the
versioned tarball and manifest. Do not replace the source snapshot with only a
tarball, and do not maintain a second editable implementation there.

For each platform update:

1. Merge the plugin change after its tests pass, then select the full immutable
   source commit SHA. Do not synchronize an uncommitted working tree.
2. Export tracked files from that commit with `git archive <full-sha>`. Replace
   the platform vendor directory with that export, excluding only any
   explicitly documented platform-owned provenance file. Do not copy
   `node_modules/`, `dist/`, local environment files or `release/`.
3. Record the canonical repository URL, complete source commit SHA, source Git
   tree SHA and package version with the platform snapshot. Verify version
   agreement and compare the exported tree before accepting the update. A
   branch name or version string alone is not a source pin.
4. Run the plugin tests from the vendor snapshot and build the platform's
   artifact with the intended gateway origin. Set
   `XBOT_RELEASE_DIR=../../frontend/public/downloads/deepseek-harness-a2a`
   explicitly for builds executed from the vendor package root.
5. Review the source pin, vendored changes and release manifest together in the
   platform PR, then use the platform's existing CI and deployment path.

The platform implements this procedure in `scripts/sync_dsh_plugin.py`:

```sh
python scripts/sync_dsh_plugin.py sync \
  --source ../deepseek-harness-a2a --commit <full-source-commit-sha>
python scripts/sync_dsh_plugin.py check
```

Run those commands from the platform root. The provenance record lives outside
the exported directory at `integrations/deepseek-harness-a2a.snapshot.json`.
The offline check verifies the pinned source commit and Git tree against the
vendored snapshot; it does not follow a remote branch during CI.

The source pin identifies the code; the manifest checksum identifies the exact
archive offered to users. A later plugin merge does not silently change an
already pinned platform build. Make fixes in this repository and synchronize a
new reviewed commit/version instead of patching the platform copy.

## Continuous integration

`.woodpecker/verify.yml` defines an independent verification workflow for pull
requests, pushes to `main` and tags. It selects a `type: ci` worker and runs
`npm ci`, `npm test` and `npm run pack:release` in Node 22. It requires no platform
database, service containers, deployment secrets or host mounts. It verifies a
release but does not publish to npm or deploy the platform.

The workflow file does not activate the repository in Woodpecker. A repository
administrator must use **New repository** to activate the private Gitea source
repository and enable pull-request events; Woodpecker then creates the forge
webhook. Keep the default `.woodpecker/` config discovery and private visibility.
After the first real run, use its reported verification status as the source
repository's merge gate. Until that activation and successful run, report local
verification as local verification. The platform's vendor verification remains
part of the platform gate independently.

Validate the workflow locally with `woodpecker-cli lint .woodpecker/verify.yml`,
then run the same npm commands above. The service-side activation and worker
availability must be verified separately. See the official Woodpecker
[repository activation](https://woodpecker-ci.org/docs/3.17/usage/intro) and
[project settings](https://woodpecker-ci.org/docs/3.17/usage/project-settings)
documentation for those controls.
