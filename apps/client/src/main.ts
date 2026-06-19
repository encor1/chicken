import Phaser from "phaser";
import ammoBoxPowerupUrl from "./assets/weapons/ammobox.png";
import grenadePowerupUrl from "./assets/weapons/grenade.png";
import machineGunWeaponUrl from "./assets/weapons/machine-gun.png";
import shotgunWeaponUrl from "./assets/weapons/shotgun.png";
import {
  POWERUP_DURATION_MS,
  POWERUP_TTL_MS,
  RELOAD_DURATION_MS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type ClientMessage,
  type LeaderboardEntry,
  type PlayerSnapshot,
  type PowerupKind,
  type PowerupSnapshot,
  type RoundSnapshot,
  type ServerMessage,
  type ShotEvent,
  type TauntEvent,
  type TargetSnapshot
} from "@game-io/shared";
import "./styles.css";

const SHOTGUN_WEAPON_KEY = "weapon-shotgun";
const MACHINE_GUN_WEAPON_KEY = "weapon-machine-gun";
const AMMO_BOX_POWERUP_KEY = "powerup-ammo-box";
const GRENADE_POWERUP_KEY = "powerup-grenade";

const params = new URLSearchParams(window.location.search);
let playerName = "";

const startScreen = document.querySelector<HTMLFormElement>("#start-screen");
const nameInput = document.querySelector<HTMLInputElement>("#player-name");

if (nameInput) {
  nameInput.value = params.get("name") ?? localStorage.getItem("gallery-name") ?? "";
  nameInput.focus();
}

startScreen?.addEventListener("submit", (event) => {
  event.preventDefault();
  const submittedName = nameInput?.value.trim() ?? "";
  playerName = submittedName.length > 0 ? submittedName : `Player ${Math.floor(Math.random() * 900 + 100)}`;
  localStorage.setItem("gallery-name", playerName);
  startScreen.classList.add("is-hidden");
  startGame();
});

class GalleryScene extends Phaser.Scene {
  private socket: WebSocket | null = null;
  private playerId = "";
  private seq = 0;
  private readonly targets = new Map<string, TargetView>();
  private readonly powerups = new Map<string, PowerupView>();
  private readonly remoteCrosshairs = new Map<string, RemoteCrosshairView>();
  private readonly seenShots = new Set<string>();
  private readonly seenTaunts = new Set<string>();
  private players: PlayerSnapshot[] = [];
  private leaderboardEntries: LeaderboardEntry[] = [];
  private recentHits: string[] = [];
  private statusText!: Phaser.GameObjects.Text;
  private leaderboardText!: Phaser.GameObjects.Text;
  private feedText!: Phaser.GameObjects.Text;
  private recentText!: Phaser.GameObjects.Text;
  private roundPanel!: Phaser.GameObjects.Graphics;
  private roundTitle!: Phaser.GameObjects.Text;
  private roundSubtitle!: Phaser.GameObjects.Text;
  private roundMeta!: Phaser.GameObjects.Text;
  private ammoHud!: AmmoHud;
  private crosshair!: Phaser.GameObjects.Graphics;
  private background!: Phaser.GameObjects.Graphics;
  private sfx!: SoundFx;
  private reloadKey!: Phaser.Input.Keyboard.Key;
  private tauntKey!: Phaser.Input.Keyboard.Key;
  private round: RoundSnapshot | null = null;
  private serverTimeOffset = 0;
  private lastRoundState = "";
  private lastRoundNumber = 0;
  private lastAimSentAt = 0;
  private lastMachineGunSendAt = 0;

  preload() {
    this.load.image(SHOTGUN_WEAPON_KEY, shotgunWeaponUrl);
    this.load.image(MACHINE_GUN_WEAPON_KEY, machineGunWeaponUrl);
    this.load.image(AMMO_BOX_POWERUP_KEY, ammoBoxPowerupUrl);
    this.load.image(GRENADE_POWERUP_KEY, grenadePowerupUrl);
  }

  create() {
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.cameras.main.setZoom(Math.min(window.innerWidth / WORLD_WIDTH, window.innerHeight / WORLD_HEIGHT));
    this.cameras.main.centerOn(WORLD_WIDTH / 2, WORLD_HEIGHT / 2);

    this.background = this.add.graphics();
    this.drawBackground();
    this.sfx = new SoundFx();

    this.statusText = this.add.text(22, 18, "Connecting...", hudStyle(18, "#f5f7fa", "800")).setDepth(80);
    this.leaderboardText = this.add.text(22, 54, "", hudStyle(14, "#e4ecf2", "700")).setDepth(80);
    this.feedText = this.add.text(WORLD_WIDTH - 22, 18, "", hudStyle(14, "#ffdf91", "700")).setOrigin(1, 0).setDepth(80);
    this.recentText = this.add.text(WORLD_WIDTH - 22, 54, "", hudStyle(13, "#f5f7fa", "700")).setOrigin(1, 0).setDepth(80);
    this.roundPanel = this.add.graphics().setDepth(86);
    this.roundTitle = this.add.text(WORLD_WIDTH / 2, 18, "", hudStyle(18, "#fffaf0", "900")).setOrigin(0.5, 0).setDepth(87);
    this.roundSubtitle = this.add.text(WORLD_WIDTH / 2, WORLD_HEIGHT / 2 - 10, "", hudStyle(28, "#ffdf91", "900")).setOrigin(0.5).setDepth(101);
    this.roundMeta = this.add.text(WORLD_WIDTH / 2, WORLD_HEIGHT / 2 + 42, "", hudStyle(18, "#f5f7fa", "800")).setOrigin(0.5).setDepth(101);
    this.ammoHud = new AmmoHud(this, WORLD_WIDTH / 2, WORLD_HEIGHT - 84);

    this.crosshair = this.add.graphics().setDepth(90);
    this.reloadKey = this.input.keyboard!.addKey("R");
    this.tauntKey = this.input.keyboard!.addKey("M");
    this.reloadKey.on("down", () => this.reload());
    this.tauntKey.on("down", () => this.taunt());
    this.input.setDefaultCursor("none");
    this.input.on("pointermove", this.drawCrosshair, this);
    this.input.on("pointerdown", this.shoot, this);

    this.scale.on("resize", this.resizeGame, this);
    this.connect();
  }

  override update(_time: number, delta: number) {
    for (const target of this.targets.values()) {
      target.update(delta);
    }
    for (const powerup of this.powerups.values()) {
      powerup.update(delta);
    }
    for (const crosshair of this.remoteCrosshairs.values()) {
      crosshair.update(delta);
    }

    this.drawCrosshair(this.input.activePointer);
    this.sendAim(this.input.activePointer);
    this.renderRound();
    const local = this.players.find((player) => player.id === this.playerId);
    if (local) {
      const accuracy = local.shots > 0 ? Math.round((local.hits / local.shots) * 100) : 0;
      this.statusText.setText(`${local.name}  score ${local.score}  streak ${local.streak}  ${accuracy}%`);
      this.renderAmmo(local);
      this.fireMachineGunIfHeld(local);
    }
  }

