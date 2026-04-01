with open('/Users/lyledizon/TaskManage/src/App.jsx', 'r') as f:
    content = f.read()

start_marker = '  // Performance stats'
end_marker = '\n}\n\n// ─────────────────────────────────────────────────────────────────────────────\n// NOTES PANEL'

start_idx = content.find(start_marker)
end_idx = content.find(end_marker, start_idx)

if start_idx == -1:
    print("ERROR: start not found")
    exit(1)
if end_idx == -1:
    print("ERROR: end not found")
    exit(1)

new_jsx = '''  // Performance stats (30 day window)
  const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0,10);
  const recentTasks = tasks.filter((t) => !t.dueDate || t.dueDate >= thirtyDaysAgoStr);
  const completedOnTime = recentTasks.filter((t) => t.completed && t.completedAt && t.dueDate && t.completedAt.slice(0,10) <= t.dueDate).length;
  const completedLate = recentTasks.filter((t) => t.completed && t.completedAt && t.dueDate && t.completedAt.slice(0,10) > t.dueDate).length;
  const completedEarly = recentTasks.filter((t) => t.completed && t.completedAt && t.dueDate && t.completedAt.slice(0,10) < t.dueDate).length;
  const missedTasks = recentTasks.filter((t) => !t.completed && t.dueDate && t.dueDate < today).length;
  const totalPerf = completedOnTime + completedLate + completedEarly + missedTasks || 1;
  const onTimePct = Math.round(completedOnTime/totalPerf*100);
  const earlyPct = Math.round(completedEarly/totalPerf*100);
  const latePct = Math.round(completedLate/totalPerf*100);
  const missedPct = Math.round(missedTasks/totalPerf*100);

  return (
    <div className="flex-1 overflow-y-auto px-8 py-4 max-w-7xl mx-auto space-y-6" style={{ minHeight: 0 }}>

      {/* ROW 1: Greeting + Search + Weather */}
      <div className="flex items-center justify-between gap-6">
        <div className="flex-shrink-0">
          <h2 className="text-2xl font-extrabold tracking-tight text-on-background font-headline">{greeting}, {firstName}.</h2>
          <p className="text-on-surface-variant text-[11px] font-medium">{dateStr}</p>
        </div>
        <div className="flex-1 flex justify-center">
          <div className="flex items-center gap-3 bg-surface-container-low px-4 py-2 rounded-xl w-full max-w-md shadow-sm border border-primary/10 transition-all hover:shadow-md focus-within:ring-2 focus-within:ring-primary/20">
            <span className="material-symbols-outlined text-primary text-lg">search</span>
            <input
              className="bg-transparent border-none focus:ring-0 text-[11px] w-full placeholder:text-slate-400 font-medium outline-none"
              placeholder="Ask Aria anything..."
              onKeyDown={(e) => { if (e.key === \'Enter\' && e.target.value.trim()) { onAIPrompt(e.target.value.trim()); e.target.value = \'\'; } }}
            />
            <div className="flex items-center gap-1 px-1.5 py-0.5 bg-surface-container-high rounded text-[8px] font-bold text-outline uppercase tracking-wider">
              <span className="material-symbols-outlined text-[10px]">keyboard_command_key</span>
              <span>K</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 bg-surface-container-low px-3 py-1.5 rounded-full border border-primary/5 flex-shrink-0">
          <span className="material-symbols-outlined text-amber-500 text-lg">sunny</span>
          <span className="text-[11px] font-bold text-on-surface">Danville</span>
        </div>
      </div>

      {/* ROW 2: Aria Daily Brief */}
      <div className="bg-gradient-to-br from-surface-container-lowest to-surface-container-low p-5 rounded-xl shadow-[0px_10px_30px_rgba(79,77,207,0.05)] relative overflow-hidden group border border-primary/5">
        <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity pointer-events-none">
          <span className="material-symbols-outlined text-[60px]">auto_awesome</span>
        </div>
        <div className="relative z-10 flex flex-col md:flex-row gap-4 items-start">
          <div className="flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-lg">auto_awesome</span>
              <h3 className="text-base font-bold font-headline text-primary">{assistantName}&apos;s Daily Brief</h3>
            </div>
            {ariaBriefLoading ? (
              <p className="text-on-surface-variant leading-relaxed text-xs max-w-4xl animate-pulse">Preparing your brief...</p>
            ) : ariaBrief ? (
              <p className="text-on-surface-variant leading-relaxed text-xs max-w-4xl">{ariaBrief}</p>
            ) : (
              <p className="text-on-surface-variant leading-relaxed text-xs max-w-4xl">No brief yet — check back in a moment.</p>
            )}
            <div className="flex gap-2">
              {overdueTasks.length > 0 && (
                <span className="bg-error/10 text-error px-2 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-wider">{overdueTasks.length} Overdue</span>
              )}
              {calendarEvents.length > 0 ? (
                <span className="bg-surface-container-highest text-on-surface-variant px-2 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-wider">{calendarEvents.length} Events Today</span>
              ) : (
                <span className="bg-surface-container-highest text-on-surface-variant px-2 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-wider">Clear Morning</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ROW 3: Quick Actions + Stat Tiles */}
      <div className="grid grid-cols-5 gap-3">
        <button onClick={onAddTask} className="bg-primary/5 hover:bg-primary hover:text-on-primary transition-all rounded-xl flex items-center justify-center p-3 gap-2 group shadow-sm border border-primary/10">
          <span className="material-symbols-outlined text-primary group-hover:text-on-primary transition-colors text-lg">add_task</span>
          <span className="text-[10px] font-bold uppercase">Add Task</span>
        </button>
        <button onClick={onQuickNote} className="bg-primary/5 hover:bg-primary hover:text-on-primary transition-all rounded-xl flex items-center justify-center p-3 gap-2 group shadow-sm border border-primary/10">
          <span className="material-symbols-outlined text-primary group-hover:text-on-primary transition-colors text-lg">edit_note</span>
          <span className="text-[10px] font-bold uppercase">Quick Note</span>
        </button>
        <button onClick={() => onNavigate(\'daily\', \'overdue\')} className="bg-surface-container-lowest p-3 rounded-xl flex items-center gap-3 hover:bg-surface-container-low transition-colors group shadow-sm">
          <div className="bg-error-container/20 p-2 rounded-full group-hover:scale-110 transition-transform">
            <span className="material-symbols-outlined text-error text-lg">event_busy</span>
          </div>
          <div>
            <p className="text-lg font-extrabold text-on-background font-headline leading-none">{String(overdueTasks.length).padStart(2,\'0\')}</p>
            <p className="text-[8px] text-on-surface-variant font-bold uppercase mt-0.5">Overdue</p>
          </div>
        </button>
        <button onClick={() => onNavigate(\'daily\', \'high\')} className="bg-surface-container-lowest p-3 rounded-xl flex items-center gap-3 hover:bg-surface-container-low transition-colors group shadow-sm">
          <div className="bg-primary/10 p-2 rounded-full group-hover:scale-110 transition-transform">
            <span className="material-symbols-outlined text-primary text-lg">priority_high</span>
          </div>
          <div>
            <p className="text-lg font-extrabold text-on-background font-headline leading-none">{String(highPriorityTasks.length).padStart(2,\'0\')}</p>
            <p className="text-[8px] text-on-surface-variant font-bold uppercase mt-0.5">Priority</p>
          </div>
        </button>
        <button onClick={() => onNavigate(\'daily\', \'done\')} className="bg-surface-container-lowest p-3 rounded-xl flex items-center gap-3 hover:bg-surface-container-low transition-colors group shadow-sm">
          <div className="bg-tertiary-container/30 p-2 rounded-full group-hover:scale-110 transition-transform">
            <span className="material-symbols-outlined text-tertiary text-lg">task_alt</span>
          </div>
          <div>
            <p className="text-lg font-extrabold text-on-background font-headline leading-none">{String(doneToday).padStart(2,\'0\')}</p>
            <p className="text-[8px] text-on-surface-variant font-bold uppercase mt-0.5">Completed</p>
          </div>
        </button>
      </div>

      {/* ROW 4: Timeline + Tasks */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
        <div className="space-y-4">
          <div className="flex justify-between items-end px-1">
            <h3 className="text-lg font-extrabold font-headline">Today&apos;s Timeline</h3>
            <button onClick={() => onNavigate(\'calendar\')} className="text-primary font-bold text-[10px] hover:underline">View Calendar</button>
          </div>
          {calendarEvents.length === 0 ? (
            <div className="space-y-3 relative">
              <div className="relative pl-10 group">
                <div className="absolute left-0 top-1 w-7 h-7 rounded-full bg-surface-container-high flex items-center justify-center z-10 ring-4 ring-background">
                  <span className="material-symbols-outlined text-on-surface-variant text-base">calendar_today</span>
                </div>
                <div className="bg-surface-container-low p-3 rounded-xl shadow-sm">
                  <span className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">Today</span>
                  <h4 className="text-sm font-bold mt-1 text-on-surface-variant">No events scheduled</h4>
                  <button onClick={() => onNavigate(\'calendar\')} className="text-primary text-[10px] font-bold mt-1 hover:underline">Open Calendar</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3 relative before:absolute before:left-[13px] before:top-4 before:bottom-4 before:w-0.5 before:bg-surface-container-high">
              {calendarEvents.slice(0,4).map((ev, i) => {
                const timeStr = ev.allDay ? \'All day\' : new Date(ev.start).toLocaleTimeString(\'en-US\', { hour: \'numeric\', minute: \'2-digit\' });
                const bgMap = [\'bg-primary\', \'bg-secondary-container\', \'bg-surface-container-high\', \'bg-surface-container-high\'];
                const iconMap = [\'schedule\', \'groups\', \'restaurant\', \'event\'];
                const textMap = [\'text-on-primary\', \'text-primary\', \'text-on-surface-variant\', \'text-on-surface-variant\'];
                return (
                  <div key={ev.id || i} className="relative pl-10 group">
                    <div className={`absolute left-0 top-1 w-7 h-7 rounded-full ${bgMap[i]||\'bg-surface-container-high\'} flex items-center justify-center z-10 ring-4 ring-background group-hover:scale-110 transition-transform`}>
                      <span className={`material-symbols-outlined ${textMap[i]||\'text-on-surface-variant\'} text-base`}>{iconMap[i]||\'event\'}</span>
                    </div>
                    <div className={`${i===1?\'border-l-4 border-primary \':\'\'} ${i===2?\'bg-surface-container-low\':\'bg-surface-container-lowest\'} p-3 rounded-xl shadow-sm hover:shadow-md transition-shadow`}>
                      <span className={`text-[8px] font-bold uppercase tracking-widest ${i===0?\'text-primary\':\'text-slate-400\'}`}>{timeStr}</span>
                      <h4 className="text-sm font-bold mt-1">{ev.title}</h4>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="space-y-4">
          <div className="flex justify-between items-end px-1">
            <h3 className="text-lg font-extrabold font-headline">Today&apos;s Tasks</h3>
            <button onClick={() => onNavigate(\'daily\')} className="text-primary font-bold text-[10px] hover:underline">Manage All</button>
          </div>
          <div className="bg-surface-container-lowest rounded-xl shadow-sm overflow-hidden border border-surface-container-low">
            <div className="divide-y divide-surface-container-low">
              {overdueTasks.length === 0 && todayTasks.length === 0 ? (
                <div className="p-3"><h5 className="text-xs font-bold text-on-surface-variant">All clear 🎉</h5></div>
              ) : (
                <>
                  {overdueTasks.slice(0,2).map((t) => (
                    <div key={t.id} className="p-3 flex items-start gap-3 hover:bg-surface-container-low transition-colors group">
                      <button className="mt-0.5 h-4 w-4 rounded-full border-2 border-error flex items-center justify-center flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <h5 className="text-xs font-bold leading-tight text-error truncate">{t.title}</h5>
                        <div className="flex gap-2 mt-1.5">
                          <span className="flex items-center gap-1 text-[8px] font-bold text-error bg-error/5 px-1.5 py-0.5 rounded-full">
                            <span className="material-symbols-outlined text-[10px]">timer</span> overdue
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                  {todayTasks.slice(0,4).map((t) => (
                    <div key={t.id} className="p-3 flex items-start gap-3 hover:bg-surface-container-low transition-colors group">
                      <button className="mt-0.5 h-4 w-4 rounded-full border-2 border-outline-variant flex items-center justify-center hover:border-primary transition-colors flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <h5 className="text-xs font-bold leading-tight truncate">{t.title}</h5>
                        <div className="flex gap-2 mt-1.5">
                          <span className="flex items-center gap-1 text-[8px] font-bold text-primary bg-primary/5 px-1.5 py-0.5 rounded-full">Due today</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ROW 5: Task Performance */}
      <div className="space-y-4">
        <div className="flex justify-between items-end px-1">
          <h3 className="text-lg font-extrabold font-headline">Task Performance</h3>
          <span className="text-on-surface-variant text-[10px] font-bold uppercase tracking-wider">Last 30 days</span>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <div className="bg-surface-container-lowest rounded-xl p-4 shadow-sm border border-surface-container-low group hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center">
                <span className="material-symbols-outlined text-emerald-500 text-lg">task_alt</span>
              </div>
              <span className="text-[8px] font-bold uppercase tracking-wider text-emerald-500 bg-emerald-50 px-2 py-0.5 rounded-full">On Time</span>
            </div>
            <p className="text-3xl font-extrabold font-headline text-on-background leading-none">{String(completedOnTime).padStart(2,\'0\')}</p>
            <p className="text-[10px] text-on-surface-variant font-medium mt-1">tasks completed on time</p>
            <div className="mt-3 h-1 bg-surface-container-high rounded-full overflow-hidden">
              <div className="h-full bg-emerald-400 rounded-full" style={{width:onTimePct+\'%\'}} />
            </div>
            <p className="text-[8px] text-on-surface-variant mt-1">{onTimePct}% of total</p>
          </div>
          <div className="bg-surface-container-lowest rounded-xl p-4 shadow-sm border border-surface-container-low group hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                <span className="material-symbols-outlined text-primary text-lg">bolt</span>
              </div>
              <span className="text-[8px] font-bold uppercase tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-full">Early</span>
            </div>
            <p className="text-3xl font-extrabold font-headline text-on-background leading-none">{String(completedEarly).padStart(2,\'0\')}</p>
            <p className="text-[10px] text-on-surface-variant font-medium mt-1">tasks completed early</p>
            <div className="mt-3 h-1 bg-surface-container-high rounded-full overflow-hidden">
              <div className="h-full bg-primary rounded-full" style={{width:earlyPct+\'%\'}} />
            </div>
            <p className="text-[8px] text-on-surface-variant mt-1">{earlyPct}% of total</p>
          </div>
          <div className="bg-surface-container-lowest rounded-xl p-4 shadow-sm border border-surface-container-low group hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <div className="w-8 h-8 rounded-full bg-amber-50 flex items-center justify-center">
                <span className="material-symbols-outlined text-amber-500 text-lg">schedule</span>
              </div>
              <span className="text-[8px] font-bold uppercase tracking-wider text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">Late</span>
            </div>
            <p className="text-3xl font-extrabold font-headline text-on-background leading-none">{String(completedLate).padStart(2,\'0\')}</p>
            <p className="text-[10px] text-on-surface-variant font-medium mt-1">tasks completed late</p>
            <div className="mt-3 h-1 bg-surface-container-high rounded-full overflow-hidden">
              <div className="h-full bg-amber-400 rounded-full" style={{width:latePct+\'%\'}} />
            </div>
            <p className="text-[8px] text-on-surface-variant mt-1">{latePct}% of total</p>
          </div>
          <div className="bg-surface-container-lowest rounded-xl p-4 shadow-sm border border-surface-container-low group hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <div className="w-8 h-8 rounded-full bg-error/10 flex items-center justify-center">
                <span className="material-symbols-outlined text-error text-lg">cancel</span>
              </div>
              <span className="text-[8px] font-bold uppercase tracking-wider text-error bg-error/10 px-2 py-0.5 rounded-full">Missed</span>
            </div>
            <p className="text-3xl font-extrabold font-headline text-on-background leading-none">{String(missedTasks).padStart(2,\'0\')}</p>
            <p className="text-[10px] text-on-surface-variant font-medium mt-1">tasks missed / abandoned</p>
            <div className="mt-3 h-1 bg-surface-container-high rounded-full overflow-hidden">
              <div className="h-full bg-error rounded-full" style={{width:missedPct+\'%\'}} />
            </div>
            <p className="text-[8px] text-on-surface-variant mt-1">{missedPct}% of total</p>
          </div>
        </div>
        <div className="bg-primary/5 border border-primary/10 rounded-xl px-4 py-3 flex items-center gap-3">
          <span className="material-symbols-outlined text-primary text-lg flex-shrink-0">auto_awesome</span>
          <p className="text-[11px] text-on-surface-variant leading-relaxed">
            <span className="font-bold text-on-background">{assistantName}&apos;s read: </span>
            {missedTasks > completedOnTime ? \'Missing more than completing on time. Focus on adding due dates to high-priority items.\' : completedEarly > completedOnTime ? \'You tend to finish early — consider tightening your deadlines to build momentum.\' : `On-time rate is strong at ${onTimePct}%. Most slippage happens on tasks without hard deadlines.`}
          </p>
        </div>
      </div>

      {/* ROW 6: Active Notes */}
      <div className="space-y-4">
        <div className="flex justify-between items-end px-1">
          <h3 className="text-lg font-extrabold font-headline">Active Notes</h3>
          <button onClick={() => onNavigate(\'notes\')} className="text-primary font-bold text-[10px] hover:underline">See All Notes</button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {notes.filter((n) => n.type !== \'digest\').slice(0,3).map((note, i) => {
            const borders = [\'border-[#4f4dcf]\', \'border-tertiary\', \'border-error\'];
            const hovers = [\'group-hover:text-primary\', \'group-hover:text-tertiary\', \'group-hover:text-error\'];
            const timeAgo = note.updatedAt ? (() => { const diff = Date.now() - new Date(note.updatedAt).getTime(); const h = Math.floor(diff/3600000); if(h<1) return \'Just now\'; if(h<24) return \'Modified \'+h+\'h ago\'; if(h<48) return \'Modified Yesterday\'; return \'Modified \'+Math.floor(h/24)+\'d ago\'; })() : \'\';
            return (
              <button key={note.id} onClick={() => onNavigate(\'notes\')} className={\'bg-surface-container-lowest p-5 rounded-xl shadow-sm border-t-4 \'+borders[i%3]+\' group hover:scale-[1.01] transition-transform cursor-pointer border-x border-b border-x-surface-container-low border-b-surface-container-low text-left w-full\'}>
                <span className="text-[8px] font-bold uppercase text-slate-400 tracking-widest">{timeAgo}</span>
                <h4 className={\'text-sm font-bold mt-2 \'+hovers[i%3]+\' transition-colors\'}>{note.title || \'Untitled\'}</h4>
                <p className="text-on-surface-variant text-[11px] mt-2.5 line-clamp-3 leading-relaxed">{(note.content||\'\').replace(/<[^>]+>/g,\'\').slice(0,120)}</p>
              </button>
            );
          })}
          {notes.filter((n) => n.type !== \'digest\').length === 0 && (
            <div className="col-span-3 bg-surface-container-lowest p-5 rounded-xl shadow-sm border border-surface-container-low text-center">
              <p className="text-[11px] text-on-surface-variant">No notes yet</p>
              <button onClick={onQuickNote} className="text-primary text-[10px] font-bold mt-2 hover:underline">Create your first note</button>
            </div>
          )}
        </div>
      </div>

      <div className="h-8" />

    </div>
  );
}'''

content = content[:start_idx] + new_jsx + content[end_idx + 2:]

with open('/Users/lyledizon/TaskManage/src/App.jsx', 'w') as f:
    f.write(content)

print("Done — total lines: " + str(content.count(chr(10))))
