/**
 * Static HTML Builder — generates one HTML page per service + category indexes.
 *
 * These pages are what crawlers (GPTBot, ClaudeBot, Gemini, Perplexity) will find.
 * Each page is self-contained, has structured data, and links to the API.
 *
 * Usage:
 *   node src/static-builder.js              — build all pages
 *   node src/static-builder.js --service NAME — build one
 *   node src/static-builder.js --category    — just category indexes
 */
import db from './db.js';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, '..', 'data', 'static');
const SERVICE_DIR = join(STATIC_DIR, 'service');
const CATEGORY_DIR = join(STATIC_DIR, 'category');
mkdirSync(SERVICE_DIR, { recursive: true });
mkdirSync(CATEGORY_DIR, { recursive: true });

const STYLE = `
body { font-family: system-ui, -apple-system, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #1a1a1a; }
h1 { font-size: 1.8em; margin: 0 0 6px; }
h2 { font-size: 1.3em; margin-top: 30px; border-bottom: 1px solid #eee; padding-bottom: 6px; }
h3 { font-size: 1.05em; margin: 18px 0 6px; }
.tag { display: inline-block; background: #0066cc; color: white; padding: 2px 10px; border-radius: 12px; font-size: 0.85em; margin: 2px; }
.tag.status-reachable { background: #28a745; }
.tag.status-auth { background: #ffc107; color: #000; }
.tag.status-error { background: #dc3545; }
.tag.cat { background: #6c757d; }
.card { background: #f5f5f5; padding: 16px 20px; border-radius: 8px; margin: 16px 0; }
.tool { background: #fff; padding: 12px 16px; border-radius: 6px; margin: 8px 0; border-left: 3px solid #0066cc; }
.tool code { font-size: 0.85em; color: #555; }
a { color: #0066cc; text-decoration: none; }
a:hover { text-decoration: underline; }
pre { background: #2b2b2b; color: #f8f8f2; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 0.85em; }
code { background: #eee; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
.meta { color: #666; font-size: 0.9em; }
footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; color: #666; font-size: 0.85em; }
`;

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serviceHtml(service, tools) {
  const title = service.title || service.name;
  const statusTag = service.probe_status === 'reachable'
    ? '<span class="tag status-reachable">live endpoint</span>'
    : service.probe_status?.startsWith('auth')
      ? '<span class="tag status-auth">auth required</span>'
      : service.probe_status
        ? `<span class="tag status-error">${escapeHtml(service.probe_status)}</span>`
        : '';

  // Schema.org structured data
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: title,
    alternateName: service.name,
    description: service.description,
    applicationCategory: service.category,
    operatingSystem: 'MCP (Model Context Protocol)',
    url: `https://mcp.rootz.global/static/service/${service.slug}.html`,
    sameAs: [service.website_url, service.repository_url].filter(Boolean),
    offers: service.auth_required ? {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      description: 'Free tier available — auth required for use',
    } : {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      description: 'Free',
    },
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} — MCP Service Registry</title>
<meta name="description" content="${escapeHtml((service.description || '').substring(0, 155))}">
<link rel="canonical" href="https://mcp.rootz.global/static/service/${escapeHtml(service.slug)}.html">
<link rel="alternate" type="application/json" href="/api/service/${encodeURIComponent(service.name)}">
<meta name="robots" content="all">
<meta property="og:title" content="${escapeHtml(title)} — MCP Service">
<meta property="og:description" content="${escapeHtml((service.description || '').substring(0, 200))}">
<meta property="og:type" content="website">
<style>${STYLE}</style>
<script type="application/ld+json">${JSON.stringify(structuredData)}</script>
</head>
<body>
<p><a href="/">← MCP Service Registry</a> · <a href="/static/category/${service.category}.html">${escapeHtml(service.category || 'other')}</a></p>

<h1>${escapeHtml(title)}</h1>
<p class="meta"><code>${escapeHtml(service.name)}</code> · v${escapeHtml(service.version || '?')}</p>

<p>${statusTag} <span class="tag cat">${escapeHtml(service.category || 'other')}</span> ${service.auth_required ? '<span class="tag status-auth">auth required</span>' : ''}</p>

<p>${escapeHtml(service.description || '')}</p>

