import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import {
  MACHINE_GUN_COOLDOWN_MS,
  MACHINE_GUN_STREAK_THRESHOLD,
  MAX_TARGETS,
  POWERUP_DURATION_MS,
  ROUND_DURATION_MS,
  ROUND_INTERMISSION_MS,
  SHOT_COOLDOWN_MS,
  SNAPSHOT_RATE,
  TARGET_SPAWN_AREA,
  TICK_RATE,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  clamp,
  distanceSquared,
  type ClientMessage,
  type CoopUpgradeSnapshot,
  type GameMode,
  type PlayerSnapshot,
  type PowerupKind,
  type PowerupSnapshot,
  type RoomSummary,
  type RoundSnapshot,
  type ServerMessage,
  type ShotEvent,
  type TauntEvent,
  type TargetKind,
  type TargetSnapshot,
  type UpgradeKind
} from "@game-io/shared";

type Client = {
  id: string;
  socket: WebSocket;
  roomId?: string;
};

type Player = PlayerSnapshot & {
  lastShotAt: number;
  lastTauntAt: number;
  upgradeVote?: UpgradeKind;
};

type Target = TargetSnapshot & {
  wobble: number;
  age: number;
  ttl: number;
};

type Powerup = PowerupSnapshot;

type CoopRun = {
  teamScore: number;
  morale: number;
  maxMorale: number;
  escapedTargets: number;
  upgrades: Partial<Record<UpgradeKind, number>>;
  lastAppliedUpgrade?: CoopUpgradeSnapshot;
};

type GameRoom = {
  id: string;
  name: string;
  mode: GameMode;
  createdAt: number;
  emptySince?: number;
  clients: Set<string>;
  players: Map<string, Player>;
  targets: Map<string, Target>;
  powerups: Map<string, Powerup>;
  shots: ShotEvent[];
  taunts: TauntEvent[];
  coopRun: CoopRun;
  round: RoundSnapshot;
  nextTargetId: number;
  nextPowerupId: number;
  nextShotId: number;
  nextTauntId: number;
  nextTargetSpawnAt: number;
};

const BASE_TEAM_MORALE = 30;
const EMPTY_ROOM_TTL_MS = 60_000;
const PVE_INTERMISSION_MS = 4500;
const OVERDRIVE_DURATION_BONUS_MS = 750;
const TARGET_SPAWN_INTERVAL_MS = 380;
const INITIAL_TARGET_FILL_RATIO = 0.58;

const UPGRADE_CATALOG: Record<UpgradeKind, Omit<CoopUpgradeSnapshot, "stacks">> = {
  rapid_fire: {
    kind: "rapid_fire",
    title: "Rapid Fire",
    description: "Shots cool down 6% faster"
  },
  steady_hands: {
    kind: "steady_hands",
    title: "Steady Hands",
    description: "Streak bonus can climb higher"
  },
  overdrive: {
    kind: "overdrive",
    title: "Overdrive",
    description: "+0.75s earned machine gun duration"
  },
  score_surge: {
    kind: "score_surge",
    title: "Score Surge",
    description: "Targets are worth 10% more"
  }
};

const app = Fastify({ logger: true });
const clientDistPath = join(dirname(fileURLToPath(import.meta.url)), "../../client/dist");
const clients = new Map<string, Client>();
const rooms = new Map<string, GameRoom>();

let nextPlayerId = 1;
let nextRoomId = 1;

await app.register(cors, { origin: true });
await app.register(websocket);

app.get("/health", async () => ({
  ok: true,
  rooms: rooms.size,
  players: [...rooms.values()].reduce((total, room) => total + room.players.size, 0)
}));

app.get("/rooms", async () => getRoomSummaries());

app.post("/rooms", async (request, reply) => {
  const body = request.body as Partial<{ name: unknown; mode: unknown }> | undefined;
  const mode = body?.mode === "pvp" ? "pvp" : "pve";
  const name = sanitizeRoomName(typeof body?.name === "string" ? body.name : "", mode);
  const room = createRoom(name, mode, Date.now());
  rooms.set(room.id, room);
  reply.code(201);
  return createRoomSummary(room);
});

