import Phaser from "phaser";
import {
  RELOAD_DURATION_MS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type ClientMessage,
  type LeaderboardEntry,
  type PlayerSnapshot,
  type ServerMessage,
  type ShotEvent,
  type TargetSnapshot
} from "@game-io/shared";
import "./styles.css";

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
  private readonly seenShots = new Set<string>();
  private players: PlayerSnapshot[] = [];
  private leaderboardEntries: LeaderboardEntry[] = [];
  private recentHits: string[] = [];
  private statusText!: Phaser.GameObjects.Text;
  private leaderboardText!: Phaser.GameObjects.Text;
  private feedText!: Phaser.GameObjects.Text;
  private recentText!: Phaser.GameObjects.Text;
  private ammoHud!: AmmoHud;
  private crosshair!: Phaser.GameObjects.Graphics;
  private background!: Phaser.GameObjects.Graphics;
  private reloadKey!: Phaser.Input.Keyboard.Key;

  create() {
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.cameras.main.setZoom(Math.min(window.innerWidth / WORLD_WIDTH, window.innerHeight / WORLD_HEIGHT));
    this.cameras.main.centerOn(WORLD_WIDTH / 2, WORLD_HEIGHT / 2);

    this.background = this.add.graphics();
    this.drawBackground();

    this.statusText = this.add.text(22, 18, "Connecting...", hudStyle(18, "#f5f7fa", "800")).setDepth(80);
    this.leaderboardText = this.add.text(22, 54, "", hudStyle(14, "#e4ecf2", "700")).setDepth(80);
    this.feedText = this.add.text(WORLD_WIDTH - 22, 18, "", hudStyle(14, "#ffdf91", "700")).setOrigin(1, 0).setDepth(80);
    this.recentText = this.add.text(WORLD_WIDTH - 22, 54, "", hudStyle(13, "#f5f7fa", "700")).setOrigin(1, 0).setDepth(80);
    this.ammoHud = new AmmoHud(this, WORLD_WIDTH / 2, WORLD_HEIGHT - 84);

    this.crosshair = this.add.graphics().setDepth(90);
    this.reloadKey = this.input.keyboard!.addKey("R");
    this.reloadKey.on("down", () => this.reload());
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

    this.drawCrosshair(this.input.activePointer);
    const local = this.players.find((player) => player.id === this.playerId);
    if (local) {
      const accuracy = local.shots > 0 ? Math.round((local.hits / local.shots) * 100) : 0;
      this.statusText.setText(`${local.name}  score ${local.score}  streak ${local.streak}  ${accuracy}%`);
      this.renderAmmo(local);
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
    this.renderLeaderboard();
    this.syncTargets(message.targets);
    this.renderShots(message.shots);
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
      if (shot.hit) {
        this.recentHits.unshift(`${shot.playerName} +${shot.points}`);
        this.recentHits = this.recentHits.slice(0, 5);
      }
    }
    this.recentText.setText(this.recentHits.join("\n"));

    const localHits = fresh.filter((shot) => shot.playerId === this.playerId && shot.hit);
    if (localHits.length > 0) {
      const latest = localHits.at(-1)!;
      this.cameras.main.shake(latest.points >= 40 ? 170 : 100, latest.points >= 40 ? 0.0065 : 0.0038);
      this.feedText.setText(`+${latest.points}`);
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
    const color = shot.hit ? colorFromHue(shot.playerHue) : 0xd6e2ea;
    const ring = this.add.circle(shot.x, shot.y, shot.hit ? 18 : 10, color, 0).setStrokeStyle(shot.hit ? 5 : 3, color, 0.95).setDepth(70);
    const label = shot.hit
      ? this.add.text(shot.x, shot.y - 34, `${shot.playerName} +${shot.points}`, hudStyle(shot.points >= 40 ? 24 : 18, "#ffdf91", "900")).setOrigin(0.5).setDepth(76)
      : null;

    if (shot.hit) {
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

  private shoot(pointer: Phaser.Input.Pointer) {
    const local = this.players.find((player) => player.id === this.playerId);
    if (local && (local.ammo <= 0 || local.reloadEndsAt > Date.now())) {
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
    this.ammoHud.kick();
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
    this.send({ type: "reload" });
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

  private drawCrosshair(pointer: Phaser.Input.Pointer) {
    const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.crosshair.clear();
    this.crosshair.lineStyle(2, 0xf7f1dc, 0.95);
    this.crosshair.strokeCircle(point.x, point.y, 13);
    this.crosshair.lineBetween(point.x - 22, point.y, point.x - 7, point.y);
    this.crosshair.lineBetween(point.x + 7, point.y, point.x + 22, point.y);
    this.crosshair.lineBetween(point.x, point.y - 22, point.x, point.y - 7);
    this.crosshair.lineBetween(point.x, point.y + 7, point.x, point.y + 22);
  }

  private drawBackground() {
    this.background.clear();
    this.background.fillStyle(0x82b8d8, 1);
    this.background.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.background.fillStyle(0xcce7f3, 0.9);
    this.background.fillCircle(180, 96, 52);
    this.background.fillCircle(224, 92, 76);
    this.background.fillCircle(282, 112, 50);
    this.background.fillCircle(920, 74, 64);
    this.background.fillCircle(990, 82, 88);
    this.background.fillCircle(1062, 104, 52);
    this.background.fillStyle(0x56784a, 1);
    this.background.fillRect(0, WORLD_HEIGHT - 116, WORLD_WIDTH, 116);
    this.background.fillStyle(0x3f5f37, 1);
    for (let x = 0; x < WORLD_WIDTH; x += 34) {
      this.background.fillTriangle(x, WORLD_HEIGHT - 116, x + 18, WORLD_HEIGHT - 158 - Math.random() * 16, x + 38, WORLD_HEIGHT - 116);
    }
    this.background.fillStyle(0x8c6239, 1);
    this.background.fillRect(0, WORLD_HEIGHT - 52, WORLD_WIDTH, 52);
  }

  private resizeGame(size: Phaser.Structs.Size) {
    this.cameras.main.setZoom(Math.min(size.width / WORLD_WIDTH, size.height / WORLD_HEIGHT));
    this.cameras.main.centerOn(WORLD_WIDTH / 2, WORLD_HEIGHT / 2);
    this.ammoHud?.setPosition(WORLD_WIDTH / 2, WORLD_HEIGHT - 84);
  }
}

class AmmoHud {
  private readonly scene: Phaser.Scene;
  private readonly root: Phaser.GameObjects.Container;
  private readonly weapon: Phaser.GameObjects.Container;
  private readonly shotgun: Phaser.GameObjects.Graphics;
  private readonly shells: Phaser.GameObjects.Container[] = [];
  private readonly reloadShell: Phaser.GameObjects.Container;
  private readonly progress: Phaser.GameObjects.Graphics;
  private readonly status: Phaser.GameObjects.Text;
  private lastAmmo = -1;
  private wasReloading = false;
  private lastReloadSlot = -1;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    this.scene = scene;
    this.root = scene.add.container(x, y).setDepth(85);
    this.weapon = scene.add.container(0, 0);
    this.shotgun = scene.add.graphics();
    this.progress = scene.add.graphics();
    this.status = scene.add.text(0, 58, "R RELOAD", hudStyle(14, "#f7f1dc", "900")).setOrigin(0.5);
    this.status.setResolution(2);
    this.reloadShell = this.createLooseShell();

    this.drawShotgun();
    this.weapon.add(this.shotgun);
    this.root.add([this.weapon, this.progress, this.status, this.reloadShell]);

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

  kick() {
    this.scene.tweens.killTweensOf(this.weapon);
    this.weapon.setPosition(0, 0);
    this.weapon.setAngle(0);
    this.scene.tweens.add({
      targets: this.weapon,
      x: { from: -18, to: 0 },
      y: { from: 8, to: 0 },
      angle: { from: -2, to: 0 },
      duration: 170,
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

  private drawShotgun() {
    this.shotgun.clear();
    this.shotgun.fillStyle(0x111820, 0.32);
    this.shotgun.fillEllipse(0, 38, 390, 34);
    this.shotgun.fillStyle(0x6f3f2a, 1);
    this.shotgun.fillRoundedRect(-178, 4, 76, 32, 11);
    this.shotgun.fillRoundedRect(62, 0, 120, 34, 12);
    this.shotgun.fillStyle(0x9b5b35, 1);
    this.shotgun.fillRoundedRect(-96, -2, 128, 38, 12);
    this.shotgun.fillStyle(0xb97846, 1);
    this.shotgun.fillRoundedRect(-70, 10, 90, 16, 8);
    this.shotgun.fillStyle(0x18232c, 1);
    this.shotgun.fillRoundedRect(-190, -19, 380, 24, 12);
    this.shotgun.fillStyle(0xd7dde0, 1);
    this.shotgun.fillRoundedRect(-176, -28, 166, 10, 5);
    this.shotgun.fillStyle(0x283947, 1);
    this.shotgun.fillRoundedRect(120, -16, 66, 16, 8);
    this.shotgun.lineStyle(4, 0xf7f1dc, 0.36);
    this.shotgun.lineBetween(-178, -10, 178, -10);
    this.shotgun.lineStyle(4, 0x111820, 0.8);
    this.shotgun.strokeRoundedRect(-96, -2, 128, 38, 12);
  }

  private createShell(index: number) {
    const shell = this.scene.add.container(-108 + index * 43, -58);
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
    this.label = scene.add.text(0, signY, `${snapshot.points}`, scoreStyle(snapshot.kind === "giant" ? 28 : 20)).setOrigin(0.5);
    this.label.setResolution(2);
    this.group = scene.add.container(snapshot.x, snapshot.y, [this.shadow, this.tail, this.wingA, this.wingB, this.body, this.head, this.eye, this.beak, this.badge, this.label]).setDepth(snapshot.kind === "giant" ? 45 : 20);
    this.group.scaleX = snapshot.facing;
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
