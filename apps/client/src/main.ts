import Phaser from "phaser";
import bossChickenUrl from "./assets/chickens/boss.png";
import basicChickenUrl from "./assets/chickens/basic.png";
import bonusChickenUrl from "./assets/chickens/bonus.png";
import giantChickenUrl from "./assets/chickens/giant.png";
import speedyChickenUrl from "./assets/chickens/speedy.png";
import grenadePowerupUrl from "./assets/weapons/grenade.png";
import machineGunWeaponUrl from "./assets/weapons/machine-gun.png";
import shotgunWeaponUrl from "./assets/weapons/shotgun.png";
import {
  POWERUP_DURATION_MS,
  POWERUP_TTL_MS,
  ROUND_DURATION_MS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type ClientMessage,
  type CoopUpgradeSnapshot,
  type PlayerSnapshot,
  type PowerupKind,
  type PowerupSnapshot,
  type RoomFilter,
  type RoomSummary,
  type RoundSnapshot,
  type ServerMessage,
  type ShotEvent,
  type TauntEvent,
  type TargetSnapshot
} from "@game-io/shared";
import "./styles.css";

const SHOTGUN_WEAPON_KEY = "weapon-shotgun";
const MACHINE_GUN_WEAPON_KEY = "weapon-machine-gun";
const GRENADE_POWERUP_KEY = "powerup-grenade";
const BASIC_CHICKEN_KEY = "chicken-basic";
const SPEEDY_CHICKEN_KEY = "chicken-speedy";
const BONUS_CHICKEN_KEY = "chicken-bonus";
const BOSS_CHICKEN_KEY = "chicken-boss";
const GIANT_CHICKEN_KEY = "chicken-giant";
const WEAPON_HUD_REST_X = 18;
const WEAPON_HUD_REST_Y = -51;

const HUD_COLORS = {
  panel: 0x07131d,
  panelAlt: 0x102233,
  line: 0x2f9ed8,
  lineSoft: 0x7edcff,
  gold: 0xffc857,
  goldLight: 0xffdf91,
  cyan: 0x49c7f5,
  red: 0xf25f5c,
  green: 0x78d66f,
  white: 0xf7fbff
};

type HudEventKind = PowerupKind | "score" | "taunt";

type HudEvent = {
  kind: HudEventKind;
  label: string;
  value: string;
  createdAt: number;
};

type GameHudState = {
  player?: PlayerSnapshot;
  round: RoundSnapshot | null;
  room: RoomSummary | null;
  now: number;
  playerCount: number;
};

const params = new URLSearchParams(window.location.search);
let playerName = "";
let selectedRoomId = "";
let game: Phaser.Game | null = null;
let roomFilter: RoomFilter = "all";
let rooms: RoomSummary[] = [];

const startScreen = document.querySelector<HTMLFormElement>("#start-screen");
const nameInput = document.querySelector<HTMLInputElement>("#player-name");
const roomNameInput = document.querySelector<HTMLInputElement>("#room-name");
const roomModeInput = document.querySelector<HTMLSelectElement>("#room-mode");
const roomsList = document.querySelector<HTMLDivElement>("#rooms-list");
const roomTabs = document.querySelectorAll<HTMLButtonElement>(".room-tab");

if (nameInput) {
  nameInput.value = params.get("name") ?? localStorage.getItem("gallery-name") ?? "";
  nameInput.focus();
}

startScreen?.addEventListener("submit", (event) => {
  event.preventDefault();
  void createRoomAndJoin();
});

roomsList?.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-room-id]");
  if (!button) {
    return;
  }
  joinRoom(button.dataset.roomId ?? "");
});

for (const tab of roomTabs) {
  tab.addEventListener("click", () => {
    roomFilter = (tab.dataset.roomFilter as RoomFilter | undefined) ?? "all";
    for (const item of roomTabs) {
      item.classList.toggle("is-active", item === tab);
    }
    renderRooms();
  });
}

void refreshRooms();
setInterval(() => {
  if (!startScreen?.classList.contains("is-hidden")) {
    void refreshRooms();
  }
}, 3000);

function apiBase() {
  const isViteDevServer = window.location.port === "5173";
  const host = params.get("server") ?? (isViteDevServer ? `${window.location.hostname}:3000` : window.location.host);
  return `${window.location.protocol}//${host}`;
}

function readPlayerName() {
  const submittedName = nameInput?.value.trim() ?? "";
  return submittedName.length > 0 ? submittedName : `Player ${Math.floor(Math.random() * 900 + 100)}`;
}

async function refreshRooms() {
  if (!roomsList) {
    return;
  }

  try {
    const response = await fetch(`${apiBase()}/rooms`);
    rooms = (await response.json()) as RoomSummary[];
    renderRooms();
  } catch {
    roomsList.innerHTML = `<div class="empty-rooms">Room list unavailable</div>`;
  }
}

function renderRooms() {
  if (!roomsList) {
    return;
  }

  const visibleRooms = rooms.filter((room) => roomFilter === "all" || room.mode === roomFilter);
  if (visibleRooms.length === 0) {
    roomsList.innerHTML = `<div class="empty-rooms">No public rooms yet</div>`;
    return;
  }

  roomsList.innerHTML = visibleRooms
    .map(
      (room) => `
        <button class="room-row" type="button" data-room-id="${escapeHtml(room.id)}">
          <span class="room-name">${escapeHtml(room.name)}</span>
          <span class="room-meta">${room.mode.toUpperCase()} · ${room.playerCount} online · ${room.mode === "pve" ? `Wave ${room.wave}` : `Round ${room.roundNumber}`} · ${room.state.replace("_", " ")}</span>
        </button>
      `
    )
    .join("");
}

async function createRoomAndJoin() {
  const mode = roomModeInput?.value === "pvp" ? "pvp" : "pve";
  const name = roomNameInput?.value.trim() || (mode === "pve" ? "Coop Run" : "Classic PvP");
  const response = await fetch(`${apiBase()}/rooms`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ name, mode })
  });
  const room = (await response.json()) as RoomSummary;
  joinRoom(room.id);
}

