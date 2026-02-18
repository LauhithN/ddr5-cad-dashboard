const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const rand = (min, max) => Math.random() * (max - min) + min;
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const formatSeconds = (ms) => `${(ms / 1000).toFixed(3)}s`;
const formatDate = (ts) =>
  new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

class TimerBag {
  constructor() {
    this.timeouts = new Set();
    this.intervals = new Set();
    this.frames = new Set();
  }

  timeout(fn, ms) {
    const id = setTimeout(() => {
      this.timeouts.delete(id);
      fn();
    }, ms);
    this.timeouts.add(id);
    return id;
  }

  interval(fn, ms) {
    const id = setInterval(fn, ms);
    this.intervals.add(id);
    return id;
  }

  frame(fn) {
    const handle = { id: 0 };
    const loop = (ts) => {
      fn(ts);
      handle.id = requestAnimationFrame(loop);
    };
    handle.id = requestAnimationFrame(loop);
    this.frames.add(handle);
    return handle;
  }

  clear() {
    this.timeouts.forEach((id) => clearTimeout(id));
    this.intervals.forEach((id) => clearInterval(id));
    this.frames.forEach((handle) => cancelAnimationFrame(handle.id));
    this.timeouts.clear();
    this.intervals.clear();
    this.frames.clear();
  }
}

class PremiumStore {
  constructor(namespace = "reaction-lab-elite") {
    this.namespace = namespace;
    this.history = this.read("history", {});
    this.leaderboard = this.read("leaderboard", {});
    this.achievements = this.read("achievements", {});
  }

  key(suffix) {
    return `${this.namespace}:${suffix}`;
  }

  read(suffix, fallback) {
    try {
      const raw = localStorage.getItem(this.key(suffix));
      if (!raw) {
        return fallback;
      }
      return JSON.parse(raw);
    } catch (_error) {
      return fallback;
    }
  }

  write(suffix, value) {
    try {
      localStorage.setItem(this.key(suffix), JSON.stringify(value));
    } catch (_error) {
      // Ignore storage failures in private mode.
    }
  }

  getHistory(gameId) {
    const values = this.history[gameId];
    return Array.isArray(values) ? values : [];
  }

  addHistory(gameId, score) {
    const updated = [...this.getHistory(gameId), score].slice(-120);
    this.history[gameId] = updated;
    this.write("history", this.history);
  }

  getLeaderboard(gameId) {
    const values = this.leaderboard[gameId];
    return Array.isArray(values) ? values : [];
  }

  recordLeaderboard(gameId, entry, lowerIsBetter) {
    const all = [...this.getLeaderboard(gameId), entry];
    all.sort((a, b) => (lowerIsBetter ? a.score - b.score : b.score - a.score));
    const rank = all.findIndex((item) => item.id === entry.id) + 1;
    this.leaderboard[gameId] = all.slice(0, 5);
    this.write("leaderboard", this.leaderboard);
    return rank;
  }

  unlockAchievements(candidates) {
    const unlocked = [];
    candidates.forEach((candidate) => {
      if (!candidate || !candidate.id || this.achievements[candidate.id]) {
        return;
      }
      const record = {
        ...candidate,
        at: Date.now(),
      };
      this.achievements[candidate.id] = record;
      unlocked.push(record);
    });

    if (unlocked.length > 0) {
      this.write("achievements", this.achievements);
    }

    return unlocked;
  }

  getAchievementsForGame(gameId) {
    return Object.values(this.achievements)
      .filter((item) => item.gameId === gameId)
      .sort((a, b) => b.at - a.at);
  }
}

const computePercentile = (history, score, lowerIsBetter) => {
  if (!history.length) {
    return 50;
  }

  let better = 0;
  history.forEach((past) => {
    if (lowerIsBetter) {
      if (score < past) {
        better += 1;
      } else if (score === past) {
        better += 0.5;
      }
    } else if (score > past) {
      better += 1;
    } else if (score === past) {
      better += 0.5;
    }
  });

  return Math.round(clamp((better / history.length) * 100, 1, 99));
};

class BaseGame {
  constructor(ctx) {
    this.ctx = ctx;
    this.stage = null;
    this.hintEl = null;
    this.running = false;
    this.finished = false;
    this.timers = new TimerBag();

    this.score = 0;
    this.round = 0;
    this.combo = 0;
    this.penalties = 0;
  }

  mount(stage) {
    this.stage = stage;
  }

  start() {
    this.running = true;
    this.finished = false;
  }

  stop() {
    this.running = false;
    this.timers.clear();
  }

  reset() {
    this.stop();
    this.finished = false;
    this.score = 0;
    this.round = 0;
    this.combo = 0;
    this.penalties = 0;
    this.updateHud();
  }

  destroy() {
    this.stop();
    if (this.stage) {
      this.stage.innerHTML = "";
    }
  }

  updateHud() {
    this.ctx.updateHud({
      score: Math.round(this.score),
      round: this.round,
      combo: this.combo,
      penalties: this.penalties,
    });
  }

  setHint(text) {
    if (this.hintEl) {
      this.hintEl.textContent = text;
    }
  }

  setStatus(text, tone = "neutral") {
    this.ctx.setStatus(text, tone);
  }

  nextRound() {
    this.round += 1;
    this.updateHud();
  }

  conclude(result) {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.running = false;
    this.timers.clear();
    this.ctx.onGameComplete(result);
  }

  handleInput(_event) {}
}

class PrecisionLadderGame extends BaseGame {
  constructor(ctx) {
    super(ctx);
    this.roundConfigs = [
      { targetMs: 2300, windowMs: 220 },
      { targetMs: 2550, windowMs: 170 },
      { targetMs: 2800, windowMs: 130 },
      { targetMs: 3100, windowMs: 95 },
      { targetMs: 3400, windowMs: 70 },
    ];

    this.currentRoundIndex = 0;
    this.awaitingTap = false;
    this.roundStartedAt = 0;
    this.totalError = 0;
    this.roundResults = [];

    this.timerEl = null;
    this.targetEl = null;
    this.roundsEl = null;
  }