<div class="card">
<h2 style="margin-top:0;border:none">Connect</h2>
${service.mcp_endpoint ? `<p><strong>MCP Endpoint:</strong> <code>${escapeHtml(service.mcp_endpoint)}</code></p>` : ''}
${service.transport_type ? `<p><strong>Transport:</strong> ${escapeHtml(service.transport_type)}</p>` : ''}
${service.mcp_endpoint ? `<pre>claude mcp add ${escapeHtml(service.slug)} --transport http ${escapeHtml(service.mcp_endpoint)}</pre>` : ''}
${service.package_registry && service.package_name ? `<p><strong>Package:</strong> <code>${escapeHtml(service.package_registry)}</code> / <code>${escapeHtml(service.package_name)}</code></p>` : ''}
${service.env_vars ? `<p><strong>Required env vars:</strong> <code>${escapeHtml(service.env_vars)}</code></p>` : ''}
</div>

<h2>Tools (${tools.length})</h2>
${tools.length === 0 ? '<p class="meta">No tools extracted yet. May require auth or probe pending.</p>' :
  tools.map(t => `
<div class="tool">
<h3><code>${escapeHtml(t.name)}</code></h3>
<p>${escapeHtml(t.description || '')}</p>
${t.input_schema ? `<details><summary class="meta">input schema</summary><pre>${escapeHtml(JSON.stringify(JSON.parse(t.input_schema), null, 2))}</pre></details>` : ''}
</div>`).join('')}

<h2>Links</h2>
<ul>
${service.website_url ? `<li><a href="${escapeHtml(service.website_url)}">Website</a></li>` : ''}
${service.repository_url ? `<li><a href="${escapeHtml(service.repository_url)}">Source repository</a> (${escapeHtml(service.repository_source || 'git')})</li>` : ''}
<li><a href="https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(service.name)}">Official MCP registry entry</a></li>
<li><a href="/api/service/${encodeURIComponent(service.name)}">JSON API response</a></li>
</ul>

<h2>Origin Chain</h2>
<p class="meta">This profile was extracted from the official MCP registry at registry.modelcontextprotocol.io and enriched with live endpoint probing. The chain is verifiable via <a href="/api/service/${encodeURIComponent(service.name)}">the JSON API</a> which includes an origin leaf hash.</p>

<footer>
<a href="https://mcp.rootz.global">MCP Service Registry</a> by <a href="https://rootz.global">Rootz</a> ·
Data from <a href="https://registry.modelcontextprotocol.io">registry.modelcontextprotocol.io</a> ·
<a href="/.well-known/ai">.well-known/ai</a> ·
Last updated ${new Date().toISOString().split('T')[0]}
</footer>
</body>
</html>`;
}

function categoryHtml(category, services) {
  const title = category.name;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} MCP Services — MCP Service Registry</title>
<meta name="description" content="${escapeHtml(category.description || '')} — ${services.length} MCP services in this category.">
<link rel="canonical" href="https://mcp.rootz.global/static/category/${category.slug}.html">
<link rel="alternate" type="application/json" href="/api/services?category=${category.slug}">
<meta name="robots" content="all">
<style>${STYLE}</style>
</head>
<body>
<p><a href="/">← MCP Service Registry</a></p>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(category.description || '')}</p>
<p class="meta">${services.length} services in this category.</p>

<h2>Services</h2>
${services.map(s => `
<div class="tool">
<h3><a href="/static/service/${escapeHtml(s.slug)}.html">${escapeHtml(s.title || s.name)}</a></h3>
<p>${escapeHtml((s.description || '').substring(0, 200))}</p>
<p class="meta">
  <code>${escapeHtml(s.name)}</code>
  ${s.tools_count > 0 ? `· ${s.tools_count} tools` : ''}
  ${s.probe_status === 'reachable' ? '· <span style="color:#28a745">● live</span>' : ''}
  ${s.probe_status?.startsWith('auth') ? '· <span style="color:#ffc107">● auth required</span>' : ''}
</p>
</div>`).join('')}

<footer>
<a href="https://mcp.rootz.global">MCP Service Registry</a> ·
<a href="/.well-known/ai">.well-known/ai</a>
</footer>
</body>
</html>`;
}

