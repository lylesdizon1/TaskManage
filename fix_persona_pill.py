path = "src/App.jsx"

with open(path, "r") as f:
    content = f.read()

# 1. Add lastAutoPersona state near chatLoading state
old_state = "  const [chatLoading, setChatLoading]           = useState(false);"
new_state = "  const [chatLoading, setChatLoading]           = useState(false);\n  const [lastAutoPersona, setLastAutoPersona]     = useState(null);"

if old_state in content:
    content = content.replace(old_state, new_state, 1)
    print("Done! Added lastAutoPersona state")
else:
    print("ERROR: chatLoading state not found")

# 2. Set lastAutoPersona after routing in handleChatSend
old_effective = "    const effectivePersona = routedPersona ?? activePersona;"
new_effective = "    const effectivePersona = routedPersona ?? activePersona;\n    setLastAutoPersona(effectivePersona);"

if old_effective in content:
    content = content.replace(old_effective, new_effective, 1)
    print("Done! Set lastAutoPersona on send")
else:
    print("ERROR: effectivePersona line not found")

# 3. Pass personaPill prop to UniversalPromptBar
old_bar = """          onSend={handleChatSend}
          loading={chatLoading}
          activeTab={window.innerWidth >= 768 ? activeView : mobileView}"""
new_bar = """          onSend={handleChatSend}
          loading={chatLoading}
          activeTab={window.innerWidth >= 768 ? activeView : mobileView}
          personaPill={lastAutoPersona ? { emoji: lastAutoPersona.emoji, name: lastAutoPersona.defaultName } : null}"""

if old_bar in content:
    content = content.replace(old_bar, new_bar, 1)
    print("Done! Passed personaPill prop to UniversalPromptBar")
else:
    print("ERROR: UniversalPromptBar props not found")

# 4. Add personaPill to UniversalPromptBar signature and render it
old_sig = "function UniversalPromptBar({ input, onInputChange, backend, onBackendChange, onSend, loading, activeTab }) {"
new_sig = "function UniversalPromptBar({ input, onInputChange, backend, onBackendChange, onSend, loading, activeTab, personaPill }) {"

if old_sig in content:
    content = content.replace(old_sig, new_sig, 1)
    print("Done! Added personaPill to component signature")
else:
    print("ERROR: UniversalPromptBar signature not found")

# 5. Render pill inside the bar, before the input
old_input = """          <input
            type="text"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1 min-w-0 bg-transparent text-gray-900 placeholder-gray-400 border-0 outline-none focus:ring-0"
            style={{ fontSize: 16 }}
          />"""
new_input = """          {personaPill && (
            <span className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700 select-none">
              {personaPill.emoji} {personaPill.name}
            </span>
          )}
          <input
            type="text"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1 min-w-0 bg-transparent text-gray-900 placeholder-gray-400 border-0 outline-none focus:ring-0"
            style={{ fontSize: 16 }}
          />"""

if old_input in content:
    content = content.replace(old_input, new_input, 1)
    print("Done! Rendered persona pill in prompt bar")
else:
    print("ERROR: input element not found")

with open(path, "w") as f:
    f.write(content)

print("\nAll done!")
