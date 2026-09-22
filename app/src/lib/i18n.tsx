import { createContext, useContext, useEffect, useState } from 'react'

// Two locales, no dependency. Keys are namespaced by surface so a missing one is obvious in review,
// and the fallback is always Chinese: a half-translated English page is worse than a consistent one.

export type Locale = 'zh' | 'en'
export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
]

export const STORAGE_KEY = 'lovbase.locale'
/**
 * The same choice, in a cookie.
 *
 * localStorage is invisible to the server, so a locale kept only there forces SSR to guess, and
 * the guess is corrected after hydration — which is the Chinese flash. A cookie rides along with
 * the request, so the server can render the right language the first time.
 */
export const LOCALE_COOKIE = 'lovbase_locale'

export const localeFromCookie = (header: string | null | undefined): Locale | null => {
  const m = header?.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=(zh|en)(?:;|$)`))
  return (m?.[1] as Locale) ?? null
}

/** Stored choice, else the browser's preference, else Chinese. */
export function detectLocale(): Locale {
  if (typeof window === 'undefined') return 'zh'
  const cookie = localeFromCookie(document.cookie)
  if (cookie) return cookie
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'zh' || saved === 'en') return saved
  } catch { /* private mode */ }
  return (navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

type Dict = Record<string, string>

const zh: Dict = {}   // Chinese is the source language: keys fall back to `en` only when missing here.

const en: Dict = {
  // ── chrome ──
  'nav.features': 'Features',
  'nav.pricing': 'Pricing',
  'nav.login': 'Log in',
  'nav.start': 'Start building',
  'nav.home': 'Home',
  'nav.search': 'Search',
  'nav.admin': 'Admin',
  'nav.projects': 'Projects',
  'nav.starred': 'Starred',
  'nav.mine': 'Created by me',
  'nav.recent': 'Recent',
  'nav.settings': 'Account',
  'nav.signout': 'Sign out',
  'nav.upgrade': 'Upgrade',
  'nav.publish': 'Publish',
  'nav.share': 'Share',
  'nav.usage': 'Usage',
  'nav.upgradePlan': 'Upgrade plan',
  'nav.allProjects': 'All projects',
  'nav.credits': 'Credits',
  'nav.resets': 'reset',
  'nav.projectsUnit': 'projects',
  'nav.folders.none': 'No folders',

  // ── builder ──
  'pane.preview': 'Preview',
  'pane.database': 'Database',
  'pane.code': 'Code',
  'pane.analytics': 'Analytics',
  'preview.empty.title': 'No data model yet',
  'code.files': 'Files',
  'preview.building.title': 'Building the interface',
  'chat.attach': 'Image, CSV or text',
  'nav.workspace': 'Open workspace',
  'pricing.card.current': 'Current plan',
  'pricing.card.asked': 'Noted, we will be in touch',
  'chat.plus.attach': 'Add attachment',
  'chat.plus.skills': 'Skills',
  'chat.plus.connectors': 'Connectors',
  'chat.plus.soon': 'Soon',
  'preview.waking.title': 'Starting the preview',
  'preview.loading.title': 'Loading the last build',
  'preview.asleep.title': 'Preview is asleep',
  'preview.wake': 'Wake preview',
  'preview.refresh': 'Reload preview',
  'preview.open': 'Open in a new tab',

  // ── composer ──
  'chat.placeholder': 'What should change? Schema, interface, data. Use @ to reference a file',
  'chat.hint': 'Enter to send · Shift+Enter for a new line · drop an image or CSV',
  'chat.skills': 'Skills',
  'chat.copy': 'Copy',
  'chat.edit': 'Edit and resend',
  'chat.retry': 'Regenerate',
  'chat.editing': 'Editing this message; sending regenerates from here',
  'chat.resuming': 'This turn is still running on the server, reconnecting…',
  'chat.outOfCredits.title': 'Out of credits for this period',
  'chat.outOfCredits.hint': 'Credits are metered by the tokens and model tier each turn actually uses. A credit pack picks up where you left off, upgrading works too, or wait for the next period.',
  'chat.seePlans': 'See plans',
  'chat.buyCredits': 'Buy credits',

  // ── account ──
  'account.title': 'Account',
  'chat.busy.title': 'Too many builds at once',
  'chat.busy.hint': 'Each build takes a container and they are all taken. Send it again in a moment — this one cost no credits.',
  'settings.appearance': 'Appearance',
  'settings.theme': 'Theme',
  'settings.language': 'Language',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.theme.system': 'System',
  'account.subtitle': 'Plan, usage and model. Generation runs on the platform model by default; Pro and above can bring their own.',
  'account.email': 'Email',
  'account.name': 'Name',
  'account.plan': 'Plan',
  'account.model': 'Current model',
  'account.projectQuota': 'Project quota',
  'account.credits': 'Credits this period',
  'account.resetsOn': 'Resets on',
  'account.used': 'Used',
  'account.left': 'Left',
  'account.total': 'Total',
  'account.byok.title': 'Bring your own model',
  'account.byok.locked': 'Point Lovbase at your own OpenAI-compatible endpoint and key, stored AES-GCM encrypted. Available on Pro and above. You are currently on the platform model.',
  'account.byok.unlock': 'Upgrade to unlock',
  'account.subscription': 'Subscription',
  'account.manage': 'Manage subscription',

  // ── marketing chrome ──
  'nav.aria.home': 'Lovbase home',
  'nav.aria.main': 'Main navigation',
  'nav.aria.menu': 'Menu',
  'cta.startFree': 'Start free',
  'footer.blurb': 'Describe an app in a sentence and get a real Postgres database and a working interface. Change the requirements later and not a row of existing data is lost.',
  'footer.product': 'Product',
  'footer.how': 'How it works',
  'footer.api': 'Data API',
  'footer.getStarted': 'Get started',
  'footer.signup': 'Sign up',
  'footer.selfhost': 'Self-host',
  'footer.openSource': 'Open source',

  // ── landing: hero ──
  'landing.hero.badge': 'The open-source Lovable alternative · built on your own Postgres',
  'landing.hero.title.a': 'Describe it once.',
  'landing.hero.title.b': 'Get a real database and an app.',
  'landing.hero.sub': 'AI designs the Postgres schema, Boris writes the app. The database is yours to connect to directly.',
  'landing.hero.seePricing': 'See pricing',
  'landing.hero.note': 'Free to start · {credits} credits a month, metered by usage · no credit card',

  // ── landing: how it works ──
  'landing.how.eyebrow': 'How it works',
  'landing.how.title': 'From one sentence to a live app, in four steps',
  'landing.how.sub': 'There is no "export it and wire up a database yourself" step in the middle. The database is real from the first step.',
  'landing.steps.describe.title': 'You describe what you need',
  'landing.steps.describe.body': 'Explain the business in plain language: customers, orders, follow-ups. No need to settle on fields or draw tables first.',
  'landing.steps.schema.title': 'It designs a real schema',
  'landing.steps.schema.body': 'The model emits IR with stable IDs, deterministic code compiles that into DDL, and real tables appear in your Postgres.',
  'landing.steps.build.title': 'Boris writes the interface',
  'landing.steps.build.body': 'Boris, the coding agent, writes a React frontend in a sandbox container that reads and writes the tables you just created. It is clickable the moment it lands.',
  'landing.steps.ship.title': 'Publish, then keep changing it',
  'landing.steps.ship.body': 'Publish a share link in one click. Change the requirements later and a rename is a RENAME, not a drop and recreate: not a row of existing data is lost.',

  // ── landing: features ──
  'landing.features.eyebrow': 'Why it is different',
  'landing.features.title': 'Other tools hand you a demo. Lovbase hands you infrastructure.',
  'landing.features.sub': 'Generating an interface is something everyone can do. The difference is whether what comes out still belongs to you.',
  'landing.features.db.title': 'A real Postgres database',
  'landing.features.db.body': 'Not a toy built-in store, and not a CSV export. Every project gets its own schema and a connection string, so psql, DBeaver, Metabase and Prisma connect straight to it.',
  'landing.features.db.p1': 'Own schema + restricted role',
  'landing.features.db.p2': 'Export SQL anytime',
  'landing.features.db.p3': 'REST data API',
  'landing.features.safe.title': 'The AI cannot delete your data',
  'landing.features.safe.body': 'The LLM never writes SQL. It only emits IR; a deterministic diff works out the change and compiles it into whitelisted DDL. Dropping a table or a column, or changing a type, has to be confirmed by you in the UI.',
  'landing.features.safe.p1': 'IR → diff → whitelisted DDL',
  'landing.features.safe.p2': 'Renames detected as RENAME',
  'landing.features.safe.p3': 'Destructive changes need confirmation',
  'landing.features.selfhost.title': 'Fully self-hostable',
  'landing.features.selfhost.body': 'The database, the main app and the sandbox that runs the code can all live on your own machines. docker compose brings up Postgres; the sandbox runner gives each app its own container on any Docker host.',
  'landing.features.selfhost.p1': 'docker compose for local',
  'landing.features.selfhost.p2': 'Self-hosted sandbox runner',
  'landing.features.selfhost.p3': 'Previews on your own domain',
  'landing.features.byok.title': 'BYOK: bring your own model',
  'landing.features.byok.body': 'From Pro up, point Lovbase at your own OpenAI-compatible endpoint and key, stored AES-GCM encrypted. Your model and your bill, including a model you host on your own network.',
  'landing.features.byok.p1': 'OpenAI-compatible endpoint',
  'landing.features.byok.p2': 'Keys stored encrypted',
  'landing.features.byok.p3': 'Pro and above',

  // ── landing: data API ──
  'api.title': 'Once it is generated, the data is still yours',
  'api.sub': 'Every project gets its own Postgres schema plus a role with DML permissions only. Connect directly with the connection string, or serve a frontend of your own through the REST endpoint.',
  'api.point1': 'The LLM never writes SQL; it emits IR, and deterministic code compiles that into DDL',
  'api.point2': 'The executing role has no CREATE / ALTER / DROP permission',
  'api.point3': 'Export the whole database as SQL and take it with you',
  'api.aria.tabs': 'Data API examples',
  'api.rest.note': 'Any frontend can read and write its own tables; auth is the project API token.',
  'api.rest.code.params': "    params: ['Shanghai'],",
  'api.rest.code.c1': '// Runs as the ws_<id> role, one statement, inside a transaction.',
  'api.rest.code.c2': '// That role only has SELECT/INSERT/UPDATE/DELETE on its own schema.',
  'api.psql.note': 'It is just Postgres. psql, DBeaver, Metabase and Prisma connect straight to it.',
  'api.schema.note': 'Structural change has exactly one path: IR to diff to whitelisted DDL, with destructive changes held for your confirmation.',
  'api.schema.code.get': 'GET  /api/data/:id/schema   → { ir, ddl, schema }',
  'api.schema.code.post': 'POST /api/data/:id/schema   → { ir } or { message }',

  // ── landing: open source ──
  'landing.open.eyebrow': 'Open source, self-hosted',
  'landing.open.title': 'No logo wall, only facts you can check yourself',
  'landing.open.sub': 'We are not going to line up avatars and numbers you have no way to verify. The more direct way to judge a data tool is to pull it down and run it yourself.',
  'landing.open.runLocally': 'Run it locally',
  'landing.selfhost.line.env': 'cp .env.example app/.dev.vars # LLM key, or use BYOK',
  'landing.open.code.k': 'The whole codebase is readable',
  'landing.open.code.v': 'The engine, the SQL gateway and the sandbox runner are all in the repo. It is not just an open SDK.',
  'landing.open.local.k': 'It runs on your machine',
  'landing.open.local.v': 'docker compose for Postgres, bun run dev, and that is the full product.',
  'landing.open.data.k': 'The data lives in your database',
  'landing.open.data.v': 'When you self-host, the connection string is yours and we cannot reach it.',
  'landing.open.model.k': 'The model is swappable',
  'landing.open.model.v': 'Self-hosted, you configure the model endpoint yourself; on the hosted version, BYOK from Pro up.',

  // ── landing: pricing teaser + CTA ──
  'landing.pricing.title': 'Priced per usage, not per seat',
  'landing.pricing.sub': 'Credits are metered against what each turn actually costs, and your own model key costs nothing. Free gives you {free} a month, enough to get an idea built.',
  'landing.pricing.more': 'See the full comparison and FAQ',
  'landing.cta.title': 'Create one table before you decide whether to trust it',
  'landing.cta.sub': 'Sign up, create a project, and get the connection string immediately. If it is not for you, export the data and take it with you.',
  'landing.cta.pricing': 'Check the pricing',

  // ── landing: hero mock ──
  'hero.appName': 'customer crm',
  'hero.pane.chat': 'Chat',
  'hero.pane.ui': 'Interface by Boris',
  'hero.chat.prompt': 'Build a CRM that tracks customers, contacts and follow-ups',
  'hero.chat.reply': 'Designed 3 tables, with contacts and follow-ups attached to customers.',
  'hero.chat.noDrop': 'No DROP, and no change that loses data.',
  'hero.ui.customers': 'Customers',
  'hero.ui.new': 'New',
  'hero.ui.col.name': 'Name',
  'hero.ui.col.city': 'City',
  'hero.ui.col.status': 'Status',
  'hero.ui.sameData': 'The same data, reachable from any client.',
  'hero.row1.name': 'Mingyuan Tech',
  'hero.row1.city': 'Shanghai',
  'hero.row2.name': 'Heshun Trading',
  'hero.row2.city': 'Guangzhou',
  'hero.row3.name': 'Qinghe Foods',
  'hero.row3.city': 'Chengdu',
  'hero.row4.name': 'Muguang Design',
  'hero.row4.city': 'Hangzhou',
  'hero.status.open': 'Following up',
  'hero.status.won': 'Closed',
  'hero.status.todo': 'To contact',

  // ── pricing: cards ──
  'pricing.aria.billing': 'Billing period',
  'pricing.billing.monthly': 'Monthly',
  'pricing.billing.yearly': 'Yearly',
  'pricing.billing.save': 'Save {pct}% yearly',
  'pricing.card.popular': 'Most popular',
  'pricing.card.creditsPerMonth': '{n} credits / mo',
  'pricing.card.perMonth': '/ mo',
  'pricing.card.freeForever': 'Free forever, no credit card',
  'pricing.card.billedYearly': 'Billed yearly at ${total}',
  'pricing.card.billedMonthly': 'Billed monthly, cancel anytime',
  'pricing.card.choose': 'Choose',

  // ── pricing: page ──
  'pricing.hero.title': 'Pay for what you use, not per head',
  'pricing.hero.sub': 'Credits are metered against what each turn actually costs. Your databases, tables and finished apps keep running even when credits run out.',
  'pricing.note.currency': 'Prices in USD. ',
  'pricing.note.yearly': 'Billed yearly that works out to ${price} a month (Pro), {pct}% less than monthly. ',
  'pricing.note.selfhost': 'Self-hosting is always free.',
  'pricing.credits.eyebrow': 'Credits',
  'pricing.credits.title': 'Every charge, itemised',
  'pricing.credits.sub': 'Priced against real cost, not against a vague unit like a "premium request". Every charge shows the model and the tokens behind it.',
  'pricing.credits.turn.title': 'One agent turn',
  'pricing.credits.turn.body': 'Charged on the tokens the turn actually spent and the tier of the model behind it, itemised afterwards.',
  'pricing.credits.build.title': 'One generated interface',
  'pricing.credits.build.body': 'Boris writes and runs the whole frontend inside a container, and the container time counts too, so it costs more.',
  'pricing.credits.metered': 'Metered',
  'pricing.packs.title': 'Out of credits? Buy a pack',
  'pricing.packs.sub': 'A one-off payment. Bought credits do not expire with the period, and are only spent once the plan\u2019s monthly allowance is gone.',
  'pricing.credits.unit': 'credits',
  'pricing.credits.free.title': 'Using what you already built',
  'pricing.credits.free.body': 'Reading and writing data, opening the app, connecting to the database and calling the data API all cost nothing.',
  'pricing.compare.eyebrow': 'Compare',
  'pricing.compare.title': 'What each of the three plans includes',
  'pricing.compare.head': 'Feature',
  'pricing.compare.recommended': 'Recommended',
  'pricing.compare.credits': 'Agent credits per month',
  'pricing.compare.credits.value': '{n} credits',
  'pricing.compare.projects': 'Projects',
  'pricing.compare.projects.value': '{n}',
  'pricing.compare.storage': 'Data storage',
  'pricing.compare.tables': 'Real Postgres tables',
  'pricing.compare.api': 'Data API (REST)',
  'pricing.compare.share': 'Public share links',
  'pricing.compare.byok': 'BYOK: your own model and key',
  'pricing.compare.direct': 'Direct database connection',
  'pricing.compare.direct.note': 'Connection string for a read-only account',
  'pricing.compare.export': 'Export SQL and project source',
  'pricing.compare.domain': 'Publish on a custom domain',
  'pricing.compare.queue': 'Priority generation queue',
  'pricing.compare.instance': 'Dedicated database instance',
  'pricing.compare.deploy': 'Assisted private deployment',
  'pricing.compare.deploy.note': 'Self-hosting it yourself is open to everyone; this is us helping you deploy',
  'pricing.compare.sso': 'SSO and audit logs',
  'pricing.compare.support': 'Support',
  'pricing.compare.support.free': 'Community',
  'pricing.compare.support.pro': 'Email support',
  'pricing.compare.support.business': 'Dedicated support',
  'pricing.faq.eyebrow': 'FAQ',
  'pricing.faq.title': 'What you are probably wondering',
  // Split around the GitHub link, which is hidden until VITE_GITHUB_URL is set; both halves have
  // to read sensibly with the link missing.
  'pricing.faq.more.before': 'Anything else?',
  'pricing.faq.more.after': 'Open an issue.',
  'pricing.faq.credit.q': 'What exactly is one credit?',
  'pricing.faq.credit.a': 'Credits are metered against real usage: what a turn costs depends on the model tier and the tokens it actually spent. A short question costs a few; having the agent read through your code and change three tables costs more. Every charge is itemised under Settings → Usage, down to which model and how many tokens. Turns on your own key (BYOK) cost nothing.',
  'pricing.faq.outOfCredits.q': 'What happens when I run out of credits?',
  'pricing.faq.outOfCredits.a': 'The databases, tables and data you have already built are untouched, apps keep serving, and the data API keeps reading and writing. Credits only gate putting the agent back to work. They reset at the start of each billing period: {free} a month on Free, {pro} on Pro and {business} on Business. Upgrade to keep going, or wait for the next period.',
  'pricing.faq.ownership.q': 'Who actually owns the data?',
  'pricing.faq.ownership.a': 'You do. Every project is its own Postgres schema, and paid plans hand you the connection string, so any Postgres client can connect. You can export the whole thing as SQL at any time, without going through our UI. We also never train models on your business data.',
  'pricing.faq.safety.q': 'Can the AI drop my tables?',
  'pricing.faq.safety.a': 'The model never changes structure directly. It only emits IR with stable IDs; deterministic code computes the diff and compiles it into whitelisted DDL. Renaming a field is recognized as a RENAME rather than a drop and recreate. Destructive changes such as dropping a table or a column or changing a type stop and wait for you to confirm them in the UI.',
  'pricing.faq.selfhost.q': 'Can I self-host it?',
  'pricing.faq.selfhost.a': 'Lovbase is open source and runs entirely on your own machines: docker compose for Postgres, the main app started locally, and the sandbox runner that executes generated code on your own Docker host. Self-hosting needs no paid plan; the "assisted private deployment" in Business means we help you deploy and maintain it.',
  'pricing.faq.byok.q': 'Can I use my own model key?',
  'pricing.faq.byok.a': 'Yes, on Pro and above. Put any OpenAI-compatible endpoint and key on the account page; the key is stored AES-GCM encrypted, and inference then runs on your own model and your own bill, including a model you host on your own network. Free uses the model the platform configures. Note that credits still count: we are still running the sandbox and the database.',
  'pricing.faq.refund.q': 'How do refunds work?',
  'pricing.faq.refund.a': 'A monthly subscription can be cancelled at any time; you keep access for the current period and are not billed again. If an annual plan turns out not to fit, contact us and we will refund the unused months.',
  'pricing.cta.title': 'The free plan already builds a real database',
  'pricing.cta.sub': 'Spend the {n} free credits getting the idea built, then decide.',

  // ── auth ──
  'auth.login.title': 'Log in',
  'auth.signup.title': 'Create an account',
  'auth.login.sub': 'Keep building your app',
  'auth.signup.sub': 'One sentence in, a real database out',
  'auth.field.name': 'Name',
  'auth.field.name.placeholder': 'What should we call you',
  'auth.field.email': 'Email',
  'auth.field.password': 'Password',
  'auth.field.password.placeholder': 'At least 8 characters',
  'auth.submitting': 'One moment…',
  'auth.signup.submit': 'Sign up',
  'auth.noAccount': 'No account yet?',
  'auth.hasAccount': 'Already have an account?',
  'auth.error.generic': 'Something went wrong. Try again.',
  'auth.social.github': 'Continue with GitHub',
  'auth.social.google': 'Continue with Google',
  'auth.or': 'or with email',

  // ── builder / projects ──
  'builder.back': 'Back to projects',
  'builder.untitled': 'Untitled project',
  'builder.collapseChat': 'Collapse chat (⌘/)',
  'builder.expandChat': 'Expand chat (⌘/)',
  'builder.noModel': 'No model configured → Settings',
  'builder.publishHint': 'Build the current interface',
  'builder.publishNeedsUi': 'Generate an interface first',
  'builder.publishing': 'Publishing…',
  'builder.published': 'Published',
  'builder.publishFailed': 'Publish failed',
  'builder.upgradeLogged': 'Noted. We will get in touch.',
  'projects.new': 'New project',
  'projects.emptyAll': 'No projects yet',
  'projects.emptyFiltered': 'Nothing here',
  'projects.emptyHint': 'Start from a template on the home page, or just describe the app you want.',
  'projects.emptyFilteredHint': 'Try another filter, or move a project in.',
  'projects.shared': 'Shared',
  'projects.tables': 'tables',
  'projects.unstar': 'Remove from starred',
  'nav.menu': 'Menu',
  'nav.closeMenu': 'Close menu',
  'account.packs.title': 'Buy credits',
  'account.packs.sub': 'Bought credits go to a wallet that does not expire with the period, and are only spent once the plan\u2019s monthly allowance is gone.',
  'account.wallet': 'Wallet',
  'account.creditsUnit': 'credits',
  'account.buy': 'Buy',
  'account.granted': 'Granted',
  'account.noted': 'Noted, we will be in touch',
  'projects.deleting': 'Deleting…',
  'projects.deleteFailed': 'Delete failed',
  'projects.limitHint': '. See Pro on the account page.',
  'chat.copied': 'Copied',
  'publish.open': 'Open live app',
  'publish.copy': 'Copy link',
  'publish.again': 'Republish current version',
  'publish.customise': 'Custom subdomain',
  'publish.promptSubdomain': 'Custom subdomain (lowercase letters, digits, hyphens)',
  'publish.lastAt': 'Last published',
  'publish.unpublish': 'Take offline',
  'publish.confirmUnpublish': 'The address stops working immediately. Continue?',
  'publish.unpublishTitle': 'Take the app offline?',
  'publish.subdomainLabel': 'Subdomain',
  'dialog.cancel': 'Cancel',
  'dialog.ok': 'OK',
  'dialog.gotIt': 'Got it',
  'dialog.error': 'Something went wrong',
}

const DICTS: Record<Locale, Dict> = { zh, en }

type Ctx = { locale: Locale; setLocale: (l: Locale) => void; t: (key: string, fallback: string) => string }
const I18nContext = createContext<Ctx>({ locale: 'zh', setLocale: () => {}, t: (_k, f) => f })

export function I18nProvider({ children, initial }: { children: React.ReactNode; initial?: Locale }) {
  // `initial` is read from the cookie on the server, so the first paint is already in the right
  // language and hydration agrees with it. Without one (no cookie yet) fall back to the old
  // behaviour: render Chinese, correct after mount. That still flashes, but only ever once —
  // picking a language writes the cookie, and every later request is server-rendered correctly.
  const [locale, setLocaleState] = useState<Locale>(initial ?? 'zh')
  useEffect(() => { if (!initial) setLocaleState(detectLocale()) }, [initial])

  const setLocale = (l: Locale) => {
    setLocaleState(l)
    try { localStorage.setItem(STORAGE_KEY, l) } catch { /* private mode */ }
    if (typeof document !== 'undefined') {
      document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'
      // A year, so a returning visitor is server-rendered in their language. Lax is enough: this
      // is a display preference, not anything that needs to survive a cross-site POST.
      document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`
    }
  }

  /** `fallback` is the Chinese source text, so an untranslated key still reads correctly. */
  const t = (key: string, fallback: string) => DICTS[locale][key] ?? fallback

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>
}

export const useI18n = () => useContext(I18nContext)
/** `t('nav.pricing', '价格')` — the second argument is the Chinese original. */
export const useT = () => useI18n().t
