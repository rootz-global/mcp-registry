/**
 * MCP Service Registry — Express API Server
 *
 * Modeled on Origin SEC Registry. Flat HTML + JSON API + .well-known/ai + MCP endpoint.
 *
 * Port: 3500 (Origin uses 3400)
 */
import express from 'express';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';
import { handleMcpRequest } from './mcp-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, '..', 'data', 'static');
const PORT = process.env.PORT || 3500;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.set('trust proxy', true);

// ============================================================
// Utils
// ============================================================
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function identifyAgent(req) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  let agentType = 'unknown';
  if (ua.includes('gptbot') || ua.includes('oai-searchbot') || ua.includes('chatgpt-user')) agentType = 'gpt';
  else if (ua.includes('claude') || ua.includes('anthropic')) agentType = 'claude';
  else if (ua.includes('gemini') || ua.includes('googlebot') || ua.includes('googleother')) agentType = 'gemini';
  else if (ua.includes('perplexity')) agentType = 'perplexity';
  else if (ua.includes('mozilla') && ua.includes('chrome')) agentType = 'browser';
  else if (ua.includes('curl') || ua.includes('wget') || ua.includes('python') || ua.includes('node')) agentType = 'script';

  const agentId = ua.substring(0, 200);
  return { agentType, agentId };
}

async function logAccess(req, serviceName, tokens) {
  const { agentType, agentId } = identifyAgent(req);
  try {
    await db.run(`
      INSERT INTO agent_access_log (agent_id, agent_type, endpoint, query_params, service_requested, response_tokens, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [agentId, agentType, req.path, JSON.stringify(req.query), serviceName, tokens, req.ip]);
  } catch {}
}

function createOriginLeaf(content, parent = null) {
  const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
  const timestamp = new Date().toISOString();
  const contentHash = createHash('sha256').update(contentStr).digest('hex');
  const leafHash = createHash('sha256')
    .update(contentHash)
    .update(parent || 'root')
    .update(timestamp)
    .digest('hex');

  return {
    leaf: leafHash,
    parent: parent,
    timestamp,
    chain: 'registry.modelcontextprotocol.io → mcp.epistery.io extraction → this response',
    registry: 'mcp.epistery.io',
    verify: `https://mcp.epistery.io/api/verify/${leafHash}`,
    keep_alive: 'Include this leaf as parent when citing this data',
  };
}

// ============================================================
// MCP protocol helpers (same flow as prober.js)
// ============================================================
const MCP_TIMEOUT = 15000;
const MCP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
  'User-Agent': 'mcp-registry-proxy/0.1',
};

function parseMcpResponse(text) {
  try { return JSON.parse(text); } catch {}
  const dataLine = text.split('\n').find(l => l.startsWith('data: '));
  if (dataLine) {
    try { return JSON.parse(dataLine.slice(6)); } catch {}
  }
  return null;
}

async function mcpInitSession(endpoint) {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        clientInfo: { name: 'mcp-registry-proxy', version: '0.1.0' },
        capabilities: {},
      },
    }),
    signal: AbortSignal.timeout(MCP_TIMEOUT),
  });

  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, status: 'auth_required', code: resp.status };
  }
  if (!resp.ok) {
    return { ok: false, status: 'http_error', code: resp.status };
  }

  const sessionId = resp.headers.get('mcp-session-id');
  const sessionHeader = sessionId ? { 'mcp-session-id': sessionId } : {};
  await resp.text(); // consume body

  // Send notifications/initialized
  await fetch(endpoint, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...sessionHeader },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    signal: AbortSignal.timeout(MCP_TIMEOUT),
  }).catch(() => {});

  return { ok: true, sessionHeader };
}

async function mcpToolsList(endpoint) {
  const start = Date.now();
  const session = await mcpInitSession(endpoint);
  if (!session.ok) {
    return { status: session.status, tools: [], response_time_ms: Date.now() - start };
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...session.sessionHeader },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(MCP_TIMEOUT),
  });

  const text = await resp.text();
  const data = parseMcpResponse(text);
  const tools = data?.result?.tools || [];

  return { status: 'ok', tools, response_time_ms: Date.now() - start };
}

async function mcpToolCall(endpoint, toolName, args) {
  const start = Date.now();
  const session = await mcpInitSession(endpoint);
  if (!session.ok) {
    return { status: session.status, data: null, response_time_ms: Date.now() - start };
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...session.sessionHeader },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
    signal: AbortSignal.timeout(MCP_TIMEOUT),
  });

  const text = await resp.text();
  const data = parseMcpResponse(text);

  return { status: 'ok', data: data?.result || data, response_time_ms: Date.now() - start };
}