function joinRoom(roomId: string) {
  if (!roomId || game) {
    return;
  }

  selectedRoomId = roomId;
  playerName = readPlayerName();
  localStorage.setItem("gallery-name", playerName);
  startScreen?.classList.add("is-hidden");
  startGame();
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") {
      return "&amp;";
    }
    if (char === "<") {
      return "&lt;";
    }
    if (char === ">") {
      return "&gt;";
    }
    if (char === '"') {
      return "&quot;";
    }
    return "&#39;";
  });
}

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
  private hud!: GameHud;
  private roundPanel!: Phaser.GameObjects.Graphics;
  private roundSubtitle!: Phaser.GameObjects.Text;
  private roundMeta!: Phaser.GameObjects.Text;
  private readonly upgradeCardTitles: Phaser.GameObjects.Text[] = [];
  private readonly upgradeCardDescriptions: Phaser.GameObjects.Text[] = [];
  private readonly upgradeCardVotes: Phaser.GameObjects.Text[] = [];
  private crosshair!: Phaser.GameObjects.Graphics;
  private background!: Phaser.GameObjects.Graphics;
  private sfx!: SoundFx;
  private tauntKey!: Phaser.Input.Keyboard.Key;
  private round: RoundSnapshot | null = null;
  private room: RoomSummary | null = null;
  private serverTimeOffset = 0;
  private lastRoundState = "";
  private lastRoundNumber = 0;
  private lastAimSentAt = 0;
  private lastMachineGunSendAt = 0;

  preload() {
    this.load.spritesheet(BASIC_CHICKEN_KEY, basicChickenUrl, { frameWidth: 274, frameHeight: 247 });
    this.load.spritesheet(SPEEDY_CHICKEN_KEY, speedyChickenUrl, { frameWidth: 338, frameHeight: 213 });
    this.load.spritesheet(BONUS_CHICKEN_KEY, bonusChickenUrl, { frameWidth: 364, frameHeight: 246 });
    this.load.spritesheet(BOSS_CHICKEN_KEY, bossChickenUrl, { frameWidth: 364, frameHeight: 320 });
    this.load.spritesheet(GIANT_CHICKEN_KEY, giantChickenUrl, { frameWidth: 435, frameHeight: 439 });
    this.load.image(SHOTGUN_WEAPON_KEY, shotgunWeaponUrl);
    this.load.image(MACHINE_GUN_WEAPON_KEY, machineGunWeaponUrl);
    this.load.image(GRENADE_POWERUP_KEY, grenadePowerupUrl);
  }

  create() {
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.cameras.main.setZoom(Math.min(window.innerWidth / WORLD_WIDTH, window.innerHeight / WORLD_HEIGHT));
    this.cameras.main.centerOn(WORLD_WIDTH / 2, WORLD_HEIGHT / 2);

    this.background = this.add.graphics();
    this.drawBackground();
    this.sfx = new SoundFx();
    createChickenAnimations(this);

    this.hud = new GameHud(this);
    this.hud.setConnectionStatus("Connecting...");
    this.roundPanel = this.add.graphics().setDepth(86);
    this.roundSubtitle = this.add.text(WORLD_WIDTH / 2, WORLD_HEIGHT / 2 - 10, "", hudStyle(28, "#ffdf91", "900")).setOrigin(0.5).setDepth(101);
    this.roundMeta = this.add.text(WORLD_WIDTH / 2, WORLD_HEIGHT / 2 + 42, "", hudStyle(18, "#f5f7fa", "800")).setOrigin(0.5).setDepth(101);
    for (let i = 0; i < 3; i += 1) {
      const title = this.add.text(0, 0, "", hudStyle(17, "#fffaf0", "900")).setOrigin(0.5, 0).setDepth(102).setVisible(false);
      const description = this.add
        .text(0, 0, "", {
          ...hudStyle(13, "#dfeaf0", "800"),
          align: "center",
          wordWrap: { width: 196 }
        })
        .setOrigin(0.5, 0)
        .setDepth(102)
        .setVisible(false);
      const votes = this.add.text(0, 0, "", hudStyle(13, "#ffdf91", "900")).setOrigin(0.5, 1).setDepth(102).setVisible(false);
      title.setResolution(2);
      description.setResolution(2);
      votes.setResolution(2);
      this.upgradeCardTitles.push(title);
      this.upgradeCardDescriptions.push(description);
      this.upgradeCardVotes.push(votes);
    }
    this.crosshair = this.add.graphics().setDepth(90);
    this.tauntKey = this.input.keyboard!.addKey("M");
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
    this.hud.render({
      player: local,
      round: this.round,
      room: this.room,
      now: this.serverNow(),
      playerCount: this.players.length
    });
    if (local) {
      this.fireMachineGunIfHeld(local);
    }
  }

  private connect() {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const isViteDevServer = window.location.port === "5173";
    const host = params.get("server") ?? (isViteDevServer ? `${window.location.hostname}:3000` : window.location.host);
    this.socket = new WebSocket(`${protocol}://${host}/ws`);

    this.socket.addEventListener("open", () => {
      this.hud.setConnectionStatus("Joining...");
      this.send({ type: "join", name: playerName, roomId: selectedRoomId });
    });

    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data as string) as ServerMessage;
      this.handleMessage(message);
    });

    this.socket.addEventListener("close", () => {
      this.hud.setConnectionStatus("Disconnected. Refresh to rejoin.");
    });
  }

  private handleMessage(message: ServerMessage) {
    if (message.type === "welcome") {
      this.playerId = message.playerId;
      return;
    }

    this.players = message.players;
    this.room = message.room;
    this.serverTimeOffset = message.serverTime - Date.now();
    this.applyRoundSnapshot(message.round);
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
        this.hud.clearEvents();
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
      this.roundPanel.setDepth(86);
      this.roundSubtitle.setVisible(false);
      this.roundMeta.setVisible(false);
      this.hideUpgradeCards();
      return;
    }

    const nextRoundIn = Math.max(0, (this.round.nextRoundStartsAt ?? now) - now);
    this.roundPanel.setDepth(98);
    this.roundSubtitle.setVisible(true);
    this.roundMeta.setVisible(true);

    if (this.round.mode === "pvp") {
      this.hideUpgradeCards();
      const winner = this.round.winner;
      this.roundSubtitle.setPosition(WORLD_WIDTH / 2, WORLD_HEIGHT / 2 - 10).setText(winner ? `${winner.name} wins round ${this.round.number}` : `Round ${this.round.number} complete`);
      this.roundMeta.setPosition(WORLD_WIDTH / 2, WORLD_HEIGHT / 2 + 42).setText(winner ? `${winner.score} points  |  next round in ${Math.ceil(nextRoundIn / 1000)}s` : `Next round in ${Math.ceil(nextRoundIn / 1000)}s`);
      this.roundPanel.fillStyle(0x111820, 0.58);
      this.roundPanel.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
      this.roundPanel.fillStyle(0x18232c, 0.92);
      this.roundPanel.lineStyle(5, 0xffdf91, 0.95);
      this.roundPanel.fillRoundedRect(WORLD_WIDTH / 2 - 330, WORLD_HEIGHT / 2 - 92, 660, 172, 8);
      this.roundPanel.strokeRoundedRect(WORLD_WIDTH / 2 - 330, WORLD_HEIGHT / 2 - 92, 660, 172, 8);
      return;
    }

    if (this.round.state === "run_over") {
      this.hideUpgradeCards();
      const panelX = WORLD_WIDTH / 2 - 330;
      const panelY = WORLD_HEIGHT / 2 - 92;
      const panelWidth = 660;
      const panelHeight = 172;
      this.roundSubtitle.setPosition(WORLD_WIDTH / 2, WORLD_HEIGHT / 2 - 10).setText("RUN OVER");
      this.roundMeta.setPosition(WORLD_WIDTH / 2, WORLD_HEIGHT / 2 + 42).setText(`Reached wave ${this.round.wave}  |  team score ${this.round.teamScore}  |  new run in ${Math.ceil(nextRoundIn / 1000)}s`);
      this.roundPanel.fillStyle(HUD_COLORS.panel, 0.52);
      this.roundPanel.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
      drawHudPanel(this.roundPanel, panelX, panelY, panelWidth, panelHeight, 12);
      this.roundPanel.lineStyle(1, HUD_COLORS.lineSoft, 0.18);
      this.roundPanel.lineBetween(panelX + 44, panelY + 112, panelX + panelWidth - 44, panelY + 112);
      this.roundPanel.fillStyle(HUD_COLORS.gold, 0.95);
      this.roundPanel.fillRoundedRect(panelX + 190, panelY + 132, panelWidth - 380, 6, 3);
      return;
    }

    const panelX = WORLD_WIDTH / 2 - 420;
    const panelY = WORLD_HEIGHT / 2 - 180;
    const panelWidth = 840;
    const panelHeight = 318;
    this.roundSubtitle.setPosition(WORLD_WIDTH / 2, panelY + 48).setText(`Wave ${this.round.wave} complete`);
    this.roundMeta
      .setPosition(WORLD_WIDTH / 2, panelY + 86)
      .setText(`Score ${this.round.teamScore}  |  Morale ${this.round.morale}/${this.round.maxMorale}  |  Next wave in ${Math.ceil(nextRoundIn / 1000)}s`);
    this.roundPanel.fillStyle(HUD_COLORS.panel, 0.56);
    this.roundPanel.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    drawHudPanel(this.roundPanel, panelX, panelY, panelWidth, panelHeight, 12);
    this.roundPanel.lineStyle(1, HUD_COLORS.lineSoft, 0.16);
    this.roundPanel.lineBetween(panelX + 36, panelY + 112, panelX + panelWidth - 36, panelY + 112);
    this.roundPanel.fillStyle(HUD_COLORS.gold, 0.95);
    this.roundPanel.fillRoundedRect(panelX + 316, panelY + 104, panelWidth - 632, 6, 3);
    this.renderUpgradeCards(this.round.upgradeOptions ?? []);
  }

  private renderUpgradeCards(options: CoopUpgradeSnapshot[]) {
    const selected = this.round?.playerUpgradeVotes?.[this.playerId];

    for (let i = 0; i < this.upgradeCardTitles.length; i += 1) {
      const option = options[i];
      const title = this.upgradeCardTitles[i];
      const description = this.upgradeCardDescriptions[i];
      const votes = this.upgradeCardVotes[i];

      if (!option) {
        title.setVisible(false);
        description.setVisible(false);
        votes.setVisible(false);
        continue;
      }

      const rect = upgradeCardRect(i, options.length);
      const isSelected = selected === option.kind;
      this.roundPanel.fillStyle(isSelected ? 0x183a2d : HUD_COLORS.panelAlt, 0.96);
      this.roundPanel.lineStyle(isSelected ? 4 : 2, isSelected ? HUD_COLORS.green : HUD_COLORS.lineSoft, isSelected ? 0.98 : 0.34);
      this.roundPanel.fillRoundedRect(rect.x, rect.y, rect.width, rect.height, 8);
      this.roundPanel.strokeRoundedRect(rect.x, rect.y, rect.width, rect.height, 8);
      this.roundPanel.fillStyle(isSelected ? HUD_COLORS.green : HUD_COLORS.line, isSelected ? 0.24 : 0.14);
      this.roundPanel.fillRoundedRect(rect.x + 6, rect.y + 6, rect.width - 12, 34, 6);
      this.roundPanel.lineStyle(1, HUD_COLORS.white, 0.12);
      this.roundPanel.lineBetween(rect.x + 18, rect.y + rect.height - 42, rect.x + rect.width - 18, rect.y + rect.height - 42);

      title.setVisible(true).setPosition(rect.x + rect.width / 2, rect.y + 17).setText(`${option.title}${option.stacks > 0 ? ` ${roman(option.stacks + 1)}` : ""}`);
      description.setVisible(true).setPosition(rect.x + rect.width / 2, rect.y + 58).setText(option.description);
      votes
        .setVisible(true)
        .setPosition(rect.x + rect.width / 2, rect.y + rect.height - 17)
        .setText(`${this.round?.upgradeVotes?.[option.kind] ?? 0} vote${(this.round?.upgradeVotes?.[option.kind] ?? 0) === 1 ? "" : "s"}`);
    }
  }

  private hideUpgradeCards() {
    for (const text of [...this.upgradeCardTitles, ...this.upgradeCardDescriptions, ...this.upgradeCardVotes]) {
      text.setVisible(false);
    }
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

      if (shot.powerupKind || shot.hit) {
        this.hud.pushEvent({
          kind: shot.powerupKind ?? "score",
          label: shot.powerupKind ? `${shot.playerName} ${powerupLabel(shot.powerupKind)}` : shot.playerName,
          value: shot.points > 0 ? `+${shot.points}` : ""
        });
      }

      if (shot.playerId === this.playerId && shot.hit && !shot.powerupKind) {
        this.spawnLocalHitConfirm(shot.x, shot.y, shot.points);
      }
    }
  }

  private spawnShotFx(shot: ShotEvent) {
    const color = shot.powerupKind ? powerupColor(shot.powerupKind) : shot.hit ? colorFromHue(shot.playerHue) : 0xd6e2ea;
    const ring = this.add.circle(shot.x, shot.y, shot.hit ? 18 : 10, color, 0).setStrokeStyle(shot.hit ? 5 : 3, color, 0.95).setDepth(70);

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
      radius: shot.hit ? (shot.points >= 40 ? 78 : 62) : 22,
      scaleX: shot.hit ? (shot.points >= 40 ? 1.48 : 1.35) : 1,
      alpha: 0,
      duration: shot.hit ? 480 : 300,
      ease: "quad.out",
      onComplete: () => ring.destroy()
    });
  }

  private spawnLocalHitConfirm(x: number, y: number, points: number) {
    const big = points >= 40;
    const pulse = this.add.graphics().setPosition(x, y).setDepth(91);
    pulse.lineStyle(big ? 5 : 4, 0xfff5c2, 0.95);
    pulse.strokeCircle(0, 0, big ? 24 : 18);
    pulse.lineStyle(2, 0x07131d, 0.28);
    pulse.strokeCircle(0, 0, big ? 30 : 23);

    const score = this.add
      .text(x, y - (big ? 44 : 34), `+${points}`, hudStyle(big ? 30 : 23, big ? "#fff5c2" : "#ffdf91", "900"))
      .setOrigin(0.5)
      .setDepth(92)
      .setResolution(2)
      .setStroke("#07131d", big ? 7 : 6)
      .setShadow(0, 3, "#07131d", 4, true, true);
    score.setScale(0.7);

    this.tweens.add({
      targets: pulse,
      scale: big ? 1.95 : 1.65,
      alpha: 0,
      duration: big ? 230 : 170,
      ease: "quad.out",
      onComplete: () => pulse.destroy()
    });

    this.tweens.add({
      targets: score,
      y: score.y - (big ? 54 : 40),
      scale: { from: 0.7, to: big ? 1.18 : 1 },
      alpha: 0,
      duration: big ? 650 : 520,
      ease: "back.out",
      onComplete: () => score.destroy()
    });
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
      this.chooseUpgradeAt(pointer);
      return;
    }
    if (this.round?.state !== "active") {
      return;
    }

    const local = this.players.find((player) => player.id === this.playerId);
    const machineGun = local ? hasActivePowerup(local, "machine_gun", Date.now()) : false;
    this.sfx.unlock();

    const point = this.pointerToWorldPoint(pointer);
    this.spawnMuzzleFlash(point.x, point.y);
    this.send({
      type: "shoot",
      x: point.x,
      y: point.y,
      seq: this.seq++
    });
    this.sfx.shot(machineGun);
    this.hud.kickWeapon();
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

  private taunt() {
    this.sfx.taunt();
    this.send({ type: "taunt" });
  }

  private chooseUpgradeAt(pointer: Phaser.Input.Pointer) {
    const options = this.round?.upgradeOptions ?? [];
    if (options.length === 0) {
      return;
    }

    const point = this.pointerToWorldPoint(pointer);
    const option = options.find((_option, index) => {
      const rect = upgradeCardRect(index, options.length);
      return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
    });

    if (!option) {
      return;
    }

    this.send({
      type: "choose_upgrade",
      kind: option.kind
    });
    this.sfx.powerup("double_points");
  }

  private sendAim(pointer: Phaser.Input.Pointer) {
    const now = Date.now();
    if (now - this.lastAimSentAt < 70) {
      return;
    }

    const point = this.pointerToWorldPoint(pointer);
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

  private pointerToWorldPoint(pointer: Phaser.Input.Pointer) {
    const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    point.x = Phaser.Math.Clamp(point.x, 0, WORLD_WIDTH);
    point.y = Phaser.Math.Clamp(point.y, 0, WORLD_HEIGHT);
    return point;
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
      this.hud.pushEvent({
        kind: "taunt",
        label: `${taunt.playerName}: ${taunt.text}`,
        value: ""
      });
      if (taunt.playerId !== this.playerId) {
        this.sfx.taunt();
      }
    }
  }

  private drawCrosshair(pointer: Phaser.Input.Pointer) {
    const point = this.pointerToWorldPoint(pointer);
    this.crosshair.clear();
    this.crosshair.lineStyle(4, 0x07131d, 0.34);
    this.crosshair.strokeCircle(point.x, point.y, 15);
    this.crosshair.lineBetween(point.x - 24, point.y, point.x - 8, point.y);
    this.crosshair.lineBetween(point.x + 8, point.y, point.x + 24, point.y);
    this.crosshair.lineBetween(point.x, point.y - 24, point.x, point.y - 8);
    this.crosshair.lineBetween(point.x, point.y + 8, point.x, point.y + 24);
    this.crosshair.lineStyle(2, 0xf7fbff, 0.96);
    this.crosshair.strokeCircle(point.x, point.y, 13);
    this.crosshair.lineBetween(point.x - 23, point.y, point.x - 8, point.y);
    this.crosshair.lineBetween(point.x + 8, point.y, point.x + 23, point.y);
    this.crosshair.lineBetween(point.x, point.y - 23, point.x, point.y - 8);
    this.crosshair.lineBetween(point.x, point.y + 8, point.x, point.y + 23);
    this.crosshair.fillStyle(0xffd45c, 0.98);
    this.crosshair.fillCircle(point.x, point.y, 3.2);
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
    this.hud?.layout();
  }
}

