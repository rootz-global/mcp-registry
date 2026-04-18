/**
 * MCP Endpoint Prober
 *
 * Hits live MCP endpoints with initialize + tools/list to get ground-truth tool schemas.
 *
 * Usage:
 *   node src/prober.js                 — probe all unprobed streamable-http services
 *   node src/prober.js --all           — re-probe everything
 *   node src/prober.js --top 200       — probe only the top 200 by some signal
 *   node src/prober.js --service NAME  — probe a specific service
 *   node src/prober.js --concurrent 5  — parallel probing (default 3)
 */
import db from './db.js';

const TIMEOUT_MS = 12000;
const DEFAULT_CONCURRENT = 3;

async function probeOne(service) {
  const start = Date.now();
  const endpoint = service.mcp_endpoint;
  if (!endpoint) {
    return { status: 'no_endpoint', tools: [] };
  }

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'User-Agent': 'rootz-mcp-registry-prober/0.1',
  };

  try {
    // Step 1: initialize
    const initResp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          clientInfo: { name: 'rootz-mcp-registry-prober', version: '0.1.0' },
          capabilities: {},
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // If auth required, we still learn something
    if (initResp.status === 401 || initResp.status === 403) {
      return {
        status: 'auth_required',
        status_code: initResp.status,
        response_time_ms: Date.now() - start,
        tools: [],
      };
    }

    if (!initResp.ok) {
      return {
        status: 'http_error',
        status_code: initResp.status,
        response_time_ms: Date.now() - start,
        tools: [],
      };
    }

    // Get session header if the server uses one (MCP Streamable HTTP spec)
    const sessionHeader = {};
    const sessionId = initResp.headers.get('mcp-session-id');
    if (sessionId) sessionHeader['mcp-session-id'] = sessionId;

    // Parse initialize response (may be SSE or JSON)
    const initText = await initResp.text();
    let initData;
    try {
      // Try JSON first
      initData = JSON.parse(initText);
    } catch {
      // Try SSE: extract 'data: {...}' lines
      const dataLine = initText.split('\n').find(l => l.startsWith('data: '));
      if (dataLine) {
        try { initData = JSON.parse(dataLine.slice(6)); } catch {}
      }
    }

    // Step 2: send notifications/initialized (required by protocol)
    await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, ...sessionHeader },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => {});

    // Step 3: tools/list
    const toolsResp = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, ...sessionHeader },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (toolsResp.status === 401 || toolsResp.status === 403) {
      return {
        status: 'auth_required_for_tools',
        status_code: toolsResp.status,
        response_time_ms: Date.now() - start,
        tools: [],
      };
    }

    const toolsText = await toolsResp.text();
    let toolsData;
    try {
      toolsData = JSON.parse(toolsText);
    } catch {
      const dataLine = toolsText.split('\n').find(l => l.startsWith('data: '));
      if (dataLine) {
        try { toolsData = JSON.parse(dataLine.slice(6)); } catch {}
      }
    }

    const tools = toolsData?.result?.tools || [];
    return {
      status: 'reachable',
      status_code: 200,
      response_time_ms: Date.now() - start,
      tools,
    };
  } catch (e) {
    return {
      status: e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'error',
      error: e.message,
      response_time_ms: Date.now() - start,
      tools: [],
    };
  }
}

function saveProbe(service, result) {
  db.prepare(`
    INSERT INTO probes (service_id, probe_type, status_code, response_time_ms, tools_found, error)
    VALUES (?, 'tools_list', ?, ?, ?, ?)
  `).run(service.id, result.status_code || null, result.response_time_ms || null, result.tools?.length || 0, result.error || null);

  db.prepare(`
    UPDATE services SET last_probed = datetime('now'), probe_status = ?, tools_count = ?, tools_extracted = 1
    WHERE id = ?
  `).run(result.status, result.tools?.length || 0, service.id);

  // Save tools
  if (result.tools && result.tools.length > 0) {
    const insertTool = db.prepare(`
      INSERT OR REPLACE INTO tools (service_id, name, description, input_schema, source)
      VALUES (?, ?, ?, ?, 'probe')
    `);
    for (const t of result.tools) {
      const schema = t.inputSchema ? JSON.stringify(t.inputSchema) : null;
      insertTool.run(service.id, t.name, t.description || '', schema);
    }
  }
}

async function runParallel(services, concurrent) {
  let done = 0;
  let reachable = 0;
  let auth = 0;
  let failed = 0;
  let totalTools = 0;

  const queue = [...services];
  const workers = Array.from({ length: concurrent }, async () => {
    while (queue.length > 0) {
      const svc = queue.shift();
      if (!svc) break;
      const result = await probeOne(svc);
      saveProbe(svc, result);
      done++;
      if (result.status === 'reachable') {
        reachable++;
        totalTools += result.tools.length;
      } else if (result.status.startsWith('auth')) {
        auth++;
      } else {
        failed++;
      }
      if (done % 10 === 0 || done === services.length) {
        console.log(`  ${done}/${services.length} — reachable:${reachable} auth:${auth} failed:${failed} tools:${totalTools}`);
      }
    }
  });
  await Promise.all(workers);
  return { done, reachable, auth, failed, totalTools };
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const concurrentIdx = args.indexOf('--concurrent');
  const concurrent = concurrentIdx >= 0 ? parseInt(args[concurrentIdx + 1]) : DEFAULT_CONCURRENT;
  const topIdx = args.indexOf('--top');
  const topN = topIdx >= 0 ? parseInt(args[topIdx + 1]) : null;
  const serviceIdx = args.indexOf('--service');
  const serviceName = serviceIdx >= 0 ? args[serviceIdx + 1] : null;

  let services;
  if (serviceName) {
    services = db.prepare('SELECT * FROM services WHERE name = ?').all(serviceName);
  } else {
    let query = `SELECT * FROM services WHERE mcp_endpoint IS NOT NULL AND transport_type = 'streamable-http'`;
    if (!all) {
      query += ` AND (last_probed IS NULL OR last_probed < datetime('now', '-1 day'))`;
    }
    query += ` ORDER BY registry_published_at DESC`;
    if (topN) query += ` LIMIT ${topN}`;
    services = db.prepare(query).all();
  }

  console.log(`Probing ${services.length} services (concurrent: ${concurrent})...`);
  if (services.length === 0) return;

  const stats = await runParallel(services, concurrent);

  console.log(`\n=== Probe Complete ===`);
  console.log(`Total:      ${stats.done}`);
  console.log(`Reachable:  ${stats.reachable}`);
  console.log(`Auth wall:  ${stats.auth}`);
  console.log(`Failed:     ${stats.failed}`);
  console.log(`Tools:      ${stats.totalTools}`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
