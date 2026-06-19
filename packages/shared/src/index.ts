export const WORLD_WIDTH = 1280;
export const WORLD_HEIGHT = 720;
export const TICK_RATE = 30;
export const SNAPSHOT_RATE = 20;
export const MAX_TARGETS = 18;
export const SHOT_COOLDOWN_MS = 160;
export const MAGAZINE_SIZE = 6;
export const RELOAD_DURATION_MS = 2100;
export const MAX_POWERUPS = 4;
export const POWERUP_DURATION_MS = 8000;
export const POWERUP_TTL_MS = 11000;
export const MACHINE_GUN_COOLDOWN_MS = 35;
export const ROUND_DURATION_MS = 90_000;
export const ROUND_INTERMISSION_MS = 10_000;

export type Vec2 = {
  x: number;
  y: number;
};

export type TargetKind = "cluck" | "runner" | "bonus" | "giant" | "royal";
export type PowerupKind = "machine_gun" | "double_points" | "nuke" | "ammo_box";

export type TargetSnapshot = {
  id: string;
  kind: TargetKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  points: number;
  facing: 1 | -1;
  flap: number;
};

export type PlayerSnapshot = {
  id: string;
  name: string;
  score: number;
  shots: number;
  hits: number;
  streak: number;
  hue: number;
  ammo: number;
  magazineSize: number;
  reloadEndsAt: number;
  aimX: number;
  aimY: number;
  activePowerups: ActivePowerupSnapshot[];
};

export type ActivePowerupSnapshot = {
  kind: PowerupKind;
  expiresAt: number;
};

export type PowerupSnapshot = {
  id: string;
  kind: PowerupKind;
  x: number;
  y: number;
  radius: number;
  expiresAt: number;
};

export type ShotEvent = {
  id: string;
  playerId: string;
  playerName: string;
  playerHue: number;
  x: number;
  y: number;
  hit: boolean;
  points: number;
  targetId?: string;
  powerupKind?: PowerupKind;
  createdAt: number;
};

export type LeaderboardEntry = {
  id: string;
  name: string;
  score: number;
  hits: number;
  shots: number;
};

export type RoundState = "active" | "ended";

export type RoundSnapshot = {
  number: number;
  state: RoundState;
  startedAt: number;
  endsAt: number;
  nextRoundStartsAt?: number;
  winner?: LeaderboardEntry;
};

export type TauntEvent = {
  id: string;
  playerId: string;
  playerName: string;
  playerHue: number;
  text: string;
  x: number;
  y: number;
  createdAt: number;
};

export type ServerMessage =
  | {
      type: "welcome";
      playerId: string;
      world: {
        width: number;
        height: number;
      };
    }
  | {
      type: "snapshot";
      serverTime: number;
      players: PlayerSnapshot[];
      targets: TargetSnapshot[];
      powerups: PowerupSnapshot[];
      shots: ShotEvent[];
      taunts: TauntEvent[];
      leaderboard: LeaderboardEntry[];
      round: RoundSnapshot;
    };

export type ClientMessage =
  | {
      type: "join";
      name: string;
    }
  | {
      type: "shoot";
      x: number;
      y: number;
      seq: number;
    }
  | {
      type: "reload";
    }
  | {
      type: "aim";
      x: number;
      y: number;
    }
  | {
      type: "taunt";
    };

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function distanceSquared(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}
