with open('/Users/lyledizon/TaskManage/src/App.jsx', 'r') as f:
    content = f.read()

# Fix 1: White background on search bar
content = content.replace(
    'bg-surface-container-low px-4 py-2 rounded-xl w-full shadow-sm border border-primary/10 transition-all hover:shadow-md focus-within:ring-2 focus-within:ring-primary/20',
    'bg-surface-container-lowest px-4 py-2.5 rounded-xl w-full shadow-sm border border-primary/10 transition-all hover:shadow-md focus-within:ring-2 focus-within:ring-primary/20'
)

# Fix 2: Remove UniversalPromptBar from desktop top bar, keep only alerts+settings
old = '        <header className="hidden md:flex items-center justify-between px-8 h-14 bg-background/80 backdrop-blur-xl sticky top-0 z-40 border-b border-surface-container-low flex-shrink-0">'
new = '        <header className="hidden md:flex items-center justify-end px-8 h-12 bg-background/80 backdrop-blur-xl sticky top-0 z-40 border-b border-surface-container-low flex-shrink-0">'
content = content.replace(old, new)

# Fix 3: Remove the UniversalPromptBar block from desktop header
old2 = '''          <UniversalPromptBar
            input={chatInput}
            onInputChange={setChatInput}
            backend={chatBackend}
            onBackendChange={setChatBackend}
            onSend={handleChatSend}
            loading={chatLoading}
            activeTab={activeView}
            personaPill={lastAutoPersona ? { emoji: lastAutoPersona.emoji, name: lastAutoPersona.defaultName } : null}
          />
          <div className="flex items-center gap-2 ml-4 flex-shrink-0">'''
new2 = '          <div className="flex items-center gap-2">'
content = content.replace(old2, new2)

with open('/Users/lyledizon/TaskManage/src/App.jsx', 'w') as f:
    f.write(content)

print("Done")
