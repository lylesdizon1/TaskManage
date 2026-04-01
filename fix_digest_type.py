path = "src/App.jsx"

with open(path, "r") as f:
    content = f.read()

fixes = [
    (
        "notes.filter((n) => n.type !== 'digest' && n.createdAt && n.createdAt >= weekAgoStr).length",
        "notes.filter((n) => n.type !== 'daily-digest' && n.createdAt && n.createdAt >= weekAgoStr).length"
    ),
    (
        "notes.find((n) => n.type !== 'digest') || null",
        "notes.find((n) => n.type !== 'daily-digest') || null"
    ),
    (
        "notes.find((n) => n.type === 'digest' && n.createdAt && n.createdAt.slice(0, 10) === today)",
        "notes.find((n) => n.type === 'daily-digest' && n.createdAt && n.createdAt.slice(0, 10) === today)"
    ),
    (
        "if (Array.isArray(data)) setNotes(data.filter((n) => n.type !== 'digest'));",
        "if (Array.isArray(data)) setNotes(data.filter((n) => n.type !== 'daily-digest'));"
    ),
    (
        "setDashboardNotes(data.filter((n) => n.type !== 'digest'))",
        "setDashboardNotes(data.filter((n) => n.type !== 'daily-digest'))"
    ),
]

count = 0
for old, new in fixes:
    if old in content:
        content = content.replace(old, new, 1)
        count += 1
        print(f"Fixed: ...{old[20:60]}...")
    else:
        print(f"MISSING: ...{old[20:60]}...")

with open(path, "w") as f:
    f.write(content)

print(f"\nDone! {count}/5 fixes applied.")