class GameHud {
  private readonly topStatus: TopStatusHud;
  private readonly playerCard: PlayerCardHud;
  private readonly eventFeed: EventFeedHud;
  private readonly powerups: PowerupBadgesHud;
  private readonly weaponPanel: WeaponPanelHud;

  constructor(scene: Phaser.Scene) {
    this.topStatus = new TopStatusHud(scene);
    this.playerCard = new PlayerCardHud(scene);
    this.eventFeed = new EventFeedHud(scene);
    this.powerups = new PowerupBadgesHud(scene);
    this.weaponPanel = new WeaponPanelHud(scene);
    this.layout();
  }

  layout() {
    this.playerCard.setPosition(18, 14);
    this.topStatus.setPosition(WORLD_WIDTH / 2, 18);
    this.eventFeed.setPosition(WORLD_WIDTH - 236, 16);
    this.powerups.setPosition(WORLD_WIDTH - 204, WORLD_HEIGHT - 110);
    this.weaponPanel.setPosition(WORLD_WIDTH / 2, WORLD_HEIGHT);
  }

  setConnectionStatus(status: string) {
    this.playerCard.setConnectionStatus(status);
  }

  clearEvents() {
    this.eventFeed.clear();
  }

  pushEvent(event: Omit<HudEvent, "createdAt">) {
    this.eventFeed.push({ ...event, createdAt: Date.now() });
  }

