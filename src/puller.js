/**
 * MCP Registry Puller
 *
 * Pulls all MCP servers from the official registry API and stores them locally.
 *
 * Usage:
 *   node src/puller.js              — pull all servers (paginated)
 *   node src/puller.js sample       — pull first 3 pages (~90 servers) for testing
 *   node src/puller.js all          — pull everything (default)
 *   node src/puller.js update       — refresh existing entries
 */
import db from './db.js';

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io/v0.1';
const USER_AGENT = 'Rootz MCP Registry research@rootz.global';
const RATE_LIMIT_MS = 500; // 2 req/sec — polite
const PAGE_SIZE = 100;

let lastRequestTime = 0;

async function rateLimitedFetch(url) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();

  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 120);
}

function extractServerData(entry) {
  // Each registry entry has shape: { server: {...}, _meta: {...} }
  const server = entry.server || entry;
  const _meta = entry._meta || server._meta || {};

  const name = server.name;
  if (!name) return null;

  const title = server.title || null;
  const description = server.description || '';
  const version = server.version || null;
  const websiteUrl = server.websiteUrl || null;

  // Repository
  let repoUrl = null, repoSource = null, repoSubfolder = null;
  if (server.repository) {
    if (typeof server.repository === 'string') {
      repoUrl = server.repository;
    } else {
      repoUrl = server.repository.url || null;
      repoSource = server.repository.source || null;
      repoSubfolder = server.repository.subfolder || null;
    }
  }

  // Remotes — prefer streamable-http
  let mcpEndpoint = null, transportType = null;
  if (Array.isArray(server.remotes)) {
    const streamable = server.remotes.find(r =>
      (typeof r === 'object' && r.type === 'streamable-http')
    );
    const first = server.remotes[0];
    if (streamable) {
      mcpEndpoint = streamable.url;
      transportType = 'streamable-http';
    } else if (typeof first === 'string') {
      mcpEndpoint = first;
      transportType = 'unknown';
    } else if (first) {
      mcpEndpoint = first.url;
      transportType = first.type || 'unknown';
    }
  }

  // Packages — first package gives install info
  let packageRegistry = null, packageName = null, envVars = null;
  if (Array.isArray(server.packages) && server.packages.length > 0) {
    const pkg = server.packages[0];
    packageRegistry = pkg.registryType || pkg.registry_name || null;
    packageName = pkg.identifier || pkg.name || null;
    if (Array.isArray(pkg.environmentVariables) && pkg.environmentVariables.length > 0) {
      envVars = JSON.stringify(pkg.environmentVariables.map(e => e.name || e));
    }
  }

  // Icon
  const iconUrl = Array.isArray(server.icons) && server.icons.length > 0
    ? server.icons[0].src
    : null;

  // Meta timestamps
  const official = _meta['io.modelcontextprotocol.registry/official'] || {};
  const publishedAt = official.publishedAt || _meta.publishedAt || null;
  const updatedAt = official.updatedAt || _meta.updatedAt || null;
  const status = official.status || 'active';

  return {
    name,
    slug: slugify(name),
    title,
    description,
    version,
    website_url: websiteUrl,
    repository_url: repoUrl,
    repository_source: repoSource,
    repository_subfolder: repoSubfolder,
    mcp_endpoint: mcpEndpoint,
    transport_type: transportType,
    package_registry: packageRegistry,
    package_name: packageName,
    env_vars: envVars,
    icon_url: iconUrl,
    auth_required: envVars ? 1 : 0, // rough heuristic
    registry_status: status,
    registry_published_at: publishedAt,
    registry_updated_at: updatedAt,
  };
}

const upsertStmt = db.prepare(`
  INSERT INTO services (
    name, slug, title, description, version,
    website_url, repository_url, repository_source, repository_subfolder,
    mcp_endpoint, transport_type, package_registry, package_name,
    env_vars, icon_url, auth_required,
    registry_status, registry_published_at, registry_updated_at,
    last_pulled, updated_at
  ) VALUES (
    @name, @slug, @title, @description, @version,
    @website_url, @repository_url, @repository_source, @repository_subfolder,
    @mcp_endpoint, @transport_type, @package_registry, @package_name,
    @env_vars, @icon_url, @auth_required,
    @registry_status, @registry_published_at, @registry_updated_at,
    datetime('now'), datetime('now')
  )
  ON CONFLICT(name) DO UPDATE SET
    title = excluded.title,
    description = excluded.description,
    version = excluded.version,
    website_url = excluded.website_url,
    repository_url = excluded.repository_url,
    repository_source = excluded.repository_source,
    repository_subfolder = excluded.repository_subfolder,
    mcp_endpoint = excluded.mcp_endpoint,
    transport_type = excluded.transport_type,
    package_registry = excluded.package_registry,
    package_name = excluded.package_name,
    env_vars = excluded.env_vars,
    icon_url = excluded.icon_url,
    auth_required = excluded.auth_required,
    registry_status = excluded.registry_status,
    registry_updated_at = excluded.registry_updated_at,
    last_pulled = datetime('now'),
    updated_at = datetime('now')
`);

async function pullAll(maxPages = Infinity) {
  let cursor = null;
  let page = 0;
  let totalFetched = 0;
  let totalInserted = 0;
  let errors = 0;

  console.log('SEC Registry Puller — MCP Services');
  console.log(`Registry: ${REGISTRY_BASE}`);
  console.log('');

  while (page < maxPages) {
    page++;
    const url = cursor
      ? `${REGISTRY_BASE}/servers?version=latest&limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
      : `${REGISTRY_BASE}/servers?version=latest&limit=${PAGE_SIZE}`;

    process.stdout.write(`Page ${page}: `);
    try {
      const data = await rateLimitedFetch(url);
      const servers = data.servers || [];
      totalFetched += servers.length;

      const insertMany = db.transaction((rows) => {
        for (const row of rows) {
          try {
            upsertStmt.run(row);
            totalInserted++;
          } catch (e) {
            errors++;
            console.log(`\n  error on ${row.name}: ${e.message}`);
          }
        }
      });

      const rows = servers.map(extractServerData).filter(Boolean);
      insertMany(rows);

      console.log(`${servers.length} servers (total: ${totalInserted})`);

      cursor = data.metadata?.nextCursor || null;
      if (!cursor) {
        console.log('\nNo more pages.');
        break;
      }
    } catch (e) {
      console.log(`FAIL — ${e.message}`);
      errors++;
      break;
    }
  }

  console.log(`\n=== Pull Complete ===`);
  console.log(`Pages:     ${page}`);
  console.log(`Fetched:   ${totalFetched}`);
  console.log(`Inserted:  ${totalInserted}`);
  console.log(`Errors:    ${errors}`);

  // Final stats
  const stats = db.prepare('SELECT COUNT(*) as n FROM services').get();
  const withRepo = db.prepare('SELECT COUNT(*) as n FROM services WHERE repository_url IS NOT NULL').get();
  const withRemote = db.prepare('SELECT COUNT(*) as n FROM services WHERE mcp_endpoint IS NOT NULL').get();
  console.log(`\nIn database:       ${stats.n} services`);
  console.log(`With repo:         ${withRepo.n}`);
  console.log(`With MCP endpoint: ${withRemote.n}`);
}

const mode = process.argv[2] || 'all';
const maxPages = mode === 'sample' ? 3 : Infinity;

pullAll(maxPages).catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