  mount(stage) {
    super.mount(stage);
    stage.innerHTML = `
      <div class="ladder-board">
        <div class="ladder-display">
          <p class="ladder-time" id="ladderTime">0.000s</p>
          <p class="ladder-target" id="ladderTarget">5 rounds. Windows tighten every round.</p>
        </div>
        <div class="ladder-rounds" id="ladderRounds"></div>
        <div class="stage-hint" id="ladderHint">Tap once per round as close to the target as possible.</div>
      </div>
    `;

    this.timerEl = stage.querySelector("#ladderTime");
    this.targetEl = stage.querySelector("#ladderTarget");
    this.roundsEl = stage.querySelector("#ladderRounds");
    this.hintEl = stage.querySelector("#ladderHint");

    this.reset();
  }

  reset() {
    super.reset();
    this.currentRoundIndex = 0;
    this.awaitingTap = false;
    this.roundStartedAt = 0;
    this.totalError = 0;
    this.roundResults = new Array(this.roundConfigs.length).fill(null);

    if (this.timerEl) {
      this.timerEl.textContent = "0.000s";
    }
    if (this.targetEl) {
      this.targetEl.textContent = "Press Start Run. 5 rounds, tighter targets each round.";
    }

    this.renderRoundChips();
    this.setHint("Score is total error. Lower is better.");
    this.setStatus("Precision setup ready", "neutral");
  }

  start() {
    if (this.running) {
      return;
    }
    super.start();

    this.score = 0;
    this.round = 0;
    this.combo = 0;
    this.penalties = 0;
    this.currentRoundIndex = 0;
    this.totalError = 0;
    this.roundResults = new Array(this.roundConfigs.length).fill(null);
    this.renderRoundChips();
    this.updateHud();

    this.timers.frame(() => {
      if (!this.running || !this.awaitingTap || !this.timerEl) {
        return;
      }
      const elapsed = performance.now() - this.roundStartedAt;
      this.timerEl.textContent = formatSeconds(elapsed);
    });

    this.openRound();
  }

  renderRoundChips() {
    if (!this.roundsEl) {
      return;
    }

    this.roundsEl.innerHTML = this.roundConfigs
      .map((config, idx) => {
        const result = this.roundResults[idx];
        const statusClass = result ? (result.within ? "good" : "bad") : "";
        const body = result
          ? `${result.error}ms`
          : `${(config.targetMs / 1000).toFixed(2)}s ±${config.windowMs}ms`;

        return `
          <div class="ladder-chip ${statusClass}">
            <strong>Round ${idx + 1}</strong>
            <span>${body}</span>
          </div>
        `;
      })
      .join("");
  }

  openRound() {
    if (!this.running) {
      return;
    }

    if (this.currentRoundIndex >= this.roundConfigs.length) {
      this.finishRun();
      return;
    }

    const config = this.roundConfigs[this.currentRoundIndex];
    this.nextRound();
    this.awaitingTap = true;
    this.roundStartedAt = performance.now();

    this.targetEl.textContent = `Round ${this.currentRoundIndex + 1}: target ${(config.targetMs / 1000).toFixed(
      2
    )}s, perfect window ±${config.windowMs}ms`;
    this.setHint("One tap decides the round.");
    this.setStatus(`Round ${this.currentRoundIndex + 1} live`, "neutral");
  }

  handleInput(event) {
    if (!this.running || event.type !== "tap") {
      return;
    }

    if (!this.awaitingTap) {
      this.penalties += 1;
      this.combo = 0;
      this.updateHud();
      this.setStatus("No active round to tap", "bad");
      return;
    }

    const config = this.roundConfigs[this.currentRoundIndex];
    const elapsed = performance.now() - this.roundStartedAt;
    const error = Math.round(Math.abs(elapsed - config.targetMs));
    const within = error <= config.windowMs;

    this.awaitingTap = false;
    this.totalError += error;
    this.score = Math.round(this.totalError);

    this.roundResults[this.currentRoundIndex] = {
      error,
      within,
      targetMs: config.targetMs,
    };

    if (this.timerEl) {
      this.timerEl.textContent = formatSeconds(elapsed);
    }

    if (within) {
      this.combo += 1;
      this.setStatus(`Round ${this.currentRoundIndex + 1}: ${error}ms error`, "good");
    } else {
      this.combo = 0;
      this.penalties += 1;
      this.setStatus(`Round ${this.currentRoundIndex + 1}: ${error}ms off`, "bad");
    }

    this.renderRoundChips();
    this.updateHud();

    this.currentRoundIndex += 1;
    this.timers.timeout(() => this.openRound(), 850);
  }

  finishRun() {
    const results = this.roundResults.filter(Boolean);
    const totalError = Math.round(this.totalError);
    const averageError = results.length
      ? Math.round(results.reduce((sum, entry) => sum + entry.error, 0) / results.length)
      : 0;
    const bestError = results.length
      ? Math.min(...results.map((entry) => entry.error))
      : 0;
    const inWindow = results.filter((entry) => entry.within).length;
    const lastRound = results[results.length - 1];

    const achievements = [];
    if (inWindow === 5) {
      achievements.push({
        id: "precision_ladder_clean_sheet",
        title: "Clean Sheet",
        description: "Hit all 5 rounds inside the tightening target windows.",
      });
    }
    if (totalError <= 420) {
      achievements.push({
        id: "precision_ladder_sub420",
        title: "Sub-420 Engineer",
        description: "Finish Precision Ladder with 420ms total error or lower.",
      });
    }
    if (lastRound && lastRound.error <= 30) {
      achievements.push({
        id: "precision_ladder_clutch30",
        title: "Clutch 30",
        description: "Land the final round within 30ms error.",
      });
    }

    this.conclude({
      score: totalError,
      scoreLabel: "Total Error",
      scoreUnit: "ms",
      lowerIsBetter: true,
      summary: `${inWindow}/5 rounds in-window | Avg ${averageError}ms | Best ${bestError}ms`,
      shareText: `Precision Ladder complete: ${totalError}ms total error (${inWindow}/5 in-window).`,
      achievements,
    });
  }
}