  kickWeapon() {
    this.weaponPanel.kick();
  }

  render(state: GameHudState) {
    const active = state.round?.state === "active";
    this.topStatus.setVisible(active);
    this.powerups.setVisible(active);
    this.weaponPanel.setVisible(active);
    this.eventFeed.setVisible(active);

    this.topStatus.render(state.round, state.room, state.now, state.playerCount);
    this.playerCard.render(state.player);
    this.eventFeed.render(state.now);
    this.powerups.render(state.player, state.now);
    this.weaponPanel.render(state.player, state.now);
  }
}

class TopStatusHud {
  private readonly root: Phaser.GameObjects.Container;
  private readonly panel: Phaser.GameObjects.Graphics;
  private readonly waveText: Phaser.GameObjects.Text;
  private readonly timerText: Phaser.GameObjects.Text;
  private readonly scoreLabel: Phaser.GameObjects.Text;
  private readonly scoreText: Phaser.GameObjects.Text;
  private readonly moraleLabel: Phaser.GameObjects.Text;
  private readonly moraleText: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene) {
    this.panel = scene.add.graphics();
    this.waveText = scene.add.text(-218, 36, "WAVE 1", hudStyle(22, "#f7fbff", "900")).setOrigin(0, 0.5);
    this.timerText = scene.add.text(18, 36, "1:30", hudStyle(30, "#ffdf91", "900")).setOrigin(0.5, 0.5);
    this.scoreLabel = scene.add.text(156, 18, "TEAM SCORE", hudStyle(11, "#49c7f5", "900")).setOrigin(0.5, 0.5);
    this.scoreText = scene.add.text(156, 48, "0", hudStyle(24, "#f7fbff", "900")).setOrigin(0.5, 0.5);
    this.moraleLabel = scene.add.text(280, 18, "MORALE", hudStyle(11, "#49c7f5", "900")).setOrigin(0.5, 0.5);
    this.moraleText = scene.add.text(280, 48, "0/0", hudStyle(24, "#f7fbff", "900")).setOrigin(0.5, 0.5);
    for (const text of [this.waveText, this.timerText, this.scoreLabel, this.scoreText, this.moraleLabel, this.moraleText]) {
      text.setResolution(2);
    }
    this.root = scene.add.container(0, 0, [this.panel, this.waveText, this.timerText, this.scoreLabel, this.scoreText, this.moraleLabel, this.moraleText]).setDepth(88);
  }

  setPosition(x: number, y: number) {
    this.root.setPosition(x, y);
  }

  setVisible(visible: boolean) {
    this.root.setVisible(visible);
  }

  render(round: RoundSnapshot | null, room: RoomSummary | null, now: number, playerCount: number) {
    if (!round) {
      this.waveText.setText("JOINING");
      this.timerText.setText("--:--");
      this.scoreText.setText("0");
      this.moraleText.setText(`${playerCount} online`);
      this.draw(1);
      return;
    }

    const remaining = Math.max(0, round.endsAt - now);
    const moraleMax = Math.max(1, round.maxMorale);
    const morale = Math.max(0, round.morale);
    const moraleRatio = round.mode === "pve" ? Phaser.Math.Clamp(morale / moraleMax, 0, 1) : Phaser.Math.Clamp(remaining / ROUND_DURATION_MS, 0, 1);

    this.waveText.setText(round.mode === "pve" ? `WAVE ${round.wave}` : `ROUND ${round.number}`);
    this.timerText.setText(formatClock(remaining));
    this.scoreLabel.setText(round.mode === "pve" ? "TEAM SCORE" : truncateHudText(room?.name ?? "ROOM", 14).toUpperCase());
    this.scoreText.setText(round.mode === "pve" ? `${round.teamScore}` : `${playerCount} online`);
    this.moraleLabel.setText(round.mode === "pve" ? "MORALE" : "STATE");
    this.moraleText.setText(round.mode === "pve" ? `${morale}/${moraleMax}` : round.state.toUpperCase());
    this.draw(moraleRatio);
  }

  private draw(progress: number) {
    const width = 650;
    const height = 104;
    this.panel.clear();
    drawHudPanel(this.panel, -width / 2, 0, width, height, 12);

    this.panel.lineStyle(2, HUD_COLORS.lineSoft, 0.12);
    this.panel.lineBetween(-58, 18, -58, 64);
    this.panel.lineBetween(92, 18, 92, 64);
    this.panel.lineBetween(220, 18, 220, 64);

    this.panel.fillStyle(HUD_COLORS.panel, 0.78);
    this.panel.lineStyle(2, HUD_COLORS.lineSoft, 0.32);
    this.panel.fillRoundedRect(-284, 24, 42, 42, 8);
    this.panel.strokeRoundedRect(-284, 24, 42, 42, 8);
    this.panel.lineStyle(4, HUD_COLORS.gold, 0.95);
    this.panel.lineBetween(-274, 44, -252, 44);
    this.panel.lineBetween(-266, 35, -260, 53);
    this.panel.lineBetween(-260, 35, -266, 53);

    this.panel.lineStyle(5, HUD_COLORS.gold, 0.95);
    this.panel.strokeCircle(-46, 36, 15);
    this.panel.lineStyle(2, HUD_COLORS.goldLight, 0.95);
    this.panel.lineBetween(-46, 36, -46, 25);
    this.panel.lineBetween(-46, 36, -35, 36);

    this.panel.fillStyle(HUD_COLORS.panel, 0.85);
    this.panel.lineStyle(2, HUD_COLORS.lineSoft, 0.24);
    this.panel.fillRoundedRect(-248, 74, 496, 14, 7);
    this.panel.strokeRoundedRect(-248, 74, 496, 14, 7);
    this.panel.fillStyle(progress < 0.25 ? HUD_COLORS.red : HUD_COLORS.gold, 1);
    this.panel.fillRoundedRect(-244, 78, 488 * progress, 6, 3);
  }
}

