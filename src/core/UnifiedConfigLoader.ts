// Use require with any typing to avoid dependency on Node type definitions in this file
declare const require: any;
const path = require('path') as any;
const fs = (require('fs') as any).promises as any;
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
  } catch (err: unknown) {
    if ((err as any).code !== 'ENOENT') {
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
      .filter((e: any) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e: any) => path.join(meta.rulerDir, e.name));
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
  } catch (err: unknown) {
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

  // Helper to parse a single mcp.json file leniently and return servers
  async function parseMcpJsonFile(filePath: string): Promise<Record<string, McpServerDef>> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch (e: unknown) {
        const stripped = raw
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|\s+)\/\/.*$/gm, '$1')
          .replace(/,\s*([}\]])/g, '$1');
        try {
          parsed = JSON.parse(stripped) as Record<string, unknown>;
        } catch {
          throw e as Error;
        }
      }

      const parsedObj = parsed as Record<string, unknown>;
      const serversRaw =
        (parsedObj.mcpServers as unknown) ||
        (parsedObj.servers as unknown) ||
        {};
      const servers: Record<string, McpServerDef> = {};
      if (serversRaw && typeof serversRaw === 'object') {
        for (const [name, def] of Object.entries(
          serversRaw as Record<string, Record<string, unknown>>,
        )) {
          if (!def || typeof def !== 'object') continue;
          const server: McpServerDef = {};
          if (typeof def.command === 'string') server.command = def.command;
          if (Array.isArray(def.command)) server.command = def.command[0];
          if (Array.isArray(def.args)) server.args = def.args.map(String);
          if (def.env && typeof def.env === 'object') {
            server.env = Object.fromEntries(
              Object.entries(def.env).filter(([, v]) => typeof v === 'string'),
            ) as Record<string, string>;
          }
          if (typeof def.url === 'string') server.url = def.url;
          if (def.headers && typeof def.headers === 'object') {
            server.headers = Object.fromEntries(
              Object.entries(def.headers).filter(
                ([, v]) => typeof v === 'string',
              ),
            ) as Record<string, string>;
          }
          if (server.url) server.type = 'remote';
          else if (server.command) server.type = 'stdio';
          servers[name] = server;
        }
      }
      return servers;
    } catch (err) {
      diagnostics.push({
        severity: 'warning',
        code: 'MCP_READ_ERROR',
        message: 'Failed to read mcp.json',
        file: filePath,
        detail: (err as Error).message,
      });
      return {};
    }
  }

  // New: collect and merge all mcp.json files under .ruler/**, with child overriding parent
  const discoveredJsonServers: Record<string, McpServerDef> = {};
  try {
    // Depth-first walk to ensure parents merge first, then children override
    async function walk(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      // Process files in this directory first
      for (const entry of entries) {
        if (entry.isFile() && entry.name === 'mcp.json') {
          const filePath = path.join(dir, entry.name);
          const servers = await parseMcpJsonFile(filePath);
          for (const [name, server] of Object.entries(servers)) {
            if (Object.prototype.hasOwnProperty.call(discoveredJsonServers, name)) {
              diagnostics.push({
                severity: 'warning',
                code: 'MCP_JSON_OVERRIDE',
                message: `MCP server '${name}' from ${filePath} overrides earlier definition`,
                file: filePath,
              });
            }
            discoveredJsonServers[name] = server;
          }
        }
      }
      // Then recurse into subdirectories
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name));
        }
      }
    }

    await walk(meta.rulerDir);
  } catch {
    // ignore directory read errors
  }

  // Preserve legacy top-level flag/diagnostic behavior
  if (mcpJsonExists) {
    meta.mcpFile = mcpFile;
  }

  // Merge servers: start with discovered JSON (including subdirs), overlay TOML (TOML wins per server name)
  Object.assign(jsonMcpServers, discoveredJsonServers);

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