  private connect() {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const isViteDevServer = window.location.port === "5173";
    const host = params.get("server") ?? (isViteDevServer ? `${window.location.hostname}:3000` : window.location.host);
    this.socket = new WebSocket(`${protocol}://${host}/ws`);

    this.socket.addEventListener("open", () => {
      this.statusText.setText("Joining...");
      this.send({ type: "join", name: playerName });
    });

    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data as string) as ServerMessage;
      this.handleMessage(message);
    });

    this.socket.addEventListener("close", () => {
      this.statusText.setText("Disconnected. Refresh to rejoin.");
    });
  }

  private handleMessage(message: ServerMessage) {
    if (message.type === "welcome") {
      this.playerId = message.playerId;
      return;
    }

    this.players = message.players;
    this.leaderboardEntries = message.leaderboard;
    this.serverTimeOffset = message.serverTime - Date.now();
    this.applyRoundSnapshot(message.round);
    this.renderLeaderboard();
    this.syncTargets(message.targets);
    this.syncPowerups(message.powerups);
    this.syncRemoteCrosshairs(message.players);
    this.renderShots(message.shots);
    this.renderTaunts(message.taunts);
  }

  private applyRoundSnapshot(round: RoundSnapshot) {
    const changed = round.number !== this.lastRoundNumber || round.state !== this.lastRoundState;
    this.round = round;

    if (changed && this.lastRoundNumber > 0) {
      if (round.state === "ended") {
        this.sfx.roundEnd();
      } else {
        this.recentHits = [];
        this.recentText.setText("");
        this.seenShots.clear();
        this.seenTaunts.clear();
        this.sfx.roundStart();
      }
    }

    this.lastRoundNumber = round.number;
    this.lastRoundState = round.state;
  }

  private renderRound() {
    if (!this.round) {
      return;
    }

    const now = this.serverNow();
    this.roundPanel.clear();

    if (this.round.state === "active") {
      const remaining = Math.max(0, this.round.endsAt - now);
      this.roundPanel.setDepth(86);
      this.roundTitle.setVisible(true);
      this.roundTitle.setText(`ROUND ${this.round.number}   ${formatClock(remaining)}`);
      this.roundSubtitle.setVisible(false);
      this.roundMeta.setVisible(false);
      this.roundPanel.fillStyle(0x18232c, 0.74);
      this.roundPanel.lineStyle(3, remaining < 10_000 ? 0xf25f5c : 0xffdf91, 0.9);
      this.roundPanel.fillRoundedRect(WORLD_WIDTH / 2 - 122, 12, 244, 40, 8);
      this.roundPanel.strokeRoundedRect(WORLD_WIDTH / 2 - 122, 12, 244, 40, 8);
      return;
    }

    const nextRoundIn = Math.max(0, (this.round.nextRoundStartsAt ?? now) - now);
    const winner = this.round.winner;
    this.roundPanel.setDepth(98);
    this.roundTitle.setVisible(false);
    this.roundSubtitle.setVisible(true);
    this.roundMeta.setVisible(true);
    this.roundSubtitle.setText(winner ? `${winner.name} wins round ${this.round.number}` : `Round ${this.round.number} complete`);
    this.roundMeta.setText(winner ? `${winner.score} points  |  next round in ${Math.ceil(nextRoundIn / 1000)}s` : `Next round in ${Math.ceil(nextRoundIn / 1000)}s`);
    this.roundPanel.fillStyle(0x111820, 0.58);
    this.roundPanel.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.roundPanel.fillStyle(0x18232c, 0.92);
    this.roundPanel.lineStyle(5, 0xffdf91, 0.95);
    this.roundPanel.fillRoundedRect(WORLD_WIDTH / 2 - 330, WORLD_HEIGHT / 2 - 92, 660, 172, 8);
    this.roundPanel.strokeRoundedRect(WORLD_WIDTH / 2 - 330, WORLD_HEIGHT / 2 - 92, 660, 172, 8);
  }

  private serverNow() {
    return Date.now() + this.serverTimeOffset;
  }

  private syncTargets(snapshot: TargetSnapshot[]) {
    const seen = new Set<string>();

    for (const target of snapshot) {
      seen.add(target.id);
      let view = this.targets.get(target.id);
      if (!view) {
        view = new TargetView(this, target);
        this.targets.set(target.id, view);
      }
      view.applySnapshot(target);
    }

    for (const [id, target] of this.targets) {
      if (!seen.has(id)) {
        target.destroy();
        this.targets.delete(id);
      }
    }
  }

  private renderShots(shots: ShotEvent[]) {
    const fresh = shots.filter((shot) => !this.seenShots.has(shot.id));
    for (const shot of fresh) {
      this.seenShots.add(shot.id);
      this.spawnShotFx(shot);
      if (shot.playerId === this.playerId) {
        if (shot.powerupKind) {
          this.sfx.powerup(shot.powerupKind);
        } else if (shot.hit) {
          this.sfx.hit(shot.points);
        } else {
          this.sfx.miss();
        }
      } else if (shot.powerupKind === "nuke") {
        this.sfx.nuke();
      }
      if (shot.powerupKind) {
        this.recentHits.unshift(`${shot.playerName} ${powerupLabel(shot.powerupKind)}${shot.points > 0 ? ` +${shot.points}` : ""}`);
        this.recentHits = this.recentHits.slice(0, 5);
      } else if (shot.hit) {
        this.recentHits.unshift(`${shot.playerName} +${shot.points}`);
        this.recentHits = this.recentHits.slice(0, 5);
      }
    }
    this.recentText.setText(this.recentHits.join("\n"));

    const localHits = fresh.filter((shot) => shot.playerId === this.playerId && shot.hit);
    if (localHits.length > 0) {
      const latest = localHits.at(-1)!;
      this.cameras.main.shake(latest.powerupKind === "nuke" ? 360 : latest.points >= 40 ? 170 : 100, latest.powerupKind === "nuke" ? 0.014 : latest.points >= 40 ? 0.0065 : 0.0038);
      this.feedText.setText(latest.powerupKind ? `${powerupLabel(latest.powerupKind)}${latest.points > 0 ? ` +${latest.points}` : ""}` : `+${latest.points}`);
      this.tweens.add({
        targets: this.feedText,
        alpha: { from: 1, to: 0 },
        y: { from: 18, to: 42 },
        duration: 620,
        ease: "quad.out",
        onComplete: () => {
          this.feedText.setAlpha(1);
          this.feedText.setY(18);
          this.feedText.setText("");
        }
      });
    }
  }

  private spawnShotFx(shot: ShotEvent) {
    const color = shot.powerupKind ? powerupColor(shot.powerupKind) : shot.hit ? colorFromHue(shot.playerHue) : 0xd6e2ea;
    const ring = this.add.circle(shot.x, shot.y, shot.hit ? 18 : 10, color, 0).setStrokeStyle(shot.hit ? 5 : 3, color, 0.95).setDepth(70);
    const label = shot.hit
      ? this.add.text(
          shot.x,
          shot.y - 34,
          shot.powerupKind ? powerupLabel(shot.powerupKind) : `${shot.playerName} +${shot.points}`,
          hudStyle(shot.points >= 40 || shot.powerupKind ? 24 : 18, "#ffdf91", "900")
        ).setOrigin(0.5).setDepth(76)
      : null;

    if (shot.powerupKind === "nuke") {
      this.spawnNukeFx(shot.x, shot.y);
    } else if (shot.powerupKind) {
      this.spawnPowerupBurst(shot.x, shot.y, color);
    } else if (shot.hit) {
      this.spawnHitBurst(shot.x, shot.y, color, shot.points);
      this.spawnFeathers(shot.x, shot.y, shot.points >= 40 ? 30 : 16);
      this.spawnScoreCoins(shot.x, shot.y, shot.points >= 40 ? 9 : 4);
    } else {
      this.spawnMissPuff(shot.x, shot.y);
    }

    this.tweens.add({
      targets: ring,
      radius: shot.hit ? 58 : 22,
      scaleX: shot.hit ? 1.35 : 1,
      alpha: 0,
      duration: shot.hit ? 480 : 300,
      ease: "quad.out",
      onComplete: () => ring.destroy()
    });

    if (label) {
      this.tweens.add({
        targets: label,
        y: label.y - 38,
        scale: { from: 1.25, to: 0.95 },
        alpha: 0,
        duration: 760,
        ease: "quad.out",
        onComplete: () => label.destroy()
      });
    }
  }

  private spawnHitBurst(x: number, y: number, color: number, points: number) {
    const flash = this.add.circle(x, y, points >= 40 ? 38 : 26, 0xfff5c2, 0.92).setDepth(73);
    const sparks = this.add.graphics().setDepth(74);
    const lines = points >= 40 ? 28 : 18;

    sparks.lineStyle(points >= 40 ? 5 : 4, color, 0.98);
    for (let i = 0; i < lines; i += 1) {
      const angle = (Math.PI * 2 * i) / lines + Math.random() * 0.18;
      const inner = points >= 40 ? 18 : 12;
      const outer = points >= 40 ? 104 + Math.random() * 38 : 58 + Math.random() * 24;
      sparks.lineBetween(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner, x + Math.cos(angle) * outer, y + Math.sin(angle) * outer);
    }

    this.tweens.add({
      targets: flash,
      radius: flash.radius * 1.6,
      alpha: 0,
      duration: points >= 40 ? 260 : 190,
      ease: "quad.out",
      onComplete: () => flash.destroy()
    });

    this.tweens.add({
      targets: sparks,
      alpha: 0,
      scale: points >= 40 ? 1.35 : 1.2,
      duration: points >= 40 ? 540 : 390,
      ease: "quad.out",
      onComplete: () => sparks.destroy()
    });
  }

  private spawnFeathers(x: number, y: number, count: number) {
    for (let i = 0; i < count; i += 1) {
      const feather = this.add.ellipse(x, y, 8 + Math.random() * 8, 22 + Math.random() * 16, 0xf7f1dc, 0.95).setDepth(75);
      feather.setStrokeStyle(1, 0xc9bfa8, 0.9);
      feather.rotation = Math.random() * Math.PI;
      const angle = Math.random() * Math.PI * 2;
      const distance = 35 + Math.random() * 95;

      this.tweens.add({
        targets: feather,
        x: x + Math.cos(angle) * distance,
        y: y + Math.sin(angle) * distance + 32,
        rotation: feather.rotation + (Math.random() - 0.5) * 5,
        alpha: 0,
        scale: { from: 1, to: 0.45 },
        duration: 650 + Math.random() * 420,
        ease: "quad.out",
        onComplete: () => feather.destroy()
      });
    }
  }

  private spawnScoreCoins(x: number, y: number, count: number) {
    for (let i = 0; i < count; i += 1) {
      const coin = this.add.circle(x, y, 5 + Math.random() * 4, 0xffdf91, 1).setStrokeStyle(2, 0x8c6239, 1).setDepth(77);
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.2;
      const distance = 44 + Math.random() * 74;
      this.tweens.add({
        targets: coin,
        x: x + Math.cos(angle) * distance,
        y: y + Math.sin(angle) * distance,
        alpha: 0,
        scale: { from: 1.15, to: 0.3 },
        duration: 520 + Math.random() * 300,
        ease: "quad.out",
        onComplete: () => coin.destroy()
      });
    }
  }

  private spawnMissPuff(x: number, y: number) {
    for (let i = 0; i < 5; i += 1) {
      const puff = this.add.circle(x, y, 8 + Math.random() * 9, 0xe7eef2, 0.45).setDepth(65);
      this.tweens.add({
        targets: puff,
        x: x + (Math.random() - 0.5) * 44,
        y: y + (Math.random() - 0.5) * 44,
        radius: puff.radius * 1.7,
        alpha: 0,
        duration: 320,
        ease: "quad.out",
        onComplete: () => puff.destroy()
      });
    }
  }

  private spawnPowerupBurst(x: number, y: number, color: number) {
    const flash = this.add.circle(x, y, 34, color, 0.78).setDepth(74);
    const rays = this.add.graphics().setDepth(75);
    rays.lineStyle(5, color, 0.95);

    for (let i = 0; i < 16; i += 1) {
      const angle = (Math.PI * 2 * i) / 16;
      rays.lineBetween(x + Math.cos(angle) * 18, y + Math.sin(angle) * 18, x + Math.cos(angle) * 82, y + Math.sin(angle) * 82);
    }

    this.tweens.add({
      targets: flash,
      radius: 70,
      alpha: 0,
      duration: 360,
      ease: "quad.out",
      onComplete: () => flash.destroy()
    });
    this.tweens.add({
      targets: rays,
      scale: 1.25,
      alpha: 0,
      duration: 520,
      ease: "quad.out",
      onComplete: () => rays.destroy()
    });
  }

  private spawnNukeFx(x: number, y: number) {
    const flash = this.add.circle(x, y, 80, 0xfff5c2, 0.92).setDepth(94);
    const shockwave = this.add.circle(x, y, 120, 0xf25f5c, 0).setStrokeStyle(12, 0xfff5c2, 0.98).setDepth(93);
    const blast = this.add.graphics().setDepth(92);

    blast.fillStyle(0xf25f5c, 0.24);
    blast.fillCircle(x, y, 540);
    for (let i = 0; i < 46; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 120 + Math.random() * 440;
      const spark = this.add.circle(x, y, 5 + Math.random() * 10, 0xffdf91, 1).setDepth(95);
      this.tweens.add({
        targets: spark,
        x: x + Math.cos(angle) * distance,
        y: y + Math.sin(angle) * distance,
        alpha: 0,
        scale: { from: 1.6, to: 0.2 },
        duration: 520 + Math.random() * 420,
        ease: "quad.out",
        onComplete: () => spark.destroy()
      });
    }

    this.tweens.add({
      targets: flash,
      radius: 300,
      alpha: 0,
      duration: 560,
      ease: "quad.out",
      onComplete: () => flash.destroy()
    });
    this.tweens.add({
      targets: shockwave,
      radius: 680,
      alpha: 0,
      duration: 780,
      ease: "quad.out",
      onComplete: () => shockwave.destroy()
    });
    this.tweens.add({
      targets: blast,
      alpha: 0,
      duration: 720,
      ease: "quad.out",
      onComplete: () => blast.destroy()
    });
  }

  private shoot(pointer: Phaser.Input.Pointer) {
    if (this.round?.state === "ended") {
      return;
    }

    const local = this.players.find((player) => player.id === this.playerId);
    const machineGun = local ? hasActivePowerup(local, "machine_gun", Date.now()) : false;
    this.sfx.unlock();
    if (local && !machineGun && (local.ammo <= 0 || local.reloadEndsAt > Date.now())) {
      this.reload();
      return;
    }

    const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.spawnMuzzleFlash(point.x, point.y);
    this.send({
      type: "shoot",
      x: point.x,
      y: point.y,
      seq: this.seq++
    });
    this.sfx.shot(machineGun);
    this.ammoHud.kick();
  }

  private fireMachineGunIfHeld(local: PlayerSnapshot) {
    const now = Date.now();
    if (!this.input.activePointer.isDown || !hasActivePowerup(local, "machine_gun", now) || now - this.lastMachineGunSendAt < 35) {
      return;
    }

    this.shoot(this.input.activePointer);
    this.lastMachineGunSendAt = now;
  }

  private spawnMuzzleFlash(x: number, y: number) {
    const flash = this.add.graphics().setDepth(88);
    flash.fillStyle(0xffdf91, 0.92);
    flash.fillCircle(x, y, 10);
    flash.lineStyle(3, 0xf7f1dc, 0.9);
    flash.strokeCircle(x, y, 20);
    this.tweens.add({
      targets: flash,
      scale: 1.7,
      alpha: 0,
      duration: 110,
      ease: "quad.out",
      onComplete: () => flash.destroy()
    });
  }

  private reload() {
    this.sfx.reload();
    this.send({ type: "reload" });
  }

  private taunt() {
    this.sfx.taunt();
    this.send({ type: "taunt" });
  }

  private sendAim(pointer: Phaser.Input.Pointer) {
    const now = Date.now();
    if (now - this.lastAimSentAt < 70) {
      return;
    }

    const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.send({
      type: "aim",
      x: point.x,
      y: point.y
    });
    this.lastAimSentAt = now;
  }

  private send(message: ClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private renderLeaderboard() {
    const lines = this.leaderboardEntries.map((entry, index) => {
      const accuracy = entry.shots > 0 ? Math.round((entry.hits / entry.shots) * 100) : 0;
      return `${index + 1}. ${entry.name.padEnd(12)} ${entry.score.toString().padStart(4)}  ${accuracy}%`;
    });

    this.leaderboardText.setText([`LIVE RANGE  ${this.players.length} online`, ...lines].join("\n"));
  }

  private renderAmmo(local: PlayerSnapshot) {
    this.ammoHud.render(local, Date.now());
  }

  private syncPowerups(snapshot: PowerupSnapshot[]) {
    const seen = new Set<string>();

    for (const powerup of snapshot) {
      seen.add(powerup.id);
      let view = this.powerups.get(powerup.id);
      if (!view) {
        view = new PowerupView(this, powerup);
        this.powerups.set(powerup.id, view);
      }
      view.applySnapshot(powerup);
    }

    for (const [id, powerup] of this.powerups) {
      if (!seen.has(id)) {
        powerup.destroy();
        this.powerups.delete(id);
      }
    }
  }

  private syncRemoteCrosshairs(players: PlayerSnapshot[]) {
    const seen = new Set<string>();

    for (const player of players) {
      if (player.id === this.playerId) {
        continue;
      }

      seen.add(player.id);
      let view = this.remoteCrosshairs.get(player.id);
      if (!view) {
        view = new RemoteCrosshairView(this, player);
        this.remoteCrosshairs.set(player.id, view);
      }
      view.applySnapshot(player);
    }

    for (const [id, crosshair] of this.remoteCrosshairs) {
      if (!seen.has(id)) {
        crosshair.destroy();
        this.remoteCrosshairs.delete(id);
      }
    }
  }

  private renderTaunts(taunts: TauntEvent[]) {
    const fresh = taunts.filter((taunt) => !this.seenTaunts.has(taunt.id));
    for (const taunt of fresh) {
      this.seenTaunts.add(taunt.id);
      this.recentHits.unshift(`${taunt.playerName}: ${taunt.text}`);
      this.recentHits = this.recentHits.slice(0, 5);
      this.spawnTaunt(taunt);
    }
    if (fresh.length > 0) {
      this.recentText.setText(this.recentHits.join("\n"));
    }
  }

  private spawnTaunt(taunt: TauntEvent) {
    if (taunt.playerId !== this.playerId) {
      this.sfx.taunt();
    }
    const label = this.add.text(taunt.x, taunt.y - 48, taunt.text.toUpperCase(), hudStyle(18, "#fffaf0", "900")).setOrigin(0.5).setDepth(92);
    const bg = this.add.graphics().setDepth(91);
    const bounds = label.getBounds();
    bg.fillStyle(colorFromHue(taunt.playerHue), 0.92);
    bg.lineStyle(3, 0x18232c, 0.95);
    bg.fillRoundedRect(bounds.x - 10, bounds.y - 5, bounds.width + 20, bounds.height + 10, 8);
    bg.strokeRoundedRect(bounds.x - 10, bounds.y - 5, bounds.width + 20, bounds.height + 10, 8);

    this.tweens.add({
      targets: [label, bg],
      y: "-=34",
      alpha: 0,
      duration: 1800,
      ease: "quad.out",
      onComplete: () => {
        label.destroy();
        bg.destroy();
      }
    });
  }

  private drawCrosshair(pointer: Phaser.Input.Pointer) {
    const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.crosshair.clear();
    this.crosshair.lineStyle(5, 0x18232c, 0.38);
    this.crosshair.strokeCircle(point.x, point.y, 16);
    this.crosshair.lineStyle(2, 0xf7f1dc, 0.95);
    this.crosshair.strokeCircle(point.x, point.y, 13);
    this.crosshair.lineStyle(2, 0xffdf91, 0.92);
    this.crosshair.strokeCircle(point.x, point.y, 4);
    this.crosshair.lineBetween(point.x - 22, point.y, point.x - 7, point.y);
    this.crosshair.lineBetween(point.x + 7, point.y, point.x + 22, point.y);
    this.crosshair.lineBetween(point.x, point.y - 22, point.x, point.y - 7);
    this.crosshair.lineBetween(point.x, point.y + 7, point.x, point.y + 22);
  }

  private drawBackground() {
    this.background.clear();
    const skyBands = [0x76b7dd, 0x83c3e4, 0x98d2e8, 0xb9dfec, 0xdbeee9];
    for (let i = 0; i < skyBands.length; i += 1) {
      this.background.fillStyle(skyBands[i], 1);
      this.background.fillRect(0, (WORLD_HEIGHT * 0.7 * i) / skyBands.length, WORLD_WIDTH, WORLD_HEIGHT * 0.7 / skyBands.length + 1);
    }

    this.background.fillStyle(0xffdf91, 1);
    this.background.fillCircle(1088, 92, 48);
    this.background.fillStyle(0xfff5c2, 0.6);
    this.background.fillCircle(1088, 92, 82);

    this.drawCloud(168, 98, 1.06);
    this.drawCloud(760, 74, 1.22);
    this.drawCloud(1030, 136, 0.78);

    this.background.fillStyle(0x5b8fa4, 0.55);
    this.background.fillTriangle(-80, 444, 150, 220, 390, 444);
    this.background.fillTriangle(230, 444, 510, 176, 820, 444);
    this.background.fillTriangle(690, 444, 960, 238, 1260, 444);
    this.background.fillStyle(0x3e7181, 0.46);
    this.background.fillTriangle(18, 458, 238, 286, 492, 458);
    this.background.fillTriangle(592, 458, 838, 246, 1120, 458);

    this.background.fillStyle(0x6c934f, 1);
    this.background.fillRect(0, WORLD_HEIGHT - 154, WORLD_WIDTH, 154);
    this.background.fillStyle(0x557b40, 1);
    for (let x = -24; x < WORLD_WIDTH + 24; x += 30) {
      const height = 42 + ((x * 17) % 29);
      this.background.fillTriangle(x, WORLD_HEIGHT - 154, x + 17, WORLD_HEIGHT - 154 - height, x + 36, WORLD_HEIGHT - 154);
    }

    this.background.fillStyle(0x835735, 1);
    for (let x = 16; x < WORLD_WIDTH; x += 128) {
      this.background.fillRoundedRect(x, WORLD_HEIGHT - 134, 18, 94, 6);
    }
    this.background.fillStyle(0xb97846, 1);
    this.background.fillRoundedRect(0, WORLD_HEIGHT - 126, WORLD_WIDTH, 16, 8);
    this.background.fillRoundedRect(0, WORLD_HEIGHT - 88, WORLD_WIDTH, 14, 7);

    this.background.fillStyle(0x8c6239, 1);
    this.background.fillRect(0, WORLD_HEIGHT - 58, WORLD_WIDTH, 58);
    this.background.fillStyle(0x6f4a2d, 0.55);
    for (let x = 0; x < WORLD_WIDTH; x += 46) {
      this.background.fillEllipse(x + 18, WORLD_HEIGHT - 24, 54, 8);
    }
  }

  private drawCloud(x: number, y: number, scale: number) {
    this.background.fillStyle(0xf4fbff, 0.72);
    this.background.fillCircle(x, y + 12 * scale, 42 * scale);
    this.background.fillCircle(x + 48 * scale, y, 58 * scale);
    this.background.fillCircle(x + 106 * scale, y + 16 * scale, 38 * scale);
    this.background.fillCircle(x + 72 * scale, y + 26 * scale, 52 * scale);
  }

  private resizeGame(size: Phaser.Structs.Size) {
    this.cameras.main.setZoom(Math.min(size.width / WORLD_WIDTH, size.height / WORLD_HEIGHT));
    this.cameras.main.centerOn(WORLD_WIDTH / 2, WORLD_HEIGHT / 2);
    this.ammoHud?.setPosition(WORLD_WIDTH / 2, WORLD_HEIGHT - 84);
  }
}

