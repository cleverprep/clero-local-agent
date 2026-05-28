#!/usr/bin/env -S node --experimental-strip-types
import process from "node:process";
import {
  capabilitiesFromConfig,
  capabilityOptionsFromConfig,
  createDaemon,
  createPairingClient,
  defaultCapabilities,
  defaultRuntimeConfig,
  defaultRuntimeConfigPath,
  loadRuntimeConfig,
  resolveDeviceToken,
  saveRuntimeConfig,
  type LocalRuntimeConfig
} from "@clero-local-agent/daemon";

type CliArgs = Record<string, string | boolean>;

function parseArgs(argv: string[]): { command: string; args: CliArgs } {
  const [command = "help", ...rest] = argv;
  const args: CliArgs = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }

  return { command, args };
}

function getString(args: CliArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function printHelp(): void {
  console.log(`clero-local-agent

Usage:
  clero-local-agent daemon --ws-url <url> --token <token> [--allowed-dir <path>] [--browser-provider managed|mcp-chrome]
  clero-local-agent pair --backend-url <url> --code <code>
  clero-local-agent capabilities [--config <path>]
  clero-local-agent config init [--config <path>]
  clero-local-agent status
`);
}

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2));

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "config") {
    const configPath = getString(args, "config");
    const subcommand = String(process.argv.slice(2)[1] ?? "help");
    if (subcommand !== "init") {
      throw new Error("config supports: init");
    }
    const targetPath = configPath ?? defaultRuntimeConfigPath();
    await saveRuntimeConfig(targetPath, defaultRuntimeConfig());
    console.log(JSON.stringify({ config_path: targetPath }, null, 2));
    return;
  }

  const configPath = getString(args, "config");
  const runtimeConfig = configPath ? await loadRuntimeConfig(configPath) : undefined;

  if (command === "capabilities") {
    console.log(JSON.stringify(runtimeConfig ? capabilitiesFromConfig(runtimeConfig) : defaultCapabilities(), null, 2));
    return;
  }

  if (command === "status") {
    console.log(JSON.stringify({ status: "offline", message: "Status is available while the daemon is running." }, null, 2));
    return;
  }

  if (command === "pair") {
    const backendUrl = getString(args, "backend-url");
    const code = getString(args, "code");
    if (!backendUrl || !code) {
      throw new Error("pair requires --backend-url and --code");
    }

    const client = createPairingClient({ backendUrl });
    const result = await client.pair({
      code,
      deviceName: getString(args, "device-name"),
      capabilities: {
        tools: (runtimeConfig ? capabilitiesFromConfig(runtimeConfig) : defaultCapabilities()).map((capability) => {
          const tool = {
            name: capability.name,
            access: capability.access,
            description: capability.description
          };
          const withGroups = capability.groups?.length ? { ...tool, groups: capability.groups } : tool;
          return capability.inputSchema ? { ...withGroups, inputSchema: capability.inputSchema } : withGroups;
        })
      }
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "daemon") {
    const wsUrl = getString(args, "ws-url") ?? process.env.CLERO_LOCAL_RUNTIME_WS_URL ?? runtimeConfig?.websocket_url;
    const token =
      nonEmptyString(getString(args, "token")) ??
      nonEmptyString(process.env.CLERO_LOCAL_RUNTIME_TOKEN) ??
      (await resolveDeviceToken(runtimeConfig));
    if (!wsUrl || !token) {
      throw new Error(
        "daemon requires --ws-url and a token from --token, CLERO_LOCAL_RUNTIME_TOKEN, config JSON, or the token store"
      );
    }

    const daemon = createDaemon({
      wsUrl,
      token,
      allowedDirectories: allowedDirectories(args, runtimeConfig),
      browserProvider: browserProviderArg(
        getString(args, "browser-provider") ?? process.env.CLERO_BROWSER_PROVIDER ?? runtimeConfig?.capabilities?.browser?.provider
      ),
      browserMcpUrl: getString(args, "browser-mcp-url") ?? process.env.CLERO_BROWSER_MCP_URL ?? runtimeConfig?.capabilities?.browser?.mcp_url,
      browserProfileDir:
        nonEmptyString(getString(args, "browser-profile-dir")) ??
        nonEmptyString(process.env.CLERO_BROWSER_PROFILE_DIR) ??
        nonEmptyString(runtimeConfig?.capabilities?.browser?.browser_profile_dir),
      browserRememberSession:
        args["no-browser-remember-session"] === true
          ? false
          : args["browser-remember-session"] === true || process.env.CLERO_BROWSER_REMEMBER_SESSION === "true"
            ? true
            : process.env.CLERO_BROWSER_REMEMBER_SESSION === "false"
              ? false
              : runtimeConfig?.capabilities?.browser?.remember_session !== false,
      browserHeadless:
        args["browser-headless"] === true ||
        process.env.CLERO_BROWSER_HEADLESS === "true" ||
        runtimeConfig?.capabilities?.browser?.browser_headless,
      browserChannel: browserChannelArg(
        getString(args, "browser-channel") ??
          process.env.CLERO_BROWSER_CHANNEL ??
          runtimeConfig?.capabilities?.browser?.browser_channel
      ),
      capabilities: runtimeConfig ? capabilityOptionsFromConfig(runtimeConfig) : undefined
    });

    await daemon.start();
    process.once("SIGINT", async () => {
      await daemon.stop();
      process.exit(0);
    });
    process.once("SIGTERM", async () => {
      await daemon.stop();
      process.exit(0);
    });
    return;
  }

  printHelp();
  process.exitCode = 1;
}

function allowedDirectories(args: CliArgs, runtimeConfig: LocalRuntimeConfig | undefined): string[] {
  const allowedDir = getString(args, "allowed-dir");
  if (allowedDir) {
    return [allowedDir];
  }
  if (runtimeConfig?.allowed_directories && runtimeConfig.allowed_directories.length > 0) {
    return runtimeConfig.allowed_directories;
  }
  return [process.cwd()];
}

function browserProviderArg(value: string | undefined): "managed" | "mcp-chrome" | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "managed" || value === "mcp-chrome") {
    return value;
  }

  throw new Error("--browser-provider must be managed or mcp-chrome");
}

function browserChannelArg(value: string | undefined): "chromium" | "chrome" | "chrome-beta" | "msedge" | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "chromium" || value === "chrome" || value === "chrome-beta" || value === "msedge") {
    return value;
  }

  throw new Error("--browser-channel must be chromium, chrome, chrome-beta, or msedge");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
