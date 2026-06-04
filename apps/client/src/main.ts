import Phaser from "phaser";
import {
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
  private ammoText!: Phaser.GameObjects.Text;
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
    this.ammoText = this.add.text(WORLD_WIDTH / 2, WORLD_HEIGHT - 34, "", hudStyle(18, "#f7f1dc", "900")).setOrigin(0.5).setDepth(80);

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
    const host = params.get("server") ?? `${window.location.hostname}:3000`;
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
    const ring = this.add.circle(shot.x, shot.y, shot.hit ? 18 : 10, color, 0).setStrokeStyle(3, color, 0.9).setDepth(70);
    const label = shot.hit
      ? this.add.text(shot.x, shot.y - 28, `${shot.playerName} +${shot.points}`, hudStyle(15, "#ffdf91", "800")).setOrigin(0.5).setDepth(72)
      : null;

    this.tweens.add({
      targets: ring,
      radius: shot.hit ? 42 : 22,
      alpha: 0,
      duration: 360,
      ease: "quad.out",
      onComplete: () => ring.destroy()
    });

    if (label) {
      this.tweens.add({
        targets: label,
        y: label.y - 24,
        alpha: 0,
        duration: 520,
        ease: "quad.out",
        onComplete: () => label.destroy()
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
    this.send({
      type: "shoot",
      x: point.x,
      y: point.y,
      seq: this.seq++
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
    const now = Date.now();
    if (local.reloadEndsAt > now) {
      const remaining = Math.ceil((local.reloadEndsAt - now) / 100) / 10;
      this.ammoText.setText(`RELOADING ${remaining.toFixed(1)}s`);
      return;
    }

    this.ammoText.setText(`AMMO ${"●".repeat(local.ammo)}${"○".repeat(local.magazineSize - local.ammo)}   R`);
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
    this.ammoText?.setPosition(WORLD_WIDTH / 2, WORLD_HEIGHT - 34);
  }
}

class TargetView {
  private readonly group: Phaser.GameObjects.Container;
  private readonly body: Phaser.GameObjects.Ellipse;
  private readonly wingA: Phaser.GameObjects.Ellipse;
  private readonly wingB: Phaser.GameObjects.Ellipse;
  private readonly head: Phaser.GameObjects.Ellipse;
  private readonly beak: Phaser.GameObjects.Triangle;
  private readonly badge: Phaser.GameObjects.Ellipse;
  private readonly label: Phaser.GameObjects.Text;
  private target: TargetSnapshot;

  constructor(scene: Phaser.Scene, snapshot: TargetSnapshot) {
    this.target = snapshot;
    const palette = paletteFor(snapshot.kind);
    this.body = scene.add.ellipse(0, 0, snapshot.radius * 1.7, snapshot.radius * 1.1, palette.body);
    this.wingA = scene.add.ellipse(-8, -7, snapshot.radius * 1.05, snapshot.radius * 0.48, palette.wing);
    this.wingB = scene.add.ellipse(8, -7, snapshot.radius * 1.05, snapshot.radius * 0.48, palette.wing);
    this.head = scene.add.ellipse(snapshot.radius * 0.68, -snapshot.radius * 0.22, snapshot.radius * 0.72, snapshot.radius * 0.62, palette.body);
    this.beak = scene.add.triangle(snapshot.radius * 1.08, -snapshot.radius * 0.2, 0, 0, 14, 6, 0, 12, 0xf0b429);
    const signY = snapshot.radius + Math.max(18, snapshot.radius * 0.36);
    this.badge = scene.add.ellipse(0, signY, Math.max(52, snapshot.radius * 1.25), Math.max(30, snapshot.radius * 0.5), 0xffdf91, 1);
    this.badge.setStrokeStyle(4, 0x18232c, 1);
    this.label = scene.add.text(0, signY, `${snapshot.points}`, scoreStyle(snapshot.kind === "giant" ? 28 : 20)).setOrigin(0.5);
    this.label.setResolution(2);
    this.group = scene.add.container(snapshot.x, snapshot.y, [this.wingA, this.wingB, this.body, this.head, this.beak, this.badge, this.label]).setDepth(snapshot.kind === "giant" ? 45 : 20);
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
