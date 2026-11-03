import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import type { IR, Field } from '@lovbase/core/ir'
import { irToDDL, qi } from '@lovbase/core/ddl'
import type { Priority, Team } from '@lovbase/core/helpdesk'

type Definition = [string, string, Array<[string, Field['type'], string?]>]
const definitions: Definition[] = [
  [
    'customers',
    '客户',
    [
      ['name', 'text'],
      ['email', 'text'],
      ['company', 'text'],
      ['plan', 'select', 'free,pro,enterprise'],
    ],
  ],
  [
    'agents',
    '客服',
    [
      ['name', 'text'],
      ['email', 'text'],
      ['team', 'select', 'frontline,technical,billing'],
      ['active', 'boolean'],
    ],
  ],
  [
    'sla_policies',
    'SLA 策略',
    [
      ['priority', 'select', 'urgent,high,normal,low'],
      ['first_response_minutes', 'number'],
      ['resolution_minutes', 'number'],
    ],
  ],
  [
    'tickets',
    '工单',
    [
      ['subject', 'text'],
      ['customer_id', 'link', 'customers'],
      ['assignee_id', 'link', 'agents'],
      ['status', 'select', 'new,open,pending,solved,closed'],
      ['priority', 'select', 'urgent,high,normal,low'],
      ['channel', 'select', 'email,chat,phone,web'],
      ['tags', 'text'],
      ['response_due_at', 'date'],
      ['due_at', 'date'],
      ['first_response_at', 'date'],
      ['solved_at', 'date'],
      ['last_activity_at', 'date'],
    ],
  ],
  [
    'messages',
    '消息',
    [
      ['ticket_id', 'link', 'tickets'],
      ['author_kind', 'select', 'customer,agent,note'],
      ['agent_id', 'link', 'agents'],
      ['body', 'text'],
    ],
  ],
]
export const helpdeskIR: IR = {
  version: 1,
  appName: 'Helpdesk',
  entities: definitions.map(([dbName, name, fields]) => ({
    id: dbName,
    dbName,
    name,
    fields: fields.map(([field, type, extra]) => ({
      id: `${dbName}_${field}`,
      dbName: field,
      name: field,
      type,
      required: false,
      ...(type === 'link' ? { linkTo: extra } : {}),
      ...(type === 'select' ? { options: extra!.split(',') } : {}),
    })),
  })),
}

const minutes = (column: string) => `CHECK(${column} = trunc(${column}) AND ${column} > 0 AND ${column} <= 525600)`
const raise = (code: string) => `RAISE EXCEPTION '${code}' USING ERRCODE = 'check_violation'`

/**
 * The ticket lifecycle lives in the database. A copy's client only inserts messages and updates
 * a ticket's status, priority or assignee; SLA targets, first-response and solved stamps and the
 * automatic status moves follow from triggers, so the SQL console, an import or an app the owner
 * rewrites later all keep the same history.
 */