class FlashGauntletGame extends BaseGame {
  constructor(ctx) {
    super(ctx);

    this.palette = [
      { name: "Coral", hex: "#ff8f78", text: "#2a1409" },
      { name: "Sky", hex: "#7ac9ff", text: "#051a28" },
      { name: "Lime", hex: "#b8f667", text: "#132506" },
      { name: "Amber", hex: "#ffc877", text: "#291805" },
      { name: "Orchid", hex: "#d49cff", text: "#20093a" },
    ];

    this.durationMs = 32000;
    this.endAt = 0;
    this.flashActive = false;
    this.flashToken = 0;
    this.currentFlash = null;

    this.targetColor = null;
    this.streak = 0;
    this.bestStreak = 0;
    this.multiplier = 1;
    this.peakMultiplier = 1;
    this.hits = 0;
    this.targetsShown = 0;
    this.decoysShown = 0;

    this.targetEl = null;
    this.timerEl = null;
    this.arenaEl = null;
    this.labelEl = null;
    this.fillEl = null;
  }

  mount(stage) {
    super.mount(stage);
    stage.innerHTML = `
      <div class="gauntlet-board">
        <div class="gauntlet-head">
          <div class="gauntlet-target" id="gauntletTarget">Target: --</div>
          <div class="gauntlet-timer" id="gauntletTimer">32.0s</div>
        </div>
        <div class="gauntlet-arena" id="gauntletArena">
          <span id="gauntletLabel">Standby</span>
        </div>
        <div class="gauntlet-meter">
          <div class="gauntlet-fill" id="gauntletFill"></div>
        </div>
        <div class="stage-hint" id="gauntletHint">Tap only on the assigned target color. Decoys are expensive.</div>
      </div>
    `;

    this.targetEl = stage.querySelector("#gauntletTarget");
    this.timerEl = stage.querySelector("#gauntletTimer");
    this.arenaEl = stage.querySelector("#gauntletArena");
    this.labelEl = stage.querySelector("#gauntletLabel");
    this.fillEl = stage.querySelector("#gauntletFill");
    this.hintEl = stage.querySelector("#gauntletHint");

    this.reset();
  }

  reset() {
    super.reset();
    this.flashActive = false;
    this.flashToken = 0;
    this.currentFlash = null;

    this.endAt = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.multiplier = 1;
    this.peakMultiplier = 1;
    this.hits = 0;
    this.targetsShown = 0;
    this.decoysShown = 0;

    this.targetColor = pick(this.palette);
    this.paintTarget();

    if (this.timerEl) {
      this.timerEl.textContent = "32.0s";
    }
    if (this.fillEl) {
      this.fillEl.style.width = "100%";
    }

    this.clearArena();
    this.setHint("Timed gauntlet. Build streaks, avoid decoys, avoid false starts.");
    this.setStatus("Gauntlet setup ready", "neutral");
  }

  paintTarget() {
    if (!this.targetEl || !this.targetColor) {
      return;
    }

    this.targetEl.textContent = `Target: ${this.targetColor.name}`;
    this.targetEl.style.background = this.targetColor.hex;
    this.targetEl.style.color = this.targetColor.text;
  }

  clearArena() {
    if (!this.arenaEl || !this.labelEl) {
      return;
    }

    this.arenaEl.classList.remove("target", "decoy");
    this.arenaEl.style.background = "rgba(10, 28, 39, 0.94)";
    this.labelEl.textContent = "Standby";
    this.labelEl.style.color = "rgba(226, 247, 255, 0.9)";
  }

  start() {
    if (this.running) {
      return;
    }
    super.start();

    this.score = 0;
    this.round = 0;
    this.combo = 0;
    this.penalties = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.multiplier = 1;
    this.peakMultiplier = 1;
    this.hits = 0;
    this.targetsShown = 0;
    this.decoysShown = 0;

    this.flashToken += 1;
    this.targetColor = pick(this.palette);
    this.paintTarget();
    this.clearArena();
    this.updateHud();

    this.endAt = performance.now() + this.durationMs;
    this.setStatus("Gauntlet live", "neutral");

    this.timers.interval(() => this.tickClock(), 40);
    this.scheduleNextFlash(320);
  }

  tickClock() {
    if (!this.running) {
      return;
    }

    const remaining = Math.max(0, this.endAt - performance.now());
    const progress = remaining / this.durationMs;

    if (this.timerEl) {
      this.timerEl.textContent = `${(remaining / 1000).toFixed(1)}s`;
    }
    if (this.fillEl) {
      this.fillEl.style.width = `${Math.round(progress * 100)}%`;
    }

    if (remaining <= 0) {
      this.finishRun();
    }
  }

  scheduleNextFlash(baseDelay = null) {
    if (!this.running) {
      return;
    }

    const remaining = Math.max(0, this.endAt - performance.now());
    const progress = 1 - remaining / this.durationMs;
    const delay =
      baseDelay !== null
        ? baseDelay
        : randInt(Math.round(260 - progress * 50), Math.round(620 - progress * 170));

    this.timers.timeout(() => this.spawnFlash(), clamp(delay, 140, 650));
  }

