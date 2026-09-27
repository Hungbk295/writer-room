#!/usr/bin/env node
/**
 * vidIQ Model Context Protocol (MCP) Bridge & CLI
 * 
 * Provides:
 * 1. MCP stdio server for Antigravity, Claude Desktop, Cursor.
 * 2. CLI commands for direct queries (e.g. balance, keyword research).
 */

const https = require("https");
const readline = require("readline");

const API_KEY = process.env.VIDIQ_API_KEY || "vidiq_X56YDx57h612EW_0v0tJjUoLw6fwWREMgJbFozpX";
const VIDIQ_ENDPOINT = "https://mcp.vidiq.com/mcp";

/**
 * Perform JSON-RPC call to vidIQ MCP endpoint
 */
function callVidiq(method, params = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params
    });

    const req = https.request(VIDIQ_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream"
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        const line = data.split(/\r?\n/).find(l => l.startsWith("data:"));
        if (!line) {
          try {
            const errObj = JSON.parse(data);
            return resolve(errObj);
          } catch {
            return reject(new Error(`Invalid response from vidIQ: ${data}`));
          }
        }
        try {
          const json = JSON.parse(line.slice(5).trim());
          resolve(json);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Handle MCP Stdio Protocol
 */
function startStdioServer() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.method === "initialize") {
      const res = {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "vidiq-mcp", version: "1.0.0" }
        }
      };
      process.stdout.write(JSON.stringify(res) + "\n");
      return;
    }

    if (msg.method === "notifications/initialized") return;

    if (msg.method === "ping") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
      return;
    }

    if (msg.method === "tools/list") {
      try {
        const resp = await callVidiq("tools/list", {});
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: resp.result }) + "\n");
      } catch (err) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: err.message } }) + "\n");
      }
      return;
    }

    if (msg.method === "tools/call") {
      try {
        const resp = await callVidiq("tools/call", msg.params);
        if (resp.error) {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: resp.error }) + "\n");
        } else {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: resp.result }) + "\n");
        }
      } catch (err) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: err.message } }) + "\n");
      }
      return;
    }
  });
}

/**
 * CLI mode
 */
async function runCli() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--stdio") {
    startStdioServer();
    return;
  }

  if (cmd === "balance") {
    const res = await callVidiq("tools/call", { name: "vidiq_balance", arguments: {} });
    console.log(JSON.stringify(res.result?.structuredContent || res, null, 2));
    return;
  }

  if (cmd === "keyword") {
    const keyword = args[1];
    if (!keyword) {
      console.error("Usage: node vidiq-mcp-server.cjs keyword <term>");
      process.exit(1);
    }
    const res = await callVidiq("tools/call", {
      name: "vidiq_keyword_research",
      arguments: { keyword, mode: "research" }
    });
    console.log(res.result?.content?.[0]?.text || JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === "call") {
    const toolName = args[1];
    const toolArgs = args[2] ? JSON.parse(args[2]) : {};
    const res = await callVidiq("tools/call", { name: toolName, arguments: toolArgs });
    console.log(res.result?.content?.[0]?.text || JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === "list") {
    const res = await callVidiq("tools/list", {});
    const tools = res.result?.tools || [];
    console.log(`Available vidIQ Tools (${tools.length}):`);
    tools.forEach(t => console.log(`- ${t.name}: ${t.title || t.description?.slice(0, 60)}`));
    return;
  }

  console.log("Usage:");
  console.log("  node scripts/vidiq-mcp-server.cjs --stdio                  # Run MCP stdio server");
  console.log("  node scripts/vidiq-mcp-server.cjs balance                 # Check credit balance");
  console.log("  node scripts/vidiq-mcp-server.cjs list                    # List available tools");
  console.log("  node scripts/vidiq-mcp-server.cjs keyword <seed>          # Research keyword");
  console.log("  node scripts/vidiq-mcp-server.cjs call <tool> '<json>'    # Generic tool call");
}

runCli().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
