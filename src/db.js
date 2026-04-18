/**
 * MCP Service Registry — Database
 *
 * Modeled on Origin SEC Registry. SQLite with WAL mode.
 */
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, 'registry.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  -------------------------------------------------
  -- Services — the core entity (one per MCP server)
  -------------------------------------------------
  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    slug TEXT UNIQUE,
    title TEXT,
    description TEXT,
    version TEXT,
    category TEXT,
    website_url TEXT,
    repository_url TEXT,
    repository_source TEXT,
    repository_subfolder TEXT,
    mcp_endpoint TEXT,
    transport_type TEXT,
    package_registry TEXT,
    package_name TEXT,
    auth_required INTEGER DEFAULT 0,
    env_vars TEXT,
    icon_url TEXT,
    pricing_tier TEXT DEFAULT 'free',
    registry_status TEXT DEFAULT 'active',
    registry_published_at TEXT,
    registry_updated_at TEXT,
    tools_extracted INTEGER DEFAULT 0,
    tools_count INTEGER DEFAULT 0,
    readme_extracted INTEGER DEFAULT 0,
    readme_text TEXT,
    license TEXT,
    stars INTEGER,
    last_probed TEXT,
    last_pulled TEXT,
    probe_status TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_services_category ON services(category);
  CREATE INDEX IF NOT EXISTS idx_services_slug ON services(slug);
  CREATE INDEX IF NOT EXISTS idx_services_stars ON services(stars DESC);
  CREATE INDEX IF NOT EXISTS idx_services_probe_status ON services(probe_status);

  -------------------------------------------------
  -- Tools — individual tools exposed by each service
  -------------------------------------------------
  CREATE TABLE IF NOT EXISTS tools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id INTEGER REFERENCES services(id),
    name TEXT NOT NULL,
    description TEXT,
    input_schema TEXT,
    output_description TEXT,
    source TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(service_id, name)
  );

  CREATE INDEX IF NOT EXISTS idx_tools_service ON tools(service_id);
  CREATE INDEX IF NOT EXISTS idx_tools_name ON tools(name);

  -------------------------------------------------
  -- Categories
  -------------------------------------------------
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    service_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -------------------------------------------------
  -- Service ↔ Category mapping (many-to-many)
  -------------------------------------------------
  CREATE TABLE IF NOT EXISTS service_categories (
    service_id INTEGER REFERENCES services(id),
    category_id INTEGER REFERENCES categories(id),
    is_primary INTEGER DEFAULT 0,
    score INTEGER DEFAULT 0,
    PRIMARY KEY (service_id, category_id)
  );

  CREATE INDEX IF NOT EXISTS idx_sc_service ON service_categories(service_id);
  CREATE INDEX IF NOT EXISTS idx_sc_category ON service_categories(category_id);

  -------------------------------------------------
  -- Probes — history of live MCP endpoint checks
  -------------------------------------------------
  CREATE TABLE IF NOT EXISTS probes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id INTEGER REFERENCES services(id),
    probe_type TEXT,
    status_code INTEGER,
    response_time_ms INTEGER,
    tools_found INTEGER DEFAULT 0,
    error TEXT,
    probed_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_probes_service ON probes(service_id);
  CREATE INDEX IF NOT EXISTS idx_probes_time ON probes(probed_at);

  -------------------------------------------------
  -- Agent access log (same pattern as Origin)
  -------------------------------------------------
  CREATE TABLE IF NOT EXISTS agent_access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT,
    agent_type TEXT,
    endpoint TEXT,
    query_params TEXT,
    service_requested TEXT,
    response_tokens INTEGER,
    ip_address TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_access_agent ON agent_access_log(agent_type);
  CREATE INDEX IF NOT EXISTS idx_access_time ON agent_access_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_access_service ON agent_access_log(service_requested);
`);

// Seed categories
const CATEGORIES = [
  { slug: 'finance', name: 'Finance & Fintech', description: 'Payments, banking, accounting, trading, invoicing' },
  { slug: 'search', name: 'Search & Web', description: 'Web search, crawling, browsing, research' },
  { slug: 'data-analytics', name: 'Data & Analytics', description: 'Databases, analytics, metrics, visualization, BI' },
  { slug: 'devtools', name: 'Developer Tools', description: 'Git, CI/CD, debugging, testing, deployment' },
  { slug: 'communication', name: 'Communication', description: 'Email, chat, messaging, calendar, notifications' },
  { slug: 'security', name: 'Security', description: 'Auth, encryption, vulnerability scanning, compliance' },
  { slug: 'legal', name: 'Legal & Compliance', description: 'Contracts, regulations, GDPR, privacy, audits' },
  { slug: 'healthcare', name: 'Healthcare', description: 'Medical, clinical, FHIR, EHR, pharma' },
  { slug: 'marketing', name: 'Marketing & Sales', description: 'SEO, CRM, campaigns, social media, advertising' },
  { slug: 'publishing', name: 'Publishing & Content', description: 'CMS, blogs, docs, wiki, content management' },
  { slug: 'ai-ml', name: 'AI & Machine Learning', description: 'LLMs, inference, training, embeddings, models' },
  { slug: 'database', name: 'Databases', description: 'Postgres, MySQL, Mongo, Redis, vector DBs' },
  { slug: 'cloud', name: 'Cloud & Infrastructure', description: 'AWS, Azure, GCP, serverless, hosting' },
  { slug: 'identity-auth', name: 'Identity & Auth', description: 'OAuth, SSO, JWT, identity providers' },
  { slug: 'news-media', name: 'News & Media', description: 'News feeds, RSS, podcasts, video, journalism' },
  { slug: 'productivity', name: 'Productivity', description: 'Notion, Obsidian, task management, notes' },
  { slug: 'ecommerce', name: 'E-commerce', description: 'Shopify, carts, inventory, product catalogs' },
  { slug: 'crypto-web3', name: 'Crypto & Web3', description: 'Blockchain, DeFi, NFTs, wallets, smart contracts' },
  { slug: 'other', name: 'Other', description: 'Services that do not fit other categories' },
];

const insertCategory = db.prepare(
  'INSERT OR IGNORE INTO categories (slug, name, description) VALUES (?, ?, ?)'
);
for (const c of CATEGORIES) insertCategory.run(c.slug, c.name, c.description);

export default db;