class PlayerCardHud {
  private readonly root: Phaser.GameObjects.Container;
  private readonly panel: Phaser.GameObjects.Graphics;
  private readonly badgeText: Phaser.GameObjects.Text;
  private readonly nameText: Phaser.GameObjects.Text;
  private readonly scoreLabel: Phaser.GameObjects.Text;
  private readonly scoreText: Phaser.GameObjects.Text;
  private readonly streakText: Phaser.GameObjects.Text;
  private readonly accuracyText: Phaser.GameObjects.Text;
  private connectionStatus = "";

  constructor(scene: Phaser.Scene) {
    this.panel = scene.add.graphics();
    this.badgeText = scene.add.text(70, 80, "MG", hudStyle(28, "#f7fbff", "900")).setOrigin(0.5);
    this.nameText = scene.add.text(132, 30, "Michael", hudStyle(19, "#f7fbff", "900")).setOrigin(0, 0.5);
    this.scoreLabel = scene.add.text(132, 68, "SCORE", hudStyle(11, "#49c7f5", "900")).setOrigin(0, 0.5);
    this.scoreText = scene.add.text(132, 94, "0", hudStyle(26, "#ffdf91", "900")).setOrigin(0, 0.5);
    this.streakText = scene.add.text(72, 142, "STREAK 0", hudStyle(12, "#f7fbff", "900")).setOrigin(0.5, 0.5);
    this.accuracyText = scene.add.text(196, 142, "ACCURACY 0%", hudStyle(12, "#f7fbff", "900")).setOrigin(0.5, 0.5);
    for (const text of [this.badgeText, this.nameText, this.scoreLabel, this.scoreText, this.streakText, this.accuracyText]) {
      text.setResolution(2);
    }
    this.root = scene.add.container(0, 0, [this.panel, this.badgeText, this.nameText, this.scoreLabel, this.scoreText, this.streakText, this.accuracyText]).setDepth(88);
    this.draw("MG");
  }

  setPosition(x: number, y: number) {
    this.root.setPosition(x, y);
  }

  setConnectionStatus(status: string) {
    this.connectionStatus = status;
    this.nameText.setText(truncateHudText(status, 22));
  }

  render(player?: PlayerSnapshot) {
    if (!player) {
      this.badgeText.setText("--");
      this.nameText.setText(truncateHudText(this.connectionStatus || "Joining...", 22));
      this.scoreText.setText("0");
      this.streakText.setText("STREAK 0");
      this.accuracyText.setText("ACCURACY 0%");
      this.draw("--");
      return;
    }

    const accuracy = player.shots > 0 ? Math.round((player.hits / player.shots) * 100) : 0;
    const badge = hasActivePowerup(player, "machine_gun", Date.now()) ? "MG" : "SG";
    this.badgeText.setText(badge);
    this.nameText.setText(truncateHudText(player.name, 15));
    this.scoreText.setText(`${player.score}`);
    this.streakText.setText(`STREAK ${player.streak}`);
    this.accuracyText.setText(`ACCURACY ${accuracy}%`);
    this.draw(badge);
  }

  private draw(badge: string) {
    this.panel.clear();
    drawHudPanel(this.panel, 0, 0, 258, 164, 12);
    this.panel.fillStyle(HUD_COLORS.panel, 0.72);
    this.panel.lineStyle(3, badge === "MG" ? HUD_COLORS.gold : HUD_COLORS.lineSoft, 0.9);
    this.panel.fillCircle(70, 82, 48);
    this.panel.strokeCircle(70, 82, 48);
    this.panel.lineStyle(8, badge === "MG" ? HUD_COLORS.gold : HUD_COLORS.line, 0.12);
    this.panel.strokeCircle(70, 82, 58);

    this.panel.lineStyle(1, HUD_COLORS.lineSoft, 0.22);
    this.panel.lineBetween(126, 44, 242, 44);
    this.panel.lineBetween(126, 108, 242, 108);
    this.panel.lineBetween(132, 126, 132, 156);
  }
}

class EventFeedHud {
  private readonly root: Phaser.GameObjects.Container;
  private readonly panel: Phaser.GameObjects.Graphics;
  private readonly title: Phaser.GameObjects.Text;
  private readonly rows: EventFeedRow[] = [];
  private events: HudEvent[] = [];

  constructor(scene: Phaser.Scene) {
    this.panel = scene.add.graphics();
    this.title = scene.add.text(110, 19, "EVENT FEED", hudStyle(15, "#f7fbff", "900")).setOrigin(0.5, 0.5);
    this.title.setResolution(2);
    this.root = scene.add.container(0, 0, [this.panel, this.title]).setDepth(88);

    for (let i = 0; i < 3; i += 1) {
      const row = new EventFeedRow(scene, 10, 42 + i * 34);
      this.rows.push(row);
      this.root.add(row.container);
    }
    this.draw(0);
    this.renderRows(Date.now());
  }

  setPosition(x: number, y: number) {
    this.root.setPosition(x, y);
  }

  setVisible(visible: boolean) {
    this.root.setVisible(visible);
  }

  clear() {
    this.events = [];
    this.renderRows(Date.now());
  }

  push(event: HudEvent) {
    this.events.unshift(event);
    this.events = this.events.slice(0, 3);
    this.renderRows(Date.now());
  }

  render(now: number) {
    this.renderRows(now);
  }

  private renderRows(now: number) {
    this.events = this.events.filter((event) => now - event.createdAt < 6000);
    let visibleRows = 0;
    for (let i = 0; i < this.rows.length; i += 1) {
      const event = this.events[i];
      const row = this.rows[i];
      if (!event) {
        row.setVisible(false);
        continue;
      }

      const age = now - event.createdAt;
      const alpha = age > 4200 ? Math.max(0.24, 1 - (age - 4200) / 1800) : 1;
      row.setVisible(true);
      row.render(event, alpha);
      visibleRows += 1;
    }
    this.root.setAlpha(visibleRows === 0 ? 0.58 : 1);
    this.draw(visibleRows);
  }

  private draw(visibleRows: number) {
    const width = 220;
    const height = visibleRows > 0 ? 44 + visibleRows * 34 : 42;
    this.panel.clear();
    drawHudPanel(this.panel, 0, 0, width, height, 12);
    this.panel.lineStyle(1, HUD_COLORS.lineSoft, 0.2);
    this.panel.lineBetween(12, 34, width - 12, 34);
  }
}

