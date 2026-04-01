path = "src/App.jsx"

with open(path, "r") as f:
    content = f.read()

count = 0

# 1. Tag assistantMsg with persona info
old_msg = "      const assistantMsg = { role: 'assistant', content: reply };"
new_msg = "      const assistantMsg = { role: 'assistant', content: reply, persona: { emoji: effectivePersona.emoji, name: effectivePersona.defaultName, id: effectivePersona.id } };"

if old_msg in content:
    content = content.replace(old_msg, new_msg, 1)
    count += 1
    print("Done! Tagged assistantMsg with persona")
else:
    print("ERROR: assistantMsg not found")

# 2. Pass lastAutoPersona to SlidingChatPanel
old_panel = "function SlidingChatPanel({ messages, loading, backend, contextBadge, onHide }) {"
new_panel = "function SlidingChatPanel({ messages, loading, backend, contextBadge, onHide, activePersona }) {"

if old_panel in content:
    content = content.replace(old_panel, new_panel, 1)
    count += 1
    print("Done! Added activePersona prop to SlidingChatPanel")
else:
    print("ERROR: SlidingChatPanel signature not found")

# 3. Show persona pill in chat header next to Claude badge
old_header = """          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${backend === 'claude' ? 'bg-indigo-100 text-indigo-700' : 'bg-green-100 text-green-700'}`}>
            {backend === 'claude' ? 'Claude' : 'ChatGPT'}
          </span>"""
new_header = """          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${backend === 'claude' ? 'bg-indigo-100 text-indigo-700' : 'bg-green-100 text-green-700'}`}>
            {backend === 'claude' ? 'Claude' : 'ChatGPT'}
          </span>
          {activePersona && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-purple-100 text-purple-700">
              {activePersona.emoji} {activePersona.name}
            </span>
          )}"""

if old_header in content:
    content = content.replace(old_header, new_header, 1)
    count += 1
    print("Done! Added persona pill to chat header")
else:
    print("ERROR: chat header badge not found")

# 4. Show persona badge on assistant message bubbles
old_bubble = """        <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
          {msg.role === 'assistant' && ("""
new_bubble = """        <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
          {msg.role === 'assistant' && msg.persona && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-purple-100 text-purple-700 mb-1 ml-9">
              {msg.persona.emoji} {msg.persona.name}
            </span>
          )}
          {msg.role === 'assistant' && ("""

if old_bubble in content:
    content = content.replace(old_bubble, new_bubble, 1)
    count += 1
    print("Done! Added per-message persona badge")
else:
    print("ERROR: assistant bubble not found")

# 5. Wire lastAutoPersona into SlidingChatPanel call site
old_call = """onHide={() => setSlidingChatOpen(false)}"""
new_call = """onHide={() => setSlidingChatOpen(false)}
                activePersona={lastAutoPersona ? { emoji: lastAutoPersona.emoji, name: lastAutoPersona.defaultName } : null}"""

if old_call in content:
    content = content.replace(old_call, new_call, 1)
    count += 1
    print("Done! Passed lastAutoPersona to SlidingChatPanel")
else:
    print("ERROR: SlidingChatPanel call site not found")

with open(path, "w") as f:
    f.write(content)

print(f"\nAll done! {count}/5 fixes applied.")