// ============================================================
// Middleware — AI discovery headers
// ============================================================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
  res.setHeader('X-Robots-Tag', 'all');
  res.setHeader('Link', '</.well-known/ai>; rel="ai-discovery"; type="application/json"');
  res.setHeader('X-Registry', 'mcp.epistery.io - AI-native MCP service discovery');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ============================================================
// Root — content negotiation
// ============================================================
async function rootJson() {
  const stats = await getStats();
  return {
    registry: 'MCP Service Registry by Rootz',
    description: 'AI-readable directory of MCP (Model Context Protocol) services. Tool schemas, live probes, cryptographic provenance.',
    version: '0.1.0',
    domain: 'mcp.epistery.io',
    start_here: {
      '1_find_service': 'GET /api/search?q=stripe',
      '2_service_detail': 'GET /api/service/{name}',
      '3_find_tool': 'GET /api/tool/{tool_name}',
      '4_categories': 'GET /api/categories',
      '5_mcp_native': 'POST /mcp (5 tools for programmatic discovery)',
    },
    stats,
    origin_parallel: {
      origin: 'origin.rootz.global — SEC data for public companies',
      mcp_registry: 'mcp.epistery.io — MCP service registry',
      pattern: 'Same stack (MySQL + Express + flat HTML + .well-known/ai) — proven at 134K agent queries/week',
    },
    discovery: '.well-known/ai',
    license: 'CC-BY-SA-4.0 + commercial validation required',
    operator: 'Rootz Corp',
  };
}

async function getStats() {
  return {
    services: (await db.get('SELECT COUNT(*) as n FROM services')).n,
    with_tools: (await db.get('SELECT COUNT(*) as n FROM services WHERE tools_count > 0')).n,
    total_tools: (await db.get('SELECT COUNT(*) as n FROM tools')).n,
    with_repo: (await db.get('SELECT COUNT(*) as n FROM services WHERE repository_url IS NOT NULL')).n,
    with_endpoint: (await db.get('SELECT COUNT(*) as n FROM services WHERE mcp_endpoint IS NOT NULL')).n,
    reachable: (await db.get("SELECT COUNT(*) as n FROM services WHERE probe_status = 'reachable'")).n,
    categories: (await db.get('SELECT COUNT(*) as n FROM categories WHERE service_count > 0')).n,
  };
}