export async function installHelpdesk(c: pg.PoolClient, schema: string) {
  await c.query(irToDDL(helpdeskIR, schema))
  const s = qi(schema)
  const table = (name: string) => `${s}.${qi(name)}`
  await c.query(`ALTER TABLE ${table('customers')}
    ALTER COLUMN name SET NOT NULL, ALTER COLUMN email SET NOT NULL,
    ALTER COLUMN company SET NOT NULL, ALTER COLUMN company SET DEFAULT '',
    ALTER COLUMN plan SET NOT NULL, ALTER COLUMN plan SET DEFAULT 'free',
    ADD CHECK(length(btrim(name)) > 0), ADD CHECK(email ~ '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$'),
    ADD CHECK(plan IN ('free','pro','enterprise')),
    ADD CONSTRAINT customers_email_key UNIQUE(email)`)
  await c.query(`ALTER TABLE ${table('agents')}
    ALTER COLUMN name SET NOT NULL, ALTER COLUMN email SET NOT NULL, ALTER COLUMN team SET NOT NULL,
    ALTER COLUMN active SET NOT NULL, ALTER COLUMN active SET DEFAULT true,
    ADD CHECK(length(btrim(name)) > 0), ADD CHECK(team IN ('frontline','technical','billing')), ADD UNIQUE(email)`)
  await c.query(`ALTER TABLE ${table('sla_policies')}
    ALTER COLUMN priority SET NOT NULL, ALTER COLUMN first_response_minutes SET NOT NULL,
    ALTER COLUMN resolution_minutes SET NOT NULL,
    ADD CHECK(priority IN ('urgent','high','normal','low')), ADD UNIQUE(priority),
    ADD ${minutes('first_response_minutes')}, ADD ${minutes('resolution_minutes')},
    ADD CHECK(resolution_minutes >= first_response_minutes)`)
  await c.query(`ALTER TABLE ${table('tickets')}
    ALTER COLUMN subject SET NOT NULL, ALTER COLUMN customer_id SET NOT NULL,
    ALTER COLUMN status SET NOT NULL, ALTER COLUMN status SET DEFAULT 'new',
    ALTER COLUMN priority SET NOT NULL, ALTER COLUMN priority SET DEFAULT 'normal',
    ALTER COLUMN channel SET NOT NULL, ALTER COLUMN channel SET DEFAULT 'web',
    ALTER COLUMN tags SET NOT NULL, ALTER COLUMN tags SET DEFAULT '',
    ALTER COLUMN last_activity_at SET NOT NULL, ALTER COLUMN last_activity_at SET DEFAULT now(),
    ADD CHECK(length(btrim(subject)) BETWEEN 1 AND 200),
    ADD CHECK(status IN ('new','open','pending','solved','closed')),
    ADD CHECK(priority IN ('urgent','high','normal','low')),
    ADD CHECK(channel IN ('email','chat','phone','web')),
    ADD CHECK((solved_at IS NOT NULL) = (status IN ('solved','closed'))),
    ADD CHECK(solved_at >= created_at), ADD CHECK(first_response_at >= created_at)`)
  await c.query(`ALTER TABLE ${table('messages')}
    ALTER COLUMN ticket_id SET NOT NULL, ALTER COLUMN author_kind SET NOT NULL, ALTER COLUMN body SET NOT NULL,
    ADD CHECK(author_kind IN ('customer','agent','note')),
    ADD CHECK(length(btrim(body)) BETWEEN 1 AND 10000),
    ADD CONSTRAINT messages_author_check CHECK((author_kind = 'customer') = (agent_id IS NULL))`)
  await c.query(`CREATE INDEX ON ${table('tickets')}(status)`)
  await c.query(`CREATE INDEX ON ${table('tickets')}(customer_id)`)
  await c.query(`CREATE INDEX ON ${table('tickets')}(last_activity_at)`)
  await c.query(`CREATE INDEX ON ${table('messages')}(ticket_id, created_at)`)

  // Tickets: SLA targets from the policy, solved stamp, closed is final, derived columns guarded.
  await c.query(`CREATE FUNCTION ${s}.helpdesk_ticket_rules() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE response numeric; resolution numeric;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.first_response_at IS NOT NULL THEN ${raise('helpdesk_first_response_derived')}; END IF;
        IF NEW.status = 'closed' THEN ${raise('helpdesk_close_unsolved')}; END IF;
        NEW.last_activity_at := NEW.created_at;
      ELSE
        IF OLD.status = 'closed' AND (NEW.status, NEW.priority, NEW.assignee_id)
            IS DISTINCT FROM (OLD.status, OLD.priority, OLD.assignee_id) THEN
          ${raise('helpdesk_ticket_closed')};
        END IF;
        -- Only the messages trigger (one level down) may stamp the first response.
        IF NEW.first_response_at IS DISTINCT FROM OLD.first_response_at AND pg_trigger_depth() < 2 THEN
          ${raise('helpdesk_first_response_derived')};
        END IF;
        IF NEW.status = 'closed' AND OLD.status NOT IN ('solved', 'closed') THEN
          ${raise('helpdesk_close_unsolved')};
        END IF;
      END IF;
      IF NEW.assignee_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id)
          AND NOT EXISTS (SELECT 1 FROM ${table('agents')} WHERE id = NEW.assignee_id AND active) THEN
        ${raise('helpdesk_agent_inactive')};
      END IF;
      -- Targets are measured from creation, so raising the priority can make a ticket overdue at once.
      IF TG_OP = 'INSERT' OR NEW.priority IS DISTINCT FROM OLD.priority THEN
        SELECT first_response_minutes, resolution_minutes INTO response, resolution
          FROM ${table('sla_policies')} WHERE priority = NEW.priority;
        NEW.response_due_at := NEW.created_at + make_interval(mins => response::int);
        NEW.due_at := NEW.created_at + make_interval(mins => resolution::int);
      END IF;
      -- Solving stamps the time unless the statement names its own (an import or a backfill);
      -- any move back to new, open or pending clears it.
      IF NEW.status IN ('solved', 'closed') THEN
        IF NEW.solved_at IS NULL THEN NEW.solved_at := now(); END IF;
      ELSE
        NEW.solved_at := NULL;
      END IF;
      RETURN NEW;
    END $$`)
  await c.query(`CREATE TRIGGER rules BEFORE INSERT OR UPDATE ON ${table('tickets')}
    FOR EACH ROW EXECUTE FUNCTION ${s}.helpdesk_ticket_rules()`)

  // Messages: append-only, never on a closed ticket, never dated before their ticket.
  await c.query(`CREATE FUNCTION ${s}.helpdesk_message_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE current text; opened timestamptz;
    BEGIN
      IF TG_OP = 'UPDATE' THEN ${raise('helpdesk_messages_append_only')}; END IF;
      -- Locks the ticket, so two replies racing to be first cannot both stamp it.
      SELECT status, created_at INTO current, opened FROM ${table('tickets')} WHERE id = NEW.ticket_id FOR UPDATE;
      IF current = 'closed' THEN ${raise('helpdesk_ticket_closed')}; END IF;
      IF NEW.created_at < opened THEN ${raise('helpdesk_message_before_ticket')}; END IF;
      RETURN NEW;
    END $$`)
  await c.query(`CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON ${table('messages')}
    FOR EACH ROW EXECUTE FUNCTION ${s}.helpdesk_message_guard()`)
  // What a message does to its ticket. Notes are activity, but neither a response nor a reply.
  await c.query(`CREATE FUNCTION ${s}.helpdesk_message_effects() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE ${table('tickets')} SET
        last_activity_at = greatest(last_activity_at, NEW.created_at),
        first_response_at = CASE WHEN NEW.author_kind = 'agent'
          THEN least(first_response_at, NEW.created_at) ELSE first_response_at END,
        status = CASE
          WHEN NEW.author_kind = 'agent' AND status = 'new' THEN 'open'
          WHEN NEW.author_kind = 'customer' AND status IN ('pending', 'solved') THEN 'open'
          ELSE status END
      WHERE id = NEW.ticket_id;
      RETURN NULL;
    END $$`)
  await c.query(`CREATE TRIGGER effects AFTER INSERT ON ${table('messages')}
    FOR EACH ROW EXECUTE FUNCTION ${s}.helpdesk_message_effects()`)

  // Editing a policy moves the targets of that priority's unsolved tickets; history stays as it was.
  await c.query(`CREATE FUNCTION ${s}.helpdesk_sla_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE ${table('tickets')} SET
        response_due_at = created_at + make_interval(mins => NEW.first_response_minutes::int),
        due_at = created_at + make_interval(mins => NEW.resolution_minutes::int)
      WHERE priority = NEW.priority AND status IN ('new', 'open', 'pending');
      RETURN NULL;
    END $$`)
  await c.query(`CREATE TRIGGER retarget AFTER INSERT OR UPDATE ON ${table('sla_policies')}
    FOR EACH ROW EXECUTE FUNCTION ${s}.helpdesk_sla_changed()`)
}

