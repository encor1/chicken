# Coop Roguelite Next Steps

## Current Direction

The game is moving from a mostly PvP timed shooting gallery toward a fast cooperative arcade roguelite:

- players share long-term run progress
- combat happens in waves
- intermissions become upgrade draft moments
- waves should become harder over time
- boss waves and stronger run identity should come later

The current implementation keeps the existing shooting loop intact and layers the first coop systems onto the existing round structure.

## Implemented First Step

The smallest meaningful step was to reinterpret rounds as coop waves and intermissions as upgrade drafts.

What exists now:

- server-authored coop run state
- accumulated team score
- wave number and difficulty metadata in snapshots
- scaling target budget and speed by wave, tuned to start gently
- upgrade draft during intermission
- client-side upgrade card UI
- player votes for a team upgrade
- team-wide upgrades that persist across the run

Current upgrade prototypes:

- Bigger Mag: increases magazine size for everyone
- Quick Reload: reduces reload duration
- Steady Hands: raises the streak bonus cap
- Powerup Rush: increases the number of active powerups on the range

## Implemented Second Step

The run now has shared failure pressure through server-authored team morale.

What exists now:

- shared team morale in snapshots
- morale damage when hostile targets escape or expire
- heavier morale penalties for giant and royal targets
- bonus targets do not damage morale when missed
- run-over state when morale reaches zero
- client HUD morale meter during active waves
- run-over overlay with an automatic new-run countdown

## Recommended Next Steps

### 1. Add Coop Pressure And Failure

Implemented. Keep tuning morale values and escape penalties as wave pacing changes.

### 2. Add Boss Wave Prototype

Once failure pressure exists, add a simple boss every 4 or 5 waves.

Suggested first boss:

- one large target with high health
- damage is based on successful shots
- boss periodically spawns normal targets or hazards
- wave ends early if the boss is defeated
- team loses morale if the boss survives the timer

Keep this prototype ugly but server-authoritative. The goal is to test pacing, not final presentation.

### 3. Make Upgrades More Roguelite

The current upgrades are team-wide stat modifiers. That is good for proving the loop, but the next version should create sharper choices.

Possible upgrades:

- piercing shots
- explosive final shell
- combo healing or morale recovery
- powerups last longer
- bonus targets grant temporary team buffs
- reload emits a small blast
- boss damage multiplier after streaks

Potential structure:

- keep team-wide voting for now
- add rarity later
- add upgrade tags like `ammo`, `reload`, `powerup`, `boss`, `survival`
- avoid per-player builds until the shared run loop feels good

## Important Tradeoffs

- The old leaderboard still exists as wave contribution. This preserves the current PvP-readable feedback, but the mode is not fully cooperative yet.
- Run state is in memory only. Server restart resets everything.
- Upgrade voting currently resolves ties by option order. That is acceptable for now but should eventually be explicit.
- Run-over currently auto-starts a fresh run after the intermission delay; there is no manual reset, lobby mode selection, or separate PvP mode toggle yet.
- The current target model has no health, which limits boss and elite design.

## Suggested Milestone Order

1. Shared lives/morale and run-over state.
2. Boss target with health and a simple boss wave schedule.
3. Better upgrade catalog with effects that change shooting behavior.
4. Optional mode selection: classic timed PvP vs coop run.
5. Balance pass on wave duration, target budget, powerups, and upgrade strength.
