import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import {
  MAGAZINE_SIZE,
  MACHINE_GUN_COOLDOWN_MS,
  MAX_POWERUPS,
  MAX_TARGETS,
  POWERUP_DURATION_MS,
  POWERUP_TTL_MS,
  RELOAD_DURATION_MS,
  ROUND_DURATION_MS,
  ROUND_INTERMISSION_MS,
  SHOT_COOLDOWN_MS,
  SNAPSHOT_RATE,
  TICK_RATE,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  clamp,
  distanceSquared,
  type ClientMessage,
  type PlayerSnapshot,
  type PowerupKind,
  type PowerupSnapshot,
  type RoundSnapshot,
  type ServerMessage,
  type ShotEvent,
  type TauntEvent,
  type TargetKind,
  type TargetSnapshot
} from "@game-io/shared";

type Client = {
  id: string;
  socket: WebSocket;
};

type Player = PlayerSnapshot & {
  lastShotAt: number;
  lastTauntAt: number;
};

type Target = TargetSnapshot & {
  wobble: number;
  age: number;
  ttl: number;
};

type Powerup = PowerupSnapshot;

const app = Fastify({ logger: true });
const clientDistPath = join(dirname(fileURLToPath(import.meta.url)), "../../client/dist");
const clients = new Map<string, Client>();
const players = new Map<string, Player>();
const targets = new Map<string, Target>();
const powerups = new Map<string, Powerup>();
const shots: ShotEvent[] = [];
const taunts: TauntEvent[] = [];
let round: RoundSnapshot = createRound(1, Date.now());

let nextPlayerId = 1;
let nextTargetId = 1;
let nextPowerupId = 1;
let nextShotId = 1;
let nextTauntId = 1;

await app.register(cors, { origin: true });
await app.register(websocket);

app.get("/health", async () => ({ ok: true, players: players.size, targets: targets.size }));

app.get("/ws", { websocket: true }, (socket) => {
  const id = `p${nextPlayerId++}`;
  const player = createPlayer(id, `Player ${id.slice(1)}`);

  clients.set(id, { id, socket });
  players.set(id, player);

  send(socket, {
    type: "welcome",
    playerId: id,
    world: {
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT
    }
  });

  socket.on("message", (raw) => {
    const message = parseMessage(raw.toString());
    if (!message) {
      return;
    }

    const current = players.get(id);
    if (!current) {
      return;
    }

    if (message.type === "join") {
      current.name = sanitizeName(message.name);
      return;
    }

    if (message.type === "shoot") {
      handleShot(current, message.x, message.y);
      return;
    }

    if (message.type === "reload") {
      startReload(current, Date.now());
      return;
    }

    if (message.type === "aim") {
      current.aimX = clamp(message.x, 0, WORLD_WIDTH);
      current.aimY = clamp(message.y, 0, WORLD_HEIGHT);
      return;
    }

    if (message.type === "taunt") {
      handleTaunt(current);
    }
  });

  socket.on("close", () => {
    clients.delete(id);
    players.delete(id);
  });
});

if (existsSync(clientDistPath)) {
  await app.register(fastifyStatic, {
    root: clientDistPath,
    wildcard: false
  });

  app.setNotFoundHandler((_request, reply) => reply.sendFile("index.html"));
}

for (let i = 0; i < MAX_TARGETS; i += 1) {
  spawnTarget(true);
}

setInterval(stepWorld, 1000 / TICK_RATE);
setInterval(broadcastSnapshot, 1000 / SNAPSHOT_RATE);

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });

function stepWorld() {
  const dt = 1 / TICK_RATE;
  const now = Date.now();

  updateRound(now);

  for (const player of players.values()) {
    finishReloadIfReady(player, now);
    player.activePowerups = player.activePowerups.filter((powerup) => powerup.expiresAt > now);
  }

  for (const [id, powerup] of powerups) {
    if (powerup.expiresAt <= now) {
      powerups.delete(id);
    }
  }

  if (round.state !== "active") {
    trimEventBuffers();
    return;
  }

  for (const target of targets.values()) {
    target.age += dt;
    target.x += target.vx * dt;
    target.y += Math.sin(target.age * target.wobble) * target.vy * dt;
    target.flap = (target.flap + dt * 9) % (Math.PI * 2);

    const outside = target.x < -140 || target.x > WORLD_WIDTH + 140 || target.y < 20 || target.y > WORLD_HEIGHT - 40;
    if (outside || target.age > target.ttl) {
      targets.delete(target.id);
    }
  }

  while (targets.size < MAX_TARGETS) {
    spawnTarget(false);
  }

  while (powerups.size < MAX_POWERUPS) {
    spawnPowerup(now);
  }

  trimEventBuffers();
}

