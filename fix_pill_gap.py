path = "src/App.jsx"

with open(path, "r") as f:
    content = f.read()

# Fix gap between pills
old = "className=\"flex flex-wrap justify-end items-center overflow-hidden\" style={{ width: '50%', gap: 4 }}"
new = "className=\"flex flex-wrap justify-end items-center overflow-hidden\" style={{ width: '50%', gap: 8 }}"

if old in content:
    content = content.replace(old, new, 1)
    with open(path, "w") as f:
        f.write(content)
    print("Done!")
else:
    print("ERROR: target not found")
