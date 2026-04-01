import re

path = "src/App.jsx"

old = "      .then((data) => { if (Array.isArray(data)) setDashboardNotes(data); })"
new = "      .then((data) => { if (Array.isArray(data)) setDashboardNotes(data.filter((n) => n.type !== 'digest')); })"

with open(path, "r") as f:
    content = f.read()

if old not in content:
    print("ERROR: target line not found — check for whitespace differences")
else:
    content = content.replace(old, new, 1)
    with open(path, "w") as f:
        f.write(content)
    print("Done!")
