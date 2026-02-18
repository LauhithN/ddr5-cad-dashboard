# Premium Trio Simulator Checklist

## Local Run
1. From `/Users/lauhithnatarajan/Documents/games test`, run:
   - `./start-local.command`
   - or `python3 -m http.server 4173`
2. Open `http://127.0.0.1:4173` in simulator/browser.

## Core Flow Validation (all 3 games)
- [ ] Select game from left panel and confirm setup card updates.
- [ ] Press `Start Run` and verify 3-2-1-GO countdown overlay.
- [ ] Use tap button and Space input; both should trigger identical behavior.
- [ ] Confirm result overlay appears at session end.
- [ ] Confirm `Copy Share` copies result text.
- [ ] Confirm `Replay` restarts from countdown.

## Precision Ladder
- [ ] Verify exactly 5 rounds.
- [ ] Confirm target windows shrink each round.
- [ ] Confirm score is cumulative error (lower is better).
- [ ] Confirm off-window taps increase penalties and reset streak.

## Flash Gauntlet
- [ ] Verify timed run lasts ~32 seconds.
- [ ] Confirm high decoy frequency vs target flashes.
- [ ] Confirm streak multiplier ramps (x1 to x4).
- [ ] Confirm false-start taps deduct score and reset streak.

## Duel Accuracy Pro
- [ ] Verify 7 rounds with narrowing target zones.
- [ ] Confirm waiting taps count as false starts.
- [ ] Confirm in-zone taps award precision-weighted points.
- [ ] Confirm misses/late taps apply penalties.

## Premium Stats Hooks
- [ ] Complete a run and verify leaderboard entry appears.
- [ ] Complete better/worse run and verify rank updates correctly.
- [ ] Unlock an achievement and verify it appears in achievements panel.
- [ ] Refresh page and verify leaderboard/achievements persist.

## Balance Pass Knobs
- Precision Ladder:
  - Adjust `targetMs` and `windowMs` in `PrecisionLadderGame.roundConfigs`.
- Flash Gauntlet:
  - Adjust `durationMs`, `targetChance`, and penalty values.
- Duel Accuracy Pro:
  - Adjust `zoneWidth`, `durationMs`, and hit/miss scoring formula.

Target tuning goal: premium should feel measurably harder than base prototypes while preserving a recoverable skill curve.