class PowerupView {
  private readonly group: Phaser.GameObjects.Container;
  private readonly halo: Phaser.GameObjects.Arc;
  private readonly core: Phaser.GameObjects.Arc;
  private readonly star: Phaser.GameObjects.Star;
  private readonly icon: Phaser.GameObjects.Text | Phaser.GameObjects.Image;
  private readonly label: Phaser.GameObjects.Text;
  private readonly timer: Phaser.GameObjects.Graphics;
  private target: PowerupSnapshot;
  private age = 0;

  constructor(scene: Phaser.Scene, snapshot: PowerupSnapshot) {
    this.target = snapshot;
    const color = powerupColor(snapshot.kind);

    this.halo = scene.add.circle(0, 0, snapshot.radius + 8, color, 0.18).setStrokeStyle(4, color, 0.85);
    this.star = scene.add.star(0, 0, 8, snapshot.radius * 0.78, snapshot.radius * 1.42, color, 0.34);
    this.core = scene.add.circle(0, 0, snapshot.radius, 0x18232c, 0.86).setStrokeStyle(4, color, 1);
    this.icon = this.createIcon(scene, snapshot.kind);
    this.label = scene.add.text(0, snapshot.radius + 24, powerupLabel(snapshot.kind).toUpperCase(), hudStyle(11, "#fffaf0", "900")).setOrigin(0.5);
    this.label.setResolution(2);
    this.timer = scene.add.graphics();
    this.group = scene.add.container(snapshot.x, snapshot.y, [this.halo, this.star, this.core, this.icon, this.label, this.timer]).setDepth(55);
  }