  spawnFlash() {
    if (!this.running) {
      return;
    }

    this.nextRound();

    const remaining = Math.max(0, this.endAt - performance.now());
    const progress = 1 - remaining / this.durationMs;
    const showMs = Math.round(clamp(270 - progress * 80, 170, 270));
    const targetChance = clamp(0.24 - progress * 0.04, 0.18, 0.24);

    const isTarget = Math.random() < targetChance;
    const color =
      isTarget
        ? this.targetColor
        : pick(this.palette.filter((entry) => entry.name !== this.targetColor.name));

    this.flashToken += 1;
    const token = this.flashToken;

    this.flashActive = true;
    this.currentFlash = {
      isTarget,
      color,
      shownAt: performance.now(),
      windowMs: showMs,
      handled: false,
    };

    if (isTarget) {
      this.targetsShown += 1;
    } else {
      this.decoysShown += 1;
    }

    this.arenaEl.classList.add(isTarget ? "target" : "decoy");
    this.arenaEl.classList.remove(isTarget ? "decoy" : "target");
    this.arenaEl.style.background = color.hex;
    this.labelEl.textContent = isTarget ? "TARGET" : "DECOY";
    this.labelEl.style.color = color.text;

    this.timers.timeout(() => {
      if (!this.running || token !== this.flashToken || !this.currentFlash) {
        return;
      }

      if (this.currentFlash.isTarget && !this.currentFlash.handled) {
        this.registerPenalty("Missed target flash", 110);
      }

      this.flashActive = false;
      this.currentFlash = null;
      this.clearArena();
      this.scheduleNextFlash();
    }, showMs);
  }

  registerPenalty(message, deduction = 85) {
    this.score = Math.max(0, this.score - deduction);
    this.penalties += 1;
    this.combo = 0;
    this.streak = 0;
    this.multiplier = 1;
    this.updateHud();
    this.setStatus(message, "bad");
  }

  handleInput(event) {
    if (!this.running || event.type !== "tap") {
      return;
    }

    if (!this.flashActive || !this.currentFlash) {
      this.registerPenalty("False start tap", 80);
      return;
    }

    if (this.currentFlash.handled) {
      this.registerPenalty("Already resolved this flash", 60);
      return;
    }

    this.currentFlash.handled = true;

    if (this.currentFlash.isTarget) {
      const rt = performance.now() - this.currentFlash.shownAt;
      const reactionBonus = Math.round(
        clamp((this.currentFlash.windowMs - rt) / this.currentFlash.windowMs, 0, 1) * 75
      );

      this.hits += 1;
      this.streak += 1;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      this.multiplier = clamp(1 + Math.floor((this.streak - 1) / 3), 1, 4);
      this.peakMultiplier = Math.max(this.peakMultiplier, this.multiplier);
      this.combo = this.streak;

      const points = Math.round((100 + reactionBonus) * this.multiplier);
      this.score += points;
      this.updateHud();
      this.setStatus(`+${points} (x${this.multiplier})`, "good");
    } else {
      this.registerPenalty("Tapped decoy flash", 95);
    }
  }

  finishRun() {
    const accuracy = this.targetsShown > 0 ? this.hits / this.targetsShown : 0;

    const achievements = [];
    if (this.bestStreak >= 10) {
      achievements.push({
        id: "flash_gauntlet_streak10",
        title: "Heat Stack x10",
        description: "Reach a 10-hit streak in Flash Gauntlet.",
      });
    }
    if (this.penalties === 0) {
      achievements.push({
        id: "flash_gauntlet_flawless",
        title: "Flawless Filter",
        description: "Finish Flash Gauntlet with zero penalties.",
      });
    }
    if (this.score >= 3200) {
      achievements.push({
        id: "flash_gauntlet_3200",
        title: "Gauntlet 3200",
        description: "Score at least 3200 points in Flash Gauntlet.",
      });
    }
    if (accuracy >= 0.85 && this.targetsShown >= 10) {
      achievements.push({
        id: "flash_gauntlet_sniper",
        title: "Sniper Vision",
        description: "Hit 85%+ target flashes with at least 10 targets shown.",
      });
    }

    this.conclude({
      score: Math.round(this.score),
      scoreLabel: "Gauntlet Score",
      scoreUnit: "pts",
      lowerIsBetter: false,
      summary: `Targets ${this.hits}/${this.targetsShown} | Best streak ${this.bestStreak} | Peak x${this.peakMultiplier}`,
      shareText: `Flash Gauntlet complete: ${Math.round(this.score)} pts (${this.hits}/${this.targetsShown} targets, peak x${this.peakMultiplier}).`,
      achievements,
    });
  }
}

class DuelAccuracyProGame extends BaseGame {
  constructor(ctx) {
    super(ctx);

    this.roundPlan = [
      { zoneWidth: 24, durationMs: 1900 },
      { zoneWidth: 22, durationMs: 1800 },
      { zoneWidth: 20, durationMs: 1700 },
      { zoneWidth: 18, durationMs: 1600 },
      { zoneWidth: 16, durationMs: 1500 },
      { zoneWidth: 14, durationMs: 1400 },
      { zoneWidth: 12, durationMs: 1300 },
    ];

    this.roundIndex = 0;
    this.phase = "idle";
    this.phaseToken = 0;
    this.sweepRaf = 0;
    this.sweepStartedAt = 0;

    this.zoneStart = 0;
    this.zoneEnd = 0;
    this.zoneCenter = 0;
    this.cursorPos = 0;

    this.roundOutcomes = [];
    this.hits = 0;
    this.falseStarts = 0;
    this.bestStreak = 0;

    this.metaEl = null;
    this.lightEl = null;
    this.trackEl = null;
    this.zoneEl = null;
    this.cursorEl = null;
    this.logEl = null;
  }