app.get('/', async (req, res) => {
  logAccess(req, null, 200);
  const { agentType } = identifyAgent(req);
  const accept = req.headers.accept || '';

  if (accept.includes('application/json') || agentType === 'script') {
    return res.json(await rootJson());
  }

  // HTML for browsers and crawlers
  const stats = await getStats();
  const topCategories = await db.all('SELECT slug, name, service_count FROM categories WHERE service_count > 0 ORDER BY service_count DESC LIMIT 10');

  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MCP Service Registry — mcp.epistery.io</title>
<meta name="description" content="AI-readable directory of ${stats.services}+ MCP services with tool schemas, live probes, and cryptographic provenance.">
<link rel="alternate" type="application/json" href="/">
<link rel="canonical" href="https://mcp.epistery.io/">
<meta name="robots" content="all">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 2em; margin: 0 0 8px; }
  .tag { display: inline-block; background: #0066cc; color: white; padding: 2px 10px; border-radius: 12px; font-size: 0.85em; margin-right: 4px; }
  .card { background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; }
  .stat { text-align: center; }
  .stat-num { font-size: 2em; font-weight: bold; color: #0066cc; }
  .stat-label { color: #666; font-size: 0.9em; }
  a { color: #0066cc; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .cats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
  .cat { background: #f5f5f5; padding: 10px 14px; border-radius: 6px; }
  code { background: #eee; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
</style>
</head>
<body>
<h1>MCP Service Registry</h1>
<p><span class="tag">AI-native</span> <span class="tag">open</span> <span class="tag">signed</span></p>
<p>AI-readable directory of MCP (Model Context Protocol) services. Built on the Origin pattern — the same discovery stack that serves <a href="https://origin.rootz.global">134K agent queries/week</a> for SEC company data.</p>

<div class="card">
<div class="stats">
<div class="stat"><div class="stat-num">${stats.services}</div><div class="stat-label">Services</div></div>
<div class="stat"><div class="stat-num">${stats.total_tools}</div><div class="stat-label">Tools</div></div>
<div class="stat"><div class="stat-num">${stats.reachable}</div><div class="stat-label">Live endpoints</div></div>
<div class="stat"><div class="stat-num">${stats.categories}</div><div class="stat-label">Categories</div></div>
</div>
</div>

<h2>Categories</h2>
<div class="cats">
${topCategories.map(c => `<div class="cat"><a href="/api/services?category=${c.slug}"><strong>${escapeHtml(c.name)}</strong></a><br><small>${c.service_count} services</small></div>`).join('')}
</div>

<h2>For AI Agents</h2>
<p>Connect via MCP: <code>claude mcp add rootz-mcp-registry --transport http https://mcp.epistery.io/mcp</code></p>
<p>Discovery document: <a href="/.well-known/ai">/.well-known/ai</a></p>
<p>Search: <a href="/api/search?q=stripe">/api/search?q=stripe</a></p>

<h2>For Humans</h2>
<p>Browse <a href="/api/categories">categories</a>, search <a href="/api/search?q=email">services</a>, or <a href="/register">register your MCP service</a>.</p>

<footer style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; color: #666; font-size: 0.85em;">
<a href="https://rootz.global">Rootz</a> · <a href="/.well-known/ai">.well-known/ai</a> · <a href="/api/stats">stats</a> · <a href="https://origin.rootz.global">origin.rootz.global</a>
</footer>
</body>
</html>`);
});

// ============================================================
// /.well-known/ai — the machine-readable discovery document
// ============================================================
app.get('/.well-known/ai', async (req, res) => {
  logAccess(req, null, 300);
  const stats = await getStats();
  res.json({
    '$schema': 'https://rootz.global/schemas/well-known-ai-v1.json',
    service: {
      name: 'MCP Service Registry',
      domain: 'mcp.epistery.io',
      description: 'AI-readable directory of MCP (Model Context Protocol) services with tool schemas, live probes, and cryptographic provenance.',
      type: 'registry',
      operator: 'Rootz Corp',
      license: 'CC-BY-SA-4.0 + commercial validation required',
    },
    stats,
    capabilities: {
      search_services: {
        method: 'GET',
        path: '/api/search?q={query}',
        description: 'Full-text search across service names and descriptions',
      },
      service_detail: {
        method: 'GET',
        path: '/api/service/{name}',
        description: 'Full service profile with tool schemas',
      },
      find_tool: {
        method: 'GET',
        path: '/api/tool/{name}',
        description: 'Find which services offer a specific tool',
      },
      list_categories: {
        method: 'GET',
        path: '/api/categories',
        description: 'List all service categories',
      },
      filter_by_category: {
        method: 'GET',
        path: '/api/services?category={slug}',
        description: 'List services in a category',
      },
      mcp_endpoint: {
        method: 'POST',
        path: '/mcp',
        description: 'Native MCP endpoint — 5 discovery tools',
        transport: 'streamable-http',
      },
    },
    mcp_tools: [
      'mcp_find_service',
      'mcp_service_detail',
      'mcp_find_tool',
      'mcp_categories',
      'mcp_stats',
    ],
    data_sources: [
      'https://registry.modelcontextprotocol.io/v0.1/servers (primary)',
      'Git repositories (tool schema extraction)',
      'Live MCP endpoint probes (ground-truth tool lists)',
    ],
    provenance: {
      signing: 'Every response includes origin leaf hash',
      verify: '/api/verify/{leaf}',
      chain: 'registry.modelcontextprotocol.io → mcp.epistery.io → agent',
    },
    related_services: {
      origin: {
        domain: 'origin.rootz.global',
        description: 'SEC data for US public companies — same pattern, different domain',
      },
    },
  });
});

// ============================================================
// GET /api/search — find services by query
// ============================================================
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const category = req.query.category || null;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  logAccess(req, null, 500);

  if (!q && !category) {
    return res.status(400).json({
      error: 'Provide q or category parameter',
      example: '/api/search?q=stripe',
    });
  }

  let sql, params;
  if (q && category) {
    sql = `SELECT id, name, slug, title, description, category, tools_count, probe_status, stars
           FROM services
           WHERE category = ? AND (title LIKE ? OR description LIKE ? OR name LIKE ?)
           ORDER BY tools_count DESC, stars DESC LIMIT ${limit}`;
    params = [category, `%${q}%`, `%${q}%`, `%${q}%`];
  } else if (category) {
    sql = `SELECT id, name, slug, title, description, category, tools_count, probe_status, stars
           FROM services WHERE category = ? ORDER BY tools_count DESC, stars DESC LIMIT ${limit}`;
    params = [category];
  } else {
    sql = `SELECT id, name, slug, title, description, category, tools_count, probe_status, stars
           FROM services
           WHERE title LIKE ? OR description LIKE ? OR name LIKE ?
           ORDER BY tools_count DESC, stars DESC LIMIT ${limit}`;
    params = [`%${q}%`, `%${q}%`, `%${q}%`];
  }

  const rows = await db.all(sql, params);
  res.json({
    query: { q, category, limit },
    count: rows.length,
    results: rows.map(r => ({
      name: r.name,
      title: r.title,
      description: r.description,
      category: r.category,
      tools_count: r.tools_count,
      reachable: r.probe_status === 'reachable',
      detail_url: `/api/service/${encodeURIComponent(r.name)}`,
    })),
    origin: createOriginLeaf({ q, category, count: rows.length }),
  });
});

// ============================================================
// GET /api/service/:name — service profile with tools
// ============================================================
app.get('/api/service/:name(*)', async (req, res) => {
  const name = req.params.name;
  const service = await db.get('SELECT * FROM services WHERE name = ? OR slug = ?', [name, name]);
  if (!service) {
    logAccess(req, name, 100);
    return res.status(404).json({ error: 'Service not found', name });
  }

  logAccess(req, service.name, 800);

  const tools = await db.all('SELECT name, description, input_schema, source FROM tools WHERE service_id = ?', [service.id]);
  const recentProbe = await db.get('SELECT * FROM probes WHERE service_id = ? ORDER BY probed_at DESC LIMIT 1', [service.id]);

  res.json({
    name: service.name,
    title: service.title,
    description: service.description,
    version: service.version,
    category: service.category,
    website_url: service.website_url,
    repository: service.repository_url,
    mcp_endpoint: service.mcp_endpoint,
    transport: service.transport_type,
    auth_required: !!service.auth_required,
    install: service.package_registry && service.package_name ? {
      registry: service.package_registry,
      package: service.package_name,
    } : null,
    env_vars: service.env_vars ? JSON.parse(service.env_vars) : [],
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema ? JSON.parse(t.input_schema) : null,
      source: t.source,
    })),
    tools_count: service.tools_count,
    probe: recentProbe ? {
      status: service.probe_status,
      last_probed: service.last_probed,
      response_time_ms: recentProbe.response_time_ms,
    } : null,
    registry_status: service.registry_status,
    registry_published_at: service.registry_published_at,
    registry_updated_at: service.registry_updated_at,
    origin: createOriginLeaf(service),
  });
});

// ============================================================
// POST /api/service/:name/tools — live tools/list from MCP endpoint
// ============================================================
app.post('/api/service/:name(*)/tools', async (req, res) => {
  const name = req.params.name;
  const service = await db.get('SELECT * FROM services WHERE name = ? OR slug = ?', [name, name]);
  if (!service) return res.status(404).json({ error: 'Service not found', name });
  if (!service.mcp_endpoint) return res.status(400).json({ error: 'Service has no MCP endpoint', name });

  logAccess(req, service.name, 500);

  try {
    const result = await mcpToolsList(service.mcp_endpoint);
    res.json({
      service: service.name,
      endpoint: service.mcp_endpoint,
      status: result.status,
      tools: result.tools,
      response_time_ms: result.response_time_ms,
    });
  } catch (e) {
    res.status(502).json({ error: 'Probe failed', message: e.message });
  }
});

// ============================================================
// POST /api/service/:name/call — proxy a tools/call to MCP endpoint
// ============================================================
app.post('/api/service/:name(*)/call', async (req, res) => {
  const name = req.params.name;
  const service = await db.get('SELECT * FROM services WHERE name = ? OR slug = ?', [name, name]);
  if (!service) return res.status(404).json({ error: 'Service not found', name });
  if (!service.mcp_endpoint) return res.status(400).json({ error: 'Service has no MCP endpoint', name });

  const { tool, arguments: args } = req.body || {};
  if (!tool) return res.status(400).json({ error: 'Request body must include "tool" name' });

  logAccess(req, service.name, 800);

  try {
    const result = await mcpToolCall(service.mcp_endpoint, tool, args || {});
    res.json({
      service: service.name,
      tool,
      status: result.status,
      result: result.data,
      response_time_ms: result.response_time_ms,
    });
  } catch (e) {
    res.status(502).json({ error: 'Call failed', message: e.message });
  }
});

// ============================================================
// GET /api/tool/:name — find which services offer this tool
// ============================================================
app.get('/api/tool/:name', async (req, res) => {
  const name = req.params.name;
  logAccess(req, null, 400);

  const exact = await db.all(`
    SELECT s.name, s.title, s.description, s.category, s.mcp_endpoint, t.description as tool_description
    FROM tools t JOIN services s ON t.service_id = s.id
    WHERE t.name = ?
    ORDER BY s.tools_count DESC
  `, [name]);

  const fuzzy = await db.all(`
    SELECT s.name, s.title, s.description, s.category, s.mcp_endpoint, t.name as tool_name, t.description as tool_description
    FROM tools t JOIN services s ON t.service_id = s.id
    WHERE t.name LIKE ? AND t.name != ?
    ORDER BY s.tools_count DESC LIMIT 20
  `, [`%${name}%`, name]);

  res.json({
    query: name,
    exact_matches: exact.length,
    similar_matches: fuzzy.length,
    exact,
    similar: fuzzy,
    origin: createOriginLeaf({ tool: name, matches: exact.length + fuzzy.length }),
  });
});

// ============================================================
// GET /api/categories
// ============================================================
app.get('/api/categories', async (req, res) => {
  logAccess(req, null, 300);
  const cats = await db.all('SELECT slug, name, description, service_count FROM categories WHERE service_count > 0 ORDER BY service_count DESC');
  res.json({
    count: cats.length,
    categories: cats.map(c => ({
      ...c,
      url: `/api/services?category=${c.slug}`,
    })),
  });
});

// ============================================================
// GET /api/services — list with optional filter
// ============================================================
app.get('/api/services', async (req, res) => {
  const category = req.query.category;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  logAccess(req, null, 600);

  const where = category ? 'WHERE category = ?' : '';
  const params = category ? [category] : [];

  const rows = await db.all(`
    SELECT name, slug, title, description, category, tools_count, probe_status
    FROM services ${where}
    ORDER BY tools_count DESC, stars DESC
    LIMIT ${Number(limit)} OFFSET ${Number(offset)}
  `, params);

  const totalRow = category
    ? await db.get('SELECT COUNT(*) as n FROM services WHERE category = ?', [category])
    : await db.get('SELECT COUNT(*) as n FROM services');
  const total = totalRow.n;

  res.json({
    category: category || null,
    total,
    limit,
    offset,
    services: rows,
  });
});

// ============================================================
// POST /api/services — register or update a service
// ============================================================
app.post('/api/services', async (req, res) => {
  const { name, title, description, category, mcp_endpoint, transport_type, website_url, repository_url } = req.body || {};

  if (!name) return res.status(400).json({ error: 'name is required' });

  logAccess(req, name, 300);

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  try {
    // UPSERT — insert or update on duplicate name
    await db.run(`
      INSERT INTO services (name, slug, title, description, category, mcp_endpoint, transport_type, website_url, repository_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        slug = VALUES(slug),
        title = COALESCE(VALUES(title), title),
        description = COALESCE(VALUES(description), description),
        category = COALESCE(VALUES(category), category),
        mcp_endpoint = COALESCE(VALUES(mcp_endpoint), mcp_endpoint),
        transport_type = COALESCE(VALUES(transport_type), transport_type),
        website_url = COALESCE(VALUES(website_url), website_url),
        repository_url = COALESCE(VALUES(repository_url), repository_url)
    `, [name, slug, title || null, description || null, category || null, mcp_endpoint || null, transport_type || null, website_url || null, repository_url || null]);

    // Update category count
    if (category) {
      await db.run('UPDATE categories SET service_count = (SELECT COUNT(*) FROM services WHERE category = ?) WHERE slug = ?', [category, category]);
    }

    const service = await db.get('SELECT id, name, slug, title, description, category, mcp_endpoint, transport_type FROM services WHERE name = ?', [name]);

    // Optional: auto-probe if endpoint provided
    let probeResult = null;
    if (mcp_endpoint && transport_type === 'streamable-http') {
      try {
        probeResult = await mcpToolsList(mcp_endpoint);
        if (probeResult.tools.length > 0) {
          await db.run('UPDATE services SET probe_status = ?, tools_count = ?, last_probed = NOW() WHERE id = ?',
            [probeResult.status === 'ok' ? 'reachable' : probeResult.status, probeResult.tools.length, service.id]);
          for (const t of probeResult.tools) {
            const schema = t.inputSchema ? JSON.stringify(t.inputSchema) : null;
            await db.run(
              'REPLACE INTO tools (service_id, name, description, input_schema, source) VALUES (?, ?, ?, ?, ?)',
              [service.id, t.name, t.description || '', schema, 'registration']
            );
          }
        }
      } catch (e) {
        probeResult = { status: 'error', error: e.message };
      }
    }

    res.json({
      status: 'ok',
      service,
      probe: probeResult ? { status: probeResult.status, tools_found: probeResult.tools?.length || 0 } : null,
    });
  } catch (e) {
    res.status(500).json({ error: 'Registration failed', message: e.message });
  }
});

// ============================================================
// POST /api/service/:name/register-tools — submit tool schemas directly
// ============================================================
app.post('/api/service/:name(*)/register-tools', async (req, res) => {
  const name = req.params.name;
  const service = await db.get('SELECT * FROM services WHERE name = ? OR slug = ?', [name, name]);
  if (!service) return res.status(404).json({ error: 'Service not found', name });

  const { tools } = req.body || {};
  if (!Array.isArray(tools) || tools.length === 0) {
    return res.status(400).json({ error: 'Request body must include "tools" array with at least one tool' });
  }

  logAccess(req, service.name, 400);

  try {
    let added = 0;
    for (const t of tools) {
      if (!t.name) continue;
      const schema = t.input_schema ? JSON.stringify(t.input_schema) : null;
      await db.run(
        `INSERT INTO tools (service_id, name, description, input_schema, source)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           description = VALUES(description),
           input_schema = VALUES(input_schema),
           source = VALUES(source)`,
        [service.id, t.name, t.description || '', schema, 'manual']
      );
      added++;
    }

    // Update tools_count on the service
    const countRow = await db.get('SELECT COUNT(*) as n FROM tools WHERE service_id = ?', [service.id]);
    await db.run('UPDATE services SET tools_count = ?, tools_extracted = 1 WHERE id = ?', [countRow.n, service.id]);

    res.json({
      status: 'ok',
      service: service.name,
      tools_added: added,
      total_tools: countRow.n,
    });
  } catch (e) {
    res.status(500).json({ error: 'Tool registration failed', message: e.message });
  }
});

// ============================================================
// GET /register — tool registration UI
// ============================================================
app.get('/register', async (req, res) => {
  const categories = await db.all('SELECT slug, name FROM categories ORDER BY name');
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Register — MCP Service Registry</title>
<meta name="description" content="Submit your MCP service and tools to the registry.">
<link rel="canonical" href="https://mcp.epistery.io/register">
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #1a1a1a; }
  h1 { margin: 0 0 4px; }
  h2 { margin: 28px 0 12px; font-size: 1.2em; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  a { color: #0066cc; text-decoration: none; }
  a:hover { text-decoration: underline; }
  label { display: block; font-weight: 600; margin: 12px 0 4px; font-size: 0.9em; }
  input, select, textarea { width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.95em; font-family: inherit; }
  textarea { resize: vertical; font-family: ui-monospace, 'Cascadia Code', Menlo, monospace; font-size: 0.85em; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 2px rgba(0,102,204,0.15); }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .hint { color: #666; font-size: 0.8em; margin: 2px 0 0; }
  button { background: #0066cc; color: white; border: none; padding: 10px 24px; border-radius: 4px; font-size: 1em; cursor: pointer; margin-top: 8px; }
  button:hover { background: #0052a3; }
  button.secondary { background: #666; }
  button.secondary:hover { background: #555; }
  .tool-entry { background: #f7f7f7; border: 1px solid #e0e0e0; border-radius: 6px; padding: 14px; margin: 8px 0; position: relative; }
  .tool-entry .remove { position: absolute; top: 8px; right: 10px; background: none; border: none; color: #c00; cursor: pointer; font-size: 1.1em; padding: 0; margin: 0; }
  #result { margin-top: 20px; padding: 14px; border-radius: 6px; display: none; }
  #result.ok { display: block; background: #e8f5e9; border: 1px solid #4caf50; }
  #result.err { display: block; background: #ffebee; border: 1px solid #f44336; }
  .or-divider { text-align: center; color: #999; margin: 20px 0; font-size: 0.9em; }
  .or-divider span { background: white; padding: 0 12px; }
  .or-divider::before { content: ''; display: block; border-top: 1px solid #ddd; margin-bottom: -10px; }
</style>
</head>
<body>
<h1>Register a Service</h1>
<p>Add your MCP server to the <a href="/">Epistery MCP Registry</a>. Provide an endpoint to auto-discover tools, or add them manually below.</p>

<form id="regForm">
<h2>Service</h2>
<label for="name">Name *</label>
<input id="name" name="name" required placeholder="com.yourorg/service-name">
<p class="hint">Unique identifier. Convention: com.org/name or @scope/name</p>

<div class="row">
  <div>
    <label for="title">Title</label>
    <input id="title" name="title" placeholder="My MCP Service">
  </div>
  <div>
    <label for="category">Category</label>
    <select id="category" name="category">
      <option value="">— select —</option>
      ${categories.map(c => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.name)}</option>`).join('\n      ')}
    </select>
  </div>
</div>

<label for="description">Description</label>
<textarea id="description" name="description" rows="2" placeholder="What does this service do?"></textarea>

<div class="row">
  <div>
    <label for="mcp_endpoint">MCP Endpoint</label>
    <input id="mcp_endpoint" name="mcp_endpoint" type="url" placeholder="https://your-server.com/mcp">
  </div>
  <div>
    <label for="transport_type">Transport</label>
    <select id="transport_type" name="transport_type">
      <option value="">— select —</option>
      <option value="streamable-http" selected>streamable-http</option>
      <option value="sse">SSE</option>
      <option value="stdio">stdio</option>
    </select>
  </div>
</div>

<div class="row">
  <div>
    <label for="website_url">Website</label>
    <input id="website_url" name="website_url" type="url" placeholder="https://...">
  </div>
  <div>
    <label for="repository_url">Repository</label>
    <input id="repository_url" name="repository_url" type="url" placeholder="https://github.com/...">
  </div>
</div>

<div class="or-divider"><span>tools — auto-probe or add manually</span></div>

<p style="font-size:0.9em; color:#555;">If you provided a streamable-http endpoint above, we'll auto-probe it for tools. Otherwise, add tools manually:</p>

<div id="tools-list"></div>
<button type="button" class="secondary" onclick="addTool()">+ Add tool</button>

<div style="margin-top: 24px;">
  <button type="submit">Register</button>
</div>
</form>

<div id="result"></div>

<script>
let toolIdx = 0;

function addTool(data) {
  const i = toolIdx++;
  const div = document.createElement('div');
  div.className = 'tool-entry';
  div.id = 'tool-' + i;
  div.innerHTML = \`
    <button type="button" class="remove" onclick="this.parentElement.remove()">&times;</button>
    <div class="row">
      <div>
        <label>Tool name *</label>
        <input name="tool_name_\${i}" required value="\${data?.name || ''}" placeholder="create_customer">
      </div>
      <div>
        <label>Description</label>
        <input name="tool_desc_\${i}" value="\${data?.description || ''}" placeholder="Creates a new customer record">
      </div>
    </div>
    <label>Input schema (JSON)</label>
    <textarea name="tool_schema_\${i}" rows="4" placeholder='{"type":"object","properties":{"name":{"type":"string"}}}'>\${data?.input_schema ? JSON.stringify(data.input_schema, null, 2) : ''}</textarea>
  \`;
  document.getElementById('tools-list').appendChild(div);
}

document.getElementById('regForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById('result');
  resultEl.className = '';
  resultEl.style.display = 'none';

  const fd = new FormData(e.target);
  const body = {
    name: fd.get('name'),
    title: fd.get('title') || undefined,
    description: fd.get('description') || undefined,
    category: fd.get('category') || undefined,
    mcp_endpoint: fd.get('mcp_endpoint') || undefined,
    transport_type: fd.get('transport_type') || undefined,
    website_url: fd.get('website_url') || undefined,
    repository_url: fd.get('repository_url') || undefined,
  };

  try {
    // 1. Register the service
    const svcResp = await fetch('/api/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const svcData = await svcResp.json();
    if (!svcResp.ok) throw new Error(svcData.error || 'Registration failed');

    // 2. Submit manual tools if any
    const toolEntries = document.querySelectorAll('.tool-entry');
    let manualTools = [];
    toolEntries.forEach((el, idx) => {
      const nameInput = el.querySelector('input[name^="tool_name_"]');
      const descInput = el.querySelector('input[name^="tool_desc_"]');
      const schemaInput = el.querySelector('textarea[name^="tool_schema_"]');
      if (nameInput?.value) {
        let schema = null;
        try { schema = schemaInput?.value ? JSON.parse(schemaInput.value) : null; } catch {}
        manualTools.push({ name: nameInput.value, description: descInput?.value || '', input_schema: schema });
      }
    });

    if (manualTools.length > 0) {
      const toolResp = await fetch('/api/service/' + encodeURIComponent(body.name) + '/register-tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools: manualTools }),
      });
      const toolData = await toolResp.json();
      if (!toolResp.ok) throw new Error(toolData.error || 'Tool registration failed');
      svcData.manual_tools = toolData;
    }

    let msg = '<strong>Registered:</strong> ' + body.name;
    if (svcData.probe?.tools_found) msg += '<br>Auto-probed ' + svcData.probe.tools_found + ' tools from endpoint';
    if (svcData.manual_tools?.tools_added) msg += '<br>' + svcData.manual_tools.tools_added + ' manual tools added';
    msg += '<br><a href="/api/service/' + encodeURIComponent(body.name) + '">View service &rarr;</a>';
    resultEl.className = 'ok';
    resultEl.innerHTML = msg;
  } catch (err) {
    resultEl.className = 'err';
    resultEl.innerHTML = '<strong>Error:</strong> ' + err.message;
  }
});
</script>

<footer style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; color: #666; font-size: 0.85em;">
<a href="/">Home</a> · <a href="/api/categories">Categories</a> · <a href="/.well-known/ai">.well-known/ai</a> · <a href="https://rootz.global">Rootz</a>
</footer>
</body>
</html>`);
});

// ============================================================
// GET /api/stats
// ============================================================
app.get('/api/stats', async (req, res) => {
  logAccess(req, null, 200);
  res.json(await getStats());
});

// ============================================================
// MCP endpoint — native AI discovery
// ============================================================
app.post('/mcp', async (req, res) => {
  const request = req.body;
  if (!request || !request.method) {
    return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid request' } });
  }

  // Log MCP detail
  const toolName = request.params?.name || null;
  const toolArgs = request.params?.arguments || null;
  req.query = { mcp_method: request.method, tool: toolName, args: toolArgs };
  logAccess(req, toolArgs?.name || null, 500);

  const response = await handleMcpRequest(request);
  if (response) res.json(response);
  else res.status(204).end();
});

// ============================================================
// Robots, sitemap, well-known
// ============================================================
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`# Welcome crawlers
User-agent: *
Allow: /

User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: PerplexityBot
Allow: /

Sitemap: https://mcp.epistery.io/sitemap.xml
`);
});

app.get('/sitemap.xml', async (req, res) => {
  const services = await db.all('SELECT slug FROM services WHERE slug IS NOT NULL ORDER BY tools_count DESC LIMIT 10000');
  const categories = await db.all('SELECT slug FROM categories WHERE service_count > 0');
  const today = new Date().toISOString().split('T')[0];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://mcp.epistery.io/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq></url>
  <url><loc>https://mcp.epistery.io/.well-known/ai</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq></url>
  <url><loc>https://mcp.epistery.io/api/categories</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq></url>
`;
  for (const c of categories) {
    xml += `  <url><loc>https://mcp.epistery.io/static/category/${c.slug}.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq></url>\n`;
  }
  for (const s of services) {
    xml += `  <url><loc>https://mcp.epistery.io/static/service/${s.slug}.html</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq></url>\n`;
  }
  xml += '</urlset>\n';
  res.type('application/xml').send(xml);
});