function trimEventBuffers() {
  const cutoff = Date.now() - 1200;
  while (shots.length > 0 && shots[0].createdAt < cutoff) {
    shots.shift();
  }

  const tauntCutoff = Date.now() - 3600;
  while (taunts.length > 0 && taunts[0].createdAt < tauntCutoff) {
    taunts.shift();
  }
}

function handleShot(player: Player, x: number, y: number) {
  const now = Date.now();
  if (round.state !== "active") {
    return;
  }

  finishReloadIfReady(player, now);
  const hasMachineGun = hasPowerup(player, "machine_gun", now);

  if (now - player.lastShotAt < getShotCooldown(player, now)) {
    return;
  }
  if (!hasMachineGun && (player.reloadEndsAt > now || player.ammo <= 0)) {
    startReload(player, now);
    return;
  }

  player.lastShotAt = now;
  if (!hasMachineGun) {
    player.ammo -= 1;
  }
  player.shots += 1;

  const point = {
    x: clamp(x, 0, WORLD_WIDTH),
    y: clamp(y, 0, WORLD_HEIGHT)
  };
  player.aimX = point.x;
  player.aimY = point.y;

  const powerup = findPowerup(point.x, point.y);
  if (powerup) {
    powerups.delete(powerup.id);
    const nukePoints = powerup.kind === "nuke" ? detonateNuke(player, now) : 0;
    if (powerup.kind !== "nuke") {
      applyPowerup(player, powerup.kind, now);
    }
    shots.push({
      id: `s${nextShotId++}`,
      playerId: player.id,
      playerName: player.name,
      playerHue: player.hue,
      x: point.x,
      y: point.y,
      hit: true,
      points: nukePoints,
      targetId: powerup.id,
      powerupKind: powerup.kind,
      createdAt: now
    });

    if (!hasMachineGun && player.ammo === 0) {
      startReload(player, now);
    }
    return;
  }

  const hit = findHit(point.x, point.y);

  let points = 0;
  let targetId: string | undefined;

  if (hit) {
    targetId = hit.id;
    targets.delete(hit.id);
    player.hits += 1;
    player.streak += 1;
    points = hit.points + Math.min(8, player.streak - 1);
    if (hasPowerup(player, "double_points", now)) {
      points *= 2;
    }
    player.score += points;
  } else {
    player.streak = 0;
  }

  shots.push({
    id: `s${nextShotId++}`,
    playerId: player.id,
    playerName: player.name,
    playerHue: player.hue,
    x: point.x,
    y: point.y,
    hit: Boolean(hit),
    points,
    targetId,
    createdAt: now
  });

  if (!hasMachineGun && player.ammo === 0) {
    startReload(player, now);
  }
}

function startReload(player: Player, now: number) {
  if (player.ammo >= player.magazineSize || player.reloadEndsAt > now) {
    return;
  }

  player.reloadEndsAt = now + RELOAD_DURATION_MS;
}

function finishReloadIfReady(player: Player, now: number) {
  if (player.reloadEndsAt > 0 && now >= player.reloadEndsAt) {
    player.ammo = player.magazineSize;
    player.reloadEndsAt = 0;
  }
}

function findHit(x: number, y: number): Target | null {
  let best: Target | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const target of targets.values()) {
    const leniency = target.radius + 8;
    const dist = distanceSquared({ x, y }, target);
    if (dist <= leniency * leniency && dist < bestDistance) {
      best = target;
      bestDistance = dist;
    }
  }

  return best;
}

function findPowerup(x: number, y: number): Powerup | null {
  let best: Powerup | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const powerup of powerups.values()) {
    const leniency = powerup.radius + 10;
    const dist = distanceSquared({ x, y }, powerup);
    if (dist <= leniency * leniency && dist < bestDistance) {
      best = powerup;
      bestDistance = dist;
    }
  }

  return best;
}

