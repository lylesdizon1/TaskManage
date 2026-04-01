path = "src/App.jsx"

with open(path, "r") as f:
    content = f.read()

old = "style={{ height: 22, borderRadius: 9999, padding: '0 8px', fontSize: 11, fontWeight: 500, backgroundColor: isZero ? '#E5E7EB' : color, color: isZero ? '#6B7280' : '#fff' }}"
new = "style={{ height: 28, borderRadius: 9999, padding: '0 12px', fontSize: 12, fontWeight: 500, backgroundColor: isZero ? '#E5E7EB' : color, color: isZero ? '#6B7280' : '#fff' }}"

if old in content:
    content = content.replace(old, new, 1)
    with open(path, "w") as f:
        f.write(content)
    print("Done!")
else:
    print("ERROR: target not found")
