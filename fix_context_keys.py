import re

# Fix 1: buildContext.js — pass as 'events' not 'calendarEvents'
path1 = "src/lib/context-engine/buildContext.js"
with open(path1, "r") as f:
    content = f.read()

old = "  const raw      = selectContext(intent, { tasks, entities, financials, notes, calendarEvents });"
new = "  const raw      = selectContext(intent, { tasks, entities, financials, notes, events: calendarEvents });"

if old in content:
    content = content.replace(old, new, 1)
    with open(path1, "w") as f:
        f.write(content)
    print("Done! Fixed buildContext.js — calendarEvents → events")
else:
    print("ERROR: buildContext target not found")

# Fix 2: contextBuilder.js — 'financials' key mismatch check
path2 = "src/lib/context-engine/contextBuilder.js"
with open(path2, "r") as f:
    content = f.read()

# contextSelector returns 'transactions' but contextBuilder checks 'financials'
old2 = "  if (slices.financials?.length) {\n    parts.push(`\\n## Financial Transactions (${slices.financials.length})\\n${JSON.stringify(slices.financials, null, 2)}`);\n  }"
new2 = "  if (slices.transactions?.length) {\n    parts.push(`\\n## Financial Transactions (${slices.transactions.length})\\n${JSON.stringify(slices.transactions, null, 2)}`);\n  }"

if old2 in content:
    content = content.replace(old2, new2, 1)
    with open(path2, "w") as f:
        f.write(content)
    print("Done! Fixed contextBuilder.js — financials → transactions")
else:
    print("SKIP: financials key already correct or not found")