function applyPowerup(player: Player, kind: PowerupKind, now: number) {
  const existing = player.activePowerups.find((powerup) => powerup.kind === kind);
  if (existing) {
    existing.expiresAt = now + POWERUP_DURATION_MS;
    return;
  }

  player.activePowerups.push({
    kind,
    expiresAt: now + POWERUP_DURATION_MS
  });
}

function hasPowerup(player: Player, kind: PowerupKind, now: number) {
  return player.activePowerups.some((powerup) => powerup.kind === kind && powerup.expiresAt > now);
}

function getShotCooldown(player: Player, now: number) {
  return hasPowerup(player, "machine_gun", now) ? MACHINE_GUN_COOLDOWN_MS : SHOT_COOLDOWN_MS;
}

function detonateNuke(player: Player, now: number) {
  let points = 0;
  for (const target of targets.values()) {
    points += target.points;
    shots.push({
      id: `s${nextShotId++}`,
      playerId: player.id,
      playerName: player.name,
      playerHue: player.hue,
      x: target.x,
      y: target.y,
      hit: true,
      points: target.points,
      targetId: target.id,
      createdAt: now
    });
  }

  if (hasPowerup(player, "double_points", now)) {
    points *= 2;
  }

  targets.clear();
  player.hits += Math.max(1, MAX_TARGETS);
  player.streak += Math.max(1, MAX_TARGETS);
  player.score += points;
  return points;
}

function handleTaunt(player: Player) {
  const now = Date.now();
  if (now - player.lastTauntAt < 4000) {
    return;
  }

  player.lastTauntAt = now;
  taunts.push({
    id: `m${nextTauntId++}`,
    playerId: player.id,
    playerName: player.name,
    playerHue: player.hue,
    text: randomTaunt(),
    x: player.aimX,
    y: player.aimY,
    createdAt: now
  });
}

function updateRound(now: number) {
  if (round.state === "active" && now >= round.endsAt) {
    endRound(now);
    return;
  }

  if (round.state === "ended" && round.nextRoundStartsAt && now >= round.nextRoundStartsAt) {
    startNextRound(now);
  }
}

function endRound(now: number) {
  const winner = [...players.values()].sort((a, b) => b.score - a.score)[0];
  round = {
    ...round,
    state: "ended",
    endsAt: now,
    nextRoundStartsAt: now + ROUND_INTERMISSION_MS,
    winner: winner
      ? {
          id: winner.id,
          name: winner.name,
          score: winner.score,
          hits: winner.hits,
          shots: winner.shots
        }
      : undefined
  };
}

function startNextRound(now: number) {
  round = createRound(round.number + 1, now);
  targets.clear();
  powerups.clear();
  shots.length = 0;
  taunts.length = 0;

  for (const player of players.values()) {
    resetPlayerForRound(player);
  }

  for (let i = 0; i < MAX_TARGETS; i += 1) {
    spawnTarget(true);
  }
}

function createRound(number: number, now: number): RoundSnapshot {
  return {
    number,
    state: "active",
    startedAt: now,
    endsAt: now + ROUND_DURATION_MS
  };
}

function resetPlayerForRound(player: Player) {
  player.score = 0;
  player.shots = 0;
  player.hits = 0;
  player.streak = 0;
  player.ammo = player.magazineSize;
  player.reloadEndsAt = 0;
  player.activePowerups = [];
  player.lastShotAt = 0;
}

function broadcastSnapshot() {
  const leaderboard = [...players.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      hits: player.hits,
      shots: player.shots
    }));

  const message: ServerMessage = {
    type: "snapshot",
    serverTime: Date.now(),
    players: [...players.values()].map(({ lastShotAt: _lastShotAt, ...player }) => player),
    targets: [...targets.values()].map(({ wobble: _wobble, age: _age, ttl: _ttl, ...target }) => target),
    powerups: [...powerups.values()],
    shots,
    taunts,
    leaderboard,
    round
  };

  const payload = JSON.stringify(message);
  for (const client of clients.values()) {
    if (client.socket.readyState === client.socket.OPEN) {
      client.socket.send(payload);
    }
  }
}

