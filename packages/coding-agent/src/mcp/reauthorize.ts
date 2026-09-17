import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import { clearCache as clearFsCache } from "../capability/fs";
import { expandEnvVarsDeep } from "../discovery/helpers";
import type { AgentSession } from "../session/agent-session";
import { connectToServer, disconnectServer } from "./client";
import { readMCPConfigFile, updateMCPServer } from "./config-writer";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	fetchResourceMetadataScopes,
	type OAuthEndpoints,
} from "./oauth-discovery";
import { lookupMcpOAuthCredentialForServer, removeManagedMcpOAuthCredential } from "./oauth-credentials";
import { MCPOAuthFlow, type MCPStoredOAuthCredential, mcpOAuthCredentialId } from "./oauth-flow";
import { MCPManager, type MCPLoadResult } from "./manager";
import type { MCPAuthChallenge, MCPAuthConfig, MCPServerConfig } from "./types";

const MCP_OAUTH_TIMEOUT_MS = 5 * 60_000;
export interface MCPAuthorizationResult {
	credentialId: string;
	clientId?: string;
	resource?: string;
}

export interface MCPAuthorizationRequest {
	authorizationUrl: string;
	tokenUrl: string;
	clientId: string;
	clientSecret: string;
	scopes: string;
	callbackPort?: number;
	callbackPath?: string;
	redirectUri?: string;
	prompt?: string;
	serverUrl?: string;
	registrationUrl?: string;
	issuerUrl?: string;
	resource?: string;
	stripSameOriginResource?: boolean;
}

export interface MCPAuthorizationHooks {
	onAuth(info: { url: string; launchUrl?: string; instructions?: string }): void;
	onProgress?(message: string): void;
	onManualCodeInput?(signal?: AbortSignal): Promise<string>;
	signal?: AbortSignal;
}

export class MCPOAuthCancelledError extends Error {
	constructor(message = "OAuth flow cancelled") {
		super(message);
		this.name = "MCPOAuthCancelledError";
	}
}

function mappedOAuthError(error: unknown): Error {
	if (error instanceof MCPOAuthCancelledError) return error;
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("timeout") || message.includes("timed out")) {
		return new Error("OAuth flow timed out. Please try again.");
	}
	if (message.includes("403") || message.includes("unauthorized")) {
		return new Error("OAuth authorization failed. Please check your client credentials.");
	}
	if (message.includes("invalid_grant")) {
		return new Error("OAuth authorization code is invalid or expired. Please try again.");
	}
	if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
		return new Error("Could not connect to OAuth server. Please check the URLs and your network connection.");
	}
	return new Error(`OAuth authentication failed: ${message}`);
}

