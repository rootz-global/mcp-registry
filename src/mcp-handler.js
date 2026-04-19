/**
 * MCP Protocol Handler — Native MCP tools for the registry itself
 *
 * This lets AI agents discover MCP services programmatically via MCP.
 */
import db from './db.js';

export const MCP_TOOLS = [
  {
    name: 'mcp_find_service',
    description: 'Find MCP services by keyword or category. Use this FIRST when looking for MCP tools to solve a task. Returns a ranked list with tool counts and endpoint status. Example: "Find MCP services for filing taxes" → mcp_find_service({query: "taxes"})',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term — what do you need the service to do? (e.g. "stripe", "email", "github", "weather")' },
        category: { type: 'string', description: 'Optional category filter. Use mcp_categories to list all.' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'mcp_service_detail',
    description: 'Get full details for an MCP service including all tool schemas, endpoint URL, auth requirements, and install instructions. Use after mcp_find_service to pick the best option.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Service name (e.g. "com.stripe/mcp") — use the name from mcp_find_service results' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mcp_find_tool',
    description: 'Find which MCP services offer a specific tool by name. Example: "which services have a create_customer tool?"',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Tool name to find (e.g. "create_customer", "search_web")' },
      },
      required: ['tool_name'],
    },
  },
  {
    name: 'mcp_categories',
    description: 'List all MCP service categories with service counts. Use this to discover what kinds of services exist before searching.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mcp_stats',
    description: 'Get registry statistics: total services, tools, categories, probe coverage. Useful for understanding what is available.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function toolFindService(args) {
  const q = (args.query || '').trim();
  const category = args.category || null;
  const limit = Math.min(args.limit || 10, 50);

  let sql, params;
  if (q && category) {
    sql = `SELECT name, title, description, category, tools_count, probe_status
           FROM services WHERE category = ? AND (title LIKE ? OR description LIKE ? OR name LIKE ?)
           ORDER BY tools_count DESC LIMIT ?`;
    params = [category, `%${q}%`, `%${q}%`, `%${q}%`, limit];
  } else if (category) {
    sql = `SELECT name, title, description, category, tools_count, probe_status
           FROM services WHERE category = ? ORDER BY tools_count DESC LIMIT ?`;
    params = [category, limit];
  } else {
    sql = `SELECT name, title, description, category, tools_count, probe_status
           FROM services WHERE title LIKE ? OR description LIKE ? OR name LIKE ?
           ORDER BY tools_count DESC LIMIT ?`;
    params = [`%${q}%`, `%${q}%`, `%${q}%`, limit];
  }

  const results = await db.all(sql, params);
  return {
    query: { q, category, limit },
    count: results.length,
    services: results.map(r => ({
      name: r.name,
      title: r.title,
      description: r.description,
      category: r.category,
      tools: r.tools_count,
      reachable: r.probe_status === 'reachable',
      detail_via: `mcp_service_detail({name: "${r.name}"})`,
    })),
    agent_hint: results.length > 0
      ? `Found ${results.length} matching services. Pick one and call mcp_service_detail to see its tools.`
      : `No services found matching "${q}". Try a different search term or call mcp_categories to browse.`,
  };
}

async function toolServiceDetail(args) {
  const svc = await db.get('SELECT * FROM services WHERE name = ? OR slug = ?', [args.name, args.name]);
  if (!svc) return { error: `Service not found: ${args.name}`, agent_hint: 'Use mcp_find_service to search.' };

  const tools = await db.all('SELECT name, description, input_schema, source FROM tools WHERE service_id = ?', [svc.id]);

  return {
    name: svc.name,
    title: svc.title,
    description: svc.description,
    version: svc.version,
    category: svc.category,
    website: svc.website_url,
    repository: svc.repository_url,
    mcp_endpoint: svc.mcp_endpoint,
    transport: svc.transport_type,
    auth_required: !!svc.auth_required,
    env_vars: svc.env_vars ? JSON.parse(svc.env_vars) : [],
    install: svc.package_name ? {
      registry: svc.package_registry,
      package: svc.package_name,
    } : null,
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema ? JSON.parse(t.input_schema) : null,
    })),
    tools_count: tools.length,
    probe_status: svc.probe_status,
    last_probed: svc.last_probed,
    agent_hint: svc.mcp_endpoint
      ? `To use this service, connect to ${svc.mcp_endpoint} via MCP. ${svc.auth_required ? 'Auth required — set env vars: ' + (svc.env_vars || 'unknown') : 'No auth required — can call directly.'}`
      : `Install locally: ${svc.package_registry || 'unknown'} package "${svc.package_name || svc.name}"`,
  };
}

