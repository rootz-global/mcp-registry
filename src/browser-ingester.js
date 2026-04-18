/**
 * Browser Automation MCP Ingester
 *
 * Adds missing puppeteer/playwright/browser MCP packages from npm to the registry.
 * Run: node src/browser-ingester.js
 */
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', 'data', 'registry.db'));
db.pragma('journal_mode = WAL');

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 120);
}

const upsert = db.prepare(`
  INSERT INTO services (name, slug, title, description, version, website_url, repository_url, package_registry, package_name, transport_type, last_pulled, updated_at)
  VALUES (@name, @slug, @title, @description, @version, @website_url, @repository_url, @package_registry, @package_name, @transport_type, datetime('now'), datetime('now'))
  ON CONFLICT(name) DO UPDATE SET
    description = COALESCE(excluded.description, description),
    version = COALESCE(excluded.version, version),
    website_url = COALESCE(excluded.website_url, website_url),
    repository_url = COALESCE(excluded.repository_url, repository_url),
    package_registry = COALESCE(excluded.package_registry, package_registry),
    package_name = COALESCE(excluded.package_name, package_name),
    transport_type = COALESCE(excluded.transport_type, transport_type),
    last_pulled = datetime('now'),
    updated_at = datetime('now')
`);

// Services discovered from npm, GitHub, and official MCP registry searches
// that are NOT already in the DB
const newServices = [
  {
    package_name: '@playwright/mcp',
    title: 'Playwright MCP (Official)',
    description: 'Official Playwright Tools for MCP. Browser automation with screenshots, navigation, form filling, PDF generation, and accessibility tree inspection.',
    version: '0.0.70',
    repository_url: 'https://github.com/microsoft/playwright-mcp',
    package_registry: 'npm',
    transport_type: 'stdio',
  },
  {
    package_name: '@cloudflare/playwright-mcp',
    title: 'Cloudflare Playwright MCP',
    description: 'Cloudflare Playwright Tools for MCP. Browser automation backed by Cloudflare Workers Browser Rendering.',
    version: '0.0.5',
    repository_url: 'https://github.com/cloudflare/playwright-mcp',
    package_registry: 'npm',
    transport_type: 'stdio',
  },
  {
    package_name: 'mcp-puppeteer',
    title: 'MCP Puppeteer',
    description: 'MCP search and page scraping plugin for AI web access using Puppeteer headless browser.',
    version: '1.0.2',
    repository_url: 'https://github.com/nicholasoxford/mcp-puppeteer',
    package_registry: 'npm',
    transport_type: 'stdio',
  },
  {
    package_name: '@imazhar101/mcp-puppeteer-server',
    title: 'Puppeteer MCP Server (imazhar)',
    description: 'Puppeteer MCP Server — provides tools for browser automation including navigation, screenshots, form filling, and JS execution.',
    version: '2.0.3',
    repository_url: null,
    package_registry: 'npm',
    transport_type: 'stdio',
  },
  {
    package_name: 'agent-browser-mcp',
    title: 'Agent Browser MCP',
    description: "MCP server integrating with Vercel's agent-browser for AI-driven browser automation, navigation, and content extraction.",
    version: null,
    repository_url: null,
    package_registry: 'npm',
    transport_type: 'stdio',
  },
  {
    package_name: '@ejazullah/mcp-playwright',
    title: 'Enhanced Playwright MCP',
    description: 'Enhanced Playwright Tools for MCP with CDP Support. Browser automation with Chrome DevTools Protocol integration.',
    version: '0.0.56',
    repository_url: null,
    package_registry: 'npm',
    transport_type: 'stdio',
  },
  {
    package_name: 'playwright-mcp',
    title: 'Playwright MCP Integration',
    description: 'Playwright integration for MCP. Browser automation, screenshots, PDF generation, and web content extraction for AI agents.',
    version: '0.0.19',
    repository_url: null,
    package_registry: 'npm',
    transport_type: 'stdio',
  },
  {
    package_name: '@pablovitasso/szkrabok',
    title: 'Szkrabok',
    description: 'Production-grade MCP browser automation layer with persistent sessions, stealth capabilities, and anti-detection for web scraping.',
    version: null,
    repository_url: null,
    package_registry: 'npm',
    transport_type: 'stdio',
  },
  {
    package_name: 'ornold-mcp',
    title: 'Ornold MCP',
    description: 'Browser automation, antidetect management, and captcha solving for AI agents via MCP.',
    version: null,
    repository_url: null,
    package_registry: 'npm',
    transport_type: 'stdio',
  },
  {
    package_name: '@andrew-chen-wang/camoufox-mcp',
    title: 'Camoufox MCP',
    description: 'Camoufox-backed MCP browser automation server. Anti-detection Firefox for stealth web scraping.',
    version: null,
    repository_url: null,
    package_registry: 'npm',
    transport_type: 'stdio',
  },
  {
    package_name: '@simplysm/mcp-playwright',
    title: 'SimplySM Playwright MCP',
    description: 'Multi-session Playwright proxy for MCP. Run parallel browser sessions with session management.',
    version: '13.0.85',
    repository_url: null,
    package_registry: 'npm',
    transport_type: 'stdio',
  },
  {
    package_name: 'mcp-playwright-network',
    title: 'Playwright MCP Network',
    description: 'Custom MCP Playwright server with network request/response capture and monitoring enhancements.',
    version: '0.0.2',
    repository_url: null,
    package_registry: 'npm',
    transport_type: 'stdio',
  },
  {
    package_name: 'playwright-mcp-advanced',
    title: 'Playwright MCP Advanced',
    description: 'Advanced Playwright Tools for MCP with extended automation capabilities, multi-page support, and advanced selectors.',
    version: '0.1.0',
    repository_url: null,
    package_registry: 'npm',
    transport_type: 'stdio',
  },
  {
    package_name: '@hisma/server-puppeteer',
    title: 'Hisma Puppeteer MCP Server',
    description: 'Fork and update of the original MCP server for browser automation using Puppeteer. Screenshots, navigation, form filling.',
    version: '0.6.5',
    repository_url: null,
    package_registry: 'npm',
    transport_type: 'stdio',
  },
  {
    package_name: 'chrome-local-mcp',
    title: 'Chrome Local MCP',
    description: 'Local Chrome browser automation MCP server powered by Puppeteer. Navigate, screenshot, and interact with pages locally.',
    version: null,
    repository_url: null,
    package_registry: 'npm',
    transport_type: 'stdio',
  },
  {
    package_name: '@aigne/example-mcp-puppeteer',
    title: 'AIGNE Puppeteer MCP Example',
    description: 'Demonstration of using AIGNE Framework and Puppeteer MCP Server for browser automation.',
    version: '1.19.6',
    repository_url: null,
    package_registry: 'npm',
    transport_type: 'stdio',
  },
];

