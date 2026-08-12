/**
 * Fork distribution configuration.
 *
 * This build of omp is distributed as binary GitHub Releases from a fork that
 * tracks upstream (can1357/oh-my-pi) nightly: the fork's release workflow
 * merges the latest upstream stable tag into `main`, reapplies the fork's
 * patches, and publishes `vX.Y.Z-fork.N` releases (X.Y.Z = upstream base tag,
 * N = fork build counter on that base).
 *
 * Both the startup update notice and `omp update` resolve the latest version
 * from the fork's GitHub Releases instead of the npm registry, so `omp update`
 * always lands on "latest upstream + fork patches".
 */
import { $env } from "@oh-my-pi/pi-utils";
import { withTimeoutSignal } from "../utils/fetch-timeout";

/** GitHub repository the fork's binary releases are published to. */
export const FORK_REPO = "bendytree/oh-my-pi";

/**
 * Latest fork release version (tag without the leading `v`), resolved from
 * the fork's GitHub Releases. Throws on network failure, rate limiting, or a
 * malformed response; callers decide whether that is fatal.
 */
export async function fetchLatestForkVersion(timeoutMs: number): Promise<string> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const token = $env.GITHUB_TOKEN || $env.GH_TOKEN;
	if (token) headers.Authorization = `Bearer ${token}`;

	const response = await fetch(`https://api.github.com/repos/${FORK_REPO}/releases/latest`, {
		headers,
		signal: withTimeoutSignal(timeoutMs),
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch fork release info: ${response.status} ${response.statusText}`);
	}
	const data: unknown = await response.json();
	const tag = (data as { tag_name?: unknown } | null)?.tag_name;
	if (typeof tag !== "string" || !/^v\d/.test(tag)) {
		throw new Error("Malformed GitHub release response: missing tag_name");
	}
	return tag.slice(1);
}