class EventFeedRow {
  readonly container: Phaser.GameObjects.Container;
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly label: Phaser.GameObjects.Text;
  private readonly value: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    this.graphics = scene.add.graphics();
    this.label = scene.add.text(42, 13, "", hudStyle(13, "#f7fbff", "900")).setOrigin(0, 0.5);
    this.value = scene.add.text(192, 13, "", hudStyle(13, "#ffdf91", "900")).setOrigin(1, 0.5);
    this.label.setResolution(2);
    this.value.setResolution(2);
    this.container = scene.add.container(x, y, [this.graphics, this.label, this.value]);
  }

  setVisible(visible: boolean) {
    this.container.setVisible(visible);
  }

  render(event: HudEvent, alpha: number) {
    const color = eventKindColor(event.kind);
    this.container.setAlpha(alpha);
    this.label.setText(truncateHudText(event.label, 15));
    this.value.setText(event.value);
    this.graphics.clear();
    this.graphics.fillStyle(HUD_COLORS.panelAlt, 0.76);
    this.graphics.lineStyle(1, HUD_COLORS.lineSoft, 0.24);
    this.graphics.fillRoundedRect(0, 0, 200, 26, 7);
    this.graphics.strokeRoundedRect(0, 0, 200, 26, 7);
    this.graphics.fillStyle(color, 0.18);
    this.graphics.lineStyle(2, color, 0.92);
    this.graphics.fillCircle(17, 13, 11);
    this.graphics.strokeCircle(17, 13, 11);
    drawEventIcon(this.graphics, event.kind, 17, 13, color);
  }
}

class PowerupBadgesHud {
  private readonly root: Phaser.GameObjects.Container;
  private readonly slots: PowerupBadgeSlot[] = [];

  constructor(scene: Phaser.Scene) {
    this.root = scene.add.container(0, 0).setDepth(88);
    for (let i = 0; i < 3; i += 1) {
      const slot = new PowerupBadgeSlot(scene, i * 78, 0);
      this.slots.push(slot);
      this.root.add(slot.container);
    }
  }

  setPosition(x: number, y: number) {
    this.root.setPosition(x, y);
  }

  setVisible(visible: boolean) {
    this.root.setVisible(visible);
  }

  render(player: PlayerSnapshot | undefined, now: number) {
    const active = getActivePowerups(player, now);
    for (let i = 0; i < this.slots.length; i += 1) {
      const slot = this.slots[i];
      const powerup = active[i];
      if (!powerup) {
        slot.setVisible(false);
        continue;
      }
      slot.setVisible(true);
      slot.render(powerup.kind, Math.max(0, powerup.expiresAt - now));
    }
  }
}

class PowerupBadgeSlot {
  readonly container: Phaser.GameObjects.Container;
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly iconText: Phaser.GameObjects.Text;
  private readonly labelText: Phaser.GameObjects.Text;
  private readonly timerText: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    this.graphics = scene.add.graphics();
    this.iconText = scene.add.text(0, 0, "", hudStyle(18, "#f7fbff", "900")).setOrigin(0.5);
    this.labelText = scene.add.text(0, 48, "", hudStyle(10, "#49c7f5", "900")).setOrigin(0.5);
    this.timerText = scene.add.text(0, 66, "", hudStyle(12, "#f7fbff", "900")).setOrigin(0.5);
    for (const text of [this.iconText, this.labelText, this.timerText]) {
      text.setResolution(2);
    }
    this.container = scene.add.container(x, y, [this.graphics, this.iconText, this.labelText, this.timerText]);
  }

  setVisible(visible: boolean) {
    this.container.setVisible(visible);
  }

  render(kind: PowerupKind, remainingMs: number) {
    const color = powerupColor(kind);
    const seconds = Math.ceil(remainingMs / 1000);
    this.iconText.setText(powerupIcon(kind).toUpperCase());
    this.labelText.setText(powerupLabel(kind).toUpperCase());
    this.timerText.setText(`00:${seconds.toString().padStart(2, "0")}`);
    this.graphics.clear();
    this.graphics.lineStyle(10, color, 0.14);
    this.graphics.strokeCircle(0, 0, 34);
    this.graphics.fillStyle(HUD_COLORS.panel, 0.9);
    this.graphics.lineStyle(4, color, 0.96);
    this.graphics.fillCircle(0, 0, 30);
    this.graphics.strokeCircle(0, 0, 30);
    this.graphics.fillStyle(HUD_COLORS.panel, 0.92);
    this.graphics.lineStyle(2, HUD_COLORS.lineSoft, 0.22);
    this.graphics.fillRoundedRect(-46, 38, 92, 40, 7);
    this.graphics.strokeRoundedRect(-46, 38, 92, 40, 7);
  }
}

class WeaponPanelHud {
  private readonly scene: Phaser.Scene;
  private readonly root: Phaser.GameObjects.Container;
  private readonly panel: Phaser.GameObjects.Graphics;
  private readonly weapon: Phaser.GameObjects.Container;
  private readonly weaponShadow: Phaser.GameObjects.Ellipse;
  private readonly shotgun: Phaser.GameObjects.Image;
  private readonly machineGun: Phaser.GameObjects.Image;
  private readonly title: Phaser.GameObjects.Text;
  private readonly status: Phaser.GameObjects.Text;
  private readonly fireRateLabel: Phaser.GameObjects.Text;
  private readonly damageLabel: Phaser.GameObjects.Text;
  private readonly stats: Phaser.GameObjects.Graphics;
  private readonly buffPanel: Phaser.GameObjects.Graphics;
  private readonly buffSlots: BuffSlotHud[] = [];
  private activeWeapon: "shotgun" | "machine_gun" = "shotgun";

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.panel = scene.add.graphics();
    this.buffPanel = scene.add.graphics();
    this.weapon = scene.add.container(WEAPON_HUD_REST_X, WEAPON_HUD_REST_Y);
    this.weaponShadow = scene.add.ellipse(0, 34, 284, 20, 0x000000, 0.28);
    this.shotgun = scene.add.image(0, -2, SHOTGUN_WEAPON_KEY).setOrigin(0.5, 0.52).setDisplaySize(286, 82);
    this.machineGun = scene.add.image(0, -1, MACHINE_GUN_WEAPON_KEY).setOrigin(0.5, 0.52).setDisplaySize(268, 97).setAlpha(0);
    this.weapon.add([this.weaponShadow, this.shotgun, this.machineGun]);

    this.title = scene.add.text(0, -108, "SHOTGUN", hudStyle(18, "#f7fbff", "900")).setOrigin(0.5);
    this.status = scene.add.text(-224, -42, "READY", hudStyle(13, "#ffdf91", "900")).setOrigin(0.5);
    this.fireRateLabel = scene.add.text(202, -72, "FIRE RATE", hudStyle(10, "#49c7f5", "900")).setOrigin(0, 0.5);
    this.damageLabel = scene.add.text(202, -38, "DAMAGE", hudStyle(10, "#49c7f5", "900")).setOrigin(0, 0.5);
    this.stats = scene.add.graphics();
    for (const text of [this.title, this.status, this.fireRateLabel, this.damageLabel]) {
      text.setResolution(2);
    }