  mount(stage) {
    super.mount(stage);
    stage.innerHTML = `
      <div class="duel-board">
        <div class="duel-head">
          <div class="duel-meta" id="duelMeta">Round 1 / ${this.roundPlan.length}</div>
          <div class="duel-light wait" id="duelLight">WAIT</div>
        </div>
        <div class="duel-track" id="duelTrack">
          <div class="duel-zone" id="duelZone"></div>
          <div class="duel-cursor" id="duelCursor"></div>
        </div>
        <div class="duel-log" id="duelLog"></div>
        <div class="stage-hint" id="duelHint">Wait for GO, then tap inside the moving target zone.</div>
      </div>
    `;

    this.metaEl = stage.querySelector("#duelMeta");
    this.lightEl = stage.querySelector("#duelLight");
    this.trackEl = stage.querySelector("#duelTrack");
    this.zoneEl = stage.querySelector("#duelZone");
    this.cursorEl = stage.querySelector("#duelCursor");
    this.logEl = stage.querySelector("#duelLog");
    this.hintEl = stage.querySelector("#duelHint");

    this.reset();
  }

  stop() {
    super.stop();
    if (this.sweepRaf) {
      cancelAnimationFrame(this.sweepRaf);
      this.sweepRaf = 0;
    }
  }

  reset() {
    super.reset();

    this.roundIndex = 0;
    this.phase = "idle";
    this.phaseToken += 1;
    this.sweepStartedAt = 0;

    this.zoneStart = 0;
    this.zoneEnd = 0;
    this.zoneCenter = 0;
    this.cursorPos = 0;

    this.roundOutcomes = new Array(this.roundPlan.length).fill(null);
    this.hits = 0;
    this.falseStarts = 0;
    this.bestStreak = 0;

    this.setLight("WAIT");
    this.updateMeta();
    this.renderLog();
    this.paintLane();
    this.setHint("7 rounds. Zone narrows each round, cumulative scoring.");
    this.setStatus("Duel setup ready", "neutral");
  }

  start() {
    if (this.running) {
      return;
    }
    super.start();

    this.score = 0;
    this.round = 0;
    this.combo = 0;
    this.penalties = 0;
    this.roundIndex = 0;
    this.roundOutcomes = new Array(this.roundPlan.length).fill(null);
    this.hits = 0;
    this.falseStarts = 0;
    this.bestStreak = 0;
    this.updateHud();
    this.renderLog();

    this.launchRound();
  }

  setLight(mode) {
    if (!this.lightEl) {
      return;
    }

    this.lightEl.textContent = mode;
    this.lightEl.classList.remove("wait", "go");
    this.lightEl.classList.add(mode === "GO" ? "go" : "wait");
  }

  updateMeta() {
    if (!this.metaEl) {
      return;
    }

    const displayRound = Math.min(this.roundIndex + 1, this.roundPlan.length);
    this.metaEl.textContent = `Round ${displayRound} / ${this.roundPlan.length}`;
  }

  paintLane() {
    if (!this.zoneEl || !this.cursorEl) {
      return;
    }

    this.zoneEl.style.left = `${this.zoneStart}%`;
    this.zoneEl.style.width = `${Math.max(0, this.zoneEnd - this.zoneStart)}%`;
    this.cursorEl.style.left = `${this.cursorPos}%`;
  }

  renderLog() {
    if (!this.logEl) {
      return;
    }

    this.logEl.innerHTML = this.roundOutcomes
      .map((outcome, idx) => {
        if (!outcome) {
          return `<div class="duel-round-chip">R${idx + 1}</div>`;
        }

        const cls = outcome.hit ? "hit" : "miss";
        return `<div class="duel-round-chip ${cls}">${outcome.label}</div>`;
      })
      .join("");
  }

  launchRound() {
    if (!this.running) {
      return;
    }

    if (this.roundIndex >= this.roundPlan.length) {
      this.finishRun();
      return;
    }

    const config = this.roundPlan[this.roundIndex];

    this.updateMeta();
    this.nextRound();
    this.phase = "arming";
    this.phaseToken += 1;

    this.zoneStart = randInt(8, Math.round(88 - config.zoneWidth));
    this.zoneEnd = this.zoneStart + config.zoneWidth;
    this.zoneCenter = this.zoneStart + config.zoneWidth / 2;
    this.cursorPos = 0;
    this.paintLane();

    this.setLight("WAIT");
    this.setHint(`Round ${this.roundIndex + 1}: wait for GO. Zone width ${config.zoneWidth}%.`);
    this.setStatus(`Round ${this.roundIndex + 1} armed`, "neutral");

    const token = this.phaseToken;
    const delay = randInt(650, 1600);

    this.timers.timeout(() => {
      if (!this.running || this.phase !== "arming" || token !== this.phaseToken) {
        return;
      }

      this.phase = "sweep";
      this.sweepStartedAt = performance.now();
      this.currentDuration = config.durationMs;
      this.setLight("GO");
      this.setStatus("GO", "good");
      this.animateSweep(token);
    }, delay);
  }

  animateSweep(token) {
    if (this.sweepRaf) {
      cancelAnimationFrame(this.sweepRaf);
      this.sweepRaf = 0;
    }

    const tick = () => {
      if (!this.running || this.phase !== "sweep" || token !== this.phaseToken) {
        return;
      }

      const elapsed = performance.now() - this.sweepStartedAt;
      const progress = clamp(elapsed / this.currentDuration, 0, 1);
      this.cursorPos = progress * 100;
      this.paintLane();

      if (progress >= 1) {
        this.resolveRound({ type: "miss" });
        return;
      }

      this.sweepRaf = requestAnimationFrame(tick);
    };

    this.sweepRaf = requestAnimationFrame(tick);
  }

  handleInput(event) {
    if (!this.running || event.type !== "tap") {
      return;
    }

    if (this.phase === "arming") {
      this.resolveRound({ type: "false_start" });
      return;
    }

    if (this.phase !== "sweep") {
      return;
    }

    const inside = this.cursorPos >= this.zoneStart && this.cursorPos <= this.zoneEnd;

    if (inside) {
      const distance = Math.abs(this.cursorPos - this.zoneCenter);
      const halfWidth = Math.max(0.001, (this.zoneEnd - this.zoneStart) / 2);
      const precision = clamp(1 - distance / halfWidth, 0, 1);
      const reactionRatio = clamp(
        (performance.now() - this.sweepStartedAt) / this.currentDuration,
        0,
        1
      );
      const speedFactor = 1 - reactionRatio;

      const points = Math.round(120 + precision * 110 + speedFactor * 50 + this.combo * 12);
      this.resolveRound({ type: "hit", points, precision });
      return;
    }

    this.resolveRound({ type: "miss_tap" });
  }

