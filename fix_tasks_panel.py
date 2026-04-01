with open('/Users/lyledizon/TaskManage/src/App.jsx', 'r') as f:
    content = f.read()

old = '''          /* Scrollable task content */
          <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 md:py-5">
            <AddTaskForm onAdd={addTask} claudeKey={apiKeys.claude} currentUser={currentUser} entities={userEntities} authToken={authToken} gcalConnected={gcalConnected} />
            <FilterBar
              activeTagFilters={activeTagFilters}
              setActiveTagFilters={setActiveTagFilters}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              entities={userEntities}
            />

            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-gray-400">
                {filteredTasks.length} task{filteredTasks.length !== 1 ? 's' : ''}
                {activeView === 'priority' ? ' (high priority)' : ''}
              </span>
              {completedCount > 0 && (
                <span className="text-xs text-gray-400">{completedCount} completed</span>
              )}
            </div>

            <div className="space-y-2.5">
              {filteredTasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                  <div className="text-5xl mb-3">✓</div>
                  <p className="text-sm font-medium text-gray-500">
                    {activeView === 'priority' ? 'No high-priority tasks' : 'No tasks here'}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    {activeTagFilters.length > 0 || statusFilter !== 'all'
                      ? 'Try clearing filters'
                      : 'Click "Add new task" above'}
                  </p>
                </div>
              ) : (
                filteredTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onToggle={toggleTask}
                    onDelete={deleteTask}
                    onEdit={editTask}
                    onToggleVisibility={toggleVisibility}
                    onSyncCalendar={handleSyncToCalendar}
                    currentUser={currentUser}
                    gcalConnected={gcalConnected}
                    entities={userEntities}
                  />
                ))
              )}
            </div>
          </div>
          )}'''

