'use strict';

const db = require('../../db.cjs');

async function backfill() {
  await db.initTables();
  try { await db.runMigrations(); } catch {}

  // Get all users
  const users = await db.getUsers();
  console.log(`[backfill] Found ${users.length} users`);

  let totalScheduled = 0;
  let totalSkipped = 0;

  for (const user of users) {
    const userTz = user.timezone || 'America/Los_Angeles';
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: userTz,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    // Seed cadence config if missing
    try { await db.seedDefaultCadenceConfig(user.id); } catch {}

    // Get user's own tasks (no entity sharing)
    const tasks = await db.getTasksForUser(user.id, []);
    const eligible = tasks.filter(t =>
      !t.completed && t.dueDate && t.dueDate >= today
    );

    console.log(`[backfill] User ${user.username} (${user.id}): ${eligible.length} eligible tasks out of ${tasks.length} total`);

    for (const task of eligible) {
      try {
        await db.scheduleTaskAlerts(
          user.id,
          task.id,
          task.title,
          task.dueDate,
          task.dueTime || null,
          task.priority || 'medium',
          userTz,
        );
        totalScheduled++;
        console.log(`  ✓ ${task.title} (due ${task.dueDate}${task.dueTime ? ' ' + task.dueTime : ''}, ${task.priority})`);
      } catch (err) {
        totalSkipped++;
        console.error(`  ✗ ${task.title}: ${err.message}`);
      }
    }
  }

  // Show what was inserted
  const { rows } = await db.pool.query(
    `SELECT id, user_id, task_id, message, channels, fire_at, fired
     FROM scheduled_alerts WHERE fired = FALSE ORDER BY fire_at ASC LIMIT 20`
  );
  console.log(`\n[backfill] Done. Scheduled: ${totalScheduled}, Skipped: ${totalSkipped}`);
  console.log(`[backfill] Unfired alerts in DB: ${rows.length}`);
  for (const r of rows) {
    console.log(`  id=${r.id} fire_at=${r.fire_at} channels=${JSON.stringify(r.channels)} msg="${r.message.slice(0, 60)}..."`);
  }

  process.exit(0);
}

backfill().catch(err => {
  console.error('[backfill] Fatal:', err.message);
  process.exit(1);
});