  resolveRound(outcome) {
    if (!this.running || this.phase === "resolved") {
      return;
    }

    if (this.sweepRaf) {
      cancelAnimationFrame(this.sweepRaf);
      this.sweepRaf = 0;
    }

    const currentRound = this.roundIndex + 1;
    this.phase = "resolved";

    if (outcome.type === "false_start") {
      this.falseStarts += 1;
      this.penalties += 1;
      this.combo = 0;
      this.score = Math.max(0, this.score - 90);
      this.roundOutcomes[this.roundIndex] = { hit: false, label: "FS" };
      this.setStatus(`Round ${currentRound}: false start`, "bad");
      this.setHint("You tapped before GO.");
    } else if (outcome.type === "hit") {
      this.hits += 1;
      this.combo += 1;
      this.bestStreak = Math.max(this.bestStreak, this.combo);
      this.score += outcome.points;
      const precisionPct = Math.round(outcome.precision * 100);
      this.roundOutcomes[this.roundIndex] = {
        hit: true,
        label: `+${outcome.points}`,
        precision: precisionPct,
      };
      this.setStatus(`Round ${currentRound}: +${outcome.points}`, "good");
      this.setHint(`Precision ${precisionPct}% in-zone.`);
    } else {
      const deduction = outcome.type === "miss_tap" ? 75 : 60;
      this.penalties += 1;
      this.combo = 0;
      this.score = Math.max(0, this.score - deduction);
      this.roundOutcomes[this.roundIndex] = { hit: false, label: "MISS" };
      this.setStatus(`Round ${currentRound}: miss`, "bad");
      this.setHint("Outside zone or too late.");
    }

    this.updateHud();
    this.renderLog();
    this.roundIndex += 1;

    this.timers.timeout(() => this.launchRound(), 760);
  }

  finishRun() {
    const precisionValues = this.roundOutcomes
      .filter((entry) => entry && entry.hit && typeof entry.precision === "number")
      .map((entry) => entry.precision);

    const averagePrecision = precisionValues.length
      ? Math.round(
          precisionValues.reduce((sum, precision) => sum + precision, 0) / precisionValues.length
        )
      : 0;

    const achievements = [];
    if (this.falseStarts === 0) {
      achievements.push({
        id: "duel_accuracy_no_false_start",
        title: "Cold Trigger Discipline",
        description: "Finish Duel Accuracy Pro with zero false starts.",
      });
    }
    if (this.hits >= 5) {
      achievements.push({
        id: "duel_accuracy_five_hits",
        title: "Five-Hit Duelist",
        description: "Land at least 5 successful hits in a single duel set.",
      });
    }
    if (this.bestStreak >= 3) {
      achievements.push({
        id: "duel_accuracy_triple_chain",
        title: "Triple Chain",
        description: "String together 3 consecutive hit rounds.",
      });
    }
    if (this.score >= 1200) {
      achievements.push({
        id: "duel_accuracy_1200",
        title: "Duel 1200",
        description: "Score at least 1200 points in Duel Accuracy Pro.",
      });
    }

    this.conclude({
      score: Math.round(this.score),
      scoreLabel: "Duel Score",
      scoreUnit: "pts",
      lowerIsBetter: false,
      summary: `Hits ${this.hits}/${this.roundPlan.length} | Avg precision ${averagePrecision}% | Best streak ${this.bestStreak}`,
      shareText: `Duel Accuracy Pro complete: ${Math.round(this.score)} pts (${this.hits}/${
        this.roundPlan.length
      } hits, avg precision ${averagePrecision}%).`,
      achievements,
    });
  }
}