function indexHtml(stats, categories, topServices) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MCP Service Registry — AI-native directory of MCP servers</title>
<meta name="description" content="AI-readable directory of ${stats.services} MCP (Model Context Protocol) services with tool schemas, live probes, and cryptographic provenance.">
<link rel="canonical" href="https://mcp.rootz.global/">
<meta name="robots" content="all">
<style>${STYLE}
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; }
.stat { text-align: center; background: #f5f5f5; padding: 16px; border-radius: 8px; }
.stat-num { font-size: 2em; font-weight: bold; color: #0066cc; }
.cats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; }
</style>
</head>
<body>
<h1>MCP Service Registry</h1>
<p>AI-native directory of MCP (Model Context Protocol) services.</p>

<div class="stats">
<div class="stat"><div class="stat-num">${stats.services}</div><div class="meta">services</div></div>
<div class="stat"><div class="stat-num">${stats.total_tools}</div><div class="meta">tools</div></div>
<div class="stat"><div class="stat-num">${stats.reachable}</div><div class="meta">live endpoints</div></div>
<div class="stat"><div class="stat-num">${stats.categories}</div><div class="meta">categories</div></div>
</div>

<h2>Categories</h2>
<div class="cats">
${categories.map(c => `<div class="tool"><a href="/static/category/${c.slug}.html"><strong>${escapeHtml(c.name)}</strong></a><br><span class="meta">${c.service_count} services</span></div>`).join('')}
</div>

<h2>Most-tooled services</h2>
${topServices.map(s => `<div class="tool"><a href="/static/service/${escapeHtml(s.slug)}.html"><strong>${escapeHtml(s.title || s.name)}</strong></a> <span class="tag">${s.tools_count} tools</span><br>${escapeHtml((s.description || '').substring(0, 150))}</div>`).join('')}

<footer>
<a href="https://rootz.global">Rootz</a> ·
<a href="/.well-known/ai">.well-known/ai</a> ·
<a href="https://origin.rootz.global">origin.rootz.global</a>
</footer>
</body>
</html>`;
}

function run() {
  const args = process.argv.slice(2);
  const serviceArg = args.includes('--service') ? args[args.indexOf('--service') + 1] : null;
  const catOnly = args.includes('--category');

  let servicesBuilt = 0;
  let categoriesBuilt = 0;

  if (!catOnly) {
    let services;
    if (serviceArg) {
      services = db.prepare('SELECT * FROM services WHERE name = ? OR slug = ?').all(serviceArg, serviceArg);
    } else {
      services = db.prepare('SELECT * FROM services WHERE slug IS NOT NULL').all();
    }

    console.log(`Building ${services.length} service pages...`);
    for (const svc of services) {
      const tools = db.prepare('SELECT name, description, input_schema FROM tools WHERE service_id = ?').all(svc.id);
      const html = serviceHtml(svc, tools);
      writeFileSync(join(SERVICE_DIR, `${svc.slug}.html`), html);
      servicesBuilt++;
      if (servicesBuilt % 500 === 0) console.log(`  ${servicesBuilt}/${services.length}`);
    }
  }

  const categories = db.prepare('SELECT * FROM categories WHERE service_count > 0').all();
  console.log(`\nBuilding ${categories.length} category pages...`);
  for (const cat of categories) {
    const services = db.prepare('SELECT name, slug, title, description, tools_count, probe_status FROM services WHERE category = ? ORDER BY tools_count DESC, title LIMIT 500').all(cat.slug);
    const html = categoryHtml(cat, services);
    writeFileSync(join(CATEGORY_DIR, `${cat.slug}.html`), html);
    categoriesBuilt++;
  }

  // Index page
  const stats = {
    services: db.prepare('SELECT COUNT(*) as n FROM services').get().n,
    total_tools: db.prepare('SELECT COUNT(*) as n FROM tools').get().n,
    reachable: db.prepare("SELECT COUNT(*) as n FROM services WHERE probe_status = 'reachable'").get().n,
    categories: categories.length,
  };
  const topServices = db.prepare('SELECT name, slug, title, description, tools_count FROM services WHERE tools_count > 0 ORDER BY tools_count DESC LIMIT 20').all();
  writeFileSync(join(STATIC_DIR, 'index.html'), indexHtml(stats, categories, topServices));

  console.log(`\n=== Build Complete ===`);
  console.log(`  Service pages:  ${servicesBuilt}`);
  console.log(`  Category pages: ${categoriesBuilt}`);
  console.log(`  Index page:     1`);
  console.log(`  Output:         ${STATIC_DIR}`);
}

run();