  applySnapshot(snapshot: PowerupSnapshot) {
    this.target = snapshot;
  }

  update(delta: number) {
    this.age += delta / 1000;
    const t = Math.min(1, delta / 80);
    const pulse = 1 + Math.sin(this.age * 5.4) * 0.08;
    this.group.x = Phaser.Math.Linear(this.group.x, this.target.x, t);
    this.group.y = Phaser.Math.Linear(this.group.y, this.target.y, t);
    this.halo.setScale(pulse);
    this.star.setAngle(this.star.angle + delta * 0.06);
    this.star.setScale(1 + Math.sin(this.age * 4.2) * 0.06);
    this.icon.setAngle(Math.sin(this.age * 3.2) * 4);

    const remaining = Phaser.Math.Clamp((this.target.expiresAt - Date.now()) / POWERUP_TTL_MS, 0, 1);
    const color = powerupColor(this.target.kind);
    this.timer.clear();
    this.timer.lineStyle(4, 0xf7f1dc, 0.25);
    this.timer.strokeCircle(0, 0, this.target.radius + 16);
    this.timer.lineStyle(4, color, 0.95);
    this.timer.beginPath();
    this.timer.arc(0, 0, this.target.radius + 16, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remaining, false);
    this.timer.strokePath();
  }

  destroy() {
    this.group.destroy(true);
  }