function spawnTarget(initial: boolean) {
  const kind = randomKind();
  const fromLeft = Math.random() < 0.5;
  const isGiant = kind === "giant";
  const isRoyal = kind === "royal";
  const baseY = isGiant || isRoyal ? WORLD_HEIGHT - 230 - Math.random() * 95 : 90 + Math.random() * (WORLD_HEIGHT - 220);
  const speed = isGiant
    ? 95 + Math.random() * 45
    : isRoyal
      ? 330 + Math.random() * 80
      : kind === "bonus"
      ? 300 + Math.random() * 110
      : kind === "runner"
        ? 230 + Math.random() * 90
        : 150 + Math.random() * 80;
  const radius = isGiant ? 78 : isRoyal ? 48 : kind === "bonus" ? 18 : kind === "runner" ? 23 : 30;
  const x = initial ? Math.random() * WORLD_WIDTH : fromLeft ? -radius * 2.4 : WORLD_WIDTH + radius * 2.4;
  const id = `t${nextTargetId++}`;

  targets.set(id, {
    id,
    kind,
    x,
    y: baseY,
    vx: fromLeft ? speed : -speed,
    vy: 75 + Math.random() * 80,
    radius,
    points: isRoyal ? 250 : isGiant ? 75 : kind === "bonus" ? 25 : kind === "runner" ? 15 : 10,
    facing: fromLeft ? 1 : -1,
    flap: Math.random() * Math.PI * 2,
    wobble: 2.2 + Math.random() * 2.8,
    age: 0,
    ttl: isRoyal ? 5.5 + Math.random() * 1.5 : isGiant ? 13 + Math.random() * 3 : 7 + Math.random() * 5
  });
}

function randomKind(): TargetKind {
  const hasGiant = [...targets.values()].some((target) => target.kind === "giant");
  const hasRoyal = [...targets.values()].some((target) => target.kind === "royal");
  const roll = Math.random();
  if (!hasRoyal && roll > 0.992) {
    return "royal";
  }
  if (!hasGiant && roll > 0.965) {
    return "giant";
  }
  if (roll > 0.9) {
    return "bonus";
  }
  if (roll > 0.62) {
    return "runner";
  }
  return "cluck";
}

function spawnPowerup(now: number) {
  const margin = 72;
  const kind = randomPowerupKind();
  const id = `u${nextPowerupId++}`;

  powerups.set(id, {
    id,
    kind,
    x: margin + Math.random() * (WORLD_WIDTH - margin * 2),
    y: 92 + Math.random() * (WORLD_HEIGHT - 240),
    radius: 28,
    expiresAt: now + POWERUP_TTL_MS
  });
}

function randomPowerupKind(): PowerupKind {
  const roll = Math.random();
  if (roll > 0.82) {
    return "nuke";
  }
  if (roll > 0.48) {
    return "machine_gun";
  }
  return "double_points";
}

function createPlayer(id: string, name: string): Player {
  return {
    id,
    name,
    score: 0,
    shots: 0,
    hits: 0,
    streak: 0,
    hue: Math.floor(Math.random() * 360),
    ammo: MAGAZINE_SIZE,
    magazineSize: MAGAZINE_SIZE,
    reloadEndsAt: 0,
    aimX: WORLD_WIDTH / 2,
    aimY: WORLD_HEIGHT / 2,
    activePowerups: [],
    lastShotAt: 0,
    lastTauntAt: 0
  };
}

function sanitizeName(name: string): string {
  const clean = name.replace(/[^\w -]/g, "").trim().slice(0, 16);
  return clean.length > 0 ? clean : "Player";
}

function parseMessage(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as ClientMessage;
    if (parsed.type === "join" && typeof parsed.name === "string") {
      return parsed;
    }
    if (parsed.type === "shoot" && typeof parsed.x === "number" && typeof parsed.y === "number") {
      return parsed;
    }
    if (parsed.type === "reload") {
      return parsed;
    }
    if (parsed.type === "aim" && typeof parsed.x === "number" && typeof parsed.y === "number") {
      return parsed;
    }
    if (parsed.type === "taunt") {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

function randomTaunt(): string {
  const options = ["too slow", "nice miss", "my coop now", "reload faster", "easy points", "aim higher"];
  return options[Math.floor(Math.random() * options.length)];
}

function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