/** Deterministic, so every demo and every copy starts from the same believable month. */
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

export const defaultSla: [Priority, number, number][] = [
  ['urgent', 30, 8 * 60],
  ['high', 60, 24 * 60],
  ['normal', 4 * 60, 72 * 60],
  ['low', 8 * 60, 120 * 60],
]

type Step = ['c' | 'a' | 'n' | 'pending' | 'solve', string?]
type Scenario = {
  subjects: string[]
  tags: string
  priorities: Priority[]
  channels: string[]
  team: Team
  steps: Step[]
}
// Placeholders: {first} is the customer's first name. Every script opens with the customer.
const scenarios: Scenario[] = [
  {
    subjects: ["Can't sign in after switching to Okta SSO", 'SSO login fails with "invalid SAML response"'],
    tags: 'sso,login',
    priorities: ['high', 'high', 'urgent'],
    channels: ['email', 'chat'],
    team: 'technical',
    steps: [
      ['c', "Hi, we switched our workspace to Okta SSO this morning and now half the team gets 'invalid SAML response' when they sign in. Our analysts are blocked."],
      ['n', 'SAML trace attached by the customer: Okta sends the email under `mail`, we expect `email`.'],
      ['a', 'Hi {first}, thanks for the trace. It shows Okta sending the email address in an attribute called `mail`, while we expect `email`. Could you add an attribute statement named `email` to the Okta app and try again?'],
      ['pending'],
      ['c', 'That fixed it for everyone. Thank you!'],
      ['solve'],
    ],
  },
  {
    subjects: ['Invoice shows our old VAT number', 'Need a corrected invoice for the audit'],
    tags: 'billing,invoice',
    priorities: ['normal', 'low'],
    channels: ['email'],
    team: 'billing',
    steps: [
      ['c', 'Our October invoice still has our old VAT number on it. Finance needs a corrected copy for the audit.'],
      ['a', "Hi {first}, I've updated the VAT number on your billing profile and reissued the October invoice. You'll find it under Settings → Billing → Invoices."],
      ['pending'],
      ['c', 'Got it, thanks.'],
      ['solve'],
    ],
  },
  {
    subjects: ['API returns 429 Too Many Requests', 'Sync job rate limited on /v2/events'],
    tags: 'api,rate-limit',
    priorities: ['high', 'urgent'],
    channels: ['email', 'web'],
    team: 'technical',
    steps: [
      ['c', "Since about 09:40 our sync job gets HTTP 429 on /v2/events, even though we're well under 50 requests a minute. Our production dashboards are going stale."],
      ['a', "Hi {first}, I'm looking into this now. Could you send me one of the request IDs from the 429 responses? It's in the X-Request-Id header."],
      ['pending'],
      ['c', "Here's one: req_8f2c41d0a9. We're seeing hundreds of these."],
      ['n', 'Limit bucket keyed by IP: their NAT pool shares an egress IP with another tenant. Platform switched them to per-token limits.'],
      ['a', "Thanks, that ID made it clear. Your limit was being counted per IP address, and your traffic shares an outgoing IP with another account. We've moved your workspace to per-token limits, so the 429s should stop within a few minutes."],
      ['c', 'Confirmed, the sync is green again.'],
      ['solve'],
    ],
  },
  {
    subjects: ['Export all dashboards in a folder to PDF?', 'Bulk PDF export for the board pack'],
    tags: 'how-to,export',
    priorities: ['low', 'normal'],
    channels: ['chat', 'web'],
    team: 'frontline',
    steps: [
      ['c', 'Is there a way to export every dashboard in a folder as PDFs at once? We do this every month for the board.'],
      ['a', "Hi {first}! Not in one click yet, but you can schedule a PDF delivery for a whole folder: open the folder, choose ⋯ → Schedule delivery and pick PDF. Each dashboard arrives as its own attachment. I've also added your vote for a bulk export."],
      ['solve'],
    ],
  },
  {
    subjects: ['Charged twice for the Pro upgrade', 'Duplicate charge on my card'],
    tags: 'billing,refund',
    priorities: ['high', 'normal'],
    channels: ['email', 'chat'],
    team: 'billing',
    steps: [
      ['c', 'I upgraded to Pro yesterday and my card was charged twice, $49 each time. Please refund the duplicate.'],
      ['n', 'Two captures 40 seconds apart: a double submit on checkout. Refunded the second one in full.'],
      ['a', "Hi {first}, sorry about that. The second charge came from a double submission at checkout, and I've refunded it in full. Depending on your bank it shows up within 5–10 business days."],
      ['pending'],
      ['c', 'Thanks for sorting it out so quickly.'],
      ['solve'],
    ],
  },
  {
    subjects: ['Webhook deliveries failing with timeouts', 'Webhooks stopped arriving last night'],
    tags: 'webhooks,integration',
    priorities: ['normal', 'high'],
    channels: ['web', 'email'],
    team: 'technical',
    steps: [
      ['c', "Our webhook endpoint stopped receiving events last night. The delivery log says 'timeout after 10s'."],
      ['a', 'Hi {first}, the log shows your endpoint taking 12–15 seconds to answer since 22:10. We retry for 24 hours, so nothing is lost yet. Is there a slow step before you return 200?'],
      ['pending'],
      ['c', 'Found it: we were processing synchronously. It goes to a queue now and we answer in 200 ms.'],
      ['a', "Perfect, deliveries are succeeding again and the retries are draining. I'll close this one."],
      ['solve'],
    ],
  },
  {
    subjects: ["EU revenue missing from yesterday's report", 'Revenue report shows zero for one region'],
    tags: 'bug,data',
    priorities: ['urgent'],
    channels: ['phone', 'email'],
    team: 'technical',
    steps: [
      ['c', "Yesterday's revenue report shows zero for the EU region. It goes to our CFO at 9 am, please help urgently."],
      ['n', 'eu-west ingestion skipped one partition after the 02:00 failover. Backfill started.'],
      ['a', "Hi {first}, we found the cause: the EU ingestion job skipped one partition after a failover at 02:00. A backfill is running and should finish within 30 minutes. I'll confirm here when it's done."],
      ['a', 'The backfill has finished and the EU figures are back in the report. Sorry for the scare.'],
      ['c', 'Numbers look right now. Thanks for the quick turnaround.'],
      ['solve'],
    ],
  },
  {
    subjects: ['Feature request: dark mode', 'Any plans for a dark theme?'],
    tags: 'feature-request',
    priorities: ['low'],
    channels: ['web', 'chat'],
    team: 'frontline',
    steps: [
      ['c', 'Any plans for a dark mode? Our team works late and the white dashboards are harsh on the eyes.'],
      ['a', "Hi {first}, thanks for asking! Dark mode is on our roadmap for early next quarter. I've added your company to the request, so you'll hear from us when it ships."],
      ['solve'],
    ],
  },
  {
    subjects: ['Adding seats for new hires', 'How do I add five seats mid-contract?'],
    tags: 'billing,seats',
    priorities: ['normal'],
    channels: ['email'],
    team: 'billing',
    steps: [
      ['c', 'We have five people starting next Monday. How do I add seats without changing our annual plan?'],
      ['a', "Hi {first}, you can add seats under Settings → Billing → Seats. They're prorated to your renewal date. Would you like me to add the five for you?"],
      ['pending'],
      ['c', 'Yes please, that would be great.'],
      ['a', 'Done: five seats added, and the prorated invoice is in your billing history.'],
      ['solve'],
    ],
  },
  {
    subjects: ['Password reset email never arrives', 'Not receiving the reset link'],
    tags: 'login,email-delivery',
    priorities: ['normal', 'high'],
    channels: ['chat', 'web'],
    team: 'frontline',
    steps: [
      ['c', "I've requested a password reset three times and nothing arrives, not even in spam."],
      ['n', 'Their mail server rejects our sender (SPF softfail on their side). Suggested allowlisting, sent a backup sign-in link.'],
      ['a', "Hi {first}, our mail log shows your mail server rejecting the reset emails. Could you ask IT to allowlist no-reply@mail.example.com? In the meantime I've sent a one-time sign-in link through our backup sender."],
      ['pending'],
      ['c', 'The link worked, and IT has allowlisted you. Thanks!'],
      ['solve'],
    ],
  },
  {
    subjects: ['Please delete my account (GDPR)', 'Data deletion request'],
    tags: 'privacy,gdpr',
    priorities: ['normal'],
    channels: ['email'],
    team: 'frontline',
    steps: [
      ['c', 'Please delete my account and all associated personal data under GDPR.'],
      ['a', "Hi {first}, we've received your request. For security, please confirm by replying from the address on the account, and we'll complete the deletion within 30 days."],
      ['pending'],
      ['c', 'Confirming, please go ahead.'],
      ['n', 'Deletion job queued; confirmation template scheduled.'],
      ['a', "Thank you. Your account and personal data are scheduled for deletion, and you'll get a final confirmation once it's complete."],
      ['solve'],
    ],
  },
  {
    subjects: ['Slack alerts post to the wrong channel', 'Alerts going to #general instead of #ops-alerts'],
    tags: 'integration,slack',
    priorities: ['normal', 'low'],
    channels: ['web', 'chat'],
    team: 'technical',
    steps: [
      ['c', 'Our alert rule is set to post to #ops-alerts, but the messages end up in #general.'],
      ['a', 'Hi {first}, it looks like the Slack app was reinstalled and the rule kept the old channel ID. Could you open the alert rule, pick #ops-alerts again and save?'],
      ['pending'],
      ['c', 'Re-selected it and it works now.'],
      ['solve'],
    ],
  },
  {
    subjects: ['CSV export opens garbled in Excel', 'Accented names look wrong in the exported CSV'],
    tags: 'export,encoding',
    priorities: ['normal'],
    channels: ['chat', 'web'],
    team: 'technical',
    steps: [
      ['c', 'When we open an exported CSV in Excel, every accented customer name turns into symbols like Ã© and Ã¼. How do we fix this?'],
      ['a', "Hi {first}, Excel doesn't assume UTF-8 when it opens a CSV. Choose \"CSV (Excel compatible)\" in the export menu: it adds a byte-order mark, and the names display correctly."],
      ['pending'],
      ['c', 'Tried it, the names are right now. Thanks!'],
      ['solve'],
    ],
  },
  {
    subjects: ['Invoice shows our old company name', "Please reissue last month's invoice"],
    tags: 'billing,invoice',
    priorities: ['low', 'normal'],
    channels: ['email'],
    team: 'billing',
    steps: [
      ['c', "Last month's invoice was issued under our old company name. Could you reissue it with the new one?"],
      ['n', 'Original voided in the billing system; reissued under the legal name the customer sent.'],
      ['a', "Hi {first}, the old invoice has been voided and a corrected one is on its way to your inbox within one business day. It's also under Settings → Billing → Invoices."],
      ['c', 'Received, thank you!'],
      ['solve'],
    ],
  },
  {
    subjects: ['Dashboards take 30 seconds to load', 'Every dashboard is slow to open'],
    tags: 'performance',
    priorities: ['high', 'urgent'],
    channels: ['phone', 'chat'],
    team: 'technical',
    steps: [
      ['c', 'Since this morning every dashboard takes over 30 seconds to open. The whole team is waiting on the numbers.'],
      ['n', 'Their queries land on shard-7, CPU pinned. Platform scaled it out.'],
      ['a', "Hi {first}, we traced it to the data shard your workspace runs on being overloaded. It's been scaled out and dashboards should open in under 2 seconds again. Could you give it another try?"],
      ['pending'],
      ['c', 'Much faster now, thanks for the quick fix.'],
      ['solve'],
    ],
  },
  {
    subjects: ['Weekly KPI email stopped sending', 'Scheduled report did not go out'],
    tags: 'reports,email-delivery',
    priorities: ['normal'],
    channels: ['email'],
    team: 'technical',
    // Solved, then reopened by the customer's next message: the trigger moves it back to open.
    steps: [
      ['c', "Our weekly KPI email didn't go out on Monday."],
      ['a', "Hi {first}, the schedule was paused when the report's owner left your workspace. I've made you the owner and resumed it, so the next one goes out Monday at 08:00."],
      ['solve'],
      ['c', 'It skipped again this week, unfortunately.'],
      ['n', 'Time zone was reset to UTC when the owner changed, so it fired before the data landed. Fixed by hand.'],
      ['a', "Sorry about that, {first}. The schedule lost its time zone when it changed owner, so it ran before the week's data arrived. I've set it to Europe/London and sent this week's report manually."],
      ['solve'],
    ],
  },
  {
    subjects: ['Need your SOC 2 Type II report', 'Security review before renewal'],
    tags: 'security,compliance',
    priorities: ['normal'],
    channels: ['email'],
    team: 'frontline',
    steps: [
      ['c', 'Our security team needs your latest SOC 2 Type II report before we renew.'],
      ['a', "Hi {first}, happy to help. The report is shared under NDA. I've sent one for e-signature, and once it's signed you'll get access to our trust portal automatically."],
      ['pending'],
      ['c', 'Signed, and we have the report. Thanks.'],
      ['solve'],
    ],
  },
  {
    subjects: ['Downgrade to Free at renewal', 'Cancel Pro when the year is up'],
    tags: 'billing,churn',
    priorities: ['low'],
    channels: ['email', 'web'],
    team: 'billing',
    steps: [
      ['c', "We'd like to move to the Free plan when our subscription renews next month."],
      ['n', 'Retention playbook: offered 20% off Pro for a year.'],
      ['a', "Hi {first}, I've scheduled the downgrade for your renewal date, so nothing changes until then. If budget is the concern, I can offer 20% off Pro for the next year. Just let me know."],
      ['pending'],
      ['c', "We'll stay on Pro with the discount, thanks for the offer."],
      ['a', 'Wonderful. The discount is applied to your renewal and the downgrade is cancelled.'],
      ['solve'],
    ],
  },
]

