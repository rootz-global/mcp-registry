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
<p>Browse <a href="/api/categories">categories</a>, search <a href="/api/search?q=email">services</a>, or query the MCP endpoint directly.</p>

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
           ORDER BY tools_count DESC, stars DESC LIMIT ?`;
    params = [category, `%${q}%`, `%${q}%`, `%${q}%`, limit];
  } else if (category) {
    sql = `SELECT id, name, slug, title, description, category, tools_count, probe_status, stars
           FROM services WHERE category = ? ORDER BY tools_count DESC, stars DESC LIMIT ?`;
    params = [category, limit];
  } else {
    sql = `SELECT id, name, slug, title, description, category, tools_count, probe_status, stars
           FROM services
           WHERE title LIKE ? OR description LIKE ? OR name LIKE ?
           ORDER BY tools_count DESC, stars DESC LIMIT ?`;
    params = [`%${q}%`, `%${q}%`, `%${q}%`, limit];
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
  const params = category ? [category, limit, offset] : [limit, offset];

  const rows = await db.all(`
    SELECT name, slug, title, description, category, tools_count, probe_status
    FROM services ${where}
    ORDER BY tools_count DESC, stars DESC
    LIMIT ? OFFSET ?
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
// Start
// ============================================================
async function start() {
  await db.init();
  const stats = await getStats();
  app.listen(PORT, () => {
    console.log(`MCP Service Registry`);
    console.log(`  Port:     ${PORT}`);
    console.log(`  Services: ${stats.services}`);
    console.log(`  Tools:    ${stats.total_tools}`);
    console.log(`  Reachable: ${stats.reachable}`);
    console.log(`  URL:      http://localhost:${PORT}/`);
  });
}

start().catch(e => {
  console.error('Server start failed:', e);
  process.exit(1);
});