app.get("/ws", { websocket: true }, (socket) => {
  const id = `p${nextPlayerId++}`;
  clients.set(id, { id, socket });

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

    if (message.type === "join") {
      joinRoom(id, message.roomId, message.name);
      return;
    }

    const room = getClientRoom(id);
    if (!room) {
      return;
    }

    const current = room.players.get(id);
    if (!current) {
      return;
    }

    if (message.type === "shoot") {
      handleShot(room, current, message.x, message.y);
      return;
    }

    if (message.type === "aim") {
      current.aimX = clamp(message.x, 0, WORLD_WIDTH);
      current.aimY = clamp(message.y, 0, WORLD_HEIGHT);
      return;
    }

    if (message.type === "taunt") {
      handleTaunt(room, current);
      return;
    }

    if (message.type === "choose_upgrade") {
      handleUpgradeChoice(room, current, message.kind);
    }
  });

  socket.on("close", () => {
    leaveRoom(id);
    clients.delete(id);
  });
});

if (existsSync(clientDistPath)) {
  await app.register(fastifyStatic, {
    root: clientDistPath,
    wildcard: false
  });

  app.setNotFoundHandler((_request, reply) => reply.sendFile("index.html"));
}

setInterval(stepWorld, 1000 / TICK_RATE);
setInterval(broadcastSnapshots, 1000 / SNAPSHOT_RATE);

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });

function joinRoom(clientId: string, roomId: string, name: string) {
  const client = clients.get(clientId);
  const room = rooms.get(roomId);
  if (!client || !room) {
    return;
  }

  leaveRoom(clientId);
  const wasEmpty = room.players.size === 0;
  const player = createPlayer(clientId, sanitizeName(name));
  client.roomId = room.id;
  room.clients.add(clientId);
  room.players.set(clientId, player);
  room.emptySince = undefined;

  if (wasEmpty) {
    restartRoom(room, Date.now());
  }

  broadcastSnapshot(room);
}

function leaveRoom(clientId: string) {
  const client = clients.get(clientId);
  if (!client?.roomId) {
    return;
  }

  const room = rooms.get(client.roomId);
  if (room) {
    room.clients.delete(clientId);
    room.players.delete(clientId);
    if (room.players.size === 0) {
      room.emptySince = Date.now();
    }
  }

  client.roomId = undefined;
}

function getClientRoom(clientId: string): GameRoom | undefined {
  const roomId = clients.get(clientId)?.roomId;
  return roomId ? rooms.get(roomId) : undefined;
}

function stepWorld() {
  const dt = 1 / TICK_RATE;
  const now = Date.now();

  for (const room of rooms.values()) {
    if (room.players.size === 0) {
      room.targets.clear();
      room.powerups.clear();
      trimEventBuffers(room);
      continue;
    }

    updateRound(room, now);

    for (const player of room.players.values()) {
      player.activePowerups = player.activePowerups.filter((powerup) => powerup.expiresAt > now);
    }

    for (const [id, powerup] of room.powerups) {
      if (powerup.expiresAt <= now) {
        room.powerups.delete(id);
      }
    }

    if (room.round.state !== "active") {
      trimEventBuffers(room);
      continue;
    }

    refreshRoomBalance(room);

    for (const target of room.targets.values()) {
      target.age += dt;
      target.x += target.vx * dt;
      target.y += Math.sin(target.age * target.wobble) * target.vy * dt;
      const targetBounds = getTargetVerticalBounds(target.radius);
      target.y = clamp(target.y, targetBounds.top, targetBounds.bottom);
      target.flap = (target.flap + dt * 9) % (Math.PI * 2);

      const outside = target.x < -140 || target.x > WORLD_WIDTH + 140;
      if (outside || target.age > target.ttl) {
        room.targets.delete(target.id);
        if (room.mode === "pve") {
          damageTeamMorale(room, target, now);
          if (room.round.state !== "active") {
            break;
          }
        }
      }
    }

    if (room.round.state !== "active") {
      trimEventBuffers(room);
      continue;
    }

    spawnDueTarget(room, now);

    trimEventBuffers(room);
  }

  cleanupEmptyRooms(now);
}

