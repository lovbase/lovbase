---
name: modeling-checklist
description: The checklist to run before modeling — when to use select / link / boolean, how to split tables, common anti-patterns. Load when the user wants a new app or a major restructuring.
---
# Modeling checklist

Go through every item before submitting propose_schema:

1. **Status-like fields are select**: any fixed set such as "pending / in progress / done" or "not checked in / checked in" must be a select with options, never text.
2. **References are link**: relations like "an order belongs to a customer" or "an attendee joins an event" are link fields, with linkTo pointing at the target entity's id. Never store the other side's name in a text field.
3. **One entity, one subject**: customers and contacts are two tables (one customer has many contacts); do not push contact names into fields on the customers table.
4. **Less is more**: only create the fields the user's description names or clearly implies. Fields like notes or created-by are not added unless the user mentions them; id and created_at come with the system.
5. **Naming**: dbName is English snake_case — plural table names (customers, orders), singular column names (status, amount); name is in the user's language.
6. **When changing the structure**: keep every existing id; a rename only changes name/dbName; for a field that is going to be dropped, say clearly in the reply that its data will be lost.
7. **After submitting**: explain in a sentence or two what changed, and remind the user that destructive changes need confirmation in the UI.
