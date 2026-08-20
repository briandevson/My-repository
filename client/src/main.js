import { buildWorld } from '../../shared/worldgen.js';
import { getItem } from '../../shared/items.js';
import { OBJECTS } from '../../shared/objects.js';
import { VIEW_RADIUS } from '../../shared/constants.js';
import { GameScene } from './scene.js';
import { UI } from './ui.js';
import { Net } from './net.js';

const canvas = document.getElementById('view');
const net = new Net();

let scene = null;
let world = null;
let selfId = null;
let latest = { players: [], npcs: [], ground: [], self: null };
/** Set while the player is mid "Use item on ..." interaction. */
let pendingUse = null;

/** Exposed for the automated play test in tools/playtest.js. */
const debug = { net, get scene() { return scene; }, get world() { return world; }, latest, inventory: [] };
window.__aetheria = debug;

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

const ui = new UI({
  onLogin(name, password) {
    ui.loginError('');
    net.send('login', { name, password });
  },
  onChat(text) {
    net.send('chat', { text });
  },
  onWalk(x, y) {
    net.send('walk', { x, y });
  },
  onSetting(key, value) {
    net.send('setting', { key, value });
  },
  onSelectSpell(id) {
    net.send('setting', { key: 'spell', value: id });
    net.send('setting', { key: 'autocast', value: true });
    ui.addMessage(`Autocast set to ${id.replace(/_/g, ' ')}. Click Combat > Controlled to go back to melee.`);
  },
  onInventory(act, slot) {
    net.send('inv', { act, slot });
  },
  onUnequip(slot) {
    net.send('inv', { act: 'unequip', slot: 0, equipSlot: slot });
  },
  onBeginUse(index, slot) {
    pendingUse = { index, slot };
    ui.addMessage(`Use ${getItem(slot.id).name} on what?`);
  },
  onInventoryClick(index, slot, event) {
    if (pendingUse && pendingUse.index !== index) {
      net.send('inv', { act: 'use', slot: pendingUse.index, targetKind: 'item', to: index });
      pendingUse = null;
      return;
    }
    const item = getItem(slot.id);
    if (event.shiftKey) {
      net.send('inv', { act: 'drop', slot: index });
      return;
    }
    if (item.equip) net.send('inv', { act: 'equip', slot: index });
    else if (item.edible || item.drinkable) net.send('inv', { act: 'eat', slot: index });
    else if (item.prayerXp) net.send('inv', { act: 'bury', slot: index });
    else if (item.cleanable) net.send('inv', { act: 'clean', slot: index });
    else ui.showItemMenu(event.clientX, event.clientY, index, slot);
  },
  onMenuChoice(choice) {
    net.send('menu', { choice });
  },
  onBank(act, slot, count) {
    net.send('bank', { act, slot, count });
  },
  onShop(act, payload) {
    net.send('shop', { act, ...payload });
  },
});

// ---------------------------------------------------------------------------
// Network handlers
// ---------------------------------------------------------------------------

net.on('error', (msg) => ui.loginError(msg.reason));

net.on('welcome', (msg) => {
  selfId = msg.id;
  world = buildWorld(msg.seed);
  scene = new GameScene(canvas, world);
  scene.selfId = selfId;
  ui.enterWorld();
  window.addEventListener('resize', () => scene.resize());
  scene.resize();
});

net.on('snapshot', (msg) => {
  if (!scene) return;
  latest = msg;
  debug.latest = msg;
  scene.setOverrides(msg.objects, msg.self.x, msg.self.y, VIEW_RADIUS);
  scene.streamObjects(msg.self.x, msg.self.y);
  scene.syncEntities(msg.players, msg.npcs);
  scene.syncGroundItems(msg.ground);
  ui.updateSelf(msg.self);
  ui.drawMinimap(world, msg.self, msg.players.filter((p) => p.id !== selfId), msg.npcs, msg.ground);
});

net.on('message', (msg) => ui.addMessage(msg.text, msg.chat ? 'chatline' : 'system'));
net.on('levelup', (msg) => ui.addMessage(`Level up: ${msg.skill} is now ${msg.level}!`, 'levelup'));
net.on('stats', (msg) => ui.renderStats(msg.stats, msg.combat, msg.quests));
net.on('inventory', (msg) => {
  debug.inventory = msg.items;
  ui.renderInventory(msg.items);
  ui.refreshBank();
  ui.refreshShop();
});
net.on('equipment', (msg) => ui.renderEquipment(msg.equipment, msg.bonuses));
net.on('bankdata', (msg) => {
  ui.bankItems = msg.items;
  ui.refreshBank();
});
net.on('openbank', () => ui.showBank(ui.bankItems ?? []));
net.on('openshop', (msg) => ui.showShop(msg));
net.on('menu', (msg) => ui.showChoiceMenu(msg.title, msg.options));
net.on('dialogue', (msg) => ui.showDialogue(msg.name, msg.lines));
net.on('die', () => ui.addMessage('You have died. You keep your three most valuable items.', 'levelup'));
net.on('close', () => ui.showLogin('Connection lost. Log in again.'));

net.connect();

// ---------------------------------------------------------------------------
// Mouse and keyboard
// ---------------------------------------------------------------------------

function toNdc(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
    y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
  };
}

