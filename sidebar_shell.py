with open('/Users/lyledizon/TaskManage/src/App.jsx', 'r') as f:
    content = f.read()

# ── PART 1: Replace outer wrapper + header + tabs ──────────────────────────
old_shell = '''  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Header ── */}
      <header className="bg-white border-b border-gray-200 px-3 md:px-6 py-2.5 md:py-3.5 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-2 md:gap-3">
          <div className="w-8 h-8 md:w-9 md:h-9 bg-indigo-600 rounded-xl flex items-center justify-center shadow-sm">
            <ChecklistIcon className="w-4 h-4 md:w-5 md:h-5 text-white" />
          </div>
          <div>
            <h1 className="text-sm md:text-base font-bold text-gray-900 leading-none">Dizon.ai</h1>
            <p className="hidden md:block text-[11px] text-gray-400 mt-0.5">Life OS for high performers</p>
          </div>
        </div>

        <div className="flex items-center gap-1 md:gap-2">
          <span className="hidden sm:inline-flex text-xs bg-gray-100 text-gray-500 px-3 py-1.5 rounded-full font-medium">
            {visibleTasks.filter((t) => !t.completed).length} active ·{' '}
            {visibleTasks.filter((t) => t.completed).length} done
          </span>

          {/* Bell — alert rules */}
          <button
            onClick={() => setShowAlerts(true)}
            className="relative p-2 min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 flex items-center justify-center text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
            title="Alert rules"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
            {enabledRulesCount > 0 && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-indigo-600 rounded-full" />
            )}
          </button>

          {/* Gear — settings */}
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            title="Settings"
          >
            <GearIcon className="w-5 h-5" />
          </button>

          {/* User badge + Logout */}
          <div className="flex items-center gap-1.5 ml-1 pl-2 border-l border-gray-200">
            <span className="hidden md:inline text-xs font-medium text-gray-600 bg-indigo-50 px-2 py-1 rounded-full">
              {currentUser.displayName}
            </span>
            <button
              onClick={onLogout}
              className="p-1.5 min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
              title="Sign out"
            >
              <LogoutIcon className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* ── Main layout ── */}
      <main className="flex flex-col overflow-hidden" style={{ height: 'calc(100vh - 49px)', minHeight: 0 }}>
        {/* Sticky prompt bar — always visible on all tabs */}
        <UniversalPromptBar
          input={chatInput}
          onInputChange={setChatInput}
          backend={chatBackend}
          onBackendChange={setChatBackend}
          onSend={handleChatSend}
          loading={chatLoading}
          activeTab={window.innerWidth >= 768 ? activeView : mobileView}
          personaPill={lastAutoPersona ? { emoji: lastAutoPersona.emoji, name: lastAutoPersona.defaultName } : null}
        />

        {/* Content row */}
        <div className="flex flex-col md:flex-row flex-1 pb-20 md:pb-6 overflow-hidden" style={{ minHeight: 0 }}>
        {/* ── Left: Task panel (shrinks when sliding chat is open) ── */}
        <section
          className={`flex-col md:border-r border-gray-200 overflow-hidden w-full ${
            mobileView === 'tasks' ? 'flex' : 'hidden md:flex'
          }`}
          style={{ flex: chatPanelOpen && activeView !== 'chat' ? '0 0 75%' : '1 1 100%', transition: 'flex 0.2s', minHeight: 0 }}
        >
          {/* View Tabs — calendar tab hidden on mobile (use bottom nav) */}
          <div className="bg-white border-b border-gray-100 px-4 md:px-6 pt-3 md:pt-4 pb-0 flex-shrink-0">
            <div className="flex gap-1 w-fit">
              {[
                { key: 'dashboard', label: 'Dashboard' },
                { key: 'daily', label: 'Tasks' },
                { key: 'calendar', label: 'Calendar', desktopOnly: true },
                { key: 'notes', label: 'Notes', desktopOnly: true },
                { key: 'chat', label: 'Chat', desktopOnly: true },
              ].map(({ key, label, desktopOnly }) => (
                <button
                  key={key}
                  onClick={() => setActiveView(key)}
                  className={`px-3 md:px-4 py-2.5 text-sm font-medium border-b-2 transition-all -mb-px items-center gap-1.5 ${
                    desktopOnly ? 'hidden md:flex' : 'flex'
                  } ${
                    activeView === key
                      ? 'border-primary text-primary'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-200'
                  }`}
                >
                  {key === 'calendar' && <CalendarIcon className="w-3.5 h-3.5" />}
                  {key === 'notes' && <NotesIcon className="w-3.5 h-3.5" />}
                  {key === 'chat' && <ChatIcon className="w-3.5 h-3.5" />}
                  {label}
                </button>
              ))}
            </div>
          </div>'''

