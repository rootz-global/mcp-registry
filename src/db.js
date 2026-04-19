/**
 * MCP Service Registry — Database (MySQL)
 *
 * Async wrapper over mysql2/promise pool.
 * Drop-in replacement for the old better-sqlite3 module.
 *
 * Config via epistery Config module:
 *   ~/.epistery/mcp.epistery.io/config.ini
 *   [mysql]
 *   host=127.0.0.1
 *   port=3307
 *   user=admin
 *   password=...
 *   database=mcp_registry
 *
 * Exports: { pool, get, all, run, execute, init }
 */
import mysql from 'mysql2/promise';
import { Config } from 'epistery';

const config = new Config();
config.setPath('/mcp.epistery.io');
const mysqlConfig = config.data.mysql || {};

const pool = mysql.createPool({
  host:     mysqlConfig.host     || '127.0.0.1',
  port:     parseInt(mysqlConfig.port || '3307'),
  user:     mysqlConfig.user     || 'admin',
  password: mysqlConfig.password || '',
  database: mysqlConfig.database || 'mcp_registry',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
});

/** First row or null */
async function get(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows[0] || null;
}

/** All rows as array */
async function all(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** INSERT / UPDATE / DELETE — returns { insertId, affectedRows } */
async function run(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return { insertId: result.insertId, affectedRows: result.affectedRows };
}

/** Raw execution for DDL (multi-statement safe) */
async function execute(sql) {
  const conn = await pool.getConnection();
  try {
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await conn.query(stmt);
    }
  } finally {
    conn.release();
  }
}

// ============================================================
// Schema + seed
// ============================================================
async function init() {
  await execute(`
    CREATE TABLE IF NOT EXISTS services (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      slug VARCHAR(255) UNIQUE,
      title TEXT,
      description TEXT,
      version VARCHAR(64),
      category VARCHAR(64),
      website_url TEXT,
      repository_url TEXT,
      repository_source VARCHAR(64),
      repository_subfolder VARCHAR(255),
      mcp_endpoint TEXT,
      transport_type VARCHAR(64),
      package_registry VARCHAR(64),
      package_name VARCHAR(255),
      auth_required INT DEFAULT 0,
      env_vars TEXT,
      icon_url TEXT,
      pricing_tier VARCHAR(32) DEFAULT 'free',
      registry_status VARCHAR(32) DEFAULT 'active',
      registry_published_at VARCHAR(64),
      registry_updated_at VARCHAR(64),
      tools_extracted INT DEFAULT 0,
      tools_count INT DEFAULT 0,
      readme_extracted INT DEFAULT 0,
      readme_text MEDIUMTEXT,
      license VARCHAR(64),
      stars INT,
      last_probed VARCHAR(64),
      last_pulled VARCHAR(64),
      probe_status VARCHAR(64),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tools (
      id INT AUTO_INCREMENT PRIMARY KEY,
      service_id INT,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      input_schema TEXT,
      output_description TEXT,
      source VARCHAR(64),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tools_svc_name (service_id, name),
      FOREIGN KEY (service_id) REFERENCES services(id)
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      service_count INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS service_categories (
      service_id INT,
      category_id INT,
      is_primary INT DEFAULT 0,
      score INT DEFAULT 0,
      PRIMARY KEY (service_id, category_id),
      FOREIGN KEY (service_id) REFERENCES services(id),
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    CREATE TABLE IF NOT EXISTS probes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      service_id INT,
      probe_type VARCHAR(64),
      status_code INT,
      response_time_ms INT,
      tools_found INT DEFAULT 0,
      error TEXT,
      probed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (service_id) REFERENCES services(id)
    );

    CREATE TABLE IF NOT EXISTS agent_access_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      agent_id VARCHAR(255),
      agent_type VARCHAR(64),
      endpoint VARCHAR(255),
      query_params TEXT,
      service_requested VARCHAR(255),
      response_tokens INT,
      ip_address VARCHAR(45),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Indexes (CREATE INDEX IF NOT EXISTS is not standard MySQL — use a helper)
  const indexes = [
    'CREATE INDEX idx_services_category ON services(category)',
    'CREATE INDEX idx_services_slug ON services(slug)',
    'CREATE INDEX idx_services_stars ON services(stars)',
    'CREATE INDEX idx_services_probe_status ON services(probe_status)',
    'CREATE INDEX idx_tools_service ON tools(service_id)',
    'CREATE INDEX idx_tools_name ON tools(name)',
    'CREATE INDEX idx_sc_service ON service_categories(service_id)',
    'CREATE INDEX idx_sc_category ON service_categories(category_id)',
    'CREATE INDEX idx_probes_service ON probes(service_id)',
    'CREATE INDEX idx_probes_time ON probes(probed_at)',
    'CREATE INDEX idx_access_agent ON agent_access_log(agent_type)',
    'CREATE INDEX idx_access_time ON agent_access_log(created_at)',
    'CREATE INDEX idx_access_service ON agent_access_log(service_requested)',
  ];
  for (const ddl of indexes) {
    try { await pool.query(ddl); } catch (e) {
      // 1061 = duplicate key name — index already exists
      if (e.errno !== 1061) throw e;
    }
  }

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
  for (const c of CATEGORIES) {
    await run(
      'INSERT IGNORE INTO categories (slug, name, description) VALUES (?, ?, ?)',
      [c.slug, c.name, c.description]
    );
  }
}

const db = { pool, get, all, run, execute, init };
export default db;

// Standalone test: node src/db.js
if (process.argv[1]?.endsWith('db.js')) {
  init()
    .then(() => { console.log('DB init OK — tables created, categories seeded'); process.exit(0); })
    .catch(e => { console.error('DB init FAILED:', e); process.exit(1); });
}