function trimEventBuffers(room: GameRoom) {
  const cutoff = Date.now() - 1200;
  while (room.shots.length > 0 && room.shots[0].createdAt < cutoff) {
    room.shots.shift();
  }

  const tauntCutoff = Date.now() - 3600;
  while (room.taunts.length > 0 && room.taunts[0].createdAt < tauntCutoff) {
    room.taunts.shift();
  }
}

function handleShot(room: GameRoom, player: Player, x: number, y: number) {
  const now = Date.now();
  if (room.round.state !== "active") {
    return;
  }

  if (now - player.lastShotAt < getShotCooldown(room, player, now)) {
    return;
  }

  player.lastShotAt = now;
  player.shots += 1;

  const point = {
    x: clamp(x, 0, WORLD_WIDTH),
    y: clamp(y, 0, WORLD_HEIGHT)
  };
  player.aimX = point.x;
  player.aimY = point.y;

  const hit = findHit(room, point.x, point.y);
  let points = 0;
  let targetId: string | undefined;
  const machineGunActive = hasPowerup(player, "machine_gun", now);

  if (hit) {
    targetId = hit.id;
    room.targets.delete(hit.id);
    player.hits += 1;
    const streakGain = getStreakGain(hit.kind);
    if (machineGunActive) {
      points = hit.points;
    } else {
      player.streak += streakGain;
      points = hit.points + Math.min(getStreakBonusCap(room), player.streak - 1);
    }
    if (hasPowerup(player, "double_points", now)) {
      points *= 2;
    }
    player.score += points;
    if (room.mode === "pve") {
      room.coopRun.teamScore += points;
      room.round = {
        ...room.round,
        targetsCleared: Math.min(room.round.targetQuota, room.round.targetsCleared + 1)
      };
      refreshRoundRunStats(room);
      if (room.round.targetsCleared >= room.round.targetQuota) {
        endRound(room, now);
      }
    }
    if (room.round.state === "active" && !machineGunActive && player.streak >= MACHINE_GUN_STREAK_THRESHOLD) {
      activateMachineGun(room, player, now);
    }
  } else {
    player.streak = 0;
  }

  room.shots.push({
    id: `s${room.nextShotId++}`,
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
}

function findHit(room: GameRoom, x: number, y: number): Target | null {
  let best: Target | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const target of room.targets.values()) {
    const leniency = target.radius + 8;
    const dist = distanceSquared({ x, y }, target);
    if (dist <= leniency * leniency && dist < bestDistance) {
      best = target;
      bestDistance = dist;
    }
  }

  return best;
}

function applyPowerup(player: Player, kind: PowerupKind, now: number, durationMs = POWERUP_DURATION_MS) {
  const existing = player.activePowerups.find((powerup) => powerup.kind === kind);
  if (existing) {
    existing.expiresAt = now + durationMs;
    return;
  }

  player.activePowerups.push({
    kind,
    expiresAt: now + durationMs
  });
}

function activateMachineGun(room: GameRoom, player: Player, now: number) {
  player.streak = 0;
  applyPowerup(player, "machine_gun", now, getMachineGunDuration(room));
}

function hasPowerup(player: Player, kind: PowerupKind, now: number) {
  return player.activePowerups.some((powerup) => powerup.kind === kind && powerup.expiresAt > now);
}

function getShotCooldown(room: GameRoom, player: Player, now: number) {
  if (hasPowerup(player, "machine_gun", now)) {
    return MACHINE_GUN_COOLDOWN_MS;
  }
  return Math.max(110, Math.round(SHOT_COOLDOWN_MS * 0.94 ** getUpgradeStacks(room, "rapid_fire")));
}

function handleTaunt(room: GameRoom, player: Player) {
  const now = Date.now();
  if (now - player.lastTauntAt < 4000) {
    return;
  }

  player.lastTauntAt = now;
  room.taunts.push({
    id: `m${room.nextTauntId++}`,
    playerId: player.id,
    playerName: player.name,
    playerHue: player.hue,
    text: randomTaunt(),
    x: player.aimX,
    y: player.aimY,
    createdAt: now
  });
}

function handleUpgradeChoice(room: GameRoom, player: Player, kind: UpgradeKind) {
  if (room.mode !== "pve" || room.round.state !== "ended" || !room.round.upgradeOptions?.some((upgrade) => upgrade.kind === kind)) {
    return;
  }

  player.upgradeVote = kind;
  refreshUpgradeVotes(room);
}

function updateRound(room: GameRoom, now: number) {
  if (room.round.state === "active" && room.mode === "pvp" && now >= room.round.endsAt) {
    endRound(room, now);
    return;
  }

  if (room.round.state === "ended" && room.round.nextRoundStartsAt && now >= room.round.nextRoundStartsAt) {
    startNextRound(room, now);
    return;
  }

  if (room.round.state === "run_over" && room.round.nextRoundStartsAt && now >= room.round.nextRoundStartsAt) {
    startNewRun(room, now);
  }
}

function endRound(room: GameRoom, now: number) {
  const winner = [...room.players.values()].sort((a, b) => b.score - a.score)[0];

  for (const player of room.players.values()) {
    player.upgradeVote = undefined;
  }

  room.round = {
    ...room.round,
    state: "ended",
    endsAt: now,
    nextRoundStartsAt: now + (room.mode === "pve" ? PVE_INTERMISSION_MS : ROUND_INTERMISSION_MS),
    teamScore: room.mode === "pve" ? room.coopRun.teamScore : getRoomScore(room),
    morale: room.mode === "pve" ? room.coopRun.morale : 0,
    maxMorale: room.mode === "pve" ? room.coopRun.maxMorale : 0,
    escapedTargets: room.mode === "pve" ? room.coopRun.escapedTargets : 0,
    runUpgrades: room.mode === "pve" ? getRunUpgrades(room) : [],
    upgradeOptions: room.mode === "pve" ? createUpgradeDraft(room) : undefined,
    upgradeVotes: room.mode === "pve" ? {} : undefined,
    playerUpgradeVotes: room.mode === "pve" ? {} : undefined,
    appliedUpgrade: room.mode === "pve" ? room.coopRun.lastAppliedUpgrade : undefined,
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

function endRun(room: GameRoom, now: number) {
  room.round = {
    ...room.round,
    state: "run_over",
    endsAt: now,
    nextRoundStartsAt: now + ROUND_INTERMISSION_MS,
    teamScore: room.coopRun.teamScore,
    morale: room.coopRun.morale,
    maxMorale: room.coopRun.maxMorale,
    escapedTargets: room.coopRun.escapedTargets,
    runUpgrades: getRunUpgrades(room),
    upgradeOptions: undefined,
    upgradeVotes: undefined,
    playerUpgradeVotes: undefined
  };

  room.targets.clear();
  room.powerups.clear();
}

function startNextRound(room: GameRoom, now: number) {
  const appliedUpgrade = room.mode === "pve" ? applyDraftWinner(room) : undefined;
  room.round = createRound(room, room.round.number + 1, now);
  room.round.appliedUpgrade = appliedUpgrade;
  room.targets.clear();
  room.powerups.clear();
  room.shots.length = 0;
  room.taunts.length = 0;
  room.nextTargetSpawnAt = now + getTargetSpawnInterval(room);

  for (const player of room.players.values()) {
    resetPlayerForRound(player);
  }

  seedInitialTargets(room);
}

function startNewRun(room: GameRoom, now: number) {
  room.coopRun = createCoopRun();
  room.round = createRound(room, 1, now);
  room.targets.clear();
  room.powerups.clear();
  room.shots.length = 0;
  room.taunts.length = 0;
  room.nextTargetSpawnAt = now + getTargetSpawnInterval(room);

  for (const player of room.players.values()) {
    resetPlayerForRound(player);
  }

  seedInitialTargets(room);
}

function restartRoom(room: GameRoom, now: number) {
  room.coopRun = createCoopRun();
  room.round = createRound(room, 1, now);
  room.targets.clear();
  room.powerups.clear();
  room.shots.length = 0;
  room.taunts.length = 0;
  room.nextTargetSpawnAt = now + getTargetSpawnInterval(room);

  for (const player of room.players.values()) {
    resetPlayerForRound(player);
  }

  seedInitialTargets(room);
}

function createRound(room: GameRoom, number: number, now: number): RoundSnapshot {
  const targetQuota = room.mode === "pve" ? getTargetQuota(room, number) : 0;
  return {
    number,
    mode: room.mode,
    wave: number,
    state: "active",
    startedAt: now,
    endsAt: room.mode === "pve" ? Number.MAX_SAFE_INTEGER : now + ROUND_DURATION_MS,
    difficulty: getDifficulty(room, number),
    targetBudget: getTargetBudget(room, number),
    targetQuota,
    targetsCleared: 0,
    teamScore: room.mode === "pve" ? room.coopRun.teamScore : 0,
    morale: room.mode === "pve" ? room.coopRun.morale : 0,
    maxMorale: room.mode === "pve" ? room.coopRun.maxMorale : 0,
    escapedTargets: room.mode === "pve" ? room.coopRun.escapedTargets : 0,
    runUpgrades: room.mode === "pve" ? getRunUpgrades(room) : [],
    appliedUpgrade: room.mode === "pve" ? room.coopRun.lastAppliedUpgrade : undefined
  };
}

function resetPlayerForRound(player: Player) {
  player.score = 0;
  player.shots = 0;
  player.hits = 0;
  player.streak = 0;
  player.activePowerups = [];
  player.lastShotAt = 0;
  player.upgradeVote = undefined;
}

function createUpgradeDraft(room: GameRoom): CoopUpgradeSnapshot[] {
  const kinds = Object.keys(UPGRADE_CATALOG) as UpgradeKind[];
  return shuffle(kinds)
    .slice(0, 3)
    .map((kind) => createUpgradeSnapshot(room, kind));
}

function applyDraftWinner(room: GameRoom): CoopUpgradeSnapshot | undefined {
  const options = room.round.upgradeOptions;
  if (!options || options.length === 0) {
    return undefined;
  }

  const votes = countUpgradeVotes(room);
  const winner = [...options].sort((a, b) => (votes[b.kind] ?? 0) - (votes[a.kind] ?? 0))[0];
  room.coopRun.upgrades[winner.kind] = (room.coopRun.upgrades[winner.kind] ?? 0) + 1;
  room.coopRun.lastAppliedUpgrade = createUpgradeSnapshot(room, winner.kind);
  return room.coopRun.lastAppliedUpgrade;
}

function refreshUpgradeVotes(room: GameRoom) {
  room.round = {
    ...room.round,
    upgradeVotes: countUpgradeVotes(room),
    playerUpgradeVotes: Object.fromEntries([...room.players.values()].filter((player) => player.upgradeVote).map((player) => [player.id, player.upgradeVote!]))
  };
}

function countUpgradeVotes(room: GameRoom): Partial<Record<UpgradeKind, number>> {
  const votes: Partial<Record<UpgradeKind, number>> = {};
  for (const player of room.players.values()) {
    if (player.upgradeVote) {
      votes[player.upgradeVote] = (votes[player.upgradeVote] ?? 0) + 1;
    }
  }
  return votes;
}

function createUpgradeSnapshot(room: GameRoom, kind: UpgradeKind): CoopUpgradeSnapshot {
  return {
    ...UPGRADE_CATALOG[kind],
    stacks: room.coopRun.upgrades[kind] ?? 0
  };
}

function getRunUpgrades(room: GameRoom): CoopUpgradeSnapshot[] {
  return (Object.keys(room.coopRun.upgrades) as UpgradeKind[]).filter((kind) => (room.coopRun.upgrades[kind] ?? 0) > 0).map((kind) => createUpgradeSnapshot(room, kind));
}

function getUpgradeStacks(room: GameRoom, kind: UpgradeKind): number {
  return room.mode === "pve" ? room.coopRun.upgrades[kind] ?? 0 : 0;
}

function getStreakBonusCap(room: GameRoom) {
  return 8 + getUpgradeStacks(room, "steady_hands") * 4;
}

function getMachineGunDuration(room: GameRoom) {
  return POWERUP_DURATION_MS + getUpgradeStacks(room, "overdrive") * OVERDRIVE_DURATION_BONUS_MS;
}

function getScoreMultiplier(room: GameRoom) {
  return 1 + getUpgradeStacks(room, "score_surge") * 0.1;
}

function damageTeamMorale(room: GameRoom, target: Target, now: number) {
  const damage = getEscapeDamage(target.kind);
  if (damage <= 0) {
    return;
  }

  room.coopRun.escapedTargets += 1;
  room.coopRun.morale = Math.max(0, room.coopRun.morale - damage);
  refreshRoundRunStats(room);

  if (room.coopRun.morale <= 0) {
    endRun(room, now);
  }
}

function getEscapeDamage(kind: TargetKind) {
  if (kind === "bonus") {
    return 0;
  }
  if (kind === "royal") {
    return 5;
  }
  if (kind === "giant") {
    return 3;
  }
  return 1;
}

function refreshRoundRunStats(room: GameRoom) {
  room.round = {
    ...room.round,
    teamScore: room.coopRun.teamScore,
    morale: room.coopRun.morale,
    maxMorale: room.coopRun.maxMorale,
    escapedTargets: room.coopRun.escapedTargets,
    targetsCleared: room.round.targetsCleared,
    runUpgrades: getRunUpgrades(room)
  };
}

function refreshRoomBalance(room: GameRoom) {
  const targetBudget = getTargetBudget(room, room.round.wave);
  if (targetBudget === room.round.targetBudget) {
    return;
  }

  room.round = {
    ...room.round,
    targetBudget
  };
}

function getDifficulty(room: GameRoom, wave: number) {
  if (room.mode === "pvp") {
    return 1;
  }
  return Number((0.82 + (wave - 1) * 0.08).toFixed(2));
}

function getTargetBudget(room: GameRoom, wave: number) {
  if (room.mode === "pvp") {
    return MAX_TARGETS;
  }
  const soloBudget = 3 + Math.floor((wave - 1) * 0.95);
  const extraPlayerBudget = (Math.max(1, room.players.size) - 1) * 2;
  return Math.min(soloBudget + extraPlayerBudget, MAX_TARGETS);
}

function getTargetQuota(room: GameRoom, wave: number) {
  if (room.mode === "pvp") {
    return 0;
  }
  const soloQuota = 5 + Math.floor((wave - 1) * 2.2);
  const extraPlayerQuota = (Math.max(1, room.players.size) - 1) * 4;
  return Math.min(soloQuota + extraPlayerQuota, 32);
}

function getRemainingTargetQuota(room: GameRoom) {
  if (room.mode !== "pve") {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, room.round.targetQuota - room.round.targetsCleared);
}

function seedInitialTargets(room: GameRoom) {
  const count = Math.min(getRemainingTargetQuota(room), Math.max(2, Math.ceil(room.round.targetBudget * INITIAL_TARGET_FILL_RATIO)));
  for (let i = 0; i < count; i += 1) {
    spawnTarget(room, true);
  }
}

function spawnDueTarget(room: GameRoom, now: number) {
  const targetLimit = Math.min(room.round.targetBudget, getRemainingTargetQuota(room));
  if (targetLimit <= 0 || room.targets.size >= targetLimit || now < room.nextTargetSpawnAt) {
    return;
  }

  spawnTarget(room, false);
  room.nextTargetSpawnAt = now + getTargetSpawnInterval(room);
}

function getTargetSpawnInterval(room: GameRoom) {
  const playerPressure = Math.max(0, room.players.size - 1) * 50;
  const wavePressure = room.mode === "pve" ? Math.min(180, (room.round.wave - 1) * 18) : 60;
  return Math.max(240, TARGET_SPAWN_INTERVAL_MS - playerPressure - wavePressure);
}

function getStreakGain(kind: TargetKind) {
  if (kind === "royal") {
    return 4;
  }
  if (kind === "runner" || kind === "bonus") {
    return 2;
  }
  if (kind === "giant") {
    return 2;
  }
  return 1;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function broadcastSnapshots() {
  for (const room of rooms.values()) {
    if (room.clients.size > 0) {
      broadcastSnapshot(room);
    }
  }
}

function broadcastSnapshot(room: GameRoom) {
  const leaderboard = [...room.players.values()]
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
    room: createRoomSummary(room),
    players: [...room.players.values()].map(({ lastShotAt: _lastShotAt, lastTauntAt: _lastTauntAt, upgradeVote: _upgradeVote, ...player }) => player),
    targets: [...room.targets.values()].map(({ wobble: _wobble, age: _age, ttl: _ttl, ...target }) => target),
    powerups: [...room.powerups.values()],
    shots: room.shots,
    taunts: room.taunts,
    leaderboard,
    round: room.round
  };

  const payload = JSON.stringify(message);
  for (const clientId of room.clients) {
    const client = clients.get(clientId);
    if (client && client.socket.readyState === client.socket.OPEN) {
      client.socket.send(payload);
    }
  }
}

function spawnTarget(room: GameRoom, initial: boolean) {
  const kind = randomKind(room);
  const fromLeft = Math.random() < 0.5;
  const isGiant = kind === "giant";
  const isRoyal = kind === "royal";
  const speedMultiplier = getDifficulty(room, room.round.wave);
  const baseSpeed = isGiant
    ? 95 + Math.random() * 45
    : isRoyal
      ? 330 + Math.random() * 80
      : kind === "bonus"
      ? 300 + Math.random() * 110
      : kind === "runner"
        ? 230 + Math.random() * 90
        : 150 + Math.random() * 80;
  const speed = baseSpeed * speedMultiplier;
  const radius = isGiant ? 78 : isRoyal ? 48 : kind === "bonus" ? 18 : kind === "runner" ? 23 : 30;
  const verticalBounds = getTargetVerticalBounds(radius);
  const baseY = randomInRange(verticalBounds.top, verticalBounds.bottom);
  const x = initial ? getInitialTargetX(fromLeft) : fromLeft ? -radius * 2.4 : WORLD_WIDTH + radius * 2.4;
  const id = `t${room.nextTargetId++}`;

  room.targets.set(id, {
    id,
    kind,
    x,
    y: baseY,
    vx: fromLeft ? speed : -speed,
    vy: 75 + Math.random() * 80,
    radius,
    points: getTargetPoints(room, kind),
    facing: fromLeft ? 1 : -1,
    flap: Math.random() * Math.PI * 2,
    wobble: 2.2 + Math.random() * 2.8,
    age: 0,
    ttl: isRoyal ? 5.5 + Math.random() * 1.5 : isGiant ? 13 + Math.random() * 3 : 7 + Math.random() * 5
  });
}

function getTargetPoints(room: GameRoom, kind: TargetKind) {
  const base = kind === "royal" ? 250 : kind === "giant" ? 75 : kind === "bonus" ? 25 : kind === "runner" ? 15 : 10;
  return Math.round(base * getScoreMultiplier(room));
}

function getInitialTargetX(fromLeft: boolean) {
  const padding = WORLD_WIDTH * 0.12;
  const laneWidth = WORLD_WIDTH * 0.28;
  return fromLeft ? padding + Math.random() * laneWidth : WORLD_WIDTH - padding - Math.random() * laneWidth;
}

function getTargetVerticalBounds(radius: number) {
  const labelClearance = radius + Math.max(18, radius * 0.36) + 12;
  const bottom = Math.min(TARGET_SPAWN_AREA.bottom - radius, WORLD_HEIGHT - 132 - labelClearance);
  return {
    top: TARGET_SPAWN_AREA.top + radius,
    bottom
  };
}

function randomKind(room: GameRoom): TargetKind {
  const hasGiant = [...room.targets.values()].some((target) => target.kind === "giant");
  const hasRoyal = [...room.targets.values()].some((target) => target.kind === "royal");
  const roll = Math.random();
  const pressure = room.mode === "pve" ? Math.min(0.04, (room.round.wave - 1) * 0.004) : 0;
  if (!hasRoyal && roll > 0.996 - pressure * 0.25) {
    return "royal";
  }
  if (!hasGiant && roll > 0.978 - pressure) {
    return "giant";
  }
  if (roll > 0.93 - pressure) {
    return "bonus";
  }
  if (roll > 0.72 - pressure) {
    return "runner";
  }
  return "cluck";
}

function randomInRange(min: number, max: number) {
  return min + Math.random() * Math.max(0, max - min);
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
    aimX: WORLD_WIDTH / 2,
    aimY: WORLD_HEIGHT / 2,
    activePowerups: [],
    lastShotAt: 0,
    lastTauntAt: 0
  };
}

function createRoom(name: string, mode: GameMode, now: number): GameRoom {
  const room: GameRoom = {
    id: `r${nextRoomId++}`,
    name,
    mode,
    createdAt: now,
    clients: new Set<string>(),
    players: new Map<string, Player>(),
    targets: new Map<string, Target>(),
    powerups: new Map<string, Powerup>(),
    shots: [],
    taunts: [],
    coopRun: createCoopRun(),
    round: undefined as unknown as RoundSnapshot,
    nextTargetId: 1,
    nextPowerupId: 1,
    nextShotId: 1,
    nextTauntId: 1,
    nextTargetSpawnAt: now
  };
  room.round = createRound(room, 1, now);
  room.emptySince = now;
  return room;
}

function createCoopRun(): CoopRun {
  return {
    teamScore: 0,
    morale: BASE_TEAM_MORALE,
    maxMorale: BASE_TEAM_MORALE,
    escapedTargets: 0,
    upgrades: {}
  };
}

function getRoomSummaries(): RoomSummary[] {
  return [...rooms.values()].sort((a, b) => b.createdAt - a.createdAt).map((room) => createRoomSummary(room));
}

function createRoomSummary(room: GameRoom): RoomSummary {
  return {
    id: room.id,
    name: room.name,
    mode: room.mode,
    playerCount: room.players.size,
    roundNumber: room.round.number,
    wave: room.round.wave,
    state: room.round.state,
    createdAt: room.createdAt
  };
}

function cleanupEmptyRooms(now: number) {
  for (const [id, room] of rooms) {
    if (room.players.size === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
      rooms.delete(id);
    }
  }
}

function getRoomScore(room: GameRoom) {
  return [...room.players.values()].reduce((total, player) => total + player.score, 0);
}

function sanitizeName(name: string): string {
  const clean = name.replace(/[^\w -]/g, "").trim().slice(0, 16);
  return clean.length > 0 ? clean : "Player";
}

function sanitizeRoomName(name: string, mode: GameMode): string {
  const clean = name.replace(/[^\w -]/g, "").trim().slice(0, 24);
  return clean.length > 0 ? clean : mode === "pve" ? "Coop Run" : "Classic PvP";
}

function parseMessage(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.type === "join" && typeof parsed.name === "string" && typeof parsed.roomId === "string") {
      return { type: "join", name: parsed.name, roomId: parsed.roomId };
    }
    if (parsed.type === "shoot" && typeof parsed.x === "number" && typeof parsed.y === "number" && typeof parsed.seq === "number") {
      return { type: "shoot", x: parsed.x, y: parsed.y, seq: parsed.seq };
    }
    if (parsed.type === "aim" && typeof parsed.x === "number" && typeof parsed.y === "number") {
      return { type: "aim", x: parsed.x, y: parsed.y };
    }
    if (parsed.type === "taunt") {
      return { type: "taunt" };
    }
    if (parsed.type === "choose_upgrade" && isUpgradeKind(parsed.kind)) {
      return { type: "choose_upgrade", kind: parsed.kind };
    }
  } catch {
    return null;
  }

  return null;
}

function isUpgradeKind(kind: unknown): kind is UpgradeKind {
  return typeof kind === "string" && Object.hasOwn(UPGRADE_CATALOG, kind);
}

function randomTaunt(): string {
  const options = ["too slow", "nice miss", "my coop now", "keep firing", "easy points", "aim higher"];
  return options[Math.floor(Math.random() * options.length)];
}

function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