new_shell = '''  return (
    <div className="min-h-screen bg-background flex" style={{ fontFamily: "'Manrope', sans-serif" }}>

      {/* ── Sidebar ── */}
      <aside className="hidden md:flex fixed left-0 top-0 h-full flex-col py-6 px-5 bg-slate-50/80 backdrop-blur-xl w-52 shadow-[0px_20px_40px_rgba(79,77,207,0.08)] z-50">
        <div className="mb-8 px-2">
          <h1 className="text-base font-bold tracking-tight text-primary" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Dizon.ai</h1>
          <p className="text-[8px] uppercase tracking-[0.2em] text-slate-400 mt-1 font-bold">Personal OS</p>
        </div>
        <nav className="flex-1 space-y-1">
          {[
            { key: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
            { key: 'daily', label: 'Tasks', icon: 'task' },
            { key: 'calendar', label: 'Calendar', icon: 'calendar_today' },
            { key: 'notes', label: 'Notes', icon: 'sticky_note_2' },
            { key: 'chat', label: 'Aria', icon: 'chat' },
          ].map(({ key, label, icon }) => (
            <button
              key={key}
              onClick={() => setActiveView(key)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl transition-all duration-200 text-left ${
                activeView === key
                  ? 'text-primary font-bold border-r-4 border-primary bg-primary/5'
                  : 'text-slate-500 font-medium hover:bg-primary/5'
              }`}
            >
              <span className="material-symbols-outlined text-lg">{icon}</span>
              <span className="text-[11px]">{label}</span>
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-2 px-2">
          <div className="flex items-center gap-2 pt-3 border-t border-slate-200">
            <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
              {currentUser.displayName?.[0] || 'L'}
            </div>
            <span className="text-[11px] font-medium text-on-surface-variant truncate">{currentUser.displayName}</span>
            <button onClick={onLogout} className="ml-auto text-slate-400 hover:text-error transition-colors" title="Sign out">
              <LogoutIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main (offset by sidebar) ── */}
      <div className="flex-1 md:ml-52 flex flex-col min-h-screen overflow-hidden">

        {/* ── Top bar ── */}
        <header className="hidden md:flex items-center justify-between px-8 h-14 bg-background/80 backdrop-blur-xl sticky top-0 z-40 border-b border-surface-container-low flex-shrink-0">
          <UniversalPromptBar
            input={chatInput}
            onInputChange={setChatInput}
            backend={chatBackend}
            onBackendChange={setChatBackend}
            onSend={handleChatSend}
            loading={chatLoading}
            activeTab={activeView}
            personaPill={lastAutoPersona ? { emoji: lastAutoPersona.emoji, name: lastAutoPersona.defaultName } : null}
          />
          <div className="flex items-center gap-2 ml-4 flex-shrink-0">
            <button onClick={() => setShowAlerts(true)} className="relative p-1.5 text-slate-400 hover:text-primary transition-colors" title="Alerts">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
              </svg>
              {enabledRulesCount > 0 && <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-primary rounded-full" />}
            </button>
            <button onClick={() => setShowSettings(true)} className="p-1.5 text-slate-400 hover:text-primary transition-colors" title="Settings">
              <GearIcon className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Mobile top bar */}
        <header className="md:hidden bg-background border-b border-surface-container-low px-4 py-3 flex items-center justify-between sticky top-0 z-40">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-primary rounded-lg flex items-center justify-center">
              <span className="text-white text-xs font-bold">D</span>
            </div>
            <h1 className="text-sm font-bold text-primary">Dizon.ai</h1>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setShowAlerts(true)} className="p-2 text-slate-400 hover:text-primary">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            </button>
            <button onClick={() => setShowSettings(true)} className="p-2 text-slate-400 hover:text-primary">
              <GearIcon className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Mobile prompt bar */}
        <div className="md:hidden flex-shrink-0">
          <UniversalPromptBar
            input={chatInput}
            onInputChange={setChatInput}
            backend={chatBackend}
            onBackendChange={setChatBackend}
            onSend={handleChatSend}
            loading={chatLoading}
            activeTab={mobileView}
            personaPill={lastAutoPersona ? { emoji: lastAutoPersona.emoji, name: lastAutoPersona.defaultName } : null}
          />
        </div>

        {/* ── Content ── */}
        <div className="flex flex-row flex-1 overflow-hidden pb-20 md:pb-0" style={{ minHeight: 0 }}>
        <section
          className={`flex-col overflow-hidden w-full ${mobileView === 'tasks' ? 'flex' : 'hidden md:flex'}`}
          style={{ flex: chatPanelOpen && activeView !== 'chat' ? '0 0 75%' : '1 1 100%', transition: 'flex 0.2s', minHeight: 0 }}
        >'''

