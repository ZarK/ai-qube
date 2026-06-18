import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AiqMcpAdapter } from "./adapter.js";
import {
  aiqCheckFilesInputSchema,
  aiqExplainDiagnosticsInputSchema,
  aiqStatusInputSchema,
} from "./schemas.js";
import type { AiqMcpServerOptions } from "./types.js";

export function createAiqMcpServer(options: AiqMcpServerOptions = {}): McpServer {
  const server = new McpServer(options.serverInfo ?? { name: "aiq-mcp", version: "0.0.0" });
  const adapter = new AiqMcpAdapter(options);

  server.registerResource(
    "aiq-config",
    "aiq://config",
    {
      description: "Current AIQ MCP defaults and read-only behavior.",
      mimeType: "application/json",
      title: "AIQ Config",
    },
    async (uri) => ({
      contents: [
        {
          text: JSON.stringify(
            {
              cwd: path.resolve(options.cwd ?? process.cwd()),
              readOnlyDefault: true,
              toolNames: [
                "aiq_check_files",
                "aiq_plan_files",
                "aiq_status",
                "aiq_doctor",
                "aiq_explain_diagnostics",
              ],
            },
            null,
            2,
          ),
          uri: uri.href,
        },
      ],
    }),
  );

  server.registerTool(
    "aiq_check_files",
    {
      description: "Run AIQ checks for explicit files without applying fixes.",
      inputSchema: aiqCheckFilesInputSchema,
    },
    async ({ files, outDir, stages, profile }) => {
      const result = await adapter.check({
        files,
        ...(outDir === undefined ? {} : { outDir }),
        ...(stages === undefined ? {} : { stages }),
        ...(profile === undefined ? {} : { profile }),
      });

      return {
        content: [{ text: result.text, type: "text" }],
        structuredContent: {
          diagnosticCount: result.report.summary.diagnosticCount,
          files: result.files,
          ok: result.ok,
          planPath: result.planPath,
          reportPath: result.reportPath,
          workflow: result.workflow,
          status: result.report.summary.status,
        },
      };
    },
  );

  server.registerTool(
    "aiq_plan_files",
    {
      description: "Plan AIQ checks for explicit files without executing tools.",
      inputSchema: aiqCheckFilesInputSchema,
    },
    async ({ files, outDir, stages, profile }) => {
      const result = await adapter.plan({
        files,
        ...(outDir === undefined ? {} : { outDir }),
        ...(stages === undefined ? {} : { stages }),
        ...(profile === undefined ? {} : { profile }),
      });

      return {
        content: [{ text: result.text, type: "text" }],
        structuredContent: {
          files: result.files,
          profile: result.plan.profile,
          stageCount: result.plan.summary.stageCount,
          stages: result.plan.stages,
          taskCount: result.plan.summary.taskCount,
          workflow: result.workflow,
        },
      };
    },
  );

  server.registerTool(
    "aiq_status",
    {
      description: "Report AIQ MCP stage/profile status and current-stage defaults.",
      inputSchema: aiqStatusInputSchema,
    },
    async ({ cwd }) => {
      const result = await adapter.status({
        ...(cwd === undefined ? {} : { cwd }),
      });

      return {
        content: [{ text: result.text, type: "text" }],
        structuredContent: {
          cwd: result.cwd,
          profile: result.profile,
          stages: result.stages,
          workflow: result.workflow,
        },
      };
    },
  );

  server.registerTool(
    "aiq_doctor",
    {
      description: "Validate AIQ MCP config/progress stage selection.",
      inputSchema: aiqStatusInputSchema,
    },
    async ({ cwd }) => {
      const result = await adapter.status({
        ...(cwd === undefined ? {} : { cwd }),
      });

      return {
        content: [{ text: `AIQ doctor\n${result.text}\nStatus: passed`, type: "text" }],
        structuredContent: {
          checks: [
            {
              name: "Config and progress selection resolved",
              ok: true,
            },
          ],
          cwd: result.cwd,
          ok: true,
          profile: result.profile,
          stages: result.stages,
          workflow: result.workflow,
        },
      };
    },
  );

  server.registerTool(
    "aiq_explain_diagnostics",
    {
      description: "Explain AIQ diagnostics from a saved report or an explicit file check.",
      inputSchema: aiqExplainDiagnosticsInputSchema,
    },
    async ({ files, outDir, stages, profile, reportPath }) => {
      const result = await adapter.explain({
        ...(files === undefined ? {} : { files }),
        ...(outDir === undefined ? {} : { outDir }),
        ...(stages === undefined ? {} : { stages }),
        ...(profile === undefined ? {} : { profile }),
        ...(reportPath === undefined ? {} : { reportPath }),
      });

      return {
        content: [{ text: result.text, type: "text" }],
        structuredContent: {
          diagnosticCount: result.diagnosticCount,
          reportPath: result.reportPath,
          status: result.report.summary.status,
        },
      };
    },
  );

  return server;
}

export async function startAiqMcpStdioServer(options: AiqMcpServerOptions = {}): Promise<void> {
  const server = createAiqMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