  private createIcon(scene: Phaser.Scene, kind: PowerupKind) {
    const texture = powerupTextureKey(kind);
    if (texture) {
      const icon = scene.add.image(0, 0, texture).setOrigin(0.5);
      const size = powerupImageSize(kind);
      icon.setDisplaySize(size.width, size.height);
      return icon;
    }

    const icon = scene.add.text(0, -1, powerupIcon(kind), hudStyle(18, "#fffaf0", "900")).setOrigin(0.5);
    icon.setResolution(2);
    return icon;
  }
}

class RemoteCrosshairView {
  private readonly group: Phaser.GameObjects.Container;
  private readonly crosshair: Phaser.GameObjects.Graphics;
  private readonly label: Phaser.GameObjects.Text;
  private target: PlayerSnapshot;

  constructor(scene: Phaser.Scene, snapshot: PlayerSnapshot) {
    this.target = snapshot;
    this.crosshair = scene.add.graphics();
    this.label = scene.add.text(0, 22, snapshot.name, hudStyle(12, "#f5f7fa", "800")).setOrigin(0.5, 0);
    this.label.setResolution(2);
    this.group = scene.add.container(snapshot.aimX, snapshot.aimY, [this.crosshair, this.label]).setDepth(89).setAlpha(0.74);
    this.draw();
  }

  applySnapshot(snapshot: PlayerSnapshot) {
    this.target = snapshot;
    this.label.setText(snapshot.name);
    this.draw();
  }

  update(delta: number) {
    const t = Math.min(1, delta / 65);
    this.group.x = Phaser.Math.Linear(this.group.x, this.target.aimX, t);
    this.group.y = Phaser.Math.Linear(this.group.y, this.target.aimY, t);
  }

