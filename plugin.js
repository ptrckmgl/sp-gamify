(function () {
  'use strict';

  const PLUGIN_ID = 'sp-gamify';
  const STATE_KEY = 'state';
  const SETTINGS_KEY = 'settings';
  const REMINDER_SECRET_KEY = 'lastReminderDay'; // local to this device, never synced
  const CHECK_INTERVAL_MS = 2 * 60 * 1000;
  const KEEP_DAYS = 90;
  const MAX_MISSED_LOOKBACK_DAYS = 7;

  // Tweak rewards and penalties here
  const XP = {
    TASK: 10,
    SUBTASK: 5,
    PER_5_MIN: 1,
    TIME_CAP: 48,
    WITHIN_ESTIMATE: 15,
    BEFORE_DUE: 10,
    OVERDUE_PENALTY: 10,
    HABIT: 10,
    HABIT_WEEK_BONUS: 20, // extra XP on every 7th day of a habit streak
    HABIT_MISS: 10,
  };

  const DEFAULT_SETTINGS = {
    goalType: 'tasks',
    goalTarget: 5,
    reminderEnabled: true,
    reminderTime: '20:00',
    reminderDevices: 'all', // 'all' | 'mobile'
  };
  const GOAL_UNITS = { tasks: 'tasks', minutes: 'min', xp: 'XP' };

  let timerId = null;
  let habitTimerId = null;
  let queue = Promise.resolve();

  // ---------- helpers ----------
  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function localDateStr(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function addDays(dayStr, n) {
    const [y, m, d] = dayStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + n);
    return localDateStr(dt);
  }

  function levelFromXp(xp) {
    let level = 1;
    while (50 * (level + 1) * level <= xp) level++;
    return level;
  }

  function habitStreak(countOnDay, today) {
    let day = (countOnDay[today] || 0) > 0 ? today : addDays(today, -1);
    let n = 0;
    while ((countOnDay[day] || 0) > 0 && n < 3650) {
      n++;
      day = addDays(day, -1);
    }
    return n;
  }

  function firstActiveDay(countOnDay) {
    const days = Object.keys(countOnDay).filter((k) => countOnDay[k] > 0).sort();
    return days.length ? days[0] : null;
  }

  async function getDay() {
    if (typeof PluginAPI.getDayContext === 'function') {
      try {
        return await PluginAPI.getDayContext();
      } catch (e) {
        PluginAPI.log.warn('[Gamify] getDayContext failed', e);
      }
    }
    return { todayStr: localDateStr(new Date()), startOfNextDayDiffMs: 0 };
  }

  async function loadSettings() {
    try {
      const raw = await PluginAPI.loadSyncedData(SETTINGS_KEY);
      if (raw) return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
    } catch (e) {
      PluginAPI.log.warn('[Gamify] could not read settings', e);
    }
    return Object.assign({}, DEFAULT_SETTINGS);
  }

  async function loadState(today) {
    const base = {
      initialized: false,
      totalXp: 0,
      streak: 0,
      bestStreak: 0,
      lastGoalDay: null,
      createdDay: today,
      days: {},
      awarded: {},
      penalized: {},
      habitsSince: null,
      habitCheckedThrough: null,
      habitAwarded: {},
      habitPenalized: {},
      awardedXp: {}, // XP given per task / habit-day, so an uncheck can take it back
      habitAwardedXp: {},
    };
    try {
      const raw = await PluginAPI.loadSyncedData(STATE_KEY);
      if (raw) return Object.assign(base, JSON.parse(raw));
    } catch (e) {
      PluginAPI.log.warn('[Gamify] could not read state', e);
    }
    return base;
  }

  function dayEntry(state, today) {
    if (!state.days[today]) {
      state.days[today] = { xp: 0, lost: 0, tasks: 0, goalMet: false };
    }
    return state.days[today];
  }

  function prune(state, today) {
    const cutoff = addDays(today, -KEEP_DAYS);
    for (const k of Object.keys(state.days)) {
      if (k < cutoff) delete state.days[k];
    }
    for (const map of [state.awarded, state.penalized, state.habitAwarded, state.habitPenalized]) {
      for (const k of Object.keys(map)) {
        if (map[k] < cutoff) delete map[k];
      }
    }
    for (const [xpMap, dayMap] of [[state.awardedXp, state.awarded], [state.habitAwardedXp, state.habitAwarded]]) {
      for (const k of Object.keys(xpMap || {})) {
        if (!dayMap[k]) delete xpMap[k];
      }
    }
  }

  // Serialises all state writes so they never overwrite each other.
  // The mutator returns false to skip saving.
  function modifyState(mutator) {
    const run = queue.then(async () => {
      const day = await getDay();
      const state = await loadState(day.todayStr);
      const result = await mutator(state, day);
      if (result === false) return null;
      prune(state, day.todayStr);
      await PluginAPI.persistDataSynced(JSON.stringify(state), STATE_KEY);
      return result;
    });
    queue = run.catch(() => {});
    return run.catch((err) => {
      PluginAPI.log.err('[Gamify] state update failed', err);
      return null;
    });
  }

  async function getAppStateSafe() {
    try {
      return await PluginAPI.getAppState();
    } catch (e) {
      PluginAPI.log.err('[Gamify] getAppState failed', e);
      return null;
    }
  }

  function enabledHabits(appState) {
    if (!appState || !appState.simpleCounters) return [];
    return Object.values(appState.simpleCounters).filter((c) => c && c.isEnabled);
  }

  function minutesTrackedOn(tasks, dayStr) {
    let ms = 0;
    for (const t of tasks) {
      // Parents already sum their subtasks' time, so count leaf tasks only
      if (t.subTaskIds && t.subTaskIds.length) continue;
      const v = t.timeSpentOnDay && t.timeSpentOnDay[dayStr];
      if (v) ms += v;
    }
    return Math.floor(ms / 60000);
  }

  function goalProgress(settings, entry, minutes) {
    if (settings.goalType === 'xp') return entry.xp;
    if (settings.goalType === 'minutes') return minutes;
    return entry.tasks;
  }

  function levelUpSnack(level) {
    PluginAPI.showSnack({
      msg: 'Level up! You reached level ' + level + '.',
      type: 'SUCCESS',
      ico: 'military_tech',
    });
  }

  // ---------- task rewards ----------
  async function onTaskComplete(taskId, task) {
    if (!task) return;

    const result = await modifyState(async (s, day) => {
      if (s.awarded[taskId]) return false;

      const isSub = !!task.parentId;
      const isParent = !!(task.subTaskIds && task.subTaskIds.length);
      const parts = [];
      let xp = isSub ? XP.SUBTASK : XP.TASK;
      parts.push(isSub ? 'subtask' : 'task');

      if (!isParent) {
        const minutes = Math.floor((task.timeSpent || 0) / 60000);
        const timeXp = Math.min(XP.TIME_CAP, Math.floor(minutes / 5) * XP.PER_5_MIN);
        if (timeXp > 0) {
          xp += timeXp;
          parts.push(minutes + ' min tracked');
        }
        if (task.timeEstimate > 0 && task.timeSpent > 0 && task.timeSpent <= task.timeEstimate) {
          xp += XP.WITHIN_ESTIMATE;
          parts.push('within estimate');
        }
      }

      let onTime = false;
      if (task.dueWithTime) onTime = Date.now() <= task.dueWithTime;
      else if (task.dueDay) onTime = day.todayStr <= task.dueDay;
      if (onTime && !s.penalized[taskId]) {
        xp += XP.BEFORE_DUE;
        parts.push('before due');
      }

      const levelBefore = levelFromXp(s.totalXp);
      s.awarded[taskId] = day.todayStr;
      s.awardedXp[taskId] = xp;
      s.totalXp += xp;
      const e = dayEntry(s, day.todayStr);
      e.xp += xp;
      e.tasks += 1;
      const levelAfter = levelFromXp(s.totalXp);

      return { xp, parts, levelUp: levelAfter > levelBefore, level: levelAfter };
    });

    if (!result) return;

    PluginAPI.showSnack({
      msg: '+' + result.xp + ' XP (' + result.parts.join(', ') + ')',
      type: 'SUCCESS',
      ico: 'stars',
    });
    if (result.levelUp) levelUpSnack(result.level);
    await evaluateGoal();
  }

  // ---------- habits ----------
  async function checkHabits() {
    const appState = await getAppStateSafe();
    if (!appState) return;
    const habits = enabledHabits(appState);

    const result = await modifyState(async (s, d) => {
      const today = d.todayStr;
      const yesterday = addDays(today, -1);
      if (!s.habitsSince) s.habitsSince = today; // no penalties for days before habits were tracked

      // Rewards for habits done today
      const gains = [];
      for (const c of habits) {
        const cod = c.countOnDay || {};
        if (!((cod[today] || 0) > 0)) continue;
        const key = c.id + '|' + today;
        if (s.habitAwarded[key]) continue;
        s.habitAwarded[key] = today;
        const streak = habitStreak(cod, today);
        let xp = XP.HABIT;
        if (streak > 0 && streak % 7 === 0) xp += XP.HABIT_WEEK_BONUS;
        s.habitAwardedXp[key] = xp;
        gains.push({ title: c.title, xp, streak });
      }

      // Penalties for missed days (only finished days, at most a week back)
      const misses = [];
      let from = s.habitCheckedThrough ? addDays(s.habitCheckedThrough, 1) : s.habitsSince;
      const minFrom = addDays(today, -MAX_MISSED_LOOKBACK_DAYS);
      if (from < minFrom) from = minFrom;
      if (from < s.habitsSince) from = s.habitsSince;

      for (let day = from; day <= yesterday; day = addDays(day, 1)) {
        for (const c of habits) {
          const cod = c.countOnDay || {};
          const first = firstActiveDay(cod);
          if (!first || day < first) continue; // habit not started yet
          if ((cod[day] || 0) > 0) continue;
          const key = c.id + '|' + day;
          if (s.habitPenalized[key]) continue;
          s.habitPenalized[key] = today;
          misses.push({ title: c.title, day });
        }
      }

      const advanced = s.habitCheckedThrough !== yesterday;
      s.habitCheckedThrough = yesterday;
      if (!gains.length && !misses.length && !advanced) return false;

      const e = dayEntry(s, today);
      const levelBefore = levelFromXp(s.totalXp);
      const gained = gains.reduce((sum, g) => sum + g.xp, 0);
      s.totalXp += gained;
      e.xp += gained;
      const lost = Math.min(s.totalXp, misses.length * XP.HABIT_MISS);
      s.totalXp -= lost;
      e.lost += lost;
      const levelAfter = levelFromXp(s.totalXp);

      return { gains, gained, misses, lost, levelUp: levelAfter > levelBefore, level: levelAfter };
    });

    if (!result) return;

    if (result.gains.length) {
      PluginAPI.showSnack({
        msg:
          '+' + result.gained + ' XP: ' +
          result.gains.map((g) => g.title + ' (' + g.streak + '-day streak)').join(', '),
        type: 'SUCCESS',
        ico: 'repeat',
      });
    }
    if (result.misses.length) {
      const titles = Array.from(new Set(result.misses.map((m) => m.title)));
      PluginAPI.showSnack({
        msg: '-' + result.lost + ' XP: missed ' + titles.join(', ') + '. Streak reset.',
        type: 'WARNING',
        ico: 'heart_broken',
      });
    }
    if (result.levelUp) levelUpSnack(result.level);
  }

  // ---------- undo: unchecked tasks and habits ----------
  async function revertUndone() {
    const settings = await loadSettings();
    const day = await getDay();
    const tasks = await PluginAPI.getTasks();
    const appState = await getAppStateSafe();
    if (!appState) return;
    const byId = {};
    for (const t of tasks) byId[t.id] = t;
    const habitById = {};
    for (const c of enabledHabits(appState)) habitById[c.id] = c;
    const minutes = minutesTrackedOn(tasks, day.todayStr);

    const result = await modifyState(async (s, d) => {
      const today = d.todayStr;
      let lost = 0;
      let count = 0;
      const levelBefore = levelFromXp(s.totalXp);

      const reverse = (dayStr, xp, isTask) => {
        const x = Math.min(s.totalXp, xp);
        s.totalXp -= x;
        lost += x;
        count++;
        const e = s.days[dayStr];
        if (e) {
          e.xp = Math.max(0, e.xp - xp);
          if (isTask) e.tasks = Math.max(0, e.tasks - 1);
        }
      };

      for (const id of Object.keys(s.awarded)) {
        const t = byId[id];
        if (!t || t.isDone) continue; // deleted/archived tasks keep their XP
        const stored = s.awardedXp[id];
        reverse(s.awarded[id], typeof stored === 'number' ? stored : (t.parentId ? XP.SUBTASK : XP.TASK), true);
        delete s.awarded[id];
        delete s.awardedXp[id];
      }

      for (const key of Object.keys(s.habitAwarded)) {
        const cut = key.lastIndexOf('|');
        const c = habitById[key.slice(0, cut)];
        if (!c || ((c.countOnDay || {})[key.slice(cut + 1)] || 0) > 0) continue;
        const stored = s.habitAwardedXp[key];
        reverse(key.slice(cut + 1), typeof stored === 'number' ? stored : XP.HABIT, false);
        delete s.habitAwarded[key];
        delete s.habitAwardedXp[key];
      }

      if (!count) return false;

      // Today's goal may no longer be met: take the streak day back
      const e = s.days[today];
      if (e && e.goalMet && goalProgress(settings, e, minutes) < settings.goalTarget) {
        e.goalMet = false;
        if (s.lastGoalDay === today) {
          s.streak = Math.max(0, s.streak - 1);
          s.lastGoalDay = s.streak > 0 ? addDays(today, -1) : null;
        }
      }
      return { lost, count, levelDown: levelFromXp(s.totalXp) < levelBefore };
    });

    if (result && result.lost > 0) {
      PluginAPI.showSnack({
        msg: '-' + result.lost + ' XP: ' + result.count + ' item' + (result.count === 1 ? '' : 's') + ' unchecked.',
        type: 'WARNING',
        ico: 'undo',
      });
    }
  }

  // ---------- daily goal and main streak ----------
  async function evaluateGoal() {
    const settings = await loadSettings();
    const day = await getDay();
    let minutes = 0;
    if (settings.goalType === 'minutes') {
      const tasks = await PluginAPI.getTasks();
      minutes = minutesTrackedOn(tasks, day.todayStr);
    }

    const result = await modifyState(async (s, d) => {
      const today = d.todayStr;
      const e = dayEntry(s, today);
      if (e.goalMet) return false;
      if (goalProgress(settings, e, minutes) < settings.goalTarget) return false;

      e.goalMet = true;
      if (s.lastGoalDay !== today) {
        s.streak = s.lastGoalDay === addDays(today, -1) ? s.streak + 1 : 1;
        s.lastGoalDay = today;
        s.bestStreak = Math.max(s.bestStreak, s.streak);
      }
      return { streak: s.streak };
    });

    if (result) {
      PluginAPI.showSnack({
        msg: 'Daily goal reached! Streak: ' + result.streak + ' day' + (result.streak === 1 ? '' : 's') + '.',
        type: 'SUCCESS',
        ico: 'local_fire_department',
      });
    }
  }

  // ---------- overdue task penalties ----------
  async function checkOverdue() {
    const tasks = await PluginAPI.getTasks();
    const now = Date.now();

    const result = await modifyState(async (s, d) => {
      const today = d.todayStr;
      let count = 0;

      for (const t of tasks) {
        if (t.isDone || s.penalized[t.id]) continue;
        let dueDay = null;
        let overdue = false;
        if (t.dueWithTime) {
          dueDay = localDateStr(new Date(t.dueWithTime - d.startOfNextDayDiffMs));
          overdue = t.dueWithTime < now;
        } else if (t.dueDay) {
          dueDay = t.dueDay;
          overdue = t.dueDay < today;
        }
        // Tasks that were already overdue before the plugin was installed are skipped
        if (!overdue || dueDay < s.createdDay) continue;
        s.penalized[t.id] = today;
        count++;
      }

      if (!count) return false;
      const lost = Math.min(s.totalXp, count * XP.OVERDUE_PENALTY);
      s.totalXp -= lost;
      dayEntry(s, today).lost += lost;
      return { count, lost };
    });

    if (result) {
      PluginAPI.showSnack({
        msg: '-' + result.lost + ' XP: ' + result.count + ' task' + (result.count === 1 ? ' is' : 's are') + ' overdue.',
        type: 'WARNING',
        ico: 'schedule',
      });
    }
  }

  // ---------- streak reminder ----------
  async function maybeRemind() {
    const settings = await loadSettings();
    if (!settings.reminderEnabled) return;

    const platform = PluginAPI.cfg && PluginAPI.cfg.platform;
    if (settings.reminderDevices === 'mobile' && platform !== 'android' && platform !== 'ios') return;

    const [hh, mm] = String(settings.reminderTime || '20:00').split(':').map(Number);
    const now = new Date();
    if (now.getHours() * 60 + now.getMinutes() < hh * 60 + mm) return;

    const day = await getDay();
    const today = day.todayStr;
    let lastDay = null;
    try {
      lastDay = await PluginAPI.getSecret(REMINDER_SECRET_KEY);
    } catch (e) {}
    if (lastDay === today) return;

    const appState = await getAppStateSafe();
    if (!appState) return;
    const state = await loadState(today);
    const entry = state.days[today] || { xp: 0, lost: 0, tasks: 0, goalMet: false };
    const minutes = minutesTrackedOn(Object.values(appState.tasks || {}), today);
    const progress = goalProgress(settings, entry, minutes);

    const missing = [];
    if (!entry.goalMet && progress < settings.goalTarget) {
      missing.push('daily goal (' + progress + '/' + settings.goalTarget + ' ' + GOAL_UNITS[settings.goalType] + ')');
    }
    for (const c of enabledHabits(appState)) {
      if (!(((c.countOnDay || {})[today] || 0) > 0)) missing.push(c.title);
    }

    try {
      await PluginAPI.setSecret(REMINDER_SECRET_KEY, today);
    } catch (e) {}
    if (!missing.length) return;

    await PluginAPI.notify({
      title: 'Keep your streaks alive',
      body: 'Still to do today: ' + missing.join(', '),
    });
  }

  async function runChecks() {
    try {
      await revertUndone();
      await checkOverdue();
      await checkHabits();
      await evaluateGoal();
      await maybeRemind();
    } catch (e) {
      PluginAPI.log.err('[Gamify] check failed', e);
    }
  }

  // ---------- registration ----------
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_COMPLETE, ({ taskId, task }) => {
    onTaskComplete(taskId, task);
  });

  // Tracking stopped or switched: a good moment to check a time-based goal
  PluginAPI.registerHook(PluginAPI.Hooks.CURRENT_TASK_CHANGE, () => {
    evaluateGoal();
  });

  // React quickly when a habit counter is clicked; the interval is the fallback
  PluginAPI.registerHook(PluginAPI.Hooks.ACTION, ({ action }) => {
    if (!action || typeof action.type !== 'string') return;
    if (action.type.indexOf('SimpleCounter') === -1 && action.type.indexOf('Task') === -1) return;
    clearTimeout(habitTimerId);
    habitTimerId = setTimeout(async () => {
      try { await revertUndone(); } catch (e) { PluginAPI.log.err('[Gamify] undo failed', e); }
      await checkHabits();
      await evaluateGoal();
    }, 1500);
  });

  PluginAPI.registerShortcut({
    id: 'open-panel',
    label: 'Open Gamify panel',
    onExec: () => {
      PluginAPI.dispatchAction({ type: '[Layout] Show PluginPanel', pluginId: PLUGIN_ID });
    },
  });

  async function start() {
    await modifyState((s) => {
      if (s.initialized) return false;
      s.initialized = true;
      return true;
    });
    await runChecks();
    timerId = setInterval(runChecks, CHECK_INTERVAL_MS);
  }

  if (typeof PluginAPI.onReady === 'function') {
    PluginAPI.onReady(start);
  } else {
    start();
  }

  if (typeof PluginAPI.onUnload === 'function') {
    PluginAPI.onUnload(() => {
      if (timerId) clearInterval(timerId);
      clearTimeout(habitTimerId);
      timerId = null;
    });
  }
})();
