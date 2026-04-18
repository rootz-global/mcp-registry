/**
 * npm MCP Package Ingester
 *
 * Searches npm for MCP server packages and adds them to the registry.
 * Filters for actual MCP servers (not clients, SDKs, or unrelated packages).
 *
 * Usage:
 *   node src/npm-ingester.js                    — search "mcp-server" (default)
 *   node src/npm-ingester.js "@modelcontextprotocol"  — search specific scope
 *   node src/npm-ingester.js --all              — run all searches
 */
import db from './db.js';

const NPM_SEARCH = 'https://registry.npmjs.org/-/v1/search';
const RATE_LIMIT_MS = 200;
let lastRequest = 0;

// Keywords that indicate this is an actual MCP server (not a client/SDK/tool)
const SERVER_KEYWORDS = ['mcp server', 'mcp-server', 'model context protocol server', 'mcp tool'];
const EXCLUDE_KEYWORDS = ['client', 'sdk', 'cli tool', 'inspector', 'debugger', 'framework'];

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 120);
}

async function rateFetch(url) {
  const now = Date.now();
  if (now - lastRequest < RATE_LIMIT_MS) await new Promise(r => setTimeout(r, RATE_LIMIT_MS - (now - lastRequest)));
  lastRequest = Date.now();
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function isLikelyMCPServer(pkg) {
  const text = `${pkg.name} ${pkg.description || ''} ${JSON.stringify(pkg.keywords || [])}`.toLowerCase();
  // Must contain MCP
  if (!text.includes('mcp')) return false;
  // Should contain server-like words
  const hasServer = SERVER_KEYWORDS.some(kw => text.includes(kw));
  // Exclude SDK/client packages
  const isExcluded = EXCLUDE_KEYWORDS.some(kw => {
    // Only exclude if the keyword is prominent (in name or first in description)
    return pkg.name.toLowerCase().includes(kw) || (pkg.description || '').toLowerCase().startsWith(kw);
  });
  return hasServer && !isExcluded;
}

const upsert = db.prepare(`
  INSERT INTO services (name, slug, title, description, version, website_url, repository_url, repository_source, package_registry, package_name, last_pulled, updated_at)
  VALUES (@name, @slug, @title, @description, @version, @website_url, @repository_url, @repository_source, 'npm', @package_name, datetime('now'), datetime('now'))
  ON CONFLICT(name) DO UPDATE SET
    description = COALESCE(excluded.description, description),
    version = COALESCE(excluded.version, version),
    website_url = COALESCE(excluded.website_url, website_url),
    repository_url = COALESCE(excluded.repository_url, repository_url),
    package_name = COALESCE(excluded.package_name, package_name),
    package_registry = 'npm',
    last_pulled = datetime('now'),
    updated_at = datetime('now')
`);

async function searchAndIngest(query, maxPages = 10) {
  let offset = 0;
  const pageSize = 250;
  let totalAdded = 0, totalSkipped = 0, totalFiltered = 0;
  let page = 0;

  console.log(`Searching npm: "${query}"`);

  while (page < maxPages) {
    page++;
    const url = `${NPM_SEARCH}?text=${encodeURIComponent(query)}&size=${pageSize}&from=${offset}`;

    try {
      const data = await rateFetch(url);
      const objects = data.objects || [];
      if (objects.length === 0) break;

      console.log(`  Page ${page}: ${objects.length} packages (total in npm: ${data.total})`);

      for (const obj of objects) {
        const pkg = obj.package;

        // Filter for actual MCP servers
        if (!isLikelyMCPServer(pkg)) {
          totalFiltered++;
          continue;
        }

        // Check if already exists (by npm package name)
        const existing = db.prepare('SELECT id FROM services WHERE package_name = ?').get(pkg.name);
        if (existing) { totalSkipped++; continue; }

        // Also check by repo URL
        const repoUrl = pkg.links?.repository || null;
        if (repoUrl) {
          const existingRepo = db.prepare('SELECT id FROM services WHERE repository_url = ?').get(repoUrl);
          if (existingRepo) {
            // Update existing entry with npm package info
            db.prepare('UPDATE services SET package_registry = ?, package_name = ? WHERE repository_url = ?')
              .run('npm', pkg.name, repoUrl);
            totalSkipped++;
            continue;
          }
        }

        // Build a registry-style name from npm package name
        // @scope/name → npm.scope/name, unscoped → npm.pkg/name
        let name;
        if (pkg.name.startsWith('@')) {
          const [scope, pkgName] = pkg.name.substring(1).split('/');
          name = `npm.${scope}/${pkgName}`;
        } else {
          name = `npm.pkg/${pkg.name}`;
        }

        try {
          upsert.run({
            name,
            slug: slugify(name),
            title: pkg.name,
            description: pkg.description || '',
            version: pkg.version || null,
            website_url: pkg.links?.homepage || null,
            repository_url: repoUrl,
            repository_source: repoUrl?.includes('github.com') ? 'github' : null,
            package_name: pkg.name,
          });
          totalAdded++;
        } catch (e) {
          // Duplicate name — skip
        }
      }

      offset += objects.length;
      if (objects.length < pageSize) break; // last page
    } catch (e) {
      console.log(`  Error: ${e.message}`);
      break;
    }
  }

  return { added: totalAdded, skipped: totalSkipped, filtered: totalFiltered };
}

async function main() {
  const arg = process.argv[2] || '--all';

  const searches = arg === '--all'
    ? ['mcp-server', '@modelcontextprotocol', 'mcp server tool', 'model context protocol']
    : [arg];

  let grandTotal = { added: 0, skipped: 0, filtered: 0 };

  for (const query of searches) {
    const result = await searchAndIngest(query, 4); // 4 pages × 250 = up to 1000 per search
    grandTotal.added += result.added;
    grandTotal.skipped += result.skipped;
    grandTotal.filtered += result.filtered;
    console.log(`  → Added: ${result.added}, Skipped: ${result.skipped}, Filtered: ${result.filtered}\n`);
  }

  console.log(`=== npm Ingestion Complete ===`);
  console.log(`Added:    ${grandTotal.added}`);
  console.log(`Skipped:  ${grandTotal.skipped} (already in DB)`);
  console.log(`Filtered: ${grandTotal.filtered} (not MCP servers)`);

  const total = db.prepare('SELECT COUNT(*) as n FROM services').get();
  const npmCount = db.prepare("SELECT COUNT(*) as n FROM services WHERE package_registry = 'npm'").get();
  console.log(`\nTotal services: ${total.n}`);
  console.log(`With npm package: ${npmCount.n}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
