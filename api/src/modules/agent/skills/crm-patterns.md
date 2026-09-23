---
name: crm-patterns
description: Proven structure for customer management, sales follow-up and order apps (customers / contacts / deals / follow-ups / orders). Load when the user wants a CRM, sales or customer follow-up app.
---
# Structure patterns for CRM-style apps

A proven minimal structure. Trim it to what the user actually needs; never build all of it by default:

- **customers**: name, industry (select), status (select: lead / in progress / won / lost), owner (text, the account manager)
- **contacts**: name, phone, email, title, customer (link→customers)
- **deals**: title, amount (number), stage (select: first contact / needs confirmed / proposal sent / negotiating / won / lost), expected_close (date), customer (link→customers)
- **followups**: happened_at (date), channel (select: phone / chat / visit / email), summary (text), customer (link→customers), contact (link→contacts)
- **orders**: order_no, amount (number), status (select: unpaid / paid / shipped / completed / cancelled), ordered_at (date), customer (link→customers)

Principles:
- The follow-ups table is the one most often left out and the most valuable one. When the user says "record conversations", build it.
- Money is always number; stages and statuses are always select.
- When the user only says "customer management", customers + contacts + followups is enough; deals and orders wait until the user asks for them.
