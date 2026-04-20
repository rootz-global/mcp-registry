# Epistery MCP Service Registry — AI Context

## What This Is

An AI-native directory of MCP (Model Context Protocol) services. Indexes 11,000+ services from 4 data sources with live endpoint probing, tool schema extraction, and cryptographic provenance.

**Live at:** https://mcp.epistery.io
**API:** https://mcp.epistery.io/api/stats
**MCP endpoint:** POST https://mcp.epistery.io/mcp
**GitHub:** https://github.com/rootz-global/mcp-registry

Built on the Origin pattern — the same discovery stack that serves 134K+ AI agent queries/week for SEC company data at origin.rootz.global.

## Data Sources (4)

| Source | Services | Method |
|--------|----------|--------|
| Official MCP Registry | ~6,000 | API pagination (registry.modelcontextprotocol.io/v0.1/servers) |
| npm packages | ~1,600 | npm search API (mcp-server, @modelcontextprotocol) |
| PyPI packages | ~3,000 | PyPI simple index + JSON API |
| GitHub awesome lists | ~500 | wong2/awesome-mcp-servers + appcypher/awesome-mcp-servers |

## Architecture

```
Data Sources → Ingesters → SQLite → Categorizer → Prober → Static Builder → Server
                                                     ↓
                                              Live MCP endpoint probing
                                              (initialize → tools/list)
                                                     ↓
                                              Tool schemas stored in DB
```

## Server Deployment

- **Server:** Oracle Cloud epistery-scan (epistery.io, 129.80.17.149)
- **SSH:** `ssh -i ~/.ssh/rootz_epistery ubuntu@epistery.io`
- **App:** `~/mcp-registry/` (cloned from rootz-global/mcp-registry)
- **PM2:** `mcp-registry` on port 3600
- **Nginx:** reverse proxy on ports 80/443 → localhost:3600
- **SSL:** Let's Encrypt via certbot (nginx plugin)
- **Static pages:** `~/mcp-registry/data/static/` (served by nginx directly)
- **Database:** `~/mcp-registry/data/registry.db` (NOT in git — too large)

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Discovery doc (HTML for browsers, JSON for API clients) |
| `GET /.well-known/ai` | Machine-readable AI discovery manifest |
| `GET /api/stats` | Registry statistics |
| `GET /api/search?q={query}` | Full-text search across services |
| `GET /api/service/{name}` | Service profile with tool schemas |
| `GET /api/tool/{name}` | Find services offering a specific tool |
| `GET /api/categories` | List all categories |
| `GET /api/services?category={slug}` | Filter by category |
| `POST /mcp` | Native MCP endpoint (5 discovery tools) |
| `GET /sitemap.xml` | Sitemap for crawlers |
| `GET /robots.txt` | Welcome all crawlers |
| `GET /static/service/{slug}.html` | Flat HTML page per service |
| `GET /static/category/{slug}.html` | Category listing page |

## MCP Tools (5)

1. **mcp_find_service** — Search by keyword/category. Use FIRST.
2. **mcp_service_detail** — Full profile with tool schemas.
3. **mcp_find_tool** — Reverse lookup: "which services have tool X?"
4. **mcp_categories** — List all categories with counts.
5. **mcp_stats** — Registry statistics.

## Key Files

| File | Purpose |
|------|---------|
| `src/puller.js` | Pull from official MCP registry API |
| `src/npm-ingester.js` | Pull from npm search API |
| `src/pypi-ingester.js` | Pull from PyPI simple index |
| `src/awesome-ingester.js` | Pull from GitHub awesome lists |
| `src/categorizer.js` | Keyword-based categorization (19 categories) |
| `src/prober.js` | Live MCP endpoint probing (concurrent) |
| `src/server.js` | Express API + static HTML + .well-known/ai |
| `src/mcp-handler.js` | MCP protocol handler (5 tools) |
| `src/static-builder.js` | Generate one HTML page per service |
| `src/db.js` | SQLite schema (services, tools, categories, probes, access_log) |

## Build Pipeline

```bash
# 1. Pull from all sources
node src/puller.js all              # Official registry (~6K services)
node src/npm-ingester.js --all      # npm packages (~1.6K new)
node src/pypi-ingester.js           # PyPI packages (~3K new)
node src/awesome-ingester.js data/new_repos.txt  # GitHub awesome lists

# 2. Categorize
node src/categorizer.js --recat

# 3. Probe live endpoints (optional, takes time)
node src/prober.js --concurrent 10

# 4. Build static HTML pages
node src/static-builder.js

# 5. Start server
PORT=3600 node src/server.js
```

## Deploy to Production

```bash
# On local machine:
cd mcp-registry
git add -A && git commit -m "description" && git push

# On server (epistery.io):
cd /opt/mcp-registry && git pull
npm install  # if dependencies changed
node src/static-builder.js  # if data changed
# pm2 restart mcp-registry -- mcp-registry is launched by epistery-scan
sudo systemctl restart epistery-scan

# To update database (not in git):
# Local: node src/db.js (checkpoint WAL)
node --input-type=module -e "import db from './src/db.js'; db.pragma('wal_checkpoint(TRUNCATE)');"
# Then scp:
scp -i ~/.ssh/rootz_epistery data/registry.db ubuntu@epistery.io:~/mcp-registry/data/
# Then restart:
ssh -i ~/.ssh/rootz_epistery ubuntu@epistery.io "cd ~/mcp-registry && pm2 restart mcp-registry"
```

## Related Projects

| Project | URL                                    | Relationship |
|---------|----------------------------------------|-------------|
| Origin SEC Registry | origin.rootz.global                    | Same pattern, SEC company data |
| Epistery Scan | epistery.io (github.com/epistery/scan) | Signed web search engine (same server) |
| Rootz MCP Tools | mcp.rootz.global                       | Rootz wallet/archive MCP tools |

## Design Documents

- `docs/DESIGN-epistery-claim-protocol.md` — Wallet-based identity for MCP services
- Geist wiki: EpisteryMCPRegistry, EpisteryClaimProtocol
- Geist messages: #15-25 (full project history)

## Categories (19)

Developer Tools, Search & Web, Finance & Fintech, Communication, Data & Analytics, Security, Crypto & Web3, Publishing & Content, AI & Machine Learning, Databases, Marketing & Sales, Legal & Compliance, News & Media, Healthcare, Productivity, Cloud & Infrastructure, Identity & Auth, E-commerce, Other