    this.root = scene.add.container(0, 0, [this.buffPanel, this.panel, this.title, this.weapon, this.status, this.fireRateLabel, this.damageLabel, this.stats]).setDepth(87);
    for (let i = 0; i < 6; i += 1) {
      const slot = new BuffSlotHud(scene, -236 + i * 30, -106);
      this.buffSlots.push(slot);
      this.root.add(slot.container);
    }
    this.drawShell();
  }

  setPosition(x: number, y: number) {
    this.root.setPosition(x, y);
  }

  setVisible(visible: boolean) {
    this.root.setVisible(visible);
  }

  render(player: PlayerSnapshot | undefined, now: number) {
    const activePowerups = getActivePowerups(player, now);
    const machineGunActive = Boolean(player && hasActivePowerup(player, "machine_gun", now));
    this.renderWeapon(machineGunActive ? "machine_gun" : "shotgun");
    this.title.setText(machineGunActive ? "MACHINE GUN" : "SHOTGUN");
    this.status.setText(machineGunActive ? "ACTIVE" : "READY");
    this.drawStats(machineGunActive);

    for (let i = 0; i < this.buffSlots.length; i += 1) {
      const powerup = activePowerups[i];
      this.buffSlots[i].render(powerup?.kind);
    }
  }

  kick() {
    this.scene.tweens.killTweensOf(this.weapon);
    this.weapon.setPosition(WEAPON_HUD_REST_X, WEAPON_HUD_REST_Y);
    this.weapon.setAngle(0);
    const machineGunKick = this.activeWeapon === "machine_gun";
    this.scene.tweens.add({
      targets: this.weapon,
      x: { from: WEAPON_HUD_REST_X + (machineGunKick ? -8 : -14), to: WEAPON_HUD_REST_X },
      y: { from: WEAPON_HUD_REST_Y + (machineGunKick ? 4 : 10), to: WEAPON_HUD_REST_Y },
      angle: { from: machineGunKick ? -1 : -2, to: 0 },
      duration: machineGunKick ? 92 : 170,
      ease: "back.out"
    });
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

  private drawShell() {
    this.panel.clear();
    drawHudPanel(this.panel, -290, -132, 580, 124, 12);
    this.panel.lineStyle(1, HUD_COLORS.lineSoft, 0.16);
    this.panel.lineBetween(-164, -90, -164, -34);
    this.panel.lineBetween(178, -90, 178, -34);
    this.panel.fillStyle(HUD_COLORS.panel, 0.58);
    this.panel.lineStyle(2, HUD_COLORS.lineSoft, 0.18);
    this.panel.fillRoundedRect(-266, -88, 96, 58, 7);
    this.panel.strokeRoundedRect(-266, -88, 96, 58, 7);
    this.panel.fillStyle(HUD_COLORS.gold, 0.95);
    for (let i = 0; i < 4; i += 1) {
      this.panel.fillRoundedRect(-244 + i * 12, -74, 6, 24, 3);
    }

    this.buffPanel.clear();
    this.buffPanel.fillStyle(HUD_COLORS.panel, 0.86);
    this.buffPanel.lineStyle(2, HUD_COLORS.line, 0.5);
    this.buffPanel.fillRoundedRect(-254, -122, 194, 32, 8);
    this.buffPanel.strokeRoundedRect(-254, -122, 194, 32, 8);
  }

  private drawStats(machineGunActive: boolean) {
    const fireRate = machineGunActive ? 8 : 3;
    const damage = machineGunActive ? 5 : 8;
    this.stats.clear();
    this.stats.fillStyle(HUD_COLORS.panel, 0.42);
    this.stats.lineStyle(1, HUD_COLORS.lineSoft, 0.18);
    this.stats.fillRoundedRect(190, -94, 78, 64, 7);
    this.stats.strokeRoundedRect(190, -94, 78, 64, 7);
    drawMeterBlocks(this.stats, 202, -60, 8, fireRate, HUD_COLORS.cyan);
    drawMeterBlocks(this.stats, 202, -28, 8, damage, HUD_COLORS.gold);
  }
}

