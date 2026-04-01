path = "db.cjs"

old = "  const where = ['user_id = $1'];"
new = "  const where = ['user_id = $1', \"type != 'digest'\"];"

with open(path, "r") as f:
    content = f.read()

if old not in content:
    print("ERROR: target line not found")
else:
    content = content.replace(old, new, 1)
    with open(path, "w") as f:
        f.write(content)
    print("Done!")
