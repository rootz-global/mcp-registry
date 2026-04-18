/**
 * PyPI MCP Package Ingester
 *
 * Searches PyPI for MCP server packages and adds them to the registry.
 *
 * Usage:
 *   node src/pypi-ingester.js
 */
import db from './db.js';

const RATE_LIMIT_MS = 300;
let lastRequest = 0;

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 120);
}

async function rateFetch(url) {
  const now = Date.now();
  if (now - lastRequest < RATE_LIMIT_MS) await new Promise(r => setTimeout(r, RATE_LIMIT_MS - (now - lastRequest)));
  lastRequest = Date.now();
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) return null;
  return resp.json();
}

const upsert = db.prepare(`
  INSERT INTO services (name, slug, title, description, version, website_url, repository_url, repository_source, package_registry, package_name, last_pulled, updated_at)
  VALUES (@name, @slug, @title, @description, @version, @website_url, @repository_url, @repository_source, 'pypi', @package_name, datetime('now'), datetime('now'))
  ON CONFLICT(name) DO UPDATE SET
    description = COALESCE(excluded.description, description),
    version = COALESCE(excluded.version, version),
    package_name = COALESCE(excluded.package_name, package_name),
    package_registry = COALESCE(excluded.package_registry, package_registry),
    last_pulled = datetime('now'),
    updated_at = datetime('now')
`);

async function main() {
  // PyPI doesn't have a great search API for JSON. Use the XML-RPC or simple index.
  // Best approach: search via warehouse API (unofficial but works)
  const searches = ['mcp-server', 'mcp server', 'model-context-protocol'];
  let totalAdded = 0, totalSkipped = 0;

  for (const query of searches) {
    console.log(`Searching PyPI: "${query}"`);

    // PyPI search via warehouse JSON API
    const url = `https://pypi.org/search/?q=${encodeURIComponent(query)}&o=`;

    // PyPI doesn't have a clean JSON search API, but we can use the warehouse API
    // Alternative: use the XML-RPC search
    // Actually, let's use the PyPI JSON API for specific packages we know about
    // from the simple index search we did earlier
    break; // PyPI search API is limited — let me try a different approach
  }

  // Better approach: fetch popular MCP packages by name patterns
  const knownPypiMCP = [
    'mcp', 'fastmcp', 'mcp-server-fetch', 'mcp-server-git', 'mcp-server-sqlite',
    'mcp-server-filesystem', 'mcp-server-time', 'mcp-server-memory',
    'mcp-server-everything', 'mcp-server-sequential-thinking',
    'mcp-server-brave-search', 'mcp-server-puppeteer',
    'uvx', 'mcp-server-docker', 'mcp-server-kubernetes',
    'mcp-server-slack', 'mcp-server-github', 'mcp-server-postgres',
    'mcp-server-sentry', 'mcp-server-linear', 'mcp-server-notion',
  ];

  // Also scan for patterns: search pypi simple index for mcp-server-*
  console.log('Fetching PyPI simple index for mcp packages...');
  const indexResp = await fetch('https://pypi.org/simple/', { headers: { 'Accept': 'text/html' } });
  const indexHtml = await indexResp.text();

  // Extract all package names containing "mcp"
  const mcpPackages = [];
  const regex = /href="\/simple\/([^"]*mcp[^"]*)\/"/gi;
  let match;
  while ((match = regex.exec(indexHtml)) !== null) {
    mcpPackages.push(match[1]);
  }
  console.log(`Found ${mcpPackages.length} PyPI packages with "mcp" in name`);

  // Filter for likely MCP servers (name contains "mcp-server" or "mcp_server")
  const serverPackages = mcpPackages.filter(p =>
    p.includes('mcp-server') || p.includes('mcp_server') || p.includes('mcpserver')
  );
  console.log(`Of those, ${serverPackages.length} look like MCP servers`);

  // Fetch metadata for each and add to DB
  for (let i = 0; i < serverPackages.length; i++) {
    const pkgName = serverPackages[i];

    // Check if already in DB
    const existing = db.prepare("SELECT id FROM services WHERE package_name = ? OR name = ?")
      .get(pkgName, `pypi.pkg/${pkgName}`);
    if (existing) { totalSkipped++; continue; }

    // Fetch package info from PyPI JSON API
    const data = await rateFetch(`https://pypi.org/pypi/${pkgName}/json`);
    if (!data || !data.info) continue;

    const info = data.info;
    const name = `pypi.pkg/${pkgName}`;

    // Extract repo URL from project URLs
    let repoUrl = null;
    if (info.project_urls) {
      repoUrl = info.project_urls.Repository || info.project_urls.Source
        || info.project_urls.GitHub || info.project_urls['Source Code']
        || info.project_urls.Homepage || null;
    }
    if (!repoUrl && info.home_page) repoUrl = info.home_page;

    try {
      upsert.run({
        name,
        slug: slugify(name),
        title: info.name || pkgName,
        description: (info.summary || '').substring(0, 500),
        version: info.version || null,
        website_url: info.project_url || info.home_page || null,
        repository_url: repoUrl && repoUrl.includes('github.com') ? repoUrl : null,
        repository_source: repoUrl?.includes('github.com') ? 'github' : null,
        package_name: pkgName,
      });
      totalAdded++;
    } catch {}

    if ((totalAdded + totalSkipped) % 50 === 0) {
      console.log(`  Progress: ${totalAdded} added, ${totalSkipped} skipped (${i + 1}/${serverPackages.length})`);
    }
  }

  console.log(`\n=== PyPI Ingestion Complete ===`);
  console.log(`Server packages found: ${serverPackages.length}`);
  console.log(`Added:   ${totalAdded}`);
  console.log(`Skipped: ${totalSkipped}`);

  const total = db.prepare('SELECT COUNT(*) as n FROM services').get();
  console.log(`Total services: ${total.n}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