if old_shell in content:
    content = content.replace(old_shell, new_shell)
    print("Part 1: shell replaced")
else:
    print("ERROR Part 1: not found")
    exit(1)

# ── PART 2: Replace closing </main> and mobile nav ─────────────────────────
old_close = '''        </div>{/* end content row */}
      </main>

      {/* ── Mobile bottom navigation ── */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 flex z-40 safe-area-bottom">
        {[
          { key: 'tasks', label: 'Tasks', icon: <ChecklistIcon className="w-5 h-5" /> },
          { key: 'chat', label: 'Chat', icon: <ChatIcon className="w-5 h-5" /> },
          { key: 'calendar', label: 'Calendar', icon: <CalendarIcon className="w-5 h-5" /> },
          { key: 'financials', label: 'Financials', icon: <DollarIcon className="w-5 h-5" /> },
          { key: 'notes', label: 'Notes', icon: <NotesIcon className="w-5 h-5" /> },
        ].map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => {
              setMobileView(key);
              if (key === 'tasks' && (activeView === 'calendar' || activeView === 'financials' || activeView === 'notes')) setActiveView('dashboard');
            }}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 min-h-[56px] text-xs font-medium transition-colors ${
              mobileView === key
                ? 'text-indigo-600'
                : 'text-gray-400 active:text-gray-600'
            }`}
          >
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </nav>'''

new_close = '''        </div>{/* end content row */}
        </div>{/* end main content */}
      </div>{/* end ml-52 wrapper */}

      {/* ── Mobile bottom navigation ── */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-outline-variant/10 flex z-40 rounded-t-2xl shadow-[0px_-10px_30px_rgba(79,77,207,0.06)]">
        {[
          { key: 'tasks', label: 'Home', icon: <span className="material-symbols-outlined text-xl">dashboard</span> },
          { key: 'daily', label: 'Tasks', icon: <span className="material-symbols-outlined text-xl">checklist</span> },
          { key: 'calendar', label: 'Calendar', icon: <span className="material-symbols-outlined text-xl">calendar_today</span> },
          { key: 'notes', label: 'Notes', icon: <span className="material-symbols-outlined text-xl">sticky_note_2</span> },
          { key: 'chat', label: 'Aria', icon: <span className="material-symbols-outlined text-xl">chat</span> },
        ].map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => {
              setMobileView(key);
              if (key === 'tasks') setActiveView('dashboard');
              else if (key === 'daily') setActiveView('daily');
            }}
            className={`flex-1 flex flex-col items-center gap-0.5 py-3 text-xs font-bold transition-colors ${
              mobileView === key ? 'text-primary' : 'text-slate-400'
            }`}
          >
            {icon}
            <span className="text-[9px] uppercase tracking-wider">{label}</span>
          </button>
        ))}
      </nav>'''

if old_close in content:
    content = content.replace(old_close, new_close)
    print("Part 2: close replaced")
else:
    print("ERROR Part 2: not found")
    exit(1)

with open('/Users/lyledizon/TaskManage/src/App.jsx', 'w') as f:
    f.write(content)

print("Done — total lines: " + str(content.count('\n')))