new = '''          /* Tasks panel — exact comp */
          <div className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>

            {/* Page header */}
            <div className="px-8 pt-6 pb-4 flex items-end justify-between">
              <div>
                <h1 className="text-2xl font-extrabold font-headline text-on-background tracking-tight">Tasks</h1>
                <p className="text-on-surface-variant text-[11px] font-medium mt-0.5">
                  {visibleTasks.filter((t) => !t.completed && t.dueDate && t.dueDate < new Date().toISOString().slice(0,10)).length} overdue
                  {' · '}
                  {visibleTasks.filter((t) => !t.completed && t.dueDate === new Date().toISOString().slice(0,10)).length} due today
                  {' · '}
                  {visibleTasks.filter((t) => !t.completed && (!t.dueDate || t.dueDate > new Date().toISOString().slice(0,10))).length} upcoming
                </p>
              </div>
              <button
                onClick={() => document.querySelector('[data-add-task]')?.click()}
                className="flex items-center gap-2 bg-primary text-on-primary px-4 py-2 rounded-xl text-[11px] font-bold shadow-lg shadow-primary/20 hover:scale-[0.98] transition-transform"
              >
                <span className="material-symbols-outlined text-base">add</span>
                Add Task
              </button>
            </div>

            {/* Hidden AddTaskForm — triggered by button above */}
            <div className="hidden">
              <AddTaskForm data-add-task onAdd={addTask} claudeKey={apiKeys.claude} currentUser={currentUser} entities={userEntities} authToken={authToken} gcalConnected={gcalConnected} />
            </div>

            {/* Filter pills — dynamic from active entities */}
            <div className="px-8 pb-5 flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setActiveTagFilters([])}
                className={`px-4 py-1.5 rounded-full text-[10px] font-bold shadow shadow-primary/20 transition-all ${activeTagFilters.length === 0 ? 'bg-primary text-white' : 'bg-surface-container-lowest border border-surface-container-high text-on-surface-variant hover:border-primary/20'}`}
              >All</button>
              {userEntities.map((entity) => (
                <button
                  key={entity.id}
                  onClick={() => setActiveTagFilters([entity.name])}
                  className={`px-4 py-1.5 rounded-full text-[10px] font-bold transition-all ${activeTagFilters.includes(entity.name) ? 'bg-primary text-white' : 'bg-surface-container-lowest border border-surface-container-high text-on-surface-variant hover:border-primary/20'}`}
                >{entity.name}</button>
              ))}
              <div className="h-4 w-px bg-outline-variant/30 mx-1" />
              <button
                onClick={() => setStatusFilter(statusFilter === 'overdue' ? 'all' : 'overdue')}
                className={`px-4 py-1.5 rounded-full text-[10px] font-bold transition-all ${statusFilter === 'overdue' ? 'bg-error text-white' : 'bg-error/10 text-error'}`}
              >Overdue</button>
            </div>

            {/* Task sections */}
            {(() => {
              const todayStr = new Date().toISOString().slice(0,10);
              const base = activeTagFilters.length > 0
                ? visibleTasks.filter((t) => t.tags?.some((tag) => activeTagFilters.includes(tag)))
                : visibleTasks;
              const overdue = base.filter((t) => !t.completed && t.dueDate && t.dueDate < todayStr);
              const todayTasks = base.filter((t) => !t.completed && t.dueDate === todayStr);
              const upcoming = base.filter((t) => !t.completed && (!t.dueDate || t.dueDate > todayStr));
              const completedToday = base.filter((t) => t.completed && t.completedAt && t.completedAt.slice(0,10) === todayStr);

              const taskRow = (t, isOverdue = false) => (
                <div key={t.id} className={`flex items-center gap-3 p-3 rounded-xl transition-colors group ${isOverdue ? 'bg-error/5 border border-error/10 hover:bg-error/10' : 'bg-surface-container-lowest border border-surface-container-low hover:bg-surface-container-low'}`}>
                  <button
                    onClick={() => toggleTask(t.id)}
                    className={`h-4 w-4 rounded-full border-2 flex-shrink-0 transition-colors ${isOverdue ? 'border-error' : 'border-outline-variant hover:border-primary'}`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-bold leading-tight truncate ${isOverdue ? 'text-on-background' : 'text-on-background'}`}>{t.title}</p>
                    {isOverdue && t.dueDate && (
                      <p className="text-[9px] text-error font-bold mt-0.5">
                        {Math.floor((new Date(todayStr) - new Date(t.dueDate)) / 86400000)} day{Math.floor((new Date(todayStr) - new Date(t.dueDate)) / 86400000) !== 1 ? 's' : ''} overdue
                      </p>
                    )}
                    {!isOverdue && t.dueDate === todayStr && (
                      <p className="text-[9px] text-on-surface-variant mt-0.5">Due today{t.priority === 'high' ? ' · High priority' : ''}</p>
                    )}
                  </div>
                  {t.tags?.[0] && (
                    <span className="text-[9px] font-bold text-on-surface-variant bg-surface-container px-2 py-0.5 rounded-full flex-shrink-0">{t.tags[0]}</span>
                  )}
                  {t.dueDate && t.dueDate !== todayStr && !isOverdue && (
                    <span className="text-[9px] text-on-surface-variant font-bold flex-shrink-0">
                      {new Date(t.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  )}
                  <span className="material-symbols-outlined text-on-surface-variant/30 group-hover:text-on-surface-variant text-base transition-colors flex-shrink-0">chevron_right</span>
                </div>
              );

              return (
                <div className="px-8 space-y-8 pb-12">

                  {/* OVERDUE */}
                  {overdue.length > 0 && (
                    <section>
                      <div className="flex items-center gap-3 mb-3">
                        <span className="material-symbols-outlined text-error text-base">event_busy</span>
                        <h2 className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-error">Overdue</h2>
                        <div className="h-px flex-1 bg-error/10" />
                        <span className="text-[9px] font-bold text-error bg-error/10 px-2 py-0.5 rounded-full">{overdue.length} tasks</span>
                      </div>
                      <div className="space-y-2">{overdue.map((t) => taskRow(t, true))}</div>
                    </section>
                  )}

                  {/* TODAY */}
                  {todayTasks.length > 0 && (
                    <section>
                      <div className="flex items-center gap-3 mb-3">
                        <span className="material-symbols-outlined text-primary text-base">today</span>
                        <h2 className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-primary/70">Today</h2>
                        <div className="h-px flex-1 bg-primary/10" />
                        <span className="text-[9px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-full">{todayTasks.length} tasks</span>
                      </div>
                      <div className="space-y-2">{todayTasks.map((t) => taskRow(t, false))}</div>
                    </section>
                  )}

                  {/* UPCOMING */}
                  {upcoming.length > 0 && (
                    <section>
                      <div className="flex items-center gap-3 mb-3">
                        <span className="material-symbols-outlined text-on-surface-variant text-base">upcoming</span>
                        <h2 className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-on-surface-variant">Upcoming</h2>
                        <div className="h-px flex-1 bg-surface-container-high" />
                        <span className="text-[9px] font-bold text-on-surface-variant bg-surface-container px-2 py-0.5 rounded-full">{upcoming.length} tasks</span>
                      </div>
                      <div className="space-y-2">{upcoming.map((t) => taskRow(t, false))}</div>
                    </section>
                  )}

                  {/* COMPLETED TODAY */}
                  {completedToday.length > 0 && (
                    <section className="opacity-60">
                      <div className="flex items-center gap-3 mb-3">
                        <span className="material-symbols-outlined text-emerald-500 text-base">task_alt</span>
                        <h2 className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-slate-400">Completed Today</h2>
                        <div className="h-px flex-1 bg-surface-container-high" />
                        <button className="text-[9px] font-bold text-on-surface-variant hover:text-primary transition-colors">Show all</button>
                      </div>
                      <div className="space-y-2">
                        {completedToday.map((t) => (
                          <div key={t.id} className="flex items-center gap-3 bg-surface-container-lowest/50 p-3 rounded-xl">
                            <div className="h-4 w-4 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0">
                              <span className="material-symbols-outlined text-white text-[10px]" style={{fontVariationSettings:"'FILL' 1"}}>check</span>
                            </div>
                            <p className="text-xs font-medium text-on-surface-variant line-through flex-1 truncate">{t.title}</p>
                            <span className="text-[9px] text-on-surface-variant font-medium flex-shrink-0">
                              {t.completedAt ? new Date(t.completedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'Today'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {/* EMPTY STATE */}
                  {overdue.length === 0 && todayTasks.length === 0 && upcoming.length === 0 && completedToday.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-16">
                      <span className="material-symbols-outlined text-5xl text-on-surface-variant/30 mb-3">task_alt</span>
                      <p className="text-sm font-bold text-on-surface-variant">All clear</p>
                      <p className="text-xs text-on-surface-variant/60 mt-1">No tasks here</p>
                    </div>
                  )}

                </div>
              );
            })()}
          </div>
          )}'''

if old in content:
    content = content.replace(old, new)
    with open('/Users/lyledizon/TaskManage/src/App.jsx', 'w') as f:
        f.write(content)
    print("Done — lines: " + str(content.count('\n')))
else:
    print("ERROR: not found")