  destroy() {
    this.group.destroy(true);
  }

  private draw() {
    const color = colorFromHue(this.target.hue);
    this.crosshair.clear();
    this.crosshair.lineStyle(3, color, 0.9);
    this.crosshair.strokeCircle(0, 0, 10);
    this.crosshair.lineBetween(-19, 0, -7, 0);
    this.crosshair.lineBetween(7, 0, 19, 0);
    this.crosshair.lineBetween(0, -19, 0, -7);
    this.crosshair.lineBetween(0, 7, 0, 19);
    this.crosshair.fillStyle(color, 0.82);
    this.crosshair.fillCircle(0, 0, 2.5);
  }
}

class SoundFx {
  private ctx: AudioContext | null = null;
  private ambientStarted = false;
  private lastShotAt = 0;

  unlock() {
    this.ctx ??= new AudioContext();
    if (this.ctx.state !== "running") {
      void this.ctx.resume();
    }
    if (!this.ambientStarted) {
      this.startAmbience();
      this.ambientStarted = true;
    }
  }

  shot(machineGun: boolean) {
    this.unlock();
    const now = performance.now();
    if (machineGun && now - this.lastShotAt < 26) {
      return;
    }
    this.lastShotAt = now;
    this.noise(machineGun ? 0.028 : 0.055, machineGun ? 0.035 : 0.07, machineGun ? 520 : 190);
    this.tone(machineGun ? 210 : 125, machineGun ? 0.035 : 0.08, "square", machineGun ? 0.045 : 0.07, 0, machineGun ? 92 : 55);
  }

  hit(points: number) {
    this.unlock();
    const big = points >= 75;
    this.tone(big ? 620 : 460, 0.08, "triangle", 0.06);
    this.tone(big ? 930 : 720, 0.12, "sine", 0.05, 0.055);
    if (big) {
      this.noise(0.08, 0.12, 1200, 0.025);
    }
  }

  miss() {
    this.unlock();
    this.noise(0.035, 0.05, 900);
  }

  powerup(kind: PowerupKind) {
    this.unlock();
    if (kind === "nuke") {
      this.nuke();
      return;
    }
    const base = kind === "machine_gun" ? 260 : 520;
    this.tone(base, 0.1, "sawtooth", 0.055);
    this.tone(base * 1.5, 0.16, "triangle", 0.052, 0.08);
    this.tone(base * 2, 0.18, "sine", 0.04, 0.18);
  }

  nuke() {
    this.unlock();
    this.noise(0.42, 0.24, 90);
    this.tone(72, 0.48, "sawtooth", 0.18);
    this.tone(44, 0.64, "square", 0.09, 0.08);
  }

  reload() {
    this.unlock();
    this.tone(180, 0.05, "triangle", 0.04);
    this.tone(230, 0.04, "triangle", 0.035, 0.16);
    this.noise(0.03, 0.05, 700, 0.08);
  }

  taunt() {
    this.unlock();
    this.tone(360, 0.08, "square", 0.045);
    this.tone(260, 0.09, "square", 0.04, 0.09);
  }

  roundStart() {
    this.unlock();
    this.tone(330, 0.1, "triangle", 0.055);
    this.tone(495, 0.12, "triangle", 0.055, 0.1);
    this.tone(660, 0.18, "sine", 0.05, 0.22);
  }

  roundEnd() {
    this.unlock();
    this.tone(520, 0.16, "sawtooth", 0.055);
    this.tone(390, 0.22, "triangle", 0.05, 0.12);
    this.noise(0.18, 0.08, 440, 0.05);
  }

  private startAmbience() {
    this.tone(110, 4.2, "sine", 0.012);
    this.tone(147, 5.2, "sine", 0.008, 0.2);
  }

  private tone(frequency: number, duration: number, type: OscillatorType, gain: number, delay = 0, slide = 0) {
    if (!this.ctx) {
      return;
    }

    const start = this.ctx.currentTime + delay;
    const oscillator = this.ctx.createOscillator();
    const envelope = this.ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (slide !== 0) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, frequency + slide), start + duration);
    }
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain, start + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope);
    envelope.connect(this.ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  private noise(duration: number, gain: number, cutoff: number, delay = 0) {
    if (!this.ctx) {
      return;
    }

    const start = this.ctx.currentTime + delay;
    const sampleCount = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
    const buffer = this.ctx.createBuffer(1, sampleCount, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }

    const source = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const envelope = this.ctx.createGain();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(cutoff, start);
    envelope.gain.setValueAtTime(gain, start);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.buffer = buffer;
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.ctx.destination);
    source.start(start);
    source.stop(start + duration);
  }
}

class AmmoHud {
  private readonly scene: Phaser.Scene;
  private readonly root: Phaser.GameObjects.Container;
  private readonly weapon: Phaser.GameObjects.Container;
  private readonly weaponShadow: Phaser.GameObjects.Ellipse;
  private readonly shotgun: Phaser.GameObjects.Image;
  private readonly machineGun: Phaser.GameObjects.Image;
  private readonly shells: Phaser.GameObjects.Container[] = [];
  private readonly reloadShell: Phaser.GameObjects.Container;
  private readonly progress: Phaser.GameObjects.Graphics;
  private readonly status: Phaser.GameObjects.Text;
  private readonly buffPanel: Phaser.GameObjects.Graphics;
  private readonly buffText: Phaser.GameObjects.Text;
  private lastAmmo = -1;
  private wasReloading = false;
  private lastReloadSlot = -1;
  private activeWeapon: "shotgun" | "machine_gun" = "shotgun";

  constructor(scene: Phaser.Scene, x: number, y: number) {
    this.scene = scene;
    this.root = scene.add.container(x, y).setDepth(85);
    this.weapon = scene.add.container(0, 0);
    this.weaponShadow = scene.add.ellipse(0, 42, 392, 32, 0x111820, 0.34);
    this.shotgun = scene.add.image(0, 2, SHOTGUN_WEAPON_KEY).setOrigin(0.5, 0.52).setDisplaySize(414, 119);
    this.machineGun = scene.add.image(0, 4, MACHINE_GUN_WEAPON_KEY).setOrigin(0.5, 0.52).setDisplaySize(356, 129).setAlpha(0);
    this.progress = scene.add.graphics();
    this.status = scene.add.text(0, 58, "R RELOAD", hudStyle(14, "#f7f1dc", "900")).setOrigin(0.5);
    this.buffPanel = scene.add.graphics();
    this.buffText = scene.add.text(0, -126, "", hudStyle(15, "#fffaf0", "900")).setOrigin(0.5);
    this.status.setResolution(2);
    this.buffText.setResolution(2);
    this.reloadShell = this.createLooseShell();

    this.weapon.add([this.weaponShadow, this.shotgun, this.machineGun]);
    this.root.add([this.buffPanel, this.weapon, this.progress, this.status, this.buffText, this.reloadShell]);

    for (let i = 0; i < 6; i += 1) {
      const shell = this.createShell(i);
      this.shells.push(shell);
      this.root.add(shell);
    }
  }

  setPosition(x: number, y: number) {
    this.root.setPosition(x, y);
  }

