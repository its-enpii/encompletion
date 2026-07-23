/**
 * embed-tool-registry — bridge between the tools DB rows and the
 * OpenAI function-calling tool definitions the LLM accepts.
 *
 * One function for the caller to use:
 *   resolveEmbedTools(tenantId) -> { tools, requiresConfirmation, capability }
 *
 * `tools` is the array passed to runLLM as opts.embedTools. Each entry
 * is { type: 'function', function: { name, description, parameters } }.
 * The LLM calls them by `function.name`; we look the name back up via
 * tool-executor.findToolByName to resolve to a row + endpoint.
 *
 * `requiresConfirmation` is the set of tool names that need explicit
 * user approval before the executor fires. Widget uses it to render
 * the confirm dialog. We return the *names* rather than ids because
 * that's what the LLM will echo in tool_calls.
 *
 * `capability` is the same shape as tool-executor.loadCapability — the
 * embed route can gate Kategori A / Bash access at run time without
 * re-querying.
 */

import { listActiveToolsForTenant, loadCapability } from './tool-executor.js';

function toolRowToLLMDef(row) {
  let parameters = {};
  if (row.json_schema) {
    try {
      const parsed = JSON.parse(row.json_schema);
      if (parsed && typeof parsed === 'object') parameters = parsed;
    } catch { /* corrupt — fall back to empty schema */ }
  }
  return {
    type: 'function',
    function: {
      name: row.name,
      description: row.description || '',
      parameters,
    },
  };
}

export function resolveEmbedTools(tenantId) {
  const rows = listActiveToolsForTenant(tenantId);
  const capability = loadCapability(tenantId);
  const tools = rows.map(toolRowToLLMDef);
  const requiresConfirmation = rows
    .filter((r) => r.requires_confirmation)
    .map((r) => r.name);
  return { tools, requiresConfirmation, capability };
}

export default { resolveEmbedTools };