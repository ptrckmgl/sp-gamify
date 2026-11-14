(function () {
  'use strict';

  const PLUGIN_ID = 'sp-gamify';
  const STATE_KEY = 'state';
  const SETTINGS_KEY = 'settings';
  const REMINDER_SECRET_KEY = 'lastReminderDay'; // local to this device, never synced
  const CHECK_INTERVAL_MS = 2 * 60 * 1000;
  const KEEP_DAYS = 90; // daily summaries and overdue-penalty records
  // Per-task and per-habit-day reward records only need to outlive the
  // uncheck-to-undo window. Keeping them short keeps the synced state small
  // (the app caps one plugin data key at 256 KB).
  const UNDO_WINDOW_DAYS = 7;
  const HABIT_PENALTY_KEEP_DAYS = 14; // missed-day checks look back at most 7 days
  const STATE_SOFT_LIMIT = 200 * 1024;
  const MAX_MISSED_LOOKBACK_DAYS = 7;
  // Combo: tasks finished close together earn a growing bonus
  const COMBO_WINDOW_MS = 30 * 60 * 1000;
  const COMBO_START = 3; // bonus begins on this task of the combo
  const COMBO_STEP = 5;
  const COMBO_CAP = 20;
  const MAX_FREEZES = 2; // streak freezes you can hold
  const FREEZE_EVERY = 7; // earn one at every 7th streak day

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
    reminderEnabled: false,
    reminderTime: '20:00',
    reminderDevices: 'all', // 'all' | 'mobile'
    celebrate: true, // show a dialog on level-up
  };
  const GOAL_UNITS = { tasks: 'tasks', minutes: 'min', xp: 'XP' };

  let timerId = null;
  let queue = Promise.resolve();
  let saveErrorShown = false;

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

  function diffDays(a, b) {
    const [ay, am, ad] = a.split('-').map(Number);
    const [by, bm, bd] = b.split('-').map(Number);
    return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
  }

  function levelFromXp(xp) {
    let level = 1;
    while (50 * (level + 1) * level <= xp) level++;
    return level;
  }

  // Rank names shown next to the level (icons are Material icon names)
  const RANKS = [
    { min: 1, name: 'Novice', icon: 'eco' },
    { min: 3, name: 'Apprentice', icon: 'hiking' },
    { min: 5, name: 'Adventurer', icon: 'explore' },
    { min: 8, name: 'Veteran', icon: 'shield' },
    { min: 12, name: 'Champion', icon: 'emoji_events' },
    { min: 17, name: 'Master', icon: 'workspace_premium' },
    { min: 23, name: 'Legend', icon: 'auto_awesome' },
    { min: 30, name: 'Mythic', icon: 'diamond' },
  ];
  function rankFor(level) {
    let r = RANKS[0];
    for (const x of RANKS) if (level >= x.min) r = x;
    return r;
  }

  // Achievements. Metadata is duplicated in index.html for display.
  const FOCUS_DAY_MINUTES = 240;
  const BADGES = [
    { id: 'tasks-1', name: 'First step', icon: 'task_alt', test: (s) => s.stats.tasks >= 1 },
    { id: 'tasks-10', name: 'Ten down', icon: 'checklist', test: (s) => s.stats.tasks >= 10 },
    { id: 'tasks-50', name: 'Fifty strong', icon: 'done_all', test: (s) => s.stats.tasks >= 50 },
    { id: 'tasks-100', name: 'Centurion', icon: 'military_tech', test: (s) => s.stats.tasks >= 100 },
    { id: 'tasks-500', name: 'Task titan', icon: 'workspace_premium', test: (s) => s.stats.tasks >= 500 },
    { id: 'streak-3', name: 'Warming up', icon: 'local_fire_department', test: (s) => s.bestStreak >= 3 },
    { id: 'streak-7', name: 'Week warrior', icon: 'whatshot', test: (s) => s.bestStreak >= 7 },
    { id: 'streak-30', name: 'Month master', icon: 'calendar_month', test: (s) => s.bestStreak >= 30 },
    { id: 'streak-100', name: 'Unbreakable', icon: 'diamond', test: (s) => s.bestStreak >= 100 },
    { id: 'habit-7', name: 'Habit formed', icon: 'repeat', test: (s) => s.stats.bestHabitStreak >= 7 },
    { id: 'level-5', name: 'Level 5', icon: 'trending_up', test: (s) => levelFromXp(s.totalXp) >= 5 },
    { id: 'level-10', name: 'Level 10', icon: 'rocket_launch', test: (s) => levelFromXp(s.totalXp) >= 10 },
    { id: 'level-20', name: 'Level 20', icon: 'stars', test: (s) => levelFromXp(s.totalXp) >= 20 },
    { id: 'level-30', name: 'Level 30', icon: 'auto_awesome', test: (s) => levelFromXp(s.totalXp) >= 30 },
    { id: 'early-bird', name: 'Early bird', icon: 'wb_twilight', test: (s) => !!s.stats.earlyBird },
    { id: 'night-owl', name: 'Night owl', icon: 'bedtime', test: (s) => !!s.stats.nightOwl },
    { id: 'focus-day', name: 'Deep focus', icon: 'timer', test: (s) => !!s.stats.focusDay },
  ];

  // Marks newly earned badges on the state and returns them (never removes any)
  function unlockBadges(state, today) {
    const fresh = [];
    for (const b of BADGES) {
      if (state.badges[b.id]) continue;
      if (b.test(state)) {
        state.badges[b.id] = today;
        fresh.push(b);
      }
    }
    return fresh;
  }

  function announceBadges(fresh) {
    if (!fresh.length) return;
    PluginAPI.showSnack({
      msg: (fresh.length === 1 ? 'Badge unlocked: ' : 'Badges unlocked: ') + fresh.map((b) => b.name).join(', '),
      type: 'SUCCESS',
      ico: fresh[0].icon,
    });
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
      badges: {},
      stats: {},
      freezes: 0,
      quests: null,
      combo: null,
      awardedAm: {},
    };
    try {
      const raw = await PluginAPI.loadSyncedData(STATE_KEY);
      if (raw) Object.assign(base, JSON.parse(raw));
    } catch (e) {
      PluginAPI.log.warn('[Gamify] could not read state', e);
    }
    base.stats = Object.assign(
      { tasks: 0, bestHabitStreak: 0, earlyBird: false, nightOwl: false, focusDay: false },
      base.stats
    );
    return base;
  }

  function dayEntry(state, today) {
    if (!state.days[today]) {
      state.days[today] = { xp: 0, lost: 0, tasks: 0, goalMet: false };
    }
    return state.days[today];
  }

  function pruneMap(map, cutoff) {
    for (const k of Object.keys(map || {})) {
      if (map[k] < cutoff) delete map[k];
    }
  }

  function prune(state, today, undoDays) {
    const cutoff = addDays(today, -KEEP_DAYS);
    for (const k of Object.keys(state.days)) {
      if (k < cutoff) delete state.days[k];
    }
    // Overdue records stay long so the same task is never penalised twice
    pruneMap(state.penalized, cutoff);
    pruneMap(state.habitPenalized, addDays(today, -HABIT_PENALTY_KEEP_DAYS));
    const undoCutoff = addDays(today, -(undoDays === undefined ? UNDO_WINDOW_DAYS : undoDays));
    pruneMap(state.awarded, undoCutoff);
    pruneMap(state.habitAwarded, undoCutoff);
    for (const [xpMap, dayMap] of [[state.awardedXp, state.awarded], [state.habitAwardedXp, state.habitAwarded], [state.awardedAm, state.awarded]]) {
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
      const fresh = unlockBadges(state, day.todayStr);
      prune(state, day.todayStr);
      let json = JSON.stringify(state);
      if (json.length > STATE_SOFT_LIMIT) {
        // Very heavy use: keep only today's reward records so saving keeps working
        prune(state, day.todayStr, 0);
        json = JSON.stringify(state);
      }
      await PluginAPI.persistDataSynced(json, STATE_KEY);
      saveErrorShown = false;
      announceBadges(fresh);
      return result;
    });
    queue = run.catch(() => {});
    return run.catch((err) => {
      PluginAPI.log.err('[Gamify] state update failed', err);
      if (!saveErrorShown) {
        saveErrorShown = true;
        PluginAPI.showSnack({ msg: 'Gamify could not save your progress. Check the console for details.', type: 'ERROR' });
      }
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

  async function levelUpSnack(level) {
    const rank = rankFor(level);
    const newRank = rank.name !== rankFor(level - 1).name;
    try {
      const settings = await loadSettings();
      if (settings.celebrate && typeof PluginAPI.openDialog === 'function') {
        PluginAPI.openDialog({
          title: 'Level up!',
          htmlContent:
            '<div style="text-align:center;padding:8px 0">' +
            '<span class="material-icons" style="font-size:56px">' + rank.icon + '</span>' +
            '<div style="font-size:40px;font-weight:700;line-height:1.2">Level ' + level + '</div>' +
            '<div style="font-size:16px;margin-top:4px">' + rank.name +
            (newRank ? ' (new rank!)' : '') + '</div></div>',
          buttons: [{ label: 'Keep going', color: 'primary', raised: true }],
        });
        return;
      }
    } catch (e) {
      PluginAPI.log.warn('[Gamify] level-up dialog failed', e);
    }
    PluginAPI.showSnack({
      msg: 'Level up! You reached level ' + level + (newRank ? ' - new rank: ' + rank.name : ' (' + rank.name + ')') + '.',
      type: 'SUCCESS',
      ico: newRank ? rank.icon : 'military_tech',
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

      const nowMs = Date.now();
      const comboCount = s.combo && nowMs - s.combo.lastAt <= COMBO_WINDOW_MS ? s.combo.count + 1 : 1;
      s.combo = { count: comboCount, lastAt: nowMs };
      if (comboCount >= COMBO_START) {
        xp += Math.min(COMBO_CAP, COMBO_STEP * (comboCount - COMBO_START + 1));
        parts.push('combo x' + comboCount);
      }

      const levelBefore = levelFromXp(s.totalXp);
      s.awarded[taskId] = day.todayStr;
      s.awardedXp[taskId] = xp;
      s.stats.tasks += 1;
      const hour = new Date().getHours();
      if (hour < 12) s.awardedAm[taskId] = true;
      if (hour < 9 && hour >= 4) s.stats.earlyBird = true;
      if (hour >= 22 || hour < 4) s.stats.nightOwl = true;
      s.totalXp += xp;
      const e = dayEntry(s, day.todayStr);
      e.xp += xp;
      e.tasks += 1;
      if (hour < 12) e.amTasks = (e.amTasks || 0) + 1;
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
    await evaluateQuests();
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
        s.stats.bestHabitStreak = Math.max(s.stats.bestHabitStreak, streak);
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
      e.habits = (e.habits || 0) + gains.length;
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

      const reverse = (dayStr, xp, isTask, taskId) => {
        const x = Math.min(s.totalXp, xp);
        s.totalXp -= x;
        lost += x;
        count++;
        const e = s.days[dayStr];
        if (e) {
          e.xp = Math.max(0, e.xp - xp);
          if (isTask) e.tasks = Math.max(0, e.tasks - 1);
          else e.habits = Math.max(0, (e.habits || 0) - 1);
          if (isTask && s.awardedAm[taskId]) e.amTasks = Math.max(0, (e.amTasks || 0) - 1);
        }
        if (isTask) s.stats.tasks = Math.max(0, s.stats.tasks - 1);
        // Undoing a task also steps the combo back, so toggling can't inflate it
        if (isTask && s.combo) s.combo.count = Math.max(0, s.combo.count - 1);
      };

      for (const id of Object.keys(s.awarded)) {
        const t = byId[id];
        if (!t || t.isDone) continue; // deleted/archived tasks keep their XP
        const stored = s.awardedXp[id];
        reverse(s.awarded[id], typeof stored === 'number' ? stored : (t.parentId ? XP.SUBTASK : XP.TASK), true, id);
        delete s.awarded[id];
        delete s.awardedXp[id];
        delete s.awardedAm[id];
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

      // Quests that are no longer met give their XP back (and can be earned again)
      const qe = s.days[today];
      if (s.quests && s.quests.day === today && qe) {
        for (const q of s.quests.list) {
          if (!q.done || questProgress(q, qe, minutes) >= q.target) continue;
          q.done = false;
          const x = Math.min(s.totalXp, q.xp);
          s.totalXp -= x;
          lost += x;
          qe.xp = Math.max(0, qe.xp - q.xp);
          if (s.quests.bonusPaid) {
            s.quests.bonusPaid = false;
            const b = Math.min(s.totalXp, QUEST_ALL_BONUS);
            s.totalXp -= b;
            lost += b;
            qe.xp = Math.max(0, qe.xp - QUEST_ALL_BONUS);
          }
        }
      }

      // Today's goal may no longer be met: take the streak day back
      const e = s.days[today];
      if (e && e.goalMet && goalProgress(settings, e, minutes) < settings.goalTarget) {
        e.goalMet = false;
        // Hand back a freeze spent today, and take back one earned today
        if (e.freezeUsed) s.freezes = Math.min(MAX_FREEZES, s.freezes + e.freezeUsed);
        if (e.freezeEarned) s.freezes = Math.max(0, s.freezes - 1);
        e.freezeUsed = 0;
        e.freezeEarned = false;
        if (s.lastGoalDay === today) {
          if (e.prevStreak !== undefined) {
            // Restore exactly what it was before today's goal was counted
            s.streak = e.prevStreak;
            s.lastGoalDay = e.prevLastGoalDay;
          } else {
            s.streak = Math.max(0, s.streak - 1);
            s.lastGoalDay = s.streak > 0 ? addDays(today, -1) : null;
          }
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

  // ---------- daily quests ----------
  const QUEST_XP = 15; // per quest
  const QUEST_ALL_BONUS = 15; // extra when all of the day's quests are done
  const QUESTS_PER_DAY = 3;

  function seededRandom(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeQuests(today, habitCount) {
    const rnd = seededRandom(today);
    const types = ['tasks', 'minutes', 'morning'];
    if (habitCount > 0) types.push('habits');
    for (let i = types.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [types[i], types[j]] = [types[j], types[i]];
    }
    return types.slice(0, QUESTS_PER_DAY).map((type) => {
      let target = 1;
      if (type === 'tasks') target = [2, 3, 4][Math.floor(rnd() * 3)];
      if (type === 'minutes') target = [20, 30, 45][Math.floor(rnd() * 3)];
      if (type === 'habits') target = Math.min(habitCount, [1, 2][Math.floor(rnd() * 2)]);
      return { type, target, xp: QUEST_XP, done: false };
    });
  }

  function questText(q) {
    if (q.type === 'tasks') return 'Finish ' + q.target + ' tasks';
    if (q.type === 'minutes') return 'Track ' + q.target + ' minutes';
    if (q.type === 'habits') return 'Complete ' + q.target + (q.target === 1 ? ' habit' : ' habits');
    return 'Finish a task before noon';
  }

  function questProgress(q, e, minutes) {
    if (q.type === 'tasks') return e.tasks || 0;
    if (q.type === 'minutes') return minutes;
    if (q.type === 'habits') return e.habits || 0;
    return e.amTasks || 0;
  }

  async function evaluateQuests() {
    const day = await getDay();
    const tasks = await PluginAPI.getTasks();
    const minutes = minutesTrackedOn(tasks, day.todayStr);
    const appState = await getAppStateSafe();
    const habitCount = enabledHabits(appState).length;

    const result = await modifyState(async (s, d) => {
      const today = d.todayStr;
      let changed = false;
      if (!s.quests || s.quests.day !== today) {
        s.quests = { day: today, list: makeQuests(today, habitCount), bonusPaid: false };
        changed = true;
      }
      const e = dayEntry(s, today);
      const done = [];
      let gained = 0;
      for (const q of s.quests.list) {
        if (q.done || questProgress(q, e, minutes) < q.target) continue;
        q.done = true;
        gained += q.xp;
        done.push(questText(q));
      }
      if (!s.quests.bonusPaid && s.quests.list.every((q) => q.done)) {
        s.quests.bonusPaid = true;
        gained += QUEST_ALL_BONUS;
        done.push('all quests done');
      }
      if (!gained) return changed ? { silent: true } : false;
      const levelBefore = levelFromXp(s.totalXp);
      s.totalXp += gained;
      e.xp += gained;
      const levelAfter = levelFromXp(s.totalXp);
      return { gained, done, levelUp: levelAfter > levelBefore, level: levelAfter };
    });

    if (!result || result.silent) return;
    PluginAPI.showSnack({
      msg: '+' + result.gained + ' XP: quest done (' + result.done.join(', ') + ')',
      type: 'SUCCESS',
      ico: 'flag',
    });
    if (result.levelUp) levelUpSnack(result.level);
  }

  // ---------- daily goal and main streak ----------
  async function evaluateGoal() {
    const settings = await loadSettings();
    const day = await getDay();
    const tasks = await PluginAPI.getTasks();
    const minutes = minutesTrackedOn(tasks, day.todayStr);

    const result = await modifyState(async (s, d) => {
      const today = d.todayStr;
      const e = dayEntry(s, today);
      let statChanged = false;
      if (minutes >= FOCUS_DAY_MINUTES && !s.stats.focusDay) {
        s.stats.focusDay = true;
        statChanged = true;
      }
      if (e.goalMet || goalProgress(settings, e, minutes) < settings.goalTarget) {
        return statChanged ? { statOnly: true } : false;
      }

      e.goalMet = true;
      let used = 0;
      let earned = false;
      if (s.lastGoalDay !== today) {
        e.prevLastGoalDay = s.lastGoalDay;
        e.prevStreak = s.streak;
        const missed = s.lastGoalDay ? diffDays(today, s.lastGoalDay) - 1 : 0;
        if (s.lastGoalDay && missed === 0) {
          s.streak += 1;
        } else if (s.lastGoalDay && missed > 0 && missed <= s.freezes) {
          // Freezes cover the missed days; the streak carries on without counting them
          s.freezes -= missed;
          used = missed;
          s.streak += 1;
        } else {
          s.streak = 1;
        }
        s.lastGoalDay = today;
        s.bestStreak = Math.max(s.bestStreak, s.streak);
        if (s.streak % FREEZE_EVERY === 0 && s.freezes < MAX_FREEZES) {
          s.freezes += 1;
          earned = true;
        }
        e.freezeUsed = used;
        e.freezeEarned = earned;
      }
      return { streak: s.streak, used, earned };
    });

    if (result && !result.statOnly) {
      PluginAPI.showSnack({
        msg:
          'Daily goal reached! Streak: ' + result.streak + ' day' + (result.streak === 1 ? '' : 's') + '.' +
          (result.used ? ' ' + result.used + ' freeze' + (result.used === 1 ? '' : 's') + ' saved your streak.' : '') +
          (result.earned ? ' You earned a streak freeze.' : ''),
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
      await evaluateQuests();
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

  // React quickly when a task or habit counter changes; the interval is the fallback.
  // Runs right away on the first action, then once more shortly after in case the
  // app state had not settled yet. Neither run is postponed by later actions.
  const NOISY_ACTION = /timespent|timetracking|tick/i; // fire constantly while tracking
  const FOLLOW_UP_MS = 800;
  let quickRunning = false;
  let quickAgain = false;
  let followUpTimer = null;

  async function quickCheck() {
    if (quickRunning) {
      quickAgain = true;
      return;
    }
    quickRunning = true;
    try {
      await revertUndone();
      await checkHabits();
      await evaluateQuests();
      await evaluateGoal();
    } catch (e) {
      PluginAPI.log.err('[Gamify] quick check failed', e);
    } finally {
      quickRunning = false;
      if (quickAgain) {
        quickAgain = false;
        quickCheck();
      }
    }
  }

  PluginAPI.registerHook(PluginAPI.Hooks.ACTION, ({ action }) => {
    if (!action || typeof action.type !== 'string') return;
    if (NOISY_ACTION.test(action.type)) return;
    if (action.type.indexOf('SimpleCounter') === -1 && action.type.indexOf('Task') === -1) return;
    quickCheck();
    if (!followUpTimer) {
      followUpTimer = setTimeout(() => {
        followUpTimer = null;
        quickCheck();
      }, FOLLOW_UP_MS);
    }
  });

  // On phones the app does not show the side panel button in the header, so add
  // our own. Desktop already has one from the manifest, so skip it there.
  const platform = PluginAPI.cfg && PluginAPI.cfg.platform;
  if (platform === 'android' || platform === 'ios') {
    PluginAPI.registerHeaderButton({
      id: 'open-gamify',
      label: 'Gamify',
      icon: 'military_tech',
      onClick: () => {
        PluginAPI.showIndexHtmlAsView();
      },
    });
  }

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
      clearTimeout(followUpTimer);
      timerId = null;
    });
  }
})();
