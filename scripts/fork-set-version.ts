#!/usr/bin/env bun
/**
 * Set the version compiled binaries report (`omp --version`, startup update
 * check) to a fork version like `17.2.15-fork.2`.
 *
 * Used by .github/workflows/fork-release.yml at build time, AFTER
 * `bun install` and before `ci:release:build-binaries`; the change is never
 * committed.
 *
 * Only `packages/utils/package.json` is touched — that is where
 * `@oh-my-pi/pi-utils` reads `VERSION` from at bundle time. Deliberately NOT
 * touched: `packages/natives/package.json`. The native loader derives its
 * version-sentinel symbol (`__piNativesV17_2_15`) from that manifest and
 * validates it against the `.node` addon, and fork builds embed the addons
 * published by the UPSTREAM base release — bumping the natives version would
 * make every compiled binary fail addon loading at runtime.
 */
import * as path from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+-fork\.\d+$/.test(version)) {
	console.error("usage: bun scripts/fork-set-version.ts <X.Y.Z-fork.N>");
	process.exit(1);
}

const manifestPath = path.join(import.meta.dir, "..", "packages", "utils", "package.json");
const raw = await Bun.file(manifestPath).text();
const updated = raw.replace(/"version": "[^"]+"/, `"version": "${version}"`);
if (updated === raw) {
	console.error(`No version field replaced in ${manifestPath}`);
	process.exit(1);
}
await Bun.write(manifestPath, updated);

const check = (await Bun.file(manifestPath).json()) as { version?: string };
if (check.version !== version) {
	console.error(`Version verification failed: expected ${version}, found ${check.version}`);
	process.exit(1);
}
console.log(`packages/utils/package.json version -> ${version}`);
