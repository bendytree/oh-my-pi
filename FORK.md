# bendytree/oh-my-pi — personal fork

Personal fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) that
stays current with upstream automatically while carrying local patches.

## How it works

- `main` = latest upstream **stable tag** + fork patches.
- `.github/workflows/fork-release.yml` runs nightly (and on every push to
  `main`): it merges the newest upstream `vX.Y.Z` tag into `main`, builds
  binaries for **darwin-arm64** and **linux-x64**, and publishes a GitHub
  release tagged `vX.Y.Z-fork.N` (`X.Y.Z` = upstream base, `N` = build counter
  on that base).
- Fork builds report `X.Y.Z-fork.N` from `omp --version`; the startup update
  notice and `omp update` resolve the latest version from **this repo's**
  GitHub releases (see `packages/coding-agent/src/cli/fork.ts`), so
  `omp update` always installs "latest upstream + my patches".
- Installs must be the standalone binary (a regular file on PATH, e.g.
  `~/.local/bin/omp`), which `omp update` replaces in place. bun/npm/brew/mise
  installs are not supported by the fork.

## Constraints

- **TypeScript patches only.** Native addons are not built from source; the
  release workflow downloads the `.node` addons published by the upstream base
  release on npm (`@oh-my-pi/pi-natives-<platform>`). A patch to `crates/`
  would silently not ship. (If ever needed: port upstream's bazel natives
  pipeline into the fork workflow.)
- `packages/natives/package.json` must keep the upstream base version — the
  addon loader validates a version-sentinel symbol derived from it against the
  upstream-built `.node`. `scripts/fork-set-version.ts` therefore bumps only
  `packages/utils/package.json` (the `VERSION` source).
- Upstream's `ci.yml` targets self-hosted runners and is disabled in this
  fork; fork builds are smoke-tested (`--version`, `--smoke-test`) but do not
  run the upstream test suite.

## When the nightly merge conflicts

The sync job fails with the conflicting tag named in the log. Resolve locally:

```sh
git fetch upstream && git merge vX.Y.Z   # fix conflicts
git push origin main                      # push retriggers the release
```

## Adding a patch

Commit to `main` (or PR into it) and push. The workflow builds and releases
`-fork.N+1`; every machine sees the update on next launch.
