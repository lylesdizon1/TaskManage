path = "src/App.jsx"

with open(path, "r") as f:
    lines = f.readlines()

content = "".join(lines)

count = 0

# 1. Fix "Read full digest" in Aria card to open chat
old_aria_btn = """              {digest && digest.content.split('\\n').length > 4 && (
                <button onClick={() => onNavigate('notes')} className="text-xs font-medium text-purple-600 hover:text-purple-800 transition-colors">
                  Read full digest &rarr;
                </button>
              )}"""
new_aria_btn = """              {digest && digest.content.split('\\n').length > 4 && (
                <button onClick={() => onAIPrompt(digest.content)} className="text-xs font-medium text-purple-600 hover:text-purple-800 transition-colors">
                  Open in Chat &rarr;
                </button>
              )}"""

if old_aria_btn in content:
    content = content.replace(old_aria_btn, new_aria_btn, 1)
    count += 1
    print("Done! Fixed Aria button → Open in Chat")
else:
    print("SKIP: Aria button already fixed or not found")

# 2. Kill pillar strip by finding start/end markers in lines
lines = content.split('\n')
start_idx = None
end_idx = None

for i, line in enumerate(lines):
    if '{/* ── Pillar Strip ── */}' in line:
        start_idx = i
    if start_idx and i > start_idx and 'View Move' in line:
        # Find the closing </div></div> after "View Move"
        for j in range(i, min(i+10, len(lines))):
            if lines[j].strip() == '</div>' and j > i:
                # This closes the pillar grid
                for k in range(j+1, min(j+5, len(lines))):
                    if lines[k].strip() == '</div>':
                        end_idx = k
                        break
                break
        break

if start_idx and end_idx:
    # Remove lines from start_idx to end_idx inclusive
    removed = end_idx - start_idx + 1
    lines = lines[:start_idx] + lines[end_idx+1:]
    content = '\n'.join(lines)
    count += 1
    print(f"Done! Removed pillar strip ({removed} lines)")
else:
    print(f"ERROR: Pillar strip markers not found (start={start_idx}, end={end_idx})")

# 3. Replace Daily Digest panel with Today's Tasks + Overdue
# Find the digest panel start and replace it
lines = content.split('\n')
digest_start = None
digest_end = None

for i, line in enumerate(lines):
    if '{/* Daily Digest (right) */}' in line:
        digest_start = i
    if digest_start and i > digest_start and '↺ Regenerate' in line:
        # Find the closing divs after Regenerate button
        for j in range(i, min(i+10, len(lines))):
            if '</div>' in lines[j] and 'div' in lines[j]:
                for k in range(j, min(j+10, len(lines))):
                    stripped = lines[k].strip()
                    if stripped == '</div>' and k > j + 2:
                        digest_end = k
                        break
                if digest_end:
                    break
        break

if digest_start and digest_end:
    new_panel_lines = """        {/* Today's Tasks + Overdue (right) */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:shadow-md transition-shadow border-l-4 border-l-indigo-400 h-full flex flex-col">
            <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
              {\'\\uD83D\\uDCCB\'} Today&rsquo;s Tasks
              {overdueTasks.length > 0 && (
                <span className="ml-auto text-xs font-medium bg-red-100 text-red-600 px-2 py-0.5 rounded-full">{overdueTasks.length} overdue</span>
              )}
            </h3>
            <div className="flex-1 overflow-y-auto space-y-1.5">
              {!tasksReady ? (
                <div className="space-y-2">{[1,2,3].map(i => <SkeletonBlock key={i} className="h-8 w-full" />)}</div>
              ) : overdueTasks.length === 0 && todayTasks.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">Nothing due today {\'\\uD83C\\uDF89\'}</p>
              ) : (
                <>
                  {overdueTasks.slice(0, 3).map(t => (
                    <div key={t.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-100">
                      <span className="text-xs text-red-500 font-medium flex-shrink-0">Overdue</span>
                      <span className="text-sm text-gray-800 truncate">{t.title}</span>
                    </div>
                  ))}
                  {todayTasks.slice(0, 5).map(t => (
                    <div key={t.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 border border-gray-100">
                      <span className={\'text-xs font-medium flex-shrink-0 \' + (t.priority === \'high\' ? \'text-red-500\' : \'text-gray-400\')}>{t.priority === \'high\' ? \'High\' : \'Today\'}</span>
                      <span className="text-sm text-gray-800 truncate">{t.title}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
            <button onClick={() => onNavigate(\'daily\')} className="mt-3 text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors">
              View all tasks &rarr;
            </button>
          </div>
        </div>
      </div>""".split('\n')

    lines = content.split('\n')
    lines = lines[:digest_start] + new_panel_lines + lines[digest_end+1:]
    content = '\n'.join(lines)
    count += 1
    print(f"Done! Replaced Daily Digest with Today's Tasks panel")
else:
    print(f"ERROR: Digest panel not found (start={digest_start}, end={digest_end})")

with open(path, "w") as f:
    f.write(content)

print(f"\n{count}/3 changes applied.")