const agentRows: [string, string, Team][] = [
  ['Mia Chen', 'mia', 'frontline'],
  ['Daniel Okafor', 'daniel', 'frontline'],
  ['Sophie Laurent', 'sophie', 'frontline'],
  ['Tom Becker', 'tom', 'frontline'],
  ['Priya Nair', 'priya', 'technical'],
  ['Lucas Martin', 'lucas', 'technical'],
  ['Hannah Weber', 'hannah', 'billing'],
  ['Wen Tan', 'wen', 'billing'],
]
/** Tom left the team ten days before the demo's "today"; his history stays, new work skips him. */
const LEAVER = 'Tom Becker'
const companies: [string, string, 'free' | 'pro' | 'enterprise'][] = [
  ['Northwind Logistics', 'northwind.example', 'enterprise'],
  ['Bluefin Analytics', 'bluefin.example', 'pro'],
  ['Harbourline Travel', 'harbourline.example', 'pro'],
  ['Kestrel Health', 'kestrel.example', 'enterprise'],
  ['Maple & Finch', 'maplefinch.example', 'free'],
  ['Orbit Labs', 'orbitlabs.example', 'pro'],
  ['Juniper Retail', 'juniper.example', 'pro'],
  ['Copperleaf Bank', 'copperleaf.example', 'enterprise'],
  ['Studio Saffron', 'saffron.example', 'free'],
  ['Tidewater Energy', 'tidewater.example', 'enterprise'],
  ['Pinecrest Schools', 'pinecrest.example', 'pro'],
  ['Lumen Games', 'lumengames.example', 'free'],
  ['Vela Insurance', 'vela.example', 'pro'],
  ['Granite Works', 'granite.example', 'free'],
  ['Atlas Freight', 'atlasfreight.example', 'pro'],
  ['Clearwater Tech', 'clearwater.example', 'pro'],
  ['Deepwell Data', 'deepwell.example', 'enterprise'],
  ['Greenfield Learning', 'greenfield.example', 'free'],
  ['Farview Logistics', 'farview.example', 'pro'],
  ['Starbridge Retail', 'starbridge.example', 'pro'],
]
const people: [string, string, number][] = [
  ['Sarah Johnson', 'sarah.johnson', 0], ['Marcus Lee', 'marcus.lee', 0], ['Elena García', 'elena.garcia', 1],
  ['James Whitfield', 'james.w', 1], ['Aisha Rahman', 'aisha', 2], ['Oliver Brandt', 'oliver.brandt', 2],
  ['Grace Kim', 'grace.kim', 3], ['Noah Fischer', 'noah', 3], ['Chloe Dubois', 'chloe', 3],
  ['Liam O’Connor', 'liam', 4], ['Yuki Tanaka', 'yuki.tanaka', 5], ['Ben Carter', 'ben', 5],
  ['Hannah Schmidt', 'h.schmidt', 6], ['Ravi Patel', 'ravi.patel', 6], ['Emily Brooks', 'emily', 7],
  ['Daniel Novak', 'd.novak', 7], ['Fatima Zahra', 'fatima', 7], ['Lucy Turner', 'lucy', 8],
  ['Mateo Silva', 'mateo', 9], ['Ingrid Larsen', 'ingrid', 9], ['Kenji Mori', 'kenji', 10],
  ['Amelia Scott', 'amelia', 10], ['Tom Hughes', 'tom.hughes', 11], ['Zoe Martin', 'zoe', 12],
  ['Peter Walsh', 'peter', 12], ['Nina Petrova', 'nina', 13], ['Sam Rivera', 'sam', 14],
  ['Laura Bianchi', 'laura', 14], ['Chris Evans', 'chris.e', 0], ['Olivia Grant', 'olivia', 1],
  ['Ethan Wright', 'ethan', 4], ['Maya Cohen', 'maya', 6], ['Isaac Morgan', 'isaac', 8],
  ['Ruth Adeyemi', 'ruth', 10], ['Jonas Weber', 'jonas', 13], ['Clara Hoffman', 'clara', 11],
  ['Sophia Reyes', 'sophia.reyes', 15], ['Arjun Mehta', 'arjun', 15], ['Lena Vogel', 'lena', 16], ['Diego Alvarez', 'diego', 16],
  ['Freya Nilsen', 'freya', 16], ['Omar Haddad', 'omar', 17], ['Hana Sato', 'hana.sato', 17], ['Julia Costa', 'julia', 18],
  ['Felix Berger', 'felix', 18], ['Nadia Kowalski', 'nadia', 19], ['Leo Moreau', 'leo', 19], ['Anna Lindqvist', 'anna', 15],
  ['Kevin Wong', 'kevin.wong', 17], ['Ivy Lam', 'ivy.lam', 19],
]
const priorityOrder: Priority[] = ['urgent', 'high', 'normal', 'low']
const MIN = 60_000
const DAY = 86_400_000
const iso = (t: number) => new Date(t).toISOString()

