import { GameWorld } from '../../server/world.js';
import { Player, giveStarterKit } from '../../server/player.js';
import { WORLD_SEED } from '../../shared/constants.js';
import { normaliseName, displayName } from '../../shared/names.js';

/**
 * DEMO ONLY. Not part of the game.
 *
 * The game is online: one server, one shared world, everyone in it. This module
 * exists so a single-player snapshot can be published as a static page for
 * people to try without joining a server. tools/build-demo.js swaps it in for
 * client/src/net.js at build time, so nothing under client/ knows it exists.
 *
 * The same authoritative GameWorld the server runs ticks inside the page
 * instead of across a socket, and the character is kept in browser storage.
 */
const SAVE_KEY = 'aetheria.demo.character.v1';
const AUTOSAVE_MS = 15000;

function readSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // private windows and blocked storage: play on, just forgetfully
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

function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* nothing to do */
  }
}

/** Recast the login screen for a demo: no accounts, no passwords, one button. */
function dressLoginScreen() {
  const $ = (id) => document.getElementById(id);
  const save = readSave();

  const tagline = document.querySelector('.tagline');
  if (tagline) tagline.textContent = 'A single-player taste of a shared world of skills, monsters and slow, stubborn progress.';

  const password = $('login-pass');
  if (password) {
    password.value = 'demo';
    password.closest('label')?.setAttribute('hidden', '');
  }
  const create = $('login-create');
  if (create) create.setAttribute('hidden', '');

  const go = $('login-go');
  if (go) go.textContent = save ? `Continue as ${displayName(save.name)}` : 'Enter the world';
  if (save && $('login-name')) $('login-name').value = displayName(save.name);

  const hint = document.querySelector('.hint');
  if (hint) {
    hint.innerHTML = save
      ? 'Single-player demo. Your character is saved in this browser. <a href="#" id="demo-reset" style="color:#b9a888">Start over</a>'
      : 'Single-player demo — the full game is multiplayer. Your character is saved in this browser.';
  }
  document.getElementById('demo-reset')?.addEventListener('click', (event) => {
    event.preventDefault();
    clearSave();
    location.reload();
  });
}

/** Nothing to be social with in single player. */
function hideMultiplayerUi() {
  document.querySelector('.tab[data-tab="social"]')?.remove();
  document.getElementById('page-social')?.remove();
}

export class Net {
  constructor() {
    this.handlers = new Map();
    this.world = null;
    this.player = null;
  }

  on(op, handler) {
    this.handlers.set(op, handler);
    return this;
  }

  connect() {
    dressLoginScreen();
    queueMicrotask(() => this.handlers.get('open')?.());
  }

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

    hideMultiplayerUi();
    this.world.addPlayer(this.player);
    this.world.start();

    this.player.message(
      returning
        ? 'Welcome back. Your progress is saved in this browser.'
        : 'This is a single-player demo. The full game is multiplayer - see the repository to run a server.',
    );

    setInterval(() => this.save(), AUTOSAVE_MS);
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
}