  render(player: PlayerSnapshot, now: number) {
    const reloading = player.reloadEndsAt > now;
    const remaining = reloading ? Math.max(0, player.reloadEndsAt - now) : 0;
    const reloadProgress = reloading ? Phaser.Math.Clamp(1 - remaining / RELOAD_DURATION_MS, 0, 1) : 0;
    const visualAmmo = reloading ? Math.max(player.ammo, Math.floor(reloadProgress * player.magazineSize)) : player.ammo;
    const activePowerups = player.activePowerups
      .filter((powerup) => powerup.expiresAt > now)
      .map((powerup) => `${powerupLabel(powerup.kind)} ${Math.ceil((powerup.expiresAt - now) / 1000)}s`);
    const machineGunActive = hasActivePowerup(player, "machine_gun", now);
    this.renderWeapon(machineGunActive ? "machine_gun" : "shotgun");
    this.renderBuffMonitor(activePowerups);

    if (player.ammo < this.lastAmmo) {
      this.kick();
    }

    if (reloading && !this.wasReloading) {
      this.playReloadStart();
      this.lastReloadSlot = -1;
    }

    this.lastAmmo = player.ammo;
    this.wasReloading = reloading;

    for (let i = 0; i < this.shells.length; i += 1) {
      const shell = this.shells[i];
      const loaded = i < visualAmmo;
      shell.setAlpha(loaded ? 1 : 0.22);
      shell.setScale(loaded ? 1 : 0.86);
    }

    this.progress.clear();
    if (machineGunActive) {
      this.status.setText("MACHINE GUN");
      return;
    }

    if (reloading) {
      const width = reloadProgress * 220;
      this.progress.fillStyle(0x18232c, 0.74);
      this.progress.fillRoundedRect(-112, 78, 224, 14, 7);
      this.progress.fillStyle(0xffdf91, 1);
      this.progress.fillRoundedRect(-110, 80, width, 10, 5);
      this.status.setText("RELOADING");
      this.animateShellInsert(visualAmmo);
      return;
    }

    this.lastReloadSlot = -1;
    this.status.setText("R RELOAD");
  }

  private renderWeapon(activeWeapon: "shotgun" | "machine_gun") {
    if (activeWeapon === this.activeWeapon) {
      return;
    }

    this.activeWeapon = activeWeapon;
    this.scene.tweens.killTweensOf([this.shotgun, this.machineGun]);
    this.scene.tweens.add({
      targets: this.shotgun,
      alpha: activeWeapon === "shotgun" ? 1 : 0,
      duration: 120,
      ease: "quad.out"
    });
    this.scene.tweens.add({
      targets: this.machineGun,
      alpha: activeWeapon === "machine_gun" ? 1 : 0,
      duration: 120,
      ease: "quad.out"
    });
  }

  private renderBuffMonitor(activePowerups: string[]) {
    this.buffPanel.clear();
    if (activePowerups.length === 0) {
      this.buffText.setText("BUFFS  none");
      this.buffPanel.fillStyle(0x18232c, 0.68);
      this.buffPanel.lineStyle(2, 0xf7f1dc, 0.28);
      this.buffPanel.fillRoundedRect(-120, -144, 240, 38, 8);
      this.buffPanel.strokeRoundedRect(-120, -144, 240, 38, 8);
      return;
    }

    const text = `BUFFS  ${activePowerups.join("   ")}`;
    const width = Math.min(560, Math.max(260, text.length * 9.5));
    this.buffText.setText(text);
    this.buffPanel.fillStyle(0x18232c, 0.86);
    this.buffPanel.lineStyle(4, 0xffdf91, 0.92);
    this.buffPanel.fillRoundedRect(-width / 2, -148, width, 46, 8);
    this.buffPanel.strokeRoundedRect(-width / 2, -148, width, 46, 8);
  }

  kick() {
    this.scene.tweens.killTweensOf(this.weapon);
    this.weapon.setPosition(0, 0);
    this.weapon.setAngle(0);
    const machineGunKick = this.activeWeapon === "machine_gun";
    this.scene.tweens.add({
      targets: this.weapon,
      x: { from: machineGunKick ? -10 : -18, to: 0 },
      y: { from: machineGunKick ? 4 : 8, to: 0 },
      angle: { from: machineGunKick ? -1 : -2, to: 0 },
      duration: machineGunKick ? 92 : 170,
      ease: "back.out"
    });
  }

  private playReloadStart() {
    this.scene.tweens.killTweensOf(this.weapon);
    this.scene.tweens.add({
      targets: this.weapon,
      angle: { from: -11, to: -5 },
      y: { from: 18, to: 8 },
      duration: 260,
      ease: "quad.out",
      yoyo: true,
      repeat: 1
    });
  }

  private animateShellInsert(ammo: number) {
    const index = Phaser.Math.Clamp(ammo, 0, this.shells.length - 1);
    if (index === this.lastReloadSlot) {
      return;
    }
    this.lastReloadSlot = index;
    const shell = this.shells[index];
    if (!shell || this.reloadShell.getData("animating")) {
      return;
    }

    this.reloadShell.setData("animating", true);
    this.reloadShell.setAlpha(1);
    this.reloadShell.setPosition(-160, 56);
    this.reloadShell.setAngle(-22);
    this.scene.tweens.add({
      targets: this.reloadShell,
      x: shell.x,
      y: shell.y,
      angle: 0,
      duration: 290,
      ease: "quad.out",
      onComplete: () => {
        this.reloadShell.setAlpha(0);
        this.reloadShell.setData("animating", false);
        this.scene.tweens.add({
          targets: shell,
          scale: { from: 1.25, to: 1 },
          duration: 180,
          ease: "back.out"
        });
      }
    });
  }

  private createShell(index: number) {
    const shell = this.scene.add.container(-108 + index * 43, -74);
    shell.scale = 1.08;
    shell.add(this.createShellGraphic());
    return shell;
  }

  private createLooseShell() {
    const shell = this.scene.add.container(-160, 56);
    shell.setAlpha(0);
    shell.scale = 1.18;
    shell.add(this.createShellGraphic());
    return shell;
  }

  private createShellGraphic() {
    const body = this.scene.add.graphics();
    body.fillStyle(0xc04f3f, 1);
    body.fillRoundedRect(-9, -16, 18, 32, 6);
    body.fillStyle(0xffdf91, 1);
    body.fillRoundedRect(-9, -18, 18, 9, 4);
    body.lineStyle(2, 0x18232c, 1);
    body.strokeRoundedRect(-9, -18, 18, 34, 6);
    return body;
  }
}

class TargetView {
  private readonly group: Phaser.GameObjects.Container;
  private readonly shadow: Phaser.GameObjects.Ellipse;
  private readonly tail: Phaser.GameObjects.Triangle;
  private readonly body: Phaser.GameObjects.Ellipse;
  private readonly wingA: Phaser.GameObjects.Ellipse;
  private readonly wingB: Phaser.GameObjects.Ellipse;
  private readonly head: Phaser.GameObjects.Ellipse;
  private readonly eye: Phaser.GameObjects.Arc;
  private readonly beak: Phaser.GameObjects.Triangle;
  private readonly badge: Phaser.GameObjects.Ellipse;
  private readonly label: Phaser.GameObjects.Text;
  private target: TargetSnapshot;