export async function seedHelpdesk(c: pg.PoolClient, schema: string, today = new Date()) {
  const insert = async (table: string, row: Record<string, unknown>) => {
    const entries = Object.entries(row)
    await c.query(
      `INSERT INTO ${qi(schema)}.${qi(table)} (${entries.map(([key]) => qi(key)).join(',')}) VALUES (${entries.map((_, i) => '$' + (i + 1)).join(',')})`,
      entries.map(([, value]) => value),
    )
  }
  const tickets = `${qi(schema)}.tickets`
  const now = today.getTime()
  // Staggered by a millisecond so reference rows list in the order they are written here.
  let order = 0
  const setupAt = () => iso(now - 45 * DAY + order++)

  for (const [priority, response, resolution] of defaultSla)
    await insert('sla_policies', { id: randomUUID(), created_at: setupAt(), priority, first_response_minutes: response, resolution_minutes: resolution })
  const agents = agentRows.map(([name, handle, team]) => ({ id: randomUUID(), name, handle, team }))
  for (const a of agents)
    await insert('agents', { id: a.id, created_at: setupAt(), name: a.name, email: `${a.handle}@support.example`, team: a.team, active: true })
  const customers = people.map(([name, handle, company]) => {
    const [org, domain, plan] = companies[company]
    return { id: randomUUID(), name, email: `${handle}@${domain}`, company: org, plan }
  })
  for (const p of customers)
    await insert('customers', { id: p.id, created_at: setupAt(), name: p.name, email: p.email, company: p.company, plan: p.plan })

  const rand = random(20261103)
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]
  const between = (low: number, high: number) => low + rand() * (high - low)
  const responseTarget = new Map(defaultSla.map(([p, response]) => [p, response]))
  const tom = agents.find((a) => a.name === LEAVER)!
  const leftAt = now - 10 * DAY

  // About four tickets a working day for thirty days, quieter at weekends, a few in the last hours.
  const opened: number[] = []
  for (let day = 29; day >= 0; day--) {
    const date = new Date(now - day * DAY)
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6
    const count = Math.round(weekend ? between(1.2, 2.6) : between(3.6, 5.6))
    // 08:00–21:00 UTC: a London team's working day and evening.
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 8)
    for (let i = 0; i < count; i++) {
      const at = start + between(0, 13 * 60) * MIN
      if (at < now - 20 * MIN) opened.push(at)
    }
  }
  for (const minutesAgo of [12, 26, 38, 64, 95, 130, 170, 260]) opened.push(now - minutesAgo * MIN)
  opened.sort((a, b) => a - b)

  for (const [index, created] of opened.entries()) {
    const scenario = scenarios[Math.floor(rand() * scenarios.length)]
    const customer = pick(customers)
    let priority = pick(scenario.priorities)
    // Enterprise contracts bump a ticket a level now and then.
    if (customer.plan === 'enterprise' && priority !== 'urgent' && rand() < 0.3)
      priority = priorityOrder[priorityOrder.indexOf(priority) - 1]
    const agent = pick(agents.filter((a) => a.team === scenario.team && (a !== tom || created < leftAt - 3 * DAY)))
    // Some queues route on arrival; the rest are picked up by whoever answers first.
    const routed = rand() < 0.35
    const id = randomUUID()
    await insert('tickets', {
      id,
      created_at: iso(created),
      subject: pick(scenario.subjects),
      customer_id: customer.id,
      assignee_id: routed ? agent.id : null,
      priority,
      channel: pick(scenario.channels),
      tags: scenario.tags,
    })
    const first = customer.name.split(' ')[0]
    const body = (text: string) => text.replaceAll('{first}', first)
    // A late first reply for roughly one ticket in six, comfortably on time for the rest.
    const lateness = rand() < 0.17 ? between(1.1, 2.6) : between(0.08, 0.85)
    const firstReply = created + responseTarget.get(priority)! * lateness * MIN
    let at = created
    let answered = false
    let assigned = routed
    let solvedAt: number | null = null
    // Part of this week's work is still in flight, more of it the newer it is, so the inbox opens
    // on tickets in every state rather than on a cleared desk. Such a ticket stops at a random
    // point before its final solve; only the last half day's may still wait for a first reply.
    const age = now - created
    const lastSolve = scenario.steps.map(([kind]) => kind).lastIndexOf('solve')
    // Urgent work does not sit for days.
    const share = age < DAY ? 0.9 : priority === 'urgent' ? 0 : age < 3 * DAY ? 0.8 : age < 6 * DAY ? 0.35 : 0
    let stop = rand() < share ? 1 + Math.floor(rand() * lastSolve) : Infinity
    const firstAnswer = scenario.steps.findIndex(([kind]) => kind === 'a')
    if (stop <= firstAnswer && age > DAY / 2) stop = firstAnswer + 1
    // Most replies that ask a question are waiting on the answer.
    if (scenario.steps[stop]?.[0] === 'pending' && rand() < 0.7) stop++
    // Walks the script in time order and stops at "now": recent tickets are still in progress.
    // Every stamp on the ticket is left to the triggers, except the solve time, which the
    // statement names because the seed is replaying the past.
    for (const [step, [kind, text]] of scenario.steps.entries()) {
      if (step >= stop) break
      if (step === 0) {
        await insert('messages', { id: randomUUID(), created_at: iso(at), ticket_id: id, author_kind: 'customer', body: body(text!) })
        continue
      }
      if (kind === 'pending') {
        await c.query(`UPDATE ${tickets} SET status = 'pending' WHERE id = $1`, [id])
        continue
      }
      if (kind === 'solve') {
        at += between(2, 90) * MIN
        if (at > now) break
        solvedAt = at
        await c.query(`UPDATE ${tickets} SET status = 'solved', solved_at = $2 WHERE id = $1`, [id, iso(at)])
        continue
      }
      if (kind === 'c')
        at += (rand() < 0.75 ? between(10, 240) : rand() < 0.8 ? between(240, 1200) : between(1440, 4000)) * MIN
      // A note written before the first reply sits a few minutes ahead of it.
      else if (!answered) at = kind === 'a' ? Math.max(at, firstReply) : Math.max(at + MIN, firstReply - between(3, 12) * MIN)
      else at += between(6, 150) * MIN
      if (at > now) break
      if (kind !== 'c' && !assigned) {
        await c.query(`UPDATE ${tickets} SET assignee_id = $2 WHERE id = $1`, [id, agent.id])
        assigned = true
      }
      await insert('messages', {
        id: randomUUID(),
        created_at: iso(at),
        ticket_id: id,
        author_kind: kind === 'c' ? 'customer' : kind === 'a' ? 'agent' : 'note',
        agent_id: kind === 'c' ? null : agent.id,
        body: body(text!),
      })
      if (kind === 'a') answered = true
      if (kind === 'c') solvedAt = null
    }
    // Solved tickets close automatically four days later, as most helpdesks do.
    if (solvedAt !== null && solvedAt < now - 4 * DAY)
      await c.query(`UPDATE ${tickets} SET status = 'closed' WHERE id = $1`, [id])
  }
  // Whatever the leaver still had open goes back to the queue before he is deactivated.
  await c.query(`UPDATE ${tickets} SET assignee_id = NULL WHERE assignee_id = $1 AND status IN ('new', 'open', 'pending')`, [tom.id])
  await c.query(`UPDATE ${qi(schema)}.agents SET active = false WHERE id = $1`, [tom.id])
}