class GameController {
  constructor() {
    this.dom = {
      gameList: document.getElementById("gameList"),
      gameTitle: document.getElementById("gameTitle"),
      gameBlurb: document.getElementById("gameBlurb"),
      recommendationBadge: document.getElementById("recommendationBadge"),
      helpText: document.getElementById("helpText"),
      startBtn: document.getElementById("startBtn"),
      resetBtn: document.getElementById("resetBtn"),
      actionBtn: document.getElementById("actionBtn"),
      statusPill: document.getElementById("statusPill"),
      stage: document.getElementById("stage"),
      hudScore: document.getElementById("hudScore"),
      hudRound: document.getElementById("hudRound"),
      hudCombo: document.getElementById("hudCombo"),
      hudPenalties: document.getElementById("hudPenalties"),
      setupCard: document.getElementById("setupCard"),
      leaderboardList: document.getElementById("leaderboardList"),
      achievementList: document.getElementById("achievementList"),
      countdownOverlay: document.getElementById("countdownOverlay"),
      countdownValue: document.getElementById("countdownValue"),
      resultOverlay: document.getElementById("resultOverlay"),
      resultTitle: document.getElementById("resultTitle"),
      resultScore: document.getElementById("resultScore"),
      resultSummary: document.getElementById("resultSummary"),
      resultPercentile: document.getElementById("resultPercentile"),
      resultLeaderboard: document.getElementById("resultLeaderboard"),
      shareBtn: document.getElementById("shareBtn"),
      replayBtn: document.getElementById("replayBtn"),
    };

    this.store = new PremiumStore();

    this.registry = [
      {
        id: "precision-ladder",
        name: "Precision Ladder",
        blurb:
          "Five stopwatch-style rounds where target windows tighten every round and your score is total timing error.",
        help: "Tap once per round as close as possible to the target time.",
        accent: "#65ddff",
        warm: "#ffb470",
        setupTitle: "Premium Differentiators",
        setupCopy:
          "A fixed 5-round ladder with progressively smaller timing windows. This mode rewards consistency under rising pressure.",
        setupList: [
          "Round windows tighten from ±220ms down to ±70ms.",
          "Final score is total error (lower is better).",
          "In-window streaks are tracked for clutch stability.",
          "Leaderboard is sorted by the lowest aggregate error.",
        ],
        factory: (ctx) => new PrecisionLadderGame(ctx),
      },
      {
        id: "flash-gauntlet",
        name: "Flash Gauntlet",
        blurb:
          "Timed color-filter gauntlet with heavy decoy pressure, streak multipliers, and aggressive false-start penalties.",
        help: "Tap only when the target color flashes. Ignore decoys.",
        accent: "#6ae4ff",
        warm: "#ffc474",
        setupTitle: "Premium Differentiators",
        setupCopy:
          "32-second score attack with rising pace, denser decoys, and multiplier scaling tied to sustained clean streaks.",
        setupList: [
          "High decoy ratio creates continuous visual pressure.",
          "Streak multiplier scales from x1 to x4.",
          "False starts and decoy taps reset streak and deduct score.",
          "Leaderboard ranks highest point totals.",
        ],
        factory: (ctx) => new FlashGauntletGame(ctx),
      },
      {
        id: "duel-accuracy-pro",
        name: "Duel Accuracy Pro",
        blurb:
          "Seven-round duel where target zones shift and narrow while cumulative score tracks precision and decision control.",
        help: "Wait for GO, then tap inside the moving zone.",
        accent: "#74f0c6",
        warm: "#ffbd7b",
        setupTitle: "Premium Differentiators",
        setupCopy:
          "Each round changes zone width and pacing, demanding both trigger discipline and precise in-zone execution.",
        setupList: [
          "7 rounds with shrinking zone widths and faster sweeps.",
          "False starts are penalized before GO appears.",
          "Round points combine precision, speed, and streak depth.",
          "Leaderboard ranks cumulative duel score.",
        ],
        factory: (ctx) => new DuelAccuracyProGame(ctx),
      },
    ];

    this.currentMeta = null;
    this.currentGame = null;
    this.countdownToken = 0;
    this.lastShareText = "";

    this.renderGameList();
    this.wireControls();
  }

  renderGameList() {
    this.dom.gameList.innerHTML = this.registry
      .map(
        (game) => `
          <button class="game-card" data-game-id="${game.id}">
            <strong>${game.name}</strong>
            <span>${game.blurb}</span>
          </button>
        `
      )
      .join("");

    this.dom.gameList.querySelectorAll(".game-card").forEach((button) => {
      button.addEventListener("click", () => {
        this.selectGame(button.dataset.gameId || "");
      });
    });

    this.selectGame(this.registry[0].id);
  }

  setTheme(accent, warm) {
    document.documentElement.style.setProperty("--accent", accent);
    document.documentElement.style.setProperty("--accent-warm", warm);
  }

  selectGame(gameId) {
    const meta = this.registry.find((entry) => entry.id === gameId);
    if (!meta) {
      return;
    }

    this.countdownToken += 1;

    if (this.currentGame) {
      this.currentGame.destroy();
    }

    this.dom.gameList.querySelectorAll(".game-card").forEach((card) => {
      card.classList.toggle("active", card.dataset.gameId === gameId);
    });

    this.currentMeta = meta;
    this.setTheme(meta.accent, meta.warm);

    this.dom.gameTitle.textContent = meta.name;
    this.dom.gameBlurb.textContent = meta.blurb;
    this.dom.helpText.innerHTML = `${meta.help} <strong>Tap only</strong> gameplay; press <strong>Space</strong> or tap the action button.`;
    this.dom.recommendationBadge.textContent = "Premium Tier Active";

    this.renderSetupCard(meta);

    const ctx = {
      updateHud: (payload) => this.updateHud(payload),
      setStatus: (text, tone) => this.setStatus(text, tone),
      onGameComplete: (payload) => this.handleGameComplete(payload),
    };

    this.currentGame = meta.factory(ctx);
    this.currentGame.mount(this.dom.stage);

    this.dom.startBtn.textContent = "Start Run";
    this.hideCountdown();
    this.hideResult();

    this.updateHud({ score: 0, round: 0, combo: 0, penalties: 0 });
    this.renderLeaderboard();
    this.renderAchievements();
  }

  renderSetupCard(meta) {
    this.dom.setupCard.innerHTML = `
      <h3 class="setup-title">${meta.setupTitle}</h3>
      <p class="setup-copy">${meta.setupCopy}</p>
      <ul class="setup-list">
        ${meta.setupList.map((item) => `<li>${item}</li>`).join("")}
      </ul>
    `;
  }

  renderLeaderboard() {
    if (!this.currentMeta) {
      return;
    }

    const list = this.store.getLeaderboard(this.currentMeta.id);

    if (!list.length) {
      this.dom.leaderboardList.innerHTML = `<li class="empty-state">No runs yet. Finish a session to seed leaderboard data.</li>`;
      return;
    }

    this.dom.leaderboardList.innerHTML = list
      .map((entry, idx) => {
        const scoreText = this.formatScore(entry.score, entry.scoreUnit);
        return `<li>#${idx + 1} ${scoreText} <span>(${formatDate(entry.at)})</span></li>`;
      })
      .join("");
  }

  renderAchievements() {
    if (!this.currentMeta) {
      return;
    }

    const items = this.store.getAchievementsForGame(this.currentMeta.id).slice(0, 8);

    if (!items.length) {
      this.dom.achievementList.innerHTML = `<li class="empty-state">No unlocks yet. Push streaks and cleaner runs.</li>`;
      return;
    }

    this.dom.achievementList.innerHTML = items
      .map((item) => `<li><strong>${item.title}</strong>: ${item.description}</li>`)
      .join("");
  }

