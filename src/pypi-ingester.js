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

const UPSERT_SQL = `
  INSERT INTO services (name, slug, title, description, version, website_url, repository_url, repository_source, package_registry, package_name, last_pulled, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pypi', ?, NOW(), NOW())
  ON DUPLICATE KEY UPDATE
    description = COALESCE(VALUES(description), description),
    version = COALESCE(VALUES(version), version),
    package_name = COALESCE(VALUES(package_name), package_name),
    package_registry = COALESCE(VALUES(package_registry), package_registry),
    last_pulled = NOW(),
    updated_at = NOW()
`;

async function main() {
  await db.init();
  // PyPI doesn't have a great search API for JSON. Use the XML-RPC or simple index.
  // Best approach: search via warehouse API (unofficial but works)
  let totalAdded = 0, totalSkipped = 0;

  // Fetch popular MCP packages by name patterns from the simple index
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
    const existing = await db.get("SELECT id FROM services WHERE package_name = ? OR name = ?",
      [pkgName, `pypi.pkg/${pkgName}`]);
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
      await db.run(UPSERT_SQL, [
        name,
        slugify(name),
        info.name || pkgName,
        (info.summary || '').substring(0, 500),
        info.version || null,
        info.project_url || info.home_page || null,
        repoUrl && repoUrl.includes('github.com') ? repoUrl : null,
        repoUrl?.includes('github.com') ? 'github' : null,
        pkgName,
      ]);
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

  const total = await db.get('SELECT COUNT(*) as n FROM services');
  console.log(`Total services: ${total.n}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
