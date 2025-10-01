// @ts-ignore - keep file-local minimalism without project-wide Node types
import { promises as fs } from 'fs';
// @ts-ignore - keep file-local minimalism without project-wide Node types
import * as path from 'path';
import { parse as parseTOML } from '@iarna/toml';
import { sha256, stableJson } from './hash';
import { concatenateRules } from './RuleProcessor';
import * as FileSystemUtils from './FileSystemUtils';
import {
  RulerUnifiedConfig,
  ConfigMeta,
  TomlConfig,
  RulesBundle,
  McpBundle,
  ConfigDiagnostic,
  RuleFile,
  McpServerDef,
} from './UnifiedConfigTypes';

export interface UnifiedLoadOptions {
  projectRoot: string;
  configPath?: string;
  cliAgents?: string[];
  cliMcpEnabled?: boolean;
  cliMcpStrategy?: string;
}

export async function loadUnifiedConfig(
  options: UnifiedLoadOptions,
): Promise<RulerUnifiedConfig> {
  // Resolve the effective .ruler directory (local or global), mirroring the main loader behavior
  const resolvedRulerDir =
    (await FileSystemUtils.findRulerDir(options.projectRoot, true)) ||
    path.join(options.projectRoot, '.ruler');

  const meta: ConfigMeta = {
    projectRoot: options.projectRoot,
    rulerDir: resolvedRulerDir,
    loadedAt: new Date(),
    version: '0.0.0-dev',
  };

  const diagnostics: ConfigDiagnostic[] = [];

  // Read TOML if available
  let tomlRaw: unknown = {};
  const tomlFile = options.configPath
    ? path.resolve(options.configPath)
    : path.join(meta.rulerDir, 'ruler.toml');
  try {
    const text = await fs.readFile(tomlFile, 'utf8');
    tomlRaw = text.trim() ? parseTOML(text) : {};
    meta.configFile = tomlFile;
  } catch (err) {
    if ((err as any)?.code !== 'ENOENT') {
      diagnostics.push({
        severity: 'warning',
        code: 'TOML_READ_ERROR',
        message: 'Failed to read ruler.toml',
        file: tomlFile,
        detail: (err as Error).message,
      });
    }
  }

  let defaultAgents: string[] | undefined;
  if (
    tomlRaw &&
    typeof tomlRaw === 'object' &&
    (tomlRaw as Record<string, unknown>).default_agents &&
    Array.isArray((tomlRaw as Record<string, unknown>).default_agents)
  ) {
    defaultAgents = (
      (tomlRaw as Record<string, unknown>).default_agents as unknown[]
    ).map((a) => String(a));
  }

  let nested = false;
  if (
    tomlRaw &&
    typeof tomlRaw === 'object' &&
    typeof (tomlRaw as Record<string, unknown>).nested === 'boolean'
  ) {
    nested = (tomlRaw as Record<string, unknown>).nested as boolean;
  }

  const toml: TomlConfig = {
    raw: tomlRaw,
    schemaVersion: 1,
    agents: {},
    defaultAgents,
    nested,
  };

  // Collect rule markdown files
  let ruleFiles: RuleFile[] = [];
  try {
    const dirEntries = await fs.readdir(meta.rulerDir, { withFileTypes: true });
    const mdFiles = dirEntries
      .filter((e: { isFile: () => boolean; name: string }) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e: { name: string }) => path.join(meta.rulerDir, e.name));
    // Sort lexicographically then ensure AGENTS.md first
    mdFiles.sort((a: string, b: string) => a.localeCompare(b));
    mdFiles.sort((a: string, b: string) => {
      const aIs = /agents\.md$/i.test(a);
      const bIs = /agents\.md$/i.test(b);
      if (aIs && !bIs) return -1;
      if (bIs && !aIs) return 1;
      return 0;
    });
    let order = 0;
    ruleFiles = await Promise.all(
      mdFiles.map(async (file: string) => {
        const content = await fs.readFile(file, 'utf8');
        const stat = await fs.stat(file);
        return {
          path: file,
          relativePath: path.basename(file),
          content,
          contentHash: sha256(content),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          order: order++,
          primary: /agents\.md$/i.test(file),
        } as RuleFile;
      }),
    );
  } catch (err) {
    diagnostics.push({
      severity: 'warning',
      code: 'RULES_READ_ERROR',
      message: 'Failed reading rule files',
      file: meta.rulerDir,
      detail: (err as Error).message,
    });
  }

  const concatenated = concatenateRules(
    ruleFiles.map((f) => ({ path: f.path, content: f.content })),
    path.dirname(meta.rulerDir),
  );
  const rules: RulesBundle = {
    files: ruleFiles,
    concatenated,
    concatenatedHash: sha256(concatenated),
  };

  // Parse TOML MCP servers
  const tomlMcpServers: Record<string, McpServerDef> = {};
  if (tomlRaw && typeof tomlRaw === 'object') {
    const tomlObj = tomlRaw as Record<string, unknown>;
    if (tomlObj.mcp_servers && typeof tomlObj.mcp_servers === 'object') {
      const mcpServersRaw = tomlObj.mcp_servers as Record<string, unknown>;
      for (const [name, def] of Object.entries(mcpServersRaw)) {
        if (!def || typeof def !== 'object') continue;
        const serverDef = def as Record<string, unknown>;
        const server: McpServerDef = {};

        // Parse command and args
        if (typeof serverDef.command === 'string') {
          server.command = serverDef.command;
        }
        if (Array.isArray(serverDef.args)) {
          server.args = serverDef.args.map(String);
        }

        // Parse env
        if (serverDef.env && typeof serverDef.env === 'object') {
          server.env = Object.fromEntries(
            Object.entries(serverDef.env).filter(
              ([, v]) => typeof v === 'string',
            ),
          ) as Record<string, string>;
        }

        // Parse URL and headers
        if (typeof serverDef.url === 'string') {
          server.url = serverDef.url;
        }
        if (serverDef.headers && typeof serverDef.headers === 'object') {
          server.headers = Object.fromEntries(
            Object.entries(serverDef.headers).filter(
              ([, v]) => typeof v === 'string',
            ),
          ) as Record<string, string>;
        }

        // Validate server configuration
        const hasCommand = !!server.command;
        const hasUrl = !!server.url;

        if (!hasCommand && !hasUrl) {
          diagnostics.push({
            severity: 'warning',
            code: 'MCP_TOML_INVALID_SERVER',
            message: `MCP server '${name}' must have at least one of command or url`,
            file: tomlFile,
          });
          continue;
        }

        if (hasCommand && hasUrl) {
          diagnostics.push({
            severity: 'warning',
            code: 'MCP_TOML_FIELD_CONFLICT',
            message: `MCP server '${name}' has both command and url - using url (remote)`,
            file: tomlFile,
          });
        }

        if (hasCommand && server.headers) {
          diagnostics.push({
            severity: 'warning',
            code: 'MCP_TOML_FIELD_CONFLICT',
            message: `MCP server '${name}' has headers with command (should be used with url only)`,
            file: tomlFile,
          });
        }

        if (hasUrl && server.env) {
          diagnostics.push({
            severity: 'warning',
            code: 'MCP_TOML_FIELD_CONFLICT',
            message: `MCP server '${name}' has env with url (should be used with command only)`,
            file: tomlFile,
          });
        }

        // Derive type - remote takes precedence if both are present
        if (server.url) {
          server.type = 'remote';
        } else if (server.command) {
          server.type = 'stdio';
        }

        tomlMcpServers[name] = server;
      }
    }
  }

  // Store TOML MCP servers in toml config
  toml.mcpServers = tomlMcpServers;

  // MCP normalization - merge JSON and TOML
  let mcp: McpBundle | null = null;
  const mcpFile = path.join(meta.rulerDir, 'mcp.json');
  const jsonMcpServers: Record<string, McpServerDef> = {};
  let mcpJsonExists = false;

  // Pre-flight existence check so users see warning even if JSON invalid
  try {
    await fs.access(mcpFile);
    mcpJsonExists = true;
    // Warning is handled by apply-engine to avoid duplication
  } catch {
    // file not present
  }

  // Add deprecation warning if mcp.json exists (regardless of validity)
  if (mcpJsonExists) {
    meta.mcpFile = mcpFile;
    diagnostics.push({
      severity: 'warning',
      code: 'MCP_JSON_DEPRECATED',
      message:
        'mcp.json detected: please migrate MCP servers to ruler.toml [mcp_servers.*] sections',
      file: mcpFile,
    });
  }

  // Collect all mcp.json files recursively
  async function collectMcpFiles(dir: string): Promise<Record<string, McpServerDef>> {
    const servers: Record<string, McpServerDef> = {};
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === 'mcp.json') {
          try {
            const raw = await fs.readFile(fullPath, 'utf8');
            const parsed = JSON.parse(raw) as any;
            const mcpServers = parsed.mcpServers || parsed.servers || {};
            Object.assign(servers, mcpServers);
          } catch {
            // ignore parse errors
          }
        } else if (entry.isDirectory()) {
          Object.assign(servers, await collectMcpFiles(fullPath));
        }
      }
    } catch {
      // ignore read errors
    }
    return servers;
  }

  // Merge discovered JSON servers
  Object.assign(jsonMcpServers, await collectMcpFiles(meta.rulerDir));

  // Merge servers: start with JSON, overlay TOML (TOML wins per server name)
  const mergedServers = { ...jsonMcpServers, ...tomlMcpServers };

  // Create MCP bundle if we have any servers
  if (Object.keys(mergedServers).length > 0 || mcpJsonExists) {
    mcp = {
      servers: mergedServers,
      raw: mcpJsonExists ? { mcpServers: jsonMcpServers } : {},
      hash: sha256(stableJson(mergedServers)),
    };
  }

  const config: RulerUnifiedConfig = {
    meta,
    toml,
    rules,
    mcp,
    agents: {},
    diagnostics,
    hash: '', // placeholder, recompute after agents
  };

  // Agent resolution (basic): enabled set is CLI override or default_agents
  const cliAgents =
    options.cliAgents && options.cliAgents.length > 0
      ? options.cliAgents
      : undefined;
  const enabledList = cliAgents ?? toml.defaultAgents ?? [];
  for (const name of enabledList) {
    config.agents[name] = {
      identifier: name,
      enabled: true,
      output: {},
      mcp: { enabled: false, strategy: 'merge' },
    };
  }
  // If CLI provided, mark defaults not included as disabled (optional design choice)
  if (cliAgents) {
    for (const name of toml.defaultAgents ?? []) {
      if (!config.agents[name]) {
        config.agents[name] = {
          identifier: name,
          enabled: false,
          output: {},
          mcp: { enabled: false, strategy: 'merge' },
        };
      }
    }
  }

  // Recompute hash including agents list
  config.hash = sha256(
    stableJson({
      toml: toml.defaultAgents,
      rules: rules.concatenatedHash,
      mcp: mcp ? mcp.hash : null,
      agents: Object.entries(config.agents).map(([k, v]) => [k, v.enabled]),
    }),
  );

  return config;
}
