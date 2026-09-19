// Subdomains a tenant must never be able to claim. Three reasons, and the third is the one
// people forget:
//   1. platform hosts — taking `api` or `cdn` would shadow our own services;
//   2. impersonation — `login`, `billing`, `security` on our own domain is a phishing kit;
//   3. domain control validation — certificate authorities and mail RFCs treat `admin`,
//      `administrator`, `hostmaster`, `postmaster` and `webmaster` as proof of ownership, so
//      handing one to a stranger can hand them a certificate.
export const RESERVED_SUBDOMAINS = new Set([
  // platform + infrastructure
  'www', 'api', 'app', 'apps', 'cdn', 'assets', 'static', 'media', 'img', 'images', 'files',
  'download', 'downloads', 'upload', 'uploads', 'storage', 'db', 'database', 'sql', 'redis',
  'proxy', 'gateway', 'edge', 'origin', 'lb', 'ns', 'ns1', 'ns2', 'ns3', 'ns4', 'dns', 'mx',
  'smtp', 'imap', 'pop', 'pop3', 'ftp', 'sftp', 'ssh', 'vpn', 'git', 'svn', 'ci', 'cd',
  'build', 'deploy', 'staging', 'stage', 'dev', 'test', 'testing', 'qa', 'preview', 'demo',
  'sandbox', 'local', 'localhost', 'internal', 'private', 'public', 'beta', 'alpha', 'canary',
  'prod', 'production', 'live', 'backup', 'archive', 'log', 'logs', 'metrics', 'monitor',
  'monitoring', 'grafana', 'kibana', 'prometheus', 'status', 'health', 'ping', 'debug',
  // certificate and mail control — never hand these out
  'admin', 'administrator', 'hostmaster', 'postmaster', 'webmaster', 'root', 'sysadmin',
  'ssl', 'tls', 'cert', 'certs', 'acme', 'autodiscover', 'autoconfig', 'mail', 'email',
  'abuse', 'security', 'noc', 'soc', 'noreply', 'no-reply',
  // product surfaces someone could impersonate
  'account', 'accounts', 'auth', 'oauth', 'sso', 'login', 'signin', 'signup', 'register',
  'logout', 'password', 'reset', 'verify', 'verification', 'token', 'session', 'dashboard',
  'console', 'panel', 'portal', 'settings', 'profile', 'user', 'users', 'me', 'my',
  'billing', 'payment', 'payments', 'pay', 'checkout', 'invoice', 'invoices', 'subscribe',
  'subscription', 'pricing', 'plans', 'upgrade', 'refund', 'store', 'shop', 'order', 'orders',
  // content and support
  'about', 'blog', 'news', 'press', 'help', 'support', 'docs', 'doc', 'documentation', 'faq',
  'contact', 'careers', 'jobs', 'legal', 'terms', 'privacy', 'policy', 'dmca', 'gdpr',
  'community', 'forum', 'chat', 'events', 'partners', 'affiliate', 'enterprise', 'sales',
  'search', 'go', 'link', 'links', 'share', 'embed', 'widget', 'track', 'analytics',
  // the product itself
  'lovbase', 'boris', 'official', 'team', 'staff', 'system',
])

/** Also refuse anything that merely looks like our preview hosts (5173-<id>-<token>). */
export const looksLikePreviewHost = (slug: string) => /^\d{2,5}-/.test(slug)