async function toolFindTool(args) {
  const name = args.tool_name;
  const exact = await db.all(`
    SELECT s.name, s.title, s.category, t.description, s.mcp_endpoint
    FROM tools t JOIN services s ON t.service_id = s.id
    WHERE t.name = ?
    ORDER BY s.tools_count DESC
  `, [name]);

  const fuzzy = await db.all(`
    SELECT s.name, s.title, s.category, t.name as tool, t.description, s.mcp_endpoint
    FROM tools t JOIN services s ON t.service_id = s.id
    WHERE t.name LIKE ? AND t.name != ?
    ORDER BY s.tools_count DESC LIMIT 20
  `, [`%${name}%`, name]);

  return {
    tool: name,
    exact_matches: exact,
    similar_matches: fuzzy,
    agent_hint: exact.length > 0
      ? `Found ${exact.length} services with a tool named "${name}". Use mcp_service_detail to see the schema.`
      : fuzzy.length > 0
        ? `No exact match. Found ${fuzzy.length} services with similar tool names.`
        : `No tools found matching "${name}".`,
  };
}

async function toolCategories() {
  const cats = await db.all('SELECT slug, name, description, service_count FROM categories WHERE service_count > 0 ORDER BY service_count DESC');
  return {
    count: cats.length,
    categories: cats,
    agent_hint: 'Use mcp_find_service with the category parameter to filter.',
  };
}

async function toolStats() {
  return {
    services: (await db.get('SELECT COUNT(*) as n FROM services')).n,
    tools: (await db.get('SELECT COUNT(*) as n FROM tools')).n,
    categories: (await db.get('SELECT COUNT(*) as n FROM categories WHERE service_count > 0')).n,
    reachable: (await db.get("SELECT COUNT(*) as n FROM services WHERE probe_status = 'reachable'")).n,
    with_tools: (await db.get('SELECT COUNT(*) as n FROM services WHERE tools_count > 0')).n,
    with_repo: (await db.get('SELECT COUNT(*) as n FROM services WHERE repository_url IS NOT NULL')).n,
    top_services: await db.all('SELECT name, title, tools_count FROM services WHERE tools_count > 0 ORDER BY tools_count DESC LIMIT 10'),
    top_categories: await db.all('SELECT slug, name, service_count FROM categories WHERE service_count > 0 ORDER BY service_count DESC LIMIT 10'),
  };
}

export async function handleToolCall(name, args) {
  switch (name) {
    case 'mcp_find_service': return await toolFindService(args || {});
    case 'mcp_service_detail': return await toolServiceDetail(args || {});
    case 'mcp_find_tool': return await toolFindTool(args || {});
    case 'mcp_categories': return await toolCategories();
    case 'mcp_stats': return await toolStats();
    default: return { error: `Unknown tool: ${name}` };
  }
}

export async function handleMcpRequest(request) {
  const { method, params, id } = request;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        serverInfo: {
          name: 'rootz-mcp-registry',
          version: '0.1.0',
          description: 'AI-native MCP service registry. Discover MCP servers with structured tool schemas. Origin pattern applied to MCP.',
        },
        capabilities: { tools: { listChanged: false } },
      },
    };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  if (method === 'tools/call') {
    const result = await handleToolCall(params?.name, params?.arguments || {});
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      },
    };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}