/** Context-menu entries for whatever is under the cursor. */
function optionsFor(hit) {
  if (!hit) return [];
  if (hit.kind === 'tile') {
    return [{ label: 'Walk here', run: () => net.send('walk', { x: hit.x, y: hit.y }) }];
  }
  if (hit.kind === 'ground') {
    return [
      { label: `Take ${hit.name}`, run: () => net.send('action', { kind: 'ground', id: hit.uid }) },
      { label: 'Walk here', run: () => walkToPick(hit) },
    ];
  }
  if (hit.kind === 'object') {
    const def = OBJECTS[hit.type] ?? {};
    const send = (option) => net.send('action', { kind: 'object', index: hit.index, option });
    const options = [];
    const verb = {
      tree: 'Chop down',
      rock: 'Mine',
      fishing: 'Fish',
      bank: 'Use bank',
      furnace: 'Smelt ore',
      anvil: 'Smith',
      range: 'Cook on',
      fire: 'Cook on',
      altar: 'Pray at',
      stall: 'Steal from',
      agility: 'Attempt',
      door: 'Open',
    }[def.kind];
    if (verb) options.push({ label: `${verb} ${def.name?.toLowerCase() ?? ''}`.trim(), run: () => send('use') });
    if (pendingUse) {
      options.unshift({
        label: `Use ${getItem(pendingUse.slot.id).name} on ${def.name ?? 'it'}`,
        run: () => {
          net.send('inv', { act: 'use', slot: pendingUse.index, targetKind: 'object', index: hit.index });
          pendingUse = null;
        },
      });
    }
    options.push({ label: 'Examine', run: () => send('examine') });
    return options;
  }
  if (hit.kind === 'entity') {
    const data = hit.data;
    const send = (option) => net.send('action', { kind: data.kind, id: hit.id, option });
    const options = [];
    if (data.kind === 'npc') {
      if (data.level > 0) options.push({ label: `Attack ${data.name} (level ${data.level})`, run: () => send('attack') });
      options.push({ label: `Talk to ${data.name}`, run: () => send('talk') });
      options.push({ label: `Pickpocket ${data.name}`, run: () => send('pickpocket') });
    } else if (hit.id !== selfId) {
      options.push({ label: `Attack ${data.name}`, run: () => send('attack') });
      options.push({ label: `Follow ${data.name}`, run: () => walkToPick(data) });
    }
    options.push({ label: 'Examine', run: () => send('examine') });
    return options;
  }
  return [];
}

function walkToPick(target) {
  net.send('walk', { x: Math.round(target.x), y: Math.round(target.y) });
}

/** Left-click performs the first, most obvious option. */
function defaultAction(hit) {
  if (!hit) return;
  if (pendingUse) {
    if (hit.kind === 'object') {
      net.send('inv', { act: 'use', slot: pendingUse.index, targetKind: 'object', index: hit.index });
      pendingUse = null;
      return;
    }
    pendingUse = null;
  }
  if (hit.kind === 'tile') {
    net.send('walk', { x: hit.x, y: hit.y });
    scene.showMarker(hit.x, hit.y);
    return;
  }
  if (hit.kind === 'ground') {
    net.send('action', { kind: 'ground', id: hit.uid });
    return;
  }
  if (hit.kind === 'object') {
    net.send('action', { kind: 'object', index: hit.index, option: 'use' });
    return;
  }
  if (hit.kind === 'entity') {
    const data = hit.data;
    if (data.kind === 'npc') {
      net.send('action', { kind: 'npc', id: hit.id, option: data.level > 0 ? 'attack' : 'talk' });
    }
  }
}

let dragging = false;
let dragMoved = false;
let lastPointer = { x: 0, y: 0 };

canvas.addEventListener('pointerdown', (event) => {
  if (!scene) return;
  if (event.button === 2) {
    dragging = true;
    dragMoved = false;
    lastPointer = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  }
});

canvas.addEventListener('pointermove', (event) => {
  if (!scene || !dragging) return;
  const dx = event.clientX - lastPointer.x;
  const dy = event.clientY - lastPointer.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
  scene.cameraYaw -= dx * 0.006;
  scene.cameraPitch = Math.max(0.25, Math.min(1.35, scene.cameraPitch + dy * 0.004));
  lastPointer = { x: event.clientX, y: event.clientY };
});

canvas.addEventListener('pointerup', (event) => {
  if (!scene) return;
  if (event.button === 2) {
    dragging = false;
    if (!dragMoved) {
      const ndc = toNdc(event);
      const hit = scene.pick(ndc.x, ndc.y);
      const options = optionsFor(hit);
      if (options.length > 0) ui.showContextMenu(event.clientX, event.clientY, titleFor(hit), options);
    }
    return;
  }
  if (event.button === 0) {
    ui.hideContextMenu();
    const ndc = toNdc(event);
    defaultAction(scene.pick(ndc.x, ndc.y));
  }
});

function titleFor(hit) {
  if (!hit) return '';
  if (hit.kind === 'object') return OBJECTS[hit.type]?.name ?? 'Object';
  if (hit.kind === 'entity') return hit.data.name;
  if (hit.kind === 'ground') return hit.name;
  return 'Ground';
}

canvas.addEventListener('wheel', (event) => {
  if (!scene) return;
  event.preventDefault();
  scene.cameraDistance = Math.max(5, Math.min(30, scene.cameraDistance + Math.sign(event.deltaY) * 1.4));
}, { passive: false });

document.addEventListener('keydown', (event) => {
  if (!scene || document.activeElement === document.getElementById('chatinput')) return;
  if (event.key === 'ArrowLeft') scene.cameraYaw -= 0.12;
  if (event.key === 'ArrowRight') scene.cameraYaw += 0.12;
  if (event.key === 'ArrowUp') scene.cameraPitch = Math.min(1.35, scene.cameraPitch + 0.06);
  if (event.key === 'ArrowDown') scene.cameraPitch = Math.max(0.25, scene.cameraPitch - 0.06);
  if (event.key.toLowerCase() === 'r') net.send('setting', { key: 'run', value: !(latest.self?.running ?? false) });
});

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

let previous = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - previous) / 1000);
  previous = now;
  if (scene) scene.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