let added = 0, updated = 0, skipped = 0;

for (const svc of newServices) {
  const name = `npm:${svc.package_name}`;
  const slug = slugify(svc.package_name);

  // Check if already exists by package_name
  const existing = db.prepare('SELECT id FROM services WHERE package_name = ? OR name = ?').get(svc.package_name, name);

  try {
    const result = upsert.run({
      name,
      slug,
      title: svc.title,
      description: svc.description,
      version: svc.version,
      website_url: svc.website_url || null,
      repository_url: svc.repository_url,
      package_registry: svc.package_registry,
      package_name: svc.package_name,
      transport_type: svc.transport_type,
    });

    if (existing) {
      updated++;
      console.log(`  UPDATED: ${svc.package_name}`);
    } else {
      added++;
      console.log(`  ADDED: ${svc.package_name} → ${name}`);
    }
  } catch (err) {
    // Likely slug conflict — try with suffixed slug
    try {
      const result = upsert.run({
        name,
        slug: slug + '-npm',
        title: svc.title,
        description: svc.description,
        version: svc.version,
        website_url: svc.website_url || null,
        repository_url: svc.repository_url,
        package_registry: svc.package_registry,
        package_name: svc.package_name,
        transport_type: svc.transport_type,
      });
      added++;
      console.log(`  ADDED (slug-fix): ${svc.package_name}`);
    } catch (err2) {
      skipped++;
      console.log(`  SKIPPED: ${svc.package_name} — ${err2.message}`);
    }
  }
}

// Now get the final count of browser-related services
const count = db.prepare(`
  SELECT count(*) as c FROM services
  WHERE description LIKE '%puppeteer%' OR description LIKE '%playwright%'
     OR description LIKE '%browser%' OR description LIKE '%headless%'
     OR description LIKE '%scrape%' OR description LIKE '%crawl%'
     OR description LIKE '%selenium%' OR description LIKE '%chromium%'
     OR name LIKE '%puppeteer%' OR name LIKE '%playwright%'
     OR name LIKE '%browser%' OR name LIKE '%headless%'
     OR name LIKE '%scrape%' OR name LIKE '%crawl%' OR name LIKE '%selenium%'
`).get();

const total = db.prepare('SELECT count(*) as c FROM services').get();

console.log(`\n--- Summary ---`);
console.log(`Added: ${added}`);
console.log(`Updated: ${updated}`);
console.log(`Skipped: ${skipped}`);
console.log(`Browser-related services total: ${count.c}`);
console.log(`Registry total: ${total.c}`);
db.close();
