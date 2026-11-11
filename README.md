# Gamify for Super Productivity

A plugin that adds XP, levels, daily-goal and habit streaks to [Super Productivity](https://super-productivity.com) (v20+).

- XP for tasks, subtasks, tracked time, finishing within estimate and before the due date
- XP for habits (enabled simple counters), with a bonus every 7th streak day
- Penalties for overdue tasks and missed habit days; unchecking a task or habit takes its XP back
- Daily goal (tasks, minutes or XP) with a main streak, plus a streak per habit
- Rank names (Novice to Mythic), 17 achievement badges, daily quests, combo bonus XP and streak freezes
- Level-up dialog (can be turned off), weekly XP chart
- Side panel that follows the app's theme, and an optional streak reminder

## Install

Zip `manifest.json`, `plugin.js` and `index.html` (files at the zip root), then in Super Productivity go to Settings > Plugins > Upload plugin. Plugins are per device, so repeat on each one.

## Preview the panel

```
python -m http.server 8765
```

Open http://localhost:8765/preview.html. It runs `index.html` against a fake plugin API with sample data. It does not exercise `plugin.js`.

## License

MIT, see [LICENSE](LICENSE).