// ============================================================
// Static HTML serving
// Google Search Console verification
app.get('/googlead5922a13359c897.html', (req, res) => {
  res.sendFile(join(__dirname, '..', 'googlead5922a13359c897.html'));
});

// ============================================================
app.use('/static', express.static(STATIC_DIR, {
  extensions: ['html'],
  maxAge: '1h',
}));

// ============================================================
// Express error middleware — catch unhandled route errors
// ============================================================
app.use((err, req, res, next) => {
  console.error('[mcp-registry] Express error:', err.message || err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ============================================================
// Health endpoint
// ============================================================
app.get('/health', async (req, res) => {
  try {
    await db.get('SELECT 1');
    res.json({ status: 'ok', service: 'mcp-registry', pid: process.pid });
  } catch (e) {
    res.status(503).json({ status: 'error', message: e.message });
  }
});

// ============================================================
// Start
// ============================================================
const UPSTREAM = process.env.UPSTREAM === '1' || process.env.UPSTREAM === 'true';
let server;

async function start() {
  await db.init();
  const stats = await getStats();
  server = app.listen(PORT, () => {
    console.log(`MCP Service Registry`);
    console.log(`  Port:     ${PORT}`);
    if (UPSTREAM) console.log(`  Mode:     UPSTREAM (TLS terminated by harness)`);
    console.log(`  Services: ${stats.services}`);
    console.log(`  Tools:    ${stats.total_tools}`);
    console.log(`  Reachable: ${stats.reachable}`);
    console.log(`  URL:      http://localhost:${PORT}/`);
  });
}

async function shutdown(signal) {
  console.log(`[mcp-registry] ${signal} received, shutting down...`);
  if (server) await new Promise(resolve => server.close(resolve));
  await db.pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[mcp-registry] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[mcp-registry] Unhandled rejection:', reason);
});

start().catch(e => {
  console.error('Server start failed:', e);
  process.exit(1);
});
