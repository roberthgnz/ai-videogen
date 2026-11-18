import { t as translate } from "@/lib/i18n";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import type { ToolResult, ToolSpec } from "./shared";

/**
 * A minimal MCP server (Streamable HTTP, JSON responses, no SSE) that lends the studio's tools to an installed
 * program for one turn. It listens on 127.0.0.1 on a free port and only answers requests that carry the
 * turn's random token, so nothing else on the machine can drive the project.
 */

export interface McpEndpoint {
  url: string;
  headers: Record<string, string>;
  close: () => Promise<void>;
}

interface RpcMessage {
  id?: string | number | null;
  method?: string;
  params?: { name?: unknown; arguments?: unknown; protocolVersion?: unknown };
}

const MAX_BODY = 8 * 1024 * 1024;

export async function serveTools(
  name: string,
  tools: ToolSpec[],
  call: (tool: string, args: unknown) => Promise<ToolResult>,
): Promise<McpEndpoint> {
  const token = randomBytes(24).toString("hex");

  async function answer(message: RpcMessage): Promise<object | null> {
    // Notifications (initialized, cancelled…) carry no id and get no answer.
    if (!message || typeof message !== "object" || message.id === undefined || message.id === null) return null;
    const ok = (result: object) => ({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        return ok({
          protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version: "1.0.0" },
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools });
      case "tools/call": {
        const tool = typeof message.params?.name === "string" ? message.params.name : "";
        const result = await call(tool, message.params?.arguments ?? {});
        const images = (result.images ?? []).map((data) => ({ type: "image", data, mimeType: "image/jpeg" }));
        return ok({ content: [{ type: "text", text: result.text }, ...images], isError: !result.ok });
      }
      case "resources/list":
        return ok({ resources: [] });
      case "prompts/list":
        return ok({ prompts: [] });
      default:
        return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: translate("Method not available: {0}", message.method) } };
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      // No server-to-client stream: clients fall back to plain request/response.
      res.writeHead(405, { Allow: "POST, DELETE" }).end();
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) {
        res.writeHead(413).end();
        return;
      }
    }
    let parsed: RpcMessage | RpcMessage[];
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: translate("JSON invalid") } }));
      return;
    }
    const batch = Array.isArray(parsed);
    const messages: RpcMessage[] = Array.isArray(parsed) ? parsed : [parsed];
    const replies = (await Promise.all(messages.map(answer))).filter((r) => r !== null);
    if (replies.length === 0) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(batch ? replies : replies[0]));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error("[agent-mcp]", error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
