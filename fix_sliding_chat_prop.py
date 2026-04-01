path = "src/App.jsx"

with open(path, "r") as f:
    content = f.read()

old = "              onHide={toggleChatPanel}\n            />"
new = "              onHide={toggleChatPanel}\n              activePersona={lastAutoPersona ? { emoji: lastAutoPersona.emoji, name: lastAutoPersona.defaultName } : null}\n            />"

if old in content:
    content = content.replace(old, new, 1)
    with open(path, "w") as f:
        f.write(content)
    print("Done!")
else:
    print("ERROR: not found")
