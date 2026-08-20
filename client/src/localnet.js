import { GameWorld } from '../../server/world.js';
import { Player, giveStarterKit } from '../../server/player.js';
import { WORLD_SEED } from '../../shared/constants.js';
import { normaliseName } from '../../shared/names.js';

/**
 * Single-player transport: the same authoritative GameWorld the dedicated
 * server runs, ticking inside the page instead of across a socket. It exposes
 * the same surface as Net, so main.js cannot tell the difference.
 *
 * The character lives in localStorage, which may be unavailable (private
 * windows, blocked site data) - every access is guarded and the game still
 * runs, it simply will not remember you.
 */
const SAVE_KEY = 'aetheria.character.v1';
const AUTOSAVE_MS = 15000;

export function readSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeSave(save) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
    return true;
  } catch {
    return false;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* nothing we can do, and nothing that should stop play */
  }
}

export class LocalNet {
  constructor() {
    this.handlers = new Map();
    this.world = null;
    this.player = null;
    this.autosave = null;
    this.offline = true;
  }

  on(op, handler) {
    this.handlers.set(op, handler);
    return this;
  }

  connect() {
    queueMicrotask(() => this.handlers.get('open')?.());
  }

  /** Deliver a server-authored message to the client handlers. */
  deliver(msg) {
    this.handlers.get(msg.op)?.(msg);
  }

  send(op, payload = {}) {
    if (op === 'login') {
      this.login(payload);
      return;
    }
    if (!this.player) return;
    if (op === 'logout') {
      this.save();
      return;
    }
    this.world.handleMessage(this.player, { op, ...payload });
  }

  login({ name }) {
    if (this.player) return;
    const save = readSave();
    const stored = save ? normaliseName(save.name) : null;
    const clean = normaliseName(name) ?? stored ?? 'adventurer';

    this.world = new GameWorld(WORLD_SEED);
    const socket = { readyState: 1, send: (data) => this.deliver(JSON.parse(data)) };
    this.player = new Player(clean, socket);
    const returning = !!save && stored === clean;
    if (returning) this.player.loadSave(save);
    else giveStarterKit(this.player);

    this.world.addPlayer(this.player);
    this.world.start();

    this.player.message(
      returning
        ? 'Welcome back. Your progress is saved in this browser.'
        : 'Your progress saves in this browser as you play.',
    );

    this.autosave = setInterval(() => this.save(), AUTOSAVE_MS);
    // Phones suspend pages rather than closing them, so this is the save that counts.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.save();
    });
    window.addEventListener('pagehide', () => this.save());
  }

  save() {
    if (!this.player) return false;
    return writeSave(this.player.toSave());
  }

  /** Wipe the character and reload into a fresh one. */
  reset() {
    clearSave();
    clearInterval(this.autosave);
    this.player = null;
    this.world?.stop();
    location.reload();
  }
}
