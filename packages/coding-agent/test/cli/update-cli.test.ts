import { afterEach, describe, expect, it, vi } from "bun:test";
import { getLatestRelease, runUpdateCommand } from "../../src/cli/update-cli";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ tag_name: "v999.0.0-fork.1" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await runUpdateCommand({ force: false, check: true });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});

// Fork note: upstream's npm rename-pointer tests do not apply here — this
// fork's getLatestRelease resolves the latest fork tag from GitHub Releases
// (see src/cli/fork.ts) and never consults the npm registry.
describe("getLatestRelease fork releases", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function stubGithubRelease(body: unknown): string[] {
		const urls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				urls.push(String(input));
				return Response.json(body);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return urls;
	}

	it("resolves the fork tag from GitHub Releases as a binary-only release", async () => {
		const urls = stubGithubRelease({ tag_name: "v999.1.0-fork.3" });

		const release = await getLatestRelease();

		expect(release.version).toBe("999.1.0-fork.3");
		expect(release.tag).toBe("v999.1.0-fork.3");
		expect(release.dist).toBe("binary");
		expect(urls).toEqual(["https://api.github.com/repos/bendytree/oh-my-pi/releases/latest"]);
	});

	it("rejects a release response with no usable tag_name", async () => {
		stubGithubRelease({ name: "omp v999.1.0" });

		await expect(getLatestRelease()).rejects.toThrow("Malformed GitHub release response: missing tag_name");
	});
});

describe("getLatestRelease proxy errors", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("translates Bun's UnsupportedProxyProtocol fetch failure into an actionable CLI message", async () => {
		const fetchStub = Object.assign(
			async () => {
				throw new Error(
					'UnsupportedProxyProtocol fetching "https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest". ' +
						"For more information, pass `verbose: true` in the second argument to fetch()",
				);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const err = await getLatestRelease({ timeoutMs: 5000 }).then(
			() => null,
			(e: unknown) => e as Error,
		);

		expect(err).toBeInstanceOf(Error);
		// The raw fetch() instruction the CLI user cannot act on must not leak through.
		expect(err?.message).not.toContain("verbose: true");
		expect(err?.message).not.toContain("fetch()");
		// Instead the user gets actionable guidance about supported proxy schemes.
		expect(err?.message).toMatch(/SOCKS/i);
		expect(err?.message).toMatch(/https?:\/\//i);
	});
});