class BuffSlotHud {
  readonly container: Phaser.GameObjects.Container;
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly label: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    this.graphics = scene.add.graphics();
    this.label = scene.add.text(0, 0, "", hudStyle(12, "#f7fbff", "900")).setOrigin(0.5);
    this.label.setResolution(2);
    this.container = scene.add.container(x, y, [this.graphics, this.label]);
  }

  render(kind?: PowerupKind) {
    this.graphics.clear();
    const active = Boolean(kind);
    const color = kind ? powerupColor(kind) : HUD_COLORS.lineSoft;
    this.graphics.fillStyle(active ? HUD_COLORS.panelAlt : HUD_COLORS.panel, active ? 0.9 : 0.72);
    this.graphics.lineStyle(active ? 3 : 2, color, active ? 0.95 : 0.28);
    this.graphics.fillRoundedRect(-13, -13, 26, 26, 6);
    this.graphics.strokeRoundedRect(-13, -13, 26, 26, 6);
    this.label.setText(kind ? powerupIcon(kind).toUpperCase() : "");
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

    this.halo = scene.add.circle(0, 0, snapshot.radius + 10, color, 0.2).setStrokeStyle(5, color, 0.92);
    this.star = scene.add.star(0, 0, 8, snapshot.radius * 0.72, snapshot.radius * 1.38, color, 0.28);
    this.core = scene.add.circle(0, 0, snapshot.radius, HUD_COLORS.panel, 0.9).setStrokeStyle(4, color, 1);
    this.icon = this.createIcon(scene, snapshot.kind);
    this.label = scene.add.text(0, snapshot.radius + 24, "", hudStyle(11, "#fffaf0", "900")).setOrigin(0.5).setVisible(false);
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

class TargetView {
  private readonly group: Phaser.GameObjects.Container;
  private readonly shadow: Phaser.GameObjects.Ellipse;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private readonly badge: Phaser.GameObjects.Ellipse;
  private readonly label: Phaser.GameObjects.Text;
  private target: TargetSnapshot;

  constructor(scene: Phaser.Scene, snapshot: TargetSnapshot) {
    this.target = snapshot;
    const spriteConfig = chickenSpriteFor(snapshot.kind);
    const displayWidth = chickenDisplayWidth(snapshot);
    this.shadow = scene.add.ellipse(0, snapshot.radius * 0.62, displayWidth * 0.64, snapshot.radius * 0.34, 0x18232c, 0.18);
    this.sprite = scene.add.sprite(0, 0, spriteConfig.textureKey).setOrigin(0.5);
    this.sprite.setDisplaySize(displayWidth, displayWidth * spriteConfig.aspectRatio);
    this.sprite.play(spriteConfig.animationKey);
    this.sprite.anims.setProgress((snapshot.flap % (Math.PI * 2)) / (Math.PI * 2));
    const signY = Math.max(snapshot.radius + 18, this.sprite.displayHeight * 0.46 + 16);
    this.badge = scene.add.ellipse(0, signY, Math.max(64, snapshot.radius * 1.42), Math.max(28, snapshot.radius * 0.46), HUD_COLORS.panel, 0.9);
    this.badge.setStrokeStyle(3, HUD_COLORS.gold, 0.95);
    this.label = scene.add.text(0, signY, `${snapshot.points} ♥`, hudStyle(snapshot.kind === "royal" ? 17 : snapshot.kind === "giant" ? 18 : 15, "#f7fbff", "900")).setOrigin(0.5);
    this.label.setResolution(2);
    this.group = scene.add.container(snapshot.x, snapshot.y, [this.shadow, this.sprite, this.badge, this.label]).setDepth(snapshot.kind === "giant" || snapshot.kind === "royal" ? 45 : 20);
    this.group.scaleX = snapshot.facing;
    this.label.scaleX = snapshot.facing;

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
  }

  destroy() {
    this.group.destroy(true);
  }
}

function createChickenAnimations(scene: Phaser.Scene) {
  const animations = [
    { textureKey: BASIC_CHICKEN_KEY, animationKey: "chicken-basic-fly", frameRate: 9 },
    { textureKey: SPEEDY_CHICKEN_KEY, animationKey: "chicken-speedy-fly", frameRate: 13 },
    { textureKey: BONUS_CHICKEN_KEY, animationKey: "chicken-bonus-fly", frameRate: 14 },
    { textureKey: BOSS_CHICKEN_KEY, animationKey: "chicken-boss-fly", frameRate: 8 },
    { textureKey: GIANT_CHICKEN_KEY, animationKey: "chicken-giant-walk", frameRate: 8 }
  ];

  for (const animation of animations) {
    if (scene.anims.exists(animation.animationKey)) {
      continue;
    }
    scene.anims.create({
      key: animation.animationKey,
      frames: scene.anims.generateFrameNumbers(animation.textureKey, { start: 0, end: 3 }),
      frameRate: animation.frameRate,
      repeat: -1
    });
  }
}

function chickenSpriteFor(kind: TargetSnapshot["kind"]) {
  if (kind === "runner") {
    return { textureKey: SPEEDY_CHICKEN_KEY, animationKey: "chicken-speedy-fly", aspectRatio: 213 / 338 };
  }
  if (kind === "bonus") {
    return { textureKey: BONUS_CHICKEN_KEY, animationKey: "chicken-bonus-fly", aspectRatio: 246 / 364 };
  }
  if (kind === "giant") {
    return { textureKey: GIANT_CHICKEN_KEY, animationKey: "chicken-giant-walk", aspectRatio: 439 / 435 };
  }
  if (kind === "royal") {
    return { textureKey: BOSS_CHICKEN_KEY, animationKey: "chicken-boss-fly", aspectRatio: 320 / 364 };
  }
  return { textureKey: BASIC_CHICKEN_KEY, animationKey: "chicken-basic-fly", aspectRatio: 247 / 274 };
}

function chickenDisplayWidth(snapshot: TargetSnapshot) {
  if (snapshot.kind === "giant") {
    return snapshot.radius * 2.9;
  }
  if (snapshot.kind === "royal") {
    return snapshot.radius * 3.35;
  }
  if (snapshot.kind === "runner") {
    return snapshot.radius * 4.3;
  }
  if (snapshot.kind === "bonus") {
    return snapshot.radius * 3.6;
  }
  return snapshot.radius * 3.3;
}

function drawHudPanel(graphics: Phaser.GameObjects.Graphics, x: number, y: number, width: number, height: number, radius: number) {
  graphics.fillStyle(0x000000, 0.22);
  graphics.fillRoundedRect(x + 4, y + 6, width, height, radius);
  graphics.lineStyle(9, HUD_COLORS.line, 0.12);
  graphics.strokeRoundedRect(x - 1, y - 1, width + 2, height + 2, radius + 2);
  graphics.fillStyle(HUD_COLORS.panel, 0.9);
  graphics.fillRoundedRect(x, y, width, height, radius);
  graphics.fillStyle(HUD_COLORS.panelAlt, 0.34);
  graphics.fillRoundedRect(x + 5, y + 5, width - 10, Math.max(18, height * 0.42), Math.max(4, radius - 2));
  graphics.lineStyle(2, HUD_COLORS.line, 0.82);
  graphics.strokeRoundedRect(x, y, width, height, radius);
  graphics.lineStyle(1, HUD_COLORS.white, 0.18);
  graphics.strokeRoundedRect(x + 4, y + 4, width - 8, height - 8, Math.max(3, radius - 3));
}

function drawMeterBlocks(graphics: Phaser.GameObjects.Graphics, x: number, y: number, count: number, filled: number, color: number) {
  for (let i = 0; i < count; i += 1) {
    graphics.fillStyle(i < filled ? color : HUD_COLORS.lineSoft, i < filled ? 0.96 : 0.16);
    graphics.fillRoundedRect(x + i * 8, y, 6, 14, 2);
  }
}

function drawEventIcon(graphics: Phaser.GameObjects.Graphics, kind: HudEventKind, x: number, y: number, color: number) {
  graphics.lineStyle(2, HUD_COLORS.white, 0.9);
  graphics.fillStyle(HUD_COLORS.white, 0.9);
  if (kind === "score") {
    graphics.beginPath();
    for (let i = 0; i < 5; i += 1) {
      const angle = -Math.PI / 2 + (Math.PI * 2 * i) / 5;
      const next = angle + Math.PI / 5;
      const outerX = x + Math.cos(angle) * 7;
      const outerY = y + Math.sin(angle) * 7;
      const innerX = x + Math.cos(next) * 3;
      const innerY = y + Math.sin(next) * 3;
      if (i === 0) {
        graphics.moveTo(outerX, outerY);
      } else {
        graphics.lineTo(outerX, outerY);
      }
      graphics.lineTo(innerX, innerY);
    }
    graphics.closePath();
    graphics.fillPath();
    return;
  }

  if (kind === "machine_gun") {
    graphics.lineStyle(3, color, 0.95);
    graphics.lineBetween(x - 8, y, x + 8, y);
    graphics.lineBetween(x + 4, y - 4, x + 9, y - 4);
    graphics.lineBetween(x - 6, y + 4, x - 2, y + 8);
    return;
  }

  if (kind === "nuke") {
    graphics.lineStyle(2, color, 0.95);
    graphics.strokeCircle(x, y, 7);
    graphics.lineBetween(x - 5, y - 5, x + 5, y + 5);
    graphics.lineBetween(x + 5, y - 5, x - 5, y + 5);
    return;
  }

  if (kind === "taunt") {
    graphics.lineStyle(2, color, 0.95);
    graphics.strokeRoundedRect(x - 8, y - 6, 16, 12, 4);
    graphics.lineBetween(x - 2, y + 6, x - 6, y + 10);
    return;
  }

  graphics.fillStyle(color, 0.95);
  graphics.fillCircle(x, y, 5);
}

function eventKindColor(kind: HudEventKind) {
  if (kind === "machine_gun") {
    return HUD_COLORS.red;
  }
  if (kind === "nuke") {
    return HUD_COLORS.cyan;
  }
  if (kind === "double_points") {
    return HUD_COLORS.gold;
  }
  if (kind === "taunt") {
    return HUD_COLORS.lineSoft;
  }
  return HUD_COLORS.goldLight;
}

function truncateHudText(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function getActivePowerups(player: PlayerSnapshot | undefined, now: number) {
  return [...(player?.activePowerups ?? [])].filter((powerup) => powerup.expiresAt > now).sort((a, b) => a.expiresAt - b.expiresAt);
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

function colorFromHue(hue: number): number {
  return Phaser.Display.Color.HSLToColor(hue / 360, 0.74, 0.55).color;
}

function powerupColor(kind: PowerupKind): number {
  if (kind === "machine_gun") {
    return 0xf25f5c;
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
  return "Double points";
}

function powerupIcon(kind: PowerupKind): string {
  if (kind === "machine_gun") {
    return "MG";
  }
  if (kind === "nuke") {
    return "!";
  }
  return "x2";
}

function powerupTextureKey(kind: PowerupKind): string | null {
  if (kind === "nuke") {
    return GRENADE_POWERUP_KEY;
  }
  return null;
}

function powerupImageSize(_kind: PowerupKind): { width: number; height: number } {
  return { width: 38, height: 42 };
}

function hasActivePowerup(player: PlayerSnapshot, kind: PowerupKind, now: number): boolean {
  return player.activePowerups.some((powerup) => powerup.kind === kind && powerup.expiresAt > now);
}

function upgradeCardRect(index: number, total: number): { x: number; y: number; width: number; height: number } {
  const width = 238;
  const height = 132;
  const gap = 22;
  const totalWidth = total * width + Math.max(0, total - 1) * gap;
  return {
    x: WORLD_WIDTH / 2 - totalWidth / 2 + index * (width + gap),
    y: WORLD_HEIGHT / 2 - 40,
    width,
    height
  };
}

function roman(value: number): string {
  return ["", "I", "II", "III", "IV", "V"][Math.min(value, 5)] ?? `${value}`;
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function startGame() {
  game = new Phaser.Game({
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
