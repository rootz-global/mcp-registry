/**
 * MCP Service Categorizer
 *
 * Keyword-based categorization. No AI needed.
 * Runs after puller, before static-builder.
 *
 * Usage:
 *   node src/categorizer.js              — categorize all services
 *   node src/categorizer.js --recat      — re-categorize (clear existing)
 */
import db from './db.js';

const CATEGORY_KEYWORDS = {
  'finance': [
    'stripe', 'payment', 'billing', 'invoice', 'fintech', 'banking',
    'trading', 'revenue', 'checkout', 'accounting', 'quickbook', 'taxes',
    'financial', 'ledger', 'bookkeep', 'expense', 'payroll', 'refund',
    'subscription', 'stocks', 'securities', 'portfolio', 'bank', 'credit',
  ],
  'search': [
    'search', 'web search', 'google', 'bing', 'crawl', 'scrape', 'browse',
    'fetch', 'brave search', 'duckduckgo', 'serp', 'query the web',
  ],
  'data-analytics': [
    'analytics', 'metrics', 'dashboard', 'bigquery', 'snowflake', 'warehouse',
    'dataset', 'csv', 'excel', 'spreadsheet', 'visualization', 'chart',
    'statistics', 'kpi', 'observability', 'monitoring', 'telemetry',
  ],
  'devtools': [
    'github', 'gitlab', 'bitbucket', 'debug', 'lint', 'ci', 'cd', 'deploy',
    'docker', 'kubernetes', 'terminal', 'ide', 'cursor', 'vscode', 'jetbrains',
    'test', 'testing', 'sentry', 'stack trace', 'codebase', 'code review',
    'pull request', 'issue tracker', 'jira', 'linear',
  ],
  'communication': [
    'email', 'slack', 'discord', 'telegram', 'sms', 'notification', 'chat',
    'message', 'calendar', 'meeting', 'zoom', 'teams', 'outlook', 'gmail',
    'matrix', 'signal', 'whatsapp', 'voice', 'call',
  ],
  'security': [
    'security', 'vulnerability', 'scan', 'firewall', 'audit', 'penetration',
    'malware', 'ransomware', 'threat', 'cve', 'owasp', 'xss', 'sql injection',
    'cryptography', 'encrypt', 'decrypt', 'signing', 'certificate',
  ],
  'legal': [
    'legal', 'compliance', 'regulation', 'contract', 'gdpr', 'privacy',
    'hipaa', 'kyc', 'aml', 'terms', 'lawsuit', 'litigation', 'patent',
    'trademark', 'copyright', 'attorney', 'counsel',
  ],
  'healthcare': [
    'health', 'medical', 'patient', 'clinical', 'fhir', 'ehr', 'pharma',
    'hospital', 'diagnosis', 'prescription', 'therapy', 'doctor', 'nurse',
    'wellness', 'fitness', 'nutrition',
  ],
  'marketing': [
    'marketing', 'seo', 'social media', 'campaign', 'advertising', 'crm',
    'salesforce', 'hubspot', 'mailchimp', 'lead', 'funnel', 'conversion',
    'a/b test', 'landing page', 'affiliate',
  ],
  'publishing': [
    'blog', 'cms', 'wordpress', 'content management', 'publish', 'document',
    'wiki', 'notion', 'obsidian', 'markdown', 'google docs', 'docs',
    'ghost', 'substack', 'medium', 'confluence',
  ],
  'ai-ml': [
    'machine learning', ' llm ', ' llms ', 'inference', 'embedding', 'vector',
    'openai', 'anthropic', 'hugging face', 'replicate', 'fine-tun',
    'training', 'model hosting', 'prompt', 'rag ',
  ],
  'database': [
    'postgres', 'postgresql', 'mysql', 'mariadb', 'mongodb', 'redis',
    'sqlite', 'supabase', 'firebase', 'dynamodb', 'cassandra', 'neo4j',
    'pinecone', 'weaviate', 'qdrant', 'chroma', 'milvus', 'duckdb',
    'clickhouse', 'database', ' sql ', 'nosql',
  ],
  'cloud': [
    ' aws ', ' azure ', ' gcp ', 'cloudflare', 'serverless', 'lambda',
    'hosting', ' s3 ', 'bucket', 'cloud run', 'fargate', 'ec2', 'vpc',
    'load balancer', 'cdn ',
  ],
  'identity-auth': [
    'identity', 'authentication', 'oauth', 'sso', ' jwt ', 'keycloak',
    'ldap', 'saml', 'auth0', 'okta', 'clerk', 'supertokens', 'magic link',
    'passkey', 'webauthn',
  ],
  'news-media': [
    'news', 'rss', 'feed', 'journalism', 'podcast', 'video', 'youtube',
    'reuters', 'bloomberg', 'headlines', 'press release', 'wire service',
    'newsletter',
  ],
  'productivity': [
    'productivity', 'todo', 'task management', 'gtd', 'project management',
    'kanban', 'gantt', 'time track', 'asana', 'monday', 'basecamp',
    'reminder',
  ],
  'ecommerce': [
    'shopify', 'woocommerce', 'magento', 'bigcommerce', 'cart', 'checkout',
    'inventory', 'product catalog', 'storefront', 'merchant',
  ],
  'crypto-web3': [
    'blockchain', 'crypto', 'bitcoin', 'ethereum', 'defi', ' nft ', 'wallet',
    'smart contract', 'web3', 'solana', 'polygon', 'arbitrum', 'optimism',
    'dex ', 'token', 'metamask',
  ],
};

