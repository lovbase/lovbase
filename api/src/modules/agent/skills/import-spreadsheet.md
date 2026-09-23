---
name: import-spreadsheet
description: The user uploaded a CSV / spreadsheet or pasted tabular data and wants a table created and the rows imported. Once loaded, follow the flow — infer the structure → create the table → batch insert → verify the row count.
---
# Importing data from a spreadsheet

The user has handed over a table (CSV text, a pasted grid, an Excel export). The goal is a real table with the data loaded into it.

Flow:
1. **Look at the data before modeling**: read the header and the first 5 rows and infer each column's type. Pure numbers → number, date-like values → date, yes/no → boolean, a small repeating set of values (≤8 distinct) → select, everything else text.
2. **Confirm before acting**: if a column's meaning is unclear or it looks like several tables are mixed together, ask the user one question rather than guessing.
3. **Create the table**: submit it with propose_schema. The table name comes from the file name or the user's description; each column's name keeps the header text as written, and dbName becomes English snake_case.
4. **Import**: batch INSERT with query, at most 50 rows per call, using `$1,$2…` parameters — never string concatenation. Empty cells become null. Dates are normalised to ISO format.
5. **Verify**: after the import, `select count(*)` and compare with the original row count; tell the user the result and list any rows that failed.
6. **Do not**: do not make every column text just to get the import through; do not ask more than one question before importing.