  updateHud({ score = 0, round = 0, combo = 0, penalties = 0 }) {
    this.dom.hudScore.textContent = String(Math.round(score));
    this.dom.hudRound.textContent = String(round);
    this.dom.hudCombo.textContent = String(combo);
    this.dom.hudPenalties.textContent = String(penalties);
  }

  setStatus(text, tone = "neutral") {
    this.dom.statusPill.textContent = text;

    if (tone === "good") {
      this.dom.statusPill.style.borderColor = "rgba(101, 239, 183, 0.58)";
      this.dom.statusPill.style.background = "rgba(101, 239, 183, 0.2)";
      return;
    }

    if (tone === "bad") {
      this.dom.statusPill.style.borderColor = "rgba(255, 121, 121, 0.58)";
      this.dom.statusPill.style.background = "rgba(255, 121, 121, 0.16)";
      return;
    }

    this.dom.statusPill.style.borderColor = "rgba(92, 208, 255, 0.35)";
    this.dom.statusPill.style.background = "rgba(92, 208, 255, 0.14)";
  }

  async startRun() {
    if (!this.currentGame || !this.currentMeta) {
      return;
    }

    this.countdownToken += 1;
    const token = this.countdownToken;

    this.hideResult();

    if (this.currentGame.running) {
      this.currentGame.stop();
    }

    this.currentGame.reset();
    this.dom.startBtn.disabled = true;
    await this.runCountdown(token);

    if (token !== this.countdownToken || !this.currentGame) {
      this.dom.startBtn.disabled = false;
      return;
    }

    this.currentGame.start();
    this.dom.startBtn.disabled = false;
    this.dom.startBtn.textContent = "Restart Run";
  }

  runCountdown(token) {
    return new Promise((resolve) => {
      const sequence = ["3", "2", "1", "GO"];
      let idx = 0;

      this.dom.countdownOverlay.classList.remove("hidden");

      const step = () => {
        if (token !== this.countdownToken) {
          this.hideCountdown();
          resolve();
          return;
        }

        this.dom.countdownValue.textContent = sequence[idx];
        idx += 1;

        if (idx < sequence.length) {
          setTimeout(step, 650);
        } else {
          setTimeout(() => {
            this.hideCountdown();
            resolve();
          }, 320);
        }
      };

      step();
    });
  }

  hideCountdown() {
    this.dom.countdownOverlay.classList.add("hidden");
  }

  hideResult() {
    this.dom.resultOverlay.classList.add("hidden");
  }

  resetGame() {
    this.countdownToken += 1;
    this.hideCountdown();
    this.hideResult();

    if (!this.currentGame) {
      return;
    }

    this.currentGame.reset();
    this.dom.startBtn.textContent = "Start Run";
    this.setStatus("Reset", "neutral");
  }

  tapAction(source = "button") {
    if (!this.currentGame) {
      return;
    }

    this.currentGame.handleInput({ type: "tap", source, key: "space" });
  }

  formatScore(score, unit = "pts") {
    if (unit === "ms") {
      return `${Math.round(score)} ms`;
    }
    return `${Math.round(score)} pts`;
  }

  handleGameComplete(payload) {
    if (!this.currentMeta) {
      return;
    }

    const history = this.store.getHistory(this.currentMeta.id);
    const percentile = computePercentile(history, payload.score, payload.lowerIsBetter);

    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      score: payload.score,
      scoreUnit: payload.scoreUnit || "pts",
      at: Date.now(),
    };

    const rank = this.store.recordLeaderboard(
      this.currentMeta.id,
      entry,
      Boolean(payload.lowerIsBetter)
    );
    this.store.addHistory(this.currentMeta.id, payload.score);

    const achievements = (payload.achievements || []).map((item) => ({
      ...item,
      gameId: this.currentMeta.id,
    }));

    const newlyUnlocked = this.store.unlockAchievements(achievements);

    const scoreText = this.formatScore(payload.score, payload.scoreUnit);
    this.dom.resultTitle.textContent = `${this.currentMeta.name}`;
    this.dom.resultScore.textContent = `${payload.scoreLabel}: ${scoreText}`;

    const unlockText = newlyUnlocked.length
      ? ` New unlocks: ${newlyUnlocked.map((item) => item.title).join(", ")}.`
      : "";

    this.dom.resultSummary.textContent = `${payload.summary}.${unlockText}`;
    this.dom.resultPercentile.textContent = `Percentile: ${percentile}%`;
    this.dom.resultLeaderboard.textContent = `Leaderboard Rank: #${rank}`;

    this.lastShareText =
      payload.shareText ||
      `${this.currentMeta.name}: ${payload.scoreLabel} ${scoreText}, percentile ${percentile}%.`;

    this.dom.resultOverlay.classList.remove("hidden");
    this.dom.startBtn.textContent = "Start Run";

    this.renderLeaderboard();
    this.renderAchievements();
  }

  copyShare() {
    if (!this.lastShareText) {
      return;
    }

    navigator.clipboard
      .writeText(this.lastShareText)
      .then(() => {
        this.setStatus("Share text copied", "good");
      })
      .catch(() => {
        this.setStatus("Clipboard unavailable", "bad");
      });
  }

  wireControls() {
    this.dom.startBtn.addEventListener("click", () => {
      this.startRun();
    });

    this.dom.resetBtn.addEventListener("click", () => {
      this.resetGame();
    });

    this.dom.actionBtn.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.tapAction("button");
    });

    this.dom.shareBtn.addEventListener("click", () => {
      this.copyShare();
    });

    this.dom.replayBtn.addEventListener("click", () => {
      this.startRun();
    });

    window.addEventListener("keydown", (event) => {
      if (event.repeat) {
        return;
      }

      if (event.key === " ") {
        event.preventDefault();
        this.tapAction("keyboard");
      }
    });
  }
}

new GameController();