function scoreText(text, keywords) {
  const lower = (' ' + text.toLowerCase() + ' ').replace(/[^\w\s/.-]/g, ' ');
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) score++;
  }
  return score;
}

function categorize(service) {
  // Don't use name/repo_url/package_name for keyword matching —
  // they often contain 'github' or 'npm' as namespace artifacts, not semantic signals.
  // Focus on the human-written title + description.
  const text = [
    service.title || '',
    service.description || '',
  ].join(' ');

  const scores = {};
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = scoreText(text, keywords);
    if (score > 0) scores[cat] = score;
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const primary = sorted[0]?.[0] || 'other';
  const allMatches = sorted;

  return { primary, all: allMatches };
}

function run() {
  const recat = process.argv.includes('--recat');

  if (recat) {
    console.log('Clearing existing categorizations...');
    db.prepare('DELETE FROM service_categories').run();
    db.prepare('UPDATE services SET category = NULL').run();
  }

  const services = db.prepare('SELECT id, name, title, description, package_name, repository_url FROM services').all();
  console.log(`Categorizing ${services.length} services...`);

  const updateService = db.prepare('UPDATE services SET category = ? WHERE id = ?');
  const insertMapping = db.prepare(`
    INSERT OR IGNORE INTO service_categories (service_id, category_id, is_primary, score)
    VALUES (?, ?, ?, ?)
  `);
  const getCategoryId = db.prepare('SELECT id FROM categories WHERE slug = ?');

  const stats = {};
  const txn = db.transaction((svcs) => {
    for (const svc of svcs) {
      const { primary, all } = categorize(svc);
      updateService.run(primary, svc.id);
      stats[primary] = (stats[primary] || 0) + 1;

      for (const [cat, score] of all) {
        const catRow = getCategoryId.get(cat);
        if (catRow) {
          insertMapping.run(svc.id, catRow.id, cat === primary ? 1 : 0, score);
        }
      }
    }
  });
  txn(services);

  // Update category service counts
  db.prepare(`
    UPDATE categories SET service_count = (
      SELECT COUNT(*) FROM services WHERE category = categories.slug
    )
  `).run();

  console.log('\n=== Categorization Complete ===');
  const sorted = Object.entries(stats).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sorted) {
    console.log(`  ${cat}: ${count}`);
  }
  console.log(`\nTotal: ${services.length}`);
}

run();