  constructor(scene: Phaser.Scene, snapshot: TargetSnapshot) {
    this.target = snapshot;
    const palette = paletteFor(snapshot.kind);
    this.shadow = scene.add.ellipse(0, snapshot.radius * 0.46, snapshot.radius * 1.8, snapshot.radius * 0.34, 0x18232c, 0.18);
    this.tail = scene.add.triangle(-snapshot.radius * 0.78, -snapshot.radius * 0.04, 0, 0, -22, -14, -18, 15, palette.wing, 0.95);
    this.body = scene.add.ellipse(0, 0, snapshot.radius * 1.7, snapshot.radius * 1.1, palette.body);
    this.wingA = scene.add.ellipse(-8, -7, snapshot.radius * 1.05, snapshot.radius * 0.48, palette.wing);
    this.wingB = scene.add.ellipse(8, -7, snapshot.radius * 1.05, snapshot.radius * 0.48, palette.wing);
    this.head = scene.add.ellipse(snapshot.radius * 0.68, -snapshot.radius * 0.22, snapshot.radius * 0.72, snapshot.radius * 0.62, palette.body);
    const highlight = scene.add.ellipse(snapshot.radius * 0.18, -snapshot.radius * 0.18, snapshot.radius * 0.72, snapshot.radius * 0.22, 0xffffff, 0.28);
    this.eye = scene.add.circle(snapshot.radius * 0.82, -snapshot.radius * 0.32, Math.max(2.8, snapshot.radius * 0.08), 0x18232c, 1);
    this.beak = scene.add.triangle(snapshot.radius * 1.08, -snapshot.radius * 0.2, 0, 0, 14, 6, 0, 12, 0xf0b429);
    this.tail.setStrokeStyle(2, 0x18232c, 0.8);
    this.body.setStrokeStyle(3, 0x7f5539, 0.86);
    this.wingA.setStrokeStyle(2, 0x18232c, 0.48);
    this.wingB.setStrokeStyle(2, 0x18232c, 0.48);
    this.head.setStrokeStyle(2, 0x7f5539, 0.82);
    this.beak.setStrokeStyle(2, 0x9a6a13, 0.9);
    const signY = snapshot.radius + Math.max(18, snapshot.radius * 0.36);
    this.badge = scene.add.ellipse(0, signY, Math.max(52, snapshot.radius * 1.25), Math.max(30, snapshot.radius * 0.5), 0xffdf91, 1);
    this.badge.setStrokeStyle(4, 0x18232c, 1);
    this.label = scene.add.text(0, signY, `${snapshot.points}`, scoreStyle(snapshot.kind === "royal" ? 26 : snapshot.kind === "giant" ? 28 : 20)).setOrigin(0.5);
    this.label.setResolution(2);
    this.group = scene.add.container(snapshot.x, snapshot.y, [this.shadow, this.tail, this.wingA, this.wingB, this.body, highlight, this.head, this.eye, this.beak, this.badge, this.label]).setDepth(snapshot.kind === "giant" || snapshot.kind === "royal" ? 45 : 20);
    this.group.scaleX = snapshot.facing;

    if (snapshot.kind === "royal") {
      const aura = scene.add.circle(0, 0, snapshot.radius * 1.25, 0xffdf91, 0).setStrokeStyle(5, 0xffdf91, 0.5);
      const crown = scene.add.triangle(snapshot.radius * 0.48, -snapshot.radius * 0.72, 0, 18, 12, -12, 25, 18, 0xffdf91, 1);
      crown.setStrokeStyle(2, 0x18232c, 0.95);
      this.group.addAt(aura, 1);
      this.group.add(crown);
    }
  }

  applySnapshot(snapshot: TargetSnapshot) {
    this.target = snapshot;
  }

  update(delta: number) {
    const t = Math.min(1, delta / 70);
    this.group.x = Phaser.Math.Linear(this.group.x, this.target.x, t);
    this.group.y = Phaser.Math.Linear(this.group.y, this.target.y, t);
    this.group.scaleX = this.target.facing;
    this.label.scaleX = this.target.facing;
    this.badge.scaleX = this.target.facing;
    const flap = Math.sin(this.target.flap) * 0.45;
    this.wingA.rotation = -0.25 + flap;
    this.wingB.rotation = 0.25 - flap;
  }

  destroy() {
    this.group.destroy(true);
  }
}

function paletteFor(kind: TargetSnapshot["kind"]) {
  if (kind === "royal") {
    return { body: 0xffdf91, wing: 0x7b2cbf };
  }
  if (kind === "giant") {
    return { body: 0xffdf91, wing: 0xc04f3f };
  }
  if (kind === "bonus") {
    return { body: 0xf25f5c, wing: 0xffc857 };
  }
  if (kind === "runner") {
    return { body: 0xf7f1dc, wing: 0xb7cad6 };
  }
  return { body: 0xebe3cf, wing: 0x7f5539 };
}

function hudStyle(fontSize: number, color: string, fontStyle: string): Phaser.Types.GameObjects.Text.TextStyle {
  return {
    color,
    fontFamily: "Inter, Arial, sans-serif",
    fontSize: `${fontSize}px`,
    fontStyle,
    stroke: "#1d2b35",
    strokeThickness: 3
  };
}

function scoreStyle(fontSize: number): Phaser.Types.GameObjects.Text.TextStyle {
  return {
    color: "#111820",
    fontFamily: "Arial Black, Inter, Arial, sans-serif",
    fontSize: `${fontSize}px`,
    fontStyle: "900"
  };
}

function colorFromHue(hue: number): number {
  return Phaser.Display.Color.HSLToColor(hue / 360, 0.74, 0.55).color;
}

function powerupColor(kind: PowerupKind): number {
  if (kind === "machine_gun") {
    return 0xf25f5c;
  }
  if (kind === "ammo_box") {
    return 0x78d66f;
  }
  if (kind === "nuke") {
    return 0xb7f7ef;
  }
  return 0xffc857;
}

function powerupLabel(kind: PowerupKind): string {
  if (kind === "machine_gun") {
    return "Machine gun";
  }
  if (kind === "nuke") {
    return "Nuke";
  }
  if (kind === "ammo_box") {
    return "Ammo box";
  }
  return "Double points";
}

function powerupIcon(kind: PowerupKind): string {
  if (kind === "machine_gun") {
    return "MG";
  }
  if (kind === "nuke") {
    return "!";
  }
  if (kind === "ammo_box") {
    return "AMMO";
  }
  return "x2";
}

function powerupTextureKey(kind: PowerupKind): string | null {
  if (kind === "nuke") {
    return GRENADE_POWERUP_KEY;
  }
  if (kind === "ammo_box") {
    return AMMO_BOX_POWERUP_KEY;
  }
  return null;
}

function powerupImageSize(kind: PowerupKind): { width: number; height: number } {
  if (kind === "ammo_box") {
    return { width: 60, height: 41 };
  }
  return { width: 38, height: 42 };
}

function hasActivePowerup(player: PlayerSnapshot, kind: PowerupKind, now: number): boolean {
  return player.activePowerups.some((powerup) => powerup.kind === kind && powerup.expiresAt > now);
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function startGame() {
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: "app",
    backgroundColor: "#82b8d8",
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: window.innerWidth,
      height: window.innerHeight
    },
    scene: [GalleryScene]
  });
}