/** Run one MCP OAuth grant with mode-specific presentation supplied by the caller. */
export async function authorizeMcp(
	request: MCPAuthorizationRequest,
	authStorage: AuthStorage,
	hooks: MCPAuthorizationHooks,
): Promise<MCPAuthorizationResult> {
	let parsedAuthorizationUrl: URL;
	try {
		parsedAuthorizationUrl = new URL(request.authorizationUrl);
		new URL(request.tokenUrl);
	} catch {
		throw new Error(
			`Invalid OAuth URLs. Please check:\n  Authorization URL: ${request.authorizationUrl}\n  Token URL: ${request.tokenUrl}`,
		);
	}

	const resolvedClientId =
		request.clientId.trim() || parsedAuthorizationUrl.searchParams.get("client_id")?.trim() || undefined;
	const resolvedClientSecret = request.clientSecret.trim() || undefined;
	const flowAbort = new AbortController();
	let timedOut = false;
	const abortFromCaller = (): void => {
		if (!flowAbort.signal.aborted) flowAbort.abort(hooks.signal?.reason ?? "MCP OAuth flow cancelled");
	};
	if (hooks.signal?.aborted) abortFromCaller();
	else hooks.signal?.addEventListener("abort", abortFromCaller, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		flowAbort.abort("MCP OAuth flow timed out");
	}, MCP_OAUTH_TIMEOUT_MS);

	try {
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: request.authorizationUrl,
				tokenUrl: request.tokenUrl,
				registrationUrl: request.registrationUrl,
				issuerUrl: request.issuerUrl,
				clientId: resolvedClientId,
				clientSecret: resolvedClientSecret,
				scopes: request.scopes || undefined,
				prompt: request.prompt,
				redirectUri: request.redirectUri,
				callbackPort: request.callbackPort,
				callbackPath: request.callbackPath,
				resource: request.resource,
				stripSameOriginResource: request.stripSameOriginResource,
			},
			{
				onAuth: hooks.onAuth,
				onProgress: hooks.onProgress,
				onManualCodeInput: hooks.onManualCodeInput,
				signal: flowAbort.signal,
			},
		);
		const cancelled = new Promise<never>((_resolve, reject) => {
			if (flowAbort.signal.aborted) {
				reject(new Error(String(flowAbort.signal.reason ?? "MCP OAuth flow aborted")));
				return;
			}
			flowAbort.signal.addEventListener(
				"abort",
				() => reject(new Error(String(flowAbort.signal.reason ?? "MCP OAuth flow aborted"))),
				{ once: true },
			);
		});
		const credentials = await Promise.race([flow.login(), cancelled]);
		const credentialId = request.serverUrl
			? mcpOAuthCredentialId(request.serverUrl)
			: `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
		const credential: MCPStoredOAuthCredential = {
			type: "oauth",
			...credentials,
			tokenUrl: request.tokenUrl,
			clientId: flow.resolvedClientId?.trim() || resolvedClientId,
			clientSecret: flow.registeredClientSecret ?? resolvedClientSecret,
			resource: flow.resource,
			authorizationUrl: flow.authorizationUrl,
		};
		await authStorage.set(credentialId, credential);
		return { credentialId, clientId: flow.resolvedClientId, resource: flow.resource };
	} catch (error) {
		if (hooks.signal?.aborted && !timedOut) throw new MCPOAuthCancelledError();
		throw mappedOAuthError(error);
	} finally {
		clearTimeout(timer);
		hooks.signal?.removeEventListener("abort", abortFromCaller);
	}
}

export function stripMcpOAuthAuth(config: MCPServerConfig): MCPServerConfig {
	const next = { ...config } as MCPServerConfig & { auth?: MCPAuthConfig };
	delete next.auth;
	return next;
}

export function persistMcpOAuthResult(
	config: MCPServerConfig,
	result: MCPAuthorizationResult,
	options: {
		tokenUrl: string;
		resource?: string;
		stripSameOriginResource?: boolean;
		clientId?: string;
		persistOAuthClientId?: boolean;
		userClientSecret?: string;
	},
): MCPServerConfig {
	const clientId = result.clientId?.trim() || options.clientId?.trim() || config.oauth?.clientId?.trim();
	const resource =
		result.resource ?? (options.stripSameOriginResource ? undefined : options.resource) ?? config.auth?.resource;
	return {
		...config,
		auth: {
			type: "oauth",
			credentialId: result.credentialId,
			tokenUrl: options.tokenUrl,
			clientId,
			clientSecret: options.userClientSecret,
			resource,
		},
		oauth: {
			...config.oauth,
			clientId: options.persistOAuthClientId === false ? undefined : clientId,
		},
	};
}

export interface ResolvedMcpServer {
	filePath: string;
	scope: "user" | "project";
	config: MCPServerConfig;
	discovered: boolean;
}

export async function findConfiguredMcpServer(cwd: string, name: string): Promise<ResolvedMcpServer | null> {
	const userPath = getMCPConfigPath("user", cwd);
	const projectPath = getMCPConfigPath("project", cwd);
	const [userConfig, projectConfig] = await Promise.all([readMCPConfigFile(userPath), readMCPConfigFile(projectPath)]);
	if (userConfig.mcpServers?.[name]) {
		return { filePath: userPath, scope: "user", config: userConfig.mcpServers[name], discovered: false };
	}
	if (projectConfig.mcpServers?.[name]) {
		return { filePath: projectPath, scope: "project", config: projectConfig.mcpServers[name], discovered: false };
	}

	const standalonePaths = [path.join(cwd, "mcp.json"), path.join(cwd, ".mcp.json")];
	const fallbackConfigs = await Promise.all(
		standalonePaths.map(async filePath => {
			try {
				return await readMCPConfigFile(filePath);
			} catch {
				return null;
			}
		}),
	);
	for (const [index, fallbackConfig] of fallbackConfigs.entries()) {
		const config = fallbackConfig?.mcpServers?.[name];
		if (config) {
			return { filePath: standalonePaths[index]!, scope: "project", config, discovered: false };
		}
	}
	return null;
}

export async function resolveMcpServerForAuth(
	cwd: string,
	name: string,
	manager?: MCPManager,
): Promise<ResolvedMcpServer | null> {
	const configured = await findConfiguredMcpServer(cwd, name);
	if (configured) return configured;
	const config = manager?.getServerConfig(name);
	const source = manager?.getSource(name);
	if (!config || !source) return null;
	return {
		filePath: getMCPConfigPath("user", cwd),
		scope: "user",
		config,
		discovered: true,
	};
}

export async function testMcpConnection(options: {
	cwd: string;
	config: MCPServerConfig;
	authStorage: AuthStorage;
	manager?: MCPManager;
	oauth?: boolean;
}): Promise<void> {
	const manager = options.manager ?? new MCPManager(options.cwd);
	if (!options.manager) manager.setAuthStorage(options.authStorage);
	const resolvedConfig = await manager.prepareConfig(options.config, { oauth: options.oauth });
	const connection = await connectToServer(`test_${Date.now()}`, resolvedConfig);
	await disconnectServer(connection);
}

async function resolveMcpOAuthEndpoints(options: {
	cwd: string;
	config: MCPServerConfig;
	authStorage: AuthStorage;
	manager?: MCPManager;
	authChallenge?: MCPAuthChallenge;
}): Promise<OAuthEndpoints> {
	const { config } = options;
	if (config.type !== "http" && config.type !== "sse") {
		const remoteUrl = config.args?.find(arg => /^https?:\/\//.test(arg));
		const httpHint = `{ "type": "http", "url": ${JSON.stringify(remoteUrl ?? "<remote url>")} }`;
		const usesMcpRemote = [config.command, ...(config.args ?? [])].some(part => part?.includes("mcp-remote"));
		throw new Error(
			usesMcpRemote
				? `this server proxies OAuth through mcp-remote, which caches tokens machine-wide in ~/.mcp-auth (shared across every OMP profile). Clear ~/.mcp-auth to force a fresh login, or replace the proxy with ${httpHint} so OMP manages OAuth per profile.`
				: `stdio servers manage their own credentials, so OMP has no OAuth to reauthorize. If the service supports OAuth over HTTP, configure it as ${httpHint} instead.`,
		);
	}

	let connectionSucceeded = false;
	let connectionError: Error | undefined;
	try {
		await testMcpConnection({
			cwd: options.cwd,
			config: stripMcpOAuthAuth(config),
			authStorage: options.authStorage,
			manager: options.manager,
			oauth: false,
		});
		connectionSucceeded = true;
	} catch (error) {
		connectionError = error as Error;
	}
	if (connectionSucceeded && !options.authChallenge) {
		const discovered = config.url ? await discoverOAuthEndpoints(config.url) : null;
		if (!discovered) throw new Error("Server connection succeeded without OAuth; reauthorization is not required.");
		return discovered;
	}

	const authError = options.authChallenge
		? new Error(`${connectionError?.message ?? "HTTP 401"}\n${options.authChallenge.wwwAuthenticate.join("\n")}`)
		: connectionError!;
	const authResult = analyzeAuthError(authError, config.url);
	let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
	if (!oauth && config.url) {
		oauth = await discoverOAuthEndpoints(config.url, authResult.authServerUrl, authResult.resourceMetadataUrl, {
			protectedScopes: authResult.scopes,
		});
	}
	if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
		const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
		if (scopes) oauth = { ...oauth, scopes };
	}
	if (!oauth) throw new Error("Could not discover OAuth endpoints from server response.");
	return oauth;
}

export interface ReauthorizeMcpOptions {
	cwd: string;
	name: string;
	authStorage: AuthStorage;
	manager?: MCPManager;
	authChallenge?: MCPAuthChallenge;
	authorize(request: MCPAuthorizationRequest): Promise<MCPAuthorizationResult>;
}

export interface ReauthorizeMcpResult {
	config: MCPServerConfig;
	scope: "user" | "project";
	persisted: boolean;
}

/** Resolve, authorize, and persist one MCP server without depending on a terminal UI. */
export async function reauthorizeMcpServer(options: ReauthorizeMcpOptions): Promise<ReauthorizeMcpResult> {
	const found = await resolveMcpServerForAuth(options.cwd, options.name, options.manager);
	if (!found) throw new Error(`Server "${options.name}" not found.`);
	if (found.config.enabled === false) {
		throw new Error(`Server "${options.name}" is disabled. Run /mcp enable ${options.name} first.`);
	}

	const currentAuth = (found.config as MCPServerConfig & { auth?: MCPAuthConfig }).auth;
	const baseConfig = stripMcpOAuthAuth(found.config);
	const runtimeBaseConfig = expandEnvVarsDeep(baseConfig);
	const oauth = await resolveMcpOAuthEndpoints({
		cwd: options.cwd,
		config: runtimeBaseConfig,
		authStorage: options.authStorage,
		manager: options.manager,
		authChallenge: options.authChallenge,
	});
	const serverUrl =
		runtimeBaseConfig.type === "http" || runtimeBaseConfig.type === "sse" ? runtimeBaseConfig.url : undefined;
	const runtimeAuth = currentAuth ? expandEnvVarsDeep(currentAuth) : undefined;
	const configuredClientId = runtimeBaseConfig.oauth?.clientId?.trim() || undefined;
	const configuredClientSecret = runtimeBaseConfig.oauth?.clientSecret;
	const existingCredential = lookupMcpOAuthCredentialForServer(
		options.authStorage,
		currentAuth,
		serverUrl,
	)?.credential;
	const persistedClientId = runtimeAuth?.clientId?.trim() || undefined;
	const storedClientId = existingCredential?.clientId?.trim() || undefined;
	const discoveredClientId = oauth.clientId?.trim() || undefined;
	const flowClientId =
		configuredClientId ??
		persistedClientId ??
		storedClientId ??
		(oauth.registrationUrl ? undefined : discoveredClientId) ??
		"";
	const storedClientSecret = storedClientId === flowClientId ? existingCredential?.clientSecret : undefined;
	const flowClientSecret =
		(configuredClientId === flowClientId ? configuredClientSecret : undefined) ??
		(persistedClientId === flowClientId ? runtimeAuth?.clientSecret : undefined) ??
		storedClientSecret ??
		"";
	const userClientSecret =
		(configuredClientId === flowClientId ? found.config.oauth?.clientSecret : undefined) ??
		(persistedClientId === flowClientId ? currentAuth?.clientSecret : undefined);
	const currentAuthResource = currentAuth?.resource ? expandEnvVarsDeep(currentAuth.resource) : undefined;
	const oauthResource = oauth.resource ?? currentAuthResource ?? serverUrl;
	const oauthResourceIsFallback = !oauth.resource && !currentAuthResource;
	const authorization = await options.authorize({
		authorizationUrl: oauth.authorizationUrl,
		tokenUrl: oauth.tokenUrl,
		clientId: flowClientId,
		clientSecret: flowClientSecret,
		scopes: oauth.scopes || runtimeBaseConfig.oauth?.scope || "",
		callbackPort: found.config.oauth?.callbackPort,
		callbackPath: found.config.oauth?.callbackPath,
		redirectUri: found.config.oauth?.redirectUri,
		prompt: found.config.oauth?.prompt,
		registrationUrl: oauth.registrationUrl,
		issuerUrl: oauth.issuerUrl,
		serverUrl,
		resource: oauthResource,
		stripSameOriginResource: oauthResourceIsFallback,
	});

	if (currentAuth?.type === "oauth" && currentAuth.credentialId !== authorization.credentialId) {
		await removeManagedMcpOAuthCredential(options.authStorage, currentAuth.credentialId);
	}
	const urlKeyedId = serverUrl ? mcpOAuthCredentialId(serverUrl) : undefined;
	const shouldPersist = Boolean(currentAuth) || authorization.credentialId !== urlKeyedId;
	const updatedConfig = shouldPersist
		? persistMcpOAuthResult(baseConfig, authorization, {
				tokenUrl: oauth.tokenUrl,
				clientId: oauth.clientId,
				persistOAuthClientId: !(configuredClientId === undefined && configuredClientSecret !== undefined),
				userClientSecret,
				resource: oauthResource,
				stripSameOriginResource: oauthResourceIsFallback,
			})
		: baseConfig;
	if (shouldPersist) await updateMCPServer(found.filePath, options.name, updatedConfig);
	return { config: updatedConfig, scope: found.scope, persisted: shouldPersist };
}

/** Reconnect configured MCP servers and rebuild the session's live MCP tools. */
export async function reloadMcpRuntime(
	session: AgentSession,
	manager: MCPManager,
	enableProjectConfig: boolean,
): Promise<MCPLoadResult> {
	await manager.disconnectAll();
	session.setMCPPromptCommands([]);
	clearFsCache();
	const result = await manager.discoverAndConnect({
		enableProjectConfig,
		filterExa: true,
		filterBrowser: session.getEvalPreludes().some(definition => definition.name === "browser"),
		extensionRoots: session.effectiveExtensionRoots,
	});
	await session.refreshMCPTools(manager.getTools());
	return result;
}
