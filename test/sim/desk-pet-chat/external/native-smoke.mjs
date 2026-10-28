#!/usr/bin/env node
/** No-cost protocol diagnostic: actual native host + Pi + MCP with a loopback scripted provider. */
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { buildEnvironmentCase, runEnvironmentTurn } from "./environment-turn.mjs";
import { EXTERNAL_DATASET_ROOT } from "./index.mjs";

export async function runExternalNativeSmoke({ repoRoot = resolve(import.meta.dirname, "../../../..") } = {}) {
  const runId = `external-native-smoke-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const root = join(repoRoot, EXTERNAL_DATASET_ROOT, "diagnostics", runId);
  mkdirSync(root, { recursive: true });
  const markerPath = join(root, "mcp-witness.txt");
  const cardPath = join(root, "card.md");
  writeFileSync(cardPath, "---\nid: external-native-smoke\nname: External Native Smoke\nversion: 1\n---\nUse the explicitly requested MCP tool and report its result.\n");
  const mcpScript = join(root, "mcp-server.mjs");
  writeFileSync(mcpScript, `import {createInterface} from 'node:readline';\nimport{writeFileSync}from'node:fs';\nconst lines=createInterface({input:process.stdin});\nfor await(const line of lines){const r=JSON.parse(line);if(r.id===undefined)continue;let result;if(r.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'native-smoke',version:'1'}};else if(r.method==='tools/list')result={tools:[{name:'terminal_exec',description:'Write the isolated native-mcp witness',inputSchema:{type:'object',properties:{command:{type:'string'}},required:['command']}}]};else if(r.method==='tools/call'){if(r.params.name!=='terminal_exec'||r.params.arguments.command!=='native-mcp-witness')throw Error('Unexpected tool request');writeFileSync(process.argv[2],'native-mcp-ok');result={content:[{type:'text',text:'native-mcp-ok'}]};}else if(r.method==='ping')result={};else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32601,message:'unsupported'}})+'\\n');continue;}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');}\n`);
  let calls = 0;
  let toolRequests = 0;
  const server = createServer(async (req, res) => {
    try {
      let body = ""; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      calls += 1;
      const tool = request.tools?.find(item => item.function?.name?.endsWith("terminal_exec"));
      const messages = request.messages ?? [];
      const gotToolResult = messages.some(item => item.role === "tool" && JSON.stringify(item.content).includes("native-mcp-ok"));
      const useTool = Boolean(tool && !gotToolResult);
      if (useTool) toolRequests += 1;
      const content = "native-mcp-ok";
      const toolCall = { id: `native-smoke-${calls}`, type: "function", function: { name: tool?.function.name, arguments: JSON.stringify({ command: "native-mcp-witness" }) } };
      if (request.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `smoke-${calls}`, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        send({ role: "assistant", ...(useTool ? { tool_calls: [{ index: 0, ...toolCall }] } : { content }) });
        send({}, useTool ? "tool_calls" : "stop");
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: `smoke-${calls}`, object: "chat.completion", model: "deepseek-flash", choices: [{ index: 0, message: { role: "assistant", content, ...(useTool ? { tool_calls: [toolCall] } : {}) }, finish_reason: useTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
      }
    } catch { res.writeHead(400); res.end("invalid diagnostic request"); }
  });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  const modelSettingsPath = join(root, "models.json");
  writeFileSync(modelSettingsPath, JSON.stringify({ underTest: { provider: "deepseek", model: "deepseek-flash", endpoint: `http://127.0.0.1:${port}`, apiKey: "diagnostic-placeholder" } }));
  const request = {
    dataset: "lhtb", taskId: "native-protocol-diagnostic", runId, cardPath, modelSettingsPath,
    instruction: "Call the installed terminal_exec MCP tool with command native-mcp-witness, then report its exact result.",
    mcpServer: { name: "external-native-smoke", transport: "stdio", command: process.execPath, args: [mcpScript, markerPath], env: {}, includeTools: ["terminal_exec"], enabled: true },
  };
  const entry = buildEnvironmentCase(request, { card: "External Native Smoke" });
  const authorizationPath = join(root, "authorization.json");
  writeFileSync(authorizationPath, JSON.stringify({ schemaVersion: 1, approvedBy: "no-cost-diagnostic-harness", approvedAt: new Date().toISOString(), scope: { caseIds: [entry.case.caseId], purpose: "development", models: ["deepseek/deepseek-flash"], data: "isolated" }, budget: { messages: 1, tokens: 100000, minutes: 10, trials: 1, repairs: 0 }, holdout: false }));
  request.authorizationPath = authorizationPath;
  try {
    const result = await runEnvironmentTurn(request, { repoRoot });
    const witness = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : null;
    const diagnostic = { runId, scope: "native-product-MCP-protocol-only", paidModelCalls: 0, loopbackRequests: calls, scriptedToolRequests: toolRequests, witness, executionComplete: result.executionComplete, evidenceRoot: result.evidenceRoot, issues: result.issues };
    writeFileSync(join(root, "diagnostic.json"), `${JSON.stringify(diagnostic, null, 2)}\n`);
    if (!result.executionComplete || witness !== "native-mcp-ok" || toolRequests < 1) throw new Error(`Native MCP diagnostic did not close; see ${root}`);
    return diagnostic;
  } finally { await new Promise(resolveClose => server.close(resolveClose)); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await runExternalNativeSmoke(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
