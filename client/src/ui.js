import { SKILLS, TILE_TYPES, EQUIP_SLOTS, INVENTORY_SIZE } from '../../shared/constants.js';
import { getItem, ITEMS } from '../../shared/items.js';
import { SPELLS, PRAYERS } from '../../shared/spells.js';
import { levelProgress } from '../../shared/xp.js';

const MINIMAP_TILES = 44; // tiles across the minimap

const MINIMAP_COLOURS = {
  [TILE_TYPES.GRASS]: '#3f6b36',
  [TILE_TYPES.DIRT]: '#6b573c',
  [TILE_TYPES.PATH]: '#8f8163',
  [TILE_TYPES.WATER]: '#245079',
  [TILE_TYPES.SAND]: '#c0af82',
  [TILE_TYPES.STONE]: '#6f6f77',
  [TILE_TYPES.FLOOR]: '#7c684a',
};

const $ = (id) => document.getElementById(id);

/** Touch devices get different wording for every control hint. */
const TOUCH = window.matchMedia?.('(pointer: coarse)').matches ?? false;

/**
 * All DOM handling lives here. The UI never talks to the socket directly; it
 * calls back into main.js through `handlers`.
 */
export class UI {
  constructor(handlers) {
    this.handlers = handlers;
    this.stats = null;
    this.inventory = [];
    this.equipment = {};
    this.self = null;
    this.quests = {};
    this.contextOpen = false;
    this.friends = [];
    this.friendNames = new Set();
    this.trade = null;

    this.bindLogin();
    this.bindTabs();
    this.bindChat();
    this.bindOrbs();
    this.bindGlobal();
    this.bindSocial();
    this.renderInventory([]);
    this.renderCombatPage();
    this.renderPrayerPage();
    this.renderMagicPage();
    this.renderQuestPage();
    this.renderFriends([]);
  }

  // --- Wiring --------------------------------------------------------------

  bindLogin() {
    const go = (create) => {
      const name = $('login-name').value.trim();
      const pass = $('login-pass').value;
      if (!name || !pass) {
        this.loginError('Enter a name and a password.');
        return;
      }
      this.handlers.onLogin(name, pass, create);
    };
    $('login-go').addEventListener('click', () => go(false));
    $('login-create').addEventListener('click', () => go(true));
    for (const id of ['login-name', 'login-pass']) {
      $(id).addEventListener('keydown', (event) => {
        if (event.key === 'Enter') go(false);
      });
    }
  }

  bindTabs() {
    const compact = window.matchMedia('(max-width: 760px)');
    const panel = $('panel');
    // On a phone the panel starts collapsed to a tab strip so the world gets
    // the screen; picking a tab opens it, picking the open one closes it again.
    const applyCompact = () => panel.classList.toggle('collapsed', compact.matches);
    applyCompact();
    compact.addEventListener('change', applyCompact);

    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => {
        const wasActive = tab.classList.contains('active');
        if (compact.matches && wasActive) {
          panel.classList.toggle('collapsed');
          return;
        }
        panel.classList.remove('collapsed');
        for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
        for (const page of document.querySelectorAll('.page')) {
          page.classList.toggle('active', page.id === `page-${tab.dataset.tab}`);
        }
      });
    }
  }

  bindSocial() {
    if (!$('friend-add')) return;
    const add = () => {
      const name = $('friend-name').value.trim();
      if (!name) return;
      $('friend-name').value = '';
      this.handlers.onFriend('add', name);
    };
    $('friend-add').addEventListener('click', add);
    $('friend-name').addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') add();
    });
  }

  /** Friends list with live presence; offline friends sink to the bottom. */
  renderFriends(friends, ignores = []) {
    this.friends = friends;
    this.friendNames = new Set(friends.map((friend) => friend.name));
    const list = $('friends-list');
    // The single-player build removes the social panel entirely, but the world
    // still announces an (empty) friends list on login - there is nothing to
    // draw, and throwing here would abort the rest of the login.
    if (!list) return;
    list.replaceChildren();

    if (friends.length === 0) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = 'No friends yet. Add someone by name above, or press and hold a player in the world and choose Add friend. Friends show as green dots on the minimap.';
      list.appendChild(note);
    }

    const sorted = [...friends].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    for (const friend of sorted) {
      const row = document.createElement('div');
      row.className = friend.online ? 'option-row friend-row online' : 'option-row friend-row';
      row.innerHTML = `<span class="dot"></span><span class="who">${escapeHtml(friend.display)}</span><span class="meta">${friend.online ? 'online' : 'offline'}</span>`;
      row.addEventListener('click', (event) => {
        const options = [];
        if (friend.online) {
          options.push({ label: `Message ${friend.display}`, run: () => this.promptMessage(friend) });
        }
        options.push({ label: 'Remove from friends', run: () => this.handlers.onFriend('remove', friend.name) });
        options.push({ label: 'Ignore', run: () => this.handlers.onFriend('add', friend.name, 'ignore') });
        this.showContextMenu(event.clientX, event.clientY, friend.display, options);
      });
      list.appendChild(row);
    }

    const block = $('ignore-block');
    if (!block) return;
    block.replaceChildren();
    if (ignores.length > 0) {
      const heading = document.createElement('div');
      heading.className = 'empty-note';
      heading.textContent = 'Ignored';
      block.appendChild(heading);
      for (const entry of ignores) {
        const row = document.createElement('div');
        row.className = 'option-row';
        row.innerHTML = `<span>${escapeHtml(entry.display)}</span><span class="meta">tap to unignore</span>`;
        row.addEventListener('click', () => this.handlers.onFriend('remove', entry.name, 'ignore'));
        block.appendChild(row);
      }
    }
  }

  /** Compose a private message to a friend. */
  promptMessage(friend) {
    this.openModal(`
      <button class="close">Close</button>
      <h2>Message ${escapeHtml(friend.display)}</h2>
      <div class="social-add">
        <input id="pm-text" maxlength="120" placeholder="say something" />
        <button id="pm-send">Send</button>
      </div>`);
    const send = () => {
      const text = $('pm-text').value.trim();
      if (text) this.handlers.onPrivateMessage(friend.name, text);
      this.closeModal();
    };
    $('pm-send').addEventListener('click', send);
    $('pm-text').addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') send();
    });
    $('pm-text').focus();
  }

  isFriend(name) {
    return this.friendNames.has(String(name ?? '').toLowerCase().replace(/ /g, '_'));
  }

  // --- Trade ---------------------------------------------------------------

  /**
   * Two-stage trade screen. Stage one is the offer, stage two is a
   * confirmation of exactly what is on the table - any change sends both
   * sides back to stage one.
   */
  showTrade(state) {
    this.trade = state;
    const stageTwo = state.stage === 2;
    const status = stageTwo
      ? `Check the offer carefully, then confirm. ${state.theyAccepted ? `<b>${escapeHtml(state.with)} has confirmed.</b>` : `Waiting for ${escapeHtml(state.with)}.`}`
      : `${state.theyAccepted ? `<b>${escapeHtml(state.with)} has accepted.</b>` : `Waiting for ${escapeHtml(state.with)} to accept.`} Changing an offer resets both sides.`;

    if (!$('trade-window')) {
      this.openModal(`
        <button class="close" id="trade-decline">Decline</button>
        <h2 id="trade-title"></h2>
        <div id="trade-window">
          <div class="trade-status" id="trade-status"></div>
          <div class="trade-columns">
            <div class="trade-column"><h3>Your offer</h3><div class="trade-offer" id="trade-yours"></div></div>
            <div class="trade-column"><h3 id="trade-theirs-title">Their offer</h3><div class="trade-offer" id="trade-theirs"></div></div>
          </div>
          <div id="trade-inventory-block">
            <h3 class="trade-column">Your pack - pick an item to offer it</h3>
            <div class="bank-grid" id="trade-inventory"></div>
          </div>
          <div class="trade-actions">
            <button id="trade-accept" class="primary"></button>
          </div>
        </div>`);
      $('trade-decline').addEventListener('click', () => this.handlers.onTrade('decline'));
      $('trade-accept').addEventListener('click', () => this.handlers.onTrade('accept'));
    }

    $('trade-title').textContent = `Trading with ${state.with}`;
    $('trade-theirs-title').textContent = `${state.with}'s offer`;
    $('trade-status').innerHTML = status;
    $('trade-accept').textContent = state.youAccepted
      ? 'Waiting for them...'
      : stageTwo
        ? 'Confirm trade'
        : 'Accept offer';
    $('trade-accept').classList.toggle('accepted', !!state.youAccepted);
    $('trade-inventory-block').style.display = stageTwo ? 'none' : '';

    const fill = (id, items, onClick) => {
      const grid = $(id);
      grid.replaceChildren();
      for (const slot of items.filter(Boolean)) {
        const cell = document.createElement('div');
        cell.className = 'slot filled';
        cell.innerHTML = `<span class="count">${slot.count > 1 ? formatCount(slot.count) : ''}</span>${shortName(safeItem(slot.id).name)}`;
        cell.title = safeItem(slot.id).name;
        if (onClick) cell.addEventListener('click', () => onClick(items.indexOf(slot), slot));
        grid.appendChild(cell);
      }
    };

    fill('trade-yours', state.yours, stageTwo ? null : (index, slot) => this.handlers.onTrade('withdraw', { slot: index, count: slot.count }));
    fill('trade-theirs', state.theirs, null);
    if (!stageTwo) {
      const grid = $('trade-inventory');
      grid.replaceChildren();
      this.inventory.forEach((slot, index) => {
        if (!slot) return;
        grid.appendChild(
          this.makeTransferSlot(slot, `Offer ${safeItem(slot.id).name}`, (count) => this.handlers.onTrade('offer', { slot: index, count })),
        );
      });
    }
  }

  /**
   * The server sends the trade state as soon as an offer changes, but the
   * inventory only flushes at the end of the tick - so re-render the pack when
   * it lands, or offered items linger in it.
   */
  refreshTrade() {
    if (this.trade) this.showTrade(this.trade);
  }

  closeTrade() {
    this.trade = null;
    this.closeModal();
  }

  bindChat() {
    const input = $('chatinput');
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key !== 'Enter') return;
      const text = input.value.trim();
      input.value = '';
      if (text) this.handlers.onChat(text);
      input.blur();
    });
  }

  bindOrbs() {
    $('orb-energy').addEventListener('click', () => {
      this.handlers.onSetting('run', !(this.self?.running ?? false));
    });
    $('minimap').addEventListener('click', (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const scale = MINIMAP_TILES / rect.width;
      const dx = (event.clientX - rect.left - rect.width / 2) * scale;
      const dy = (event.clientY - rect.top - rect.height / 2) * scale;
      if (!this.self) return;
      this.handlers.onWalk(Math.round(this.self.x + dx), Math.round(this.self.y + dy));
    });
  }

  bindGlobal() {
    document.addEventListener('click', (event) => {
      if (!this.contextOpen) return;
      if ($('contextmenu').contains(event.target)) return;
      this.hideContextMenu();
    });
    document.addEventListener('contextmenu', (event) => event.preventDefault());
    $('modal').addEventListener('click', (event) => {
      if (event.target === $('modal')) this.closeModal();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.hideContextMenu();
        this.closeModal();
      }
      if (event.key === 'Enter' && document.activeElement !== $('chatinput')) {
        $('chatinput').focus();
      }
    });
  }

  // --- Login ---------------------------------------------------------------

  loginError(text) {
    $('login-error').textContent = text;
  }

  enterWorld() {
    $('login').hidden = true;
    $('hud').hidden = false;
  }

  showLogin(reason) {
    $('login').hidden = false;
    $('hud').hidden = true;
    if (reason) this.loginError(reason);
  }

  // --- Chat log ------------------------------------------------------------

  addMessage(text, className = 'system') {
    const log = $('chatlog');
    const line = document.createElement('div');
    line.className = className;
    line.textContent = text;
    log.appendChild(line);
    while (log.children.length > 120) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  // --- Panels --------------------------------------------------------------

  renderInventory(items) {
    this.inventory = items;
    const grid = $('inventory-grid');
    grid.replaceChildren();
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const slot = items[i];
      const cell = document.createElement('div');
      cell.className = slot ? 'slot filled' : 'slot';
      if (slot) {
        const item = safeItem(slot.id);
        cell.innerHTML = `<span class="count">${slot.count > 1 ? formatCount(slot.count) : ''}</span>${shortName(item.name)}`;
        const swatch = document.createElement('div');
        swatch.className = 'swatch';
        swatch.style.background = itemColour(slot.id);
        cell.appendChild(swatch);
        cell.title = `${item.name} - ${item.examine}`;
        cell.addEventListener('click', (event) => {
          event.stopPropagation();
          this.handlers.onInventoryClick(i, slot, event);
        });
        cell.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.showItemMenu(event.clientX, event.clientY, i, slot);
        });
      }
      grid.appendChild(cell);
    }
  }

  showItemMenu(x, y, index, slot) {
    const item = safeItem(slot.id);
    const options = [];
    if (item.equip) options.push({ label: 'Wear/Wield', run: () => this.handlers.onInventory('equip', index) });
    if (item.edible || item.drinkable) {
      options.push({ label: item.drinkable ? 'Drink' : 'Eat', run: () => this.handlers.onInventory('eat', index) });
    }
    if (item.prayerXp) options.push({ label: 'Bury', run: () => this.handlers.onInventory('bury', index) });
    if (item.cleanable) options.push({ label: 'Clean', run: () => this.handlers.onInventory('clean', index) });
    options.push({ label: 'Use', run: () => this.handlers.onBeginUse(index, slot) });
    options.push({ label: 'Drop', run: () => this.handlers.onInventory('drop', index) });
    options.push({ label: 'Examine', run: () => this.handlers.onInventory('examine', index) });
    this.showContextMenu(x, y, item.name, options);
  }

  renderEquipment(equipment, bonuses) {
    this.equipment = equipment;
    const container = $('equipment-slots');
    container.replaceChildren();
    for (const slot of EQUIP_SLOTS) {
      const worn = equipment[slot];
      const cell = document.createElement('div');
      cell.className = worn ? 'eq-slot filled' : 'eq-slot';
      cell.textContent = worn ? shortName(safeItem(worn.id).name) : slot;
      if (worn) {
        cell.title = `${safeItem(worn.id).name} (click to remove)`;
        cell.addEventListener('click', () => this.handlers.onUnequip(slot));
      }
      container.appendChild(cell);
    }
    $('equipment-bonuses').innerHTML = `
      <div>Weapon aim: <b>${bonuses.aim ?? 0}</b></div>
      <div>Weapon power: <b>${bonuses.power ?? 0}</b></div>
      <div>Armour: <b>${bonuses.armour ?? 0}</b></div>
      <div>Ranged: <b>${bonuses.ranged ?? 0}</b></div>
      <div>Magic: <b>${bonuses.magic ?? 0}</b></div>
      <div>Prayer: <b>${bonuses.prayer ?? 0}</b></div>`;
  }

  renderStats(stats, combat, quests) {
    this.stats = stats;
    this.quests = quests ?? this.quests;
    const list = $('skills-list');
    list.replaceChildren();
    let total = 0;
    for (const skill of SKILLS) {
      const stat = stats[skill];
      total += stat.level;
      const row = document.createElement('div');
      row.className = 'skill-row';
      const progress = Math.round(levelProgress(stat.xp) * 100);
      const current = skill === 'hits' ? stat.current : stat.current;
      row.innerHTML = `
        <span class="name">${skill}</span>
        <span class="lvl">${current}/${stat.level}</span>
        <span class="skill-bar"><span style="width:${progress}%"></span></span>`;
      row.title = `${Math.floor(stat.xp).toLocaleString()} xp`;
      list.appendChild(row);
    }
    $('total-level').innerHTML = `<div class="bonuses">Total level: <b>${total}</b><br>Combat level: <b>${combat}</b></div>`;
    this.renderQuestPage();
  }

  renderCombatPage() {
    const container = $('combat-styles');
    container.replaceChildren();
    const styles = [
      ['controlled', 'Controlled - shared xp'],
      ['accurate', 'Accurate - attack xp'],
      ['aggressive', 'Aggressive - strength xp'],
      ['defensive', 'Defensive - defense xp'],
    ];
    for (const [id, label] of styles) {
      const row = document.createElement('div');
      row.className = 'option-row';
      row.dataset.style = id;
      row.innerHTML = `<span>${label}</span>`;
      row.addEventListener('click', () => this.handlers.onSetting('style', id));
      container.appendChild(row);
    }
    $('combat-info').innerHTML = `
      <div class="bonuses" style="margin-top:8px">
        Left-click an enemy to attack.<br>
        Autocast is set from the Magic tab.<br>
        Run with the RUN orb or by holding Shift while clicking.
      </div>`;
  }

  renderPrayerPage() {
    const container = $('prayer-list');
    container.replaceChildren();
    for (const [id, prayer] of Object.entries(PRAYERS)) {
      const row = document.createElement('div');
      row.className = 'option-row';
      row.dataset.prayer = id;
      row.innerHTML = `<span>${prayer.name}</span><span class="meta">lvl ${prayer.level}</span>`;
      row.addEventListener('click', () => this.handlers.onSetting('prayer', id));
      container.appendChild(row);
    }
  }

  renderMagicPage() {
    const container = $('spell-list');
    container.replaceChildren();
    for (const [id, spell] of Object.entries(SPELLS)) {
      const row = document.createElement('div');
      row.className = 'option-row';
      row.dataset.spell = id;
      const runes = Object.entries(spell.runes)
        .map(([rune, count]) => `${count} ${safeItem(rune).name.replace('-rune', '')}`)
        .join(', ');
      row.innerHTML = `<span>${spell.name}</span><span class="meta">lvl ${spell.level}</span>`;
      row.title = `Runes: ${runes}`;
      row.addEventListener('click', () => {
        if (spell.utility) this.handlers.onSetting('cast', id);
        else this.handlers.onSelectSpell(id);
      });
      container.appendChild(row);
    }
  }

  renderQuestPage() {
    const stage = this.quests?.lost_heirloom ?? 0;
    const status = stage === 0 ? 'Not started' : stage === 1 ? 'In progress' : 'Complete';
    $('quest-list').innerHTML = `
      <div class="option-row"><span>The Lost Heirloom</span><span class="meta">${status}</span></div>
      <div class="bonuses" style="margin-top:10px">
        <b>Getting started</b><br>
        1. Talk to the village elder in Ashford.<br>
        2. Mine copper and tin north of the village.<br>
        3. Smelt bronze at the furnace, then use the anvil.<br>
        4. Chop trees west of town and light a fire with your tinderbox.<br>
        5. Bank your loot at the bank booths.<br><br>
        <b>Controls</b><br>
        ${TOUCH
          ? 'Tap: walk or act.<br>Long press: all options.<br>Drag: rotate camera.<br>Pinch: zoom.'
          : 'Left-click: walk / default action.<br>Right-click: all options.<br>Right-drag or arrow keys: rotate.<br>Mouse wheel: zoom.'}
        <br><br><b>Playing with others</b><br>
        Everyone on this server shares one world. Press and hold (or right-click)
        another player to trade, follow, message or add them as a friend.
        Friends show as green dots on the minimap.
      </div>`;
  }

  /** Reflect per-tick server state: orbs, active style, active prayers. */
  updateSelf(self) {
    this.self = self;
    const hits = $('orb-hits');
    hits.querySelector('.orb-value').textContent = `${self.hits}`;
    setOrbFill(hits, self.maxHits ? self.hits / self.maxHits : 0);
    const prayer = $('orb-prayer');
    prayer.querySelector('.orb-value').textContent = `${Math.floor(self.prayer)}`;
    setOrbFill(prayer, self.maxPrayer ? self.prayer / self.maxPrayer : 0);
    const energy = $('orb-energy');
    energy.querySelector('.orb-value').textContent = `${self.energy}`;
    energy.classList.toggle('running', self.running);
    setOrbFill(energy, self.energy / 100);

    $('region').textContent = self.region;

    for (const row of document.querySelectorAll('#combat-styles .option-row')) {
      row.classList.toggle('active', row.dataset.style === self.combatStyle);
    }
    for (const row of document.querySelectorAll('#prayer-list .option-row')) {
      row.classList.toggle('active', self.prayers.includes(row.dataset.prayer));
    }
    for (const row of document.querySelectorAll('#spell-list .option-row')) {
      row.classList.toggle('active', self.autocast && row.dataset.spell === self.spell);
    }
  }

  // --- Context menu --------------------------------------------------------

  showContextMenu(x, y, title, options) {
    const menu = $('contextmenu');
    menu.replaceChildren();
    if (title) {
      const header = document.createElement('div');
      header.className = 'cm-title';
      header.textContent = title;
      menu.appendChild(header);
    }
    for (const option of options) {
      const item = document.createElement('div');
      item.className = 'cm-item';
      item.textContent = option.label;
      item.addEventListener('click', () => {
        this.hideContextMenu();
        option.run();
      });
      menu.appendChild(item);
    }
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 6)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 6)}px`;
    this.contextOpen = true;
  }

  hideContextMenu() {
    $('contextmenu').hidden = true;
    this.contextOpen = false;
  }

  // --- Modals --------------------------------------------------------------

  openModal(html) {
    $('modal-card').innerHTML = html;
    $('modal').hidden = false;
    const close = $('modal-card').querySelector('.close');
    if (close) close.addEventListener('click', () => this.closeModal());
  }

  closeModal() {
    $('modal').hidden = true;
    $('modal-card').replaceChildren();
    this.bankOpen = false;
    this.shopOpen = false;
  }

  showChoiceMenu(title, options) {
    this.openModal(`<button class="close">Close</button><h2>${escapeHtml(title)}</h2><div id="choice-list"></div>`);
    const list = $('choice-list');
    options.forEach((option, index) => {
      const row = document.createElement('div');
      row.className = option.enabled === false ? 'option-row locked' : 'option-row';
      row.innerHTML = `<span>${escapeHtml(option.label)}</span><span class="meta">${option.level ? `level ${option.level}` : ''}</span>`;
      if (option.enabled !== false) {
        row.addEventListener('click', () => {
          this.closeModal();
          this.handlers.onMenuChoice(index);
        });
      }
      list.appendChild(row);
    });
  }

  showDialogue(name, lines) {
    const body = lines.map((line) => `<div class="dialogue-line">${escapeHtml(line)}</div>`).join('');
    this.openModal(`<button class="close">Close</button><h2>${escapeHtml(name)}</h2>${body}`);
  }

  showBank(items) {
    this.bankOpen = true;
    this.bankItems = items;
    this.openModal(`
      <button class="close">Close</button>
      <h2>Bank of Ashford</h2>
      <div class="bank-grid" id="bank-grid"></div>
      <h2 style="font-size:15px">Inventory</h2>
      <div class="bank-grid" id="bank-inventory"></div>
      <button class="close" id="deposit-all" style="float:left">Deposit all</button>`);
    this.refreshBank();
    $('deposit-all').addEventListener('click', () => this.handlers.onBank('depositAll'));
  }

  refreshBank() {
    if (!this.bankOpen) return;
    const bankGrid = $('bank-grid');
    const invGrid = $('bank-inventory');
    if (!bankGrid || !invGrid) return;
    bankGrid.replaceChildren();
    invGrid.replaceChildren();

    (this.bankItems ?? []).forEach((slot, index) => {
      if (!slot) return;
      bankGrid.appendChild(
        this.makeTransferSlot(slot, `Withdraw ${safeItem(slot.id).name}`, (count) => this.handlers.onBank('withdraw', index, count)),
      );
    });
    this.inventory.forEach((slot, index) => {
      if (!slot) return;
      invGrid.appendChild(
        this.makeTransferSlot(slot, `Deposit ${safeItem(slot.id).name}`, (count) => this.handlers.onBank('deposit', index, count)),
      );
    });
  }

  makeTransferSlot(slot, title, action) {
    const cell = document.createElement('div');
    cell.className = 'slot filled';
    cell.title = `${title} (right-click for all)`;
    cell.innerHTML = `<span class="count">${slot.count > 1 ? formatCount(slot.count) : ''}</span>${shortName(safeItem(slot.id).name)}`;
    cell.addEventListener('click', () => action(1));
    cell.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      action(slot.count);
    });
    return cell;
  }

  showShop(shop) {
    this.shopOpen = true;
    this.shopData = shop;
    const rows = shop.stock
      .map(
        (entry) => `
        <div class="shop-row">
          <span>${escapeHtml(safeItem(entry.id).name)}</span>
          <span><span class="meta">${entry.price} gp</span> <button data-buy="${entry.id}">Buy</button></span>
        </div>`,
      )
      .join('');
    this.openModal(`
      <button class="close">Close</button>
      <h2>${escapeHtml(shop.name)}</h2>
      ${rows}
      <h2 style="font-size:15px;margin-top:14px">Sell from your pack</h2>
      <div class="bank-grid" id="shop-inventory"></div>`);
    for (const button of document.querySelectorAll('[data-buy]')) {
      button.addEventListener('click', () => this.handlers.onShop('buy', { id: button.dataset.buy }));
    }
    this.refreshShop();
  }

  refreshShop() {
    const grid = $('shop-inventory');
    if (!grid) return;
    grid.replaceChildren();
    this.inventory.forEach((slot, index) => {
      if (!slot) return;
      grid.appendChild(
        this.makeTransferSlot(slot, `Sell ${safeItem(slot.id).name}`, () => this.handlers.onShop('sell', { slot: index })),
      );
    });
  }

  // --- Minimap -------------------------------------------------------------

  drawMinimap(world, self, players, npcs, ground) {
    const canvas = $('minimap');
    const ctx = canvas.getContext('2d');
    const scale = canvas.width / MINIMAP_TILES;
    const half = MINIMAP_TILES / 2;

    ctx.fillStyle = '#0d1218';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let dy = -half; dy < half; dy++) {
      for (let dx = -half; dx < half; dx++) {
        const x = Math.round(self.x + dx);
        const y = Math.round(self.y + dy);
        if (x < 0 || y < 0 || x >= world.size || y >= world.size) continue;
        ctx.fillStyle = MINIMAP_COLOURS[world.tiles[y * world.size + x]] ?? '#3f6b36';
        ctx.fillRect((dx + half) * scale, (dy + half) * scale, scale + 1, scale + 1);
      }
    }

    const plot = (x, y, colour, size = 3) => {
      const px = (x - self.x + half) * scale;
      const py = (y - self.y + half) * scale;
      ctx.fillStyle = colour;
      ctx.fillRect(px - size / 2, py - size / 2, size, size);
    };

    for (const object of world.objects) {
      const dx = Math.abs(object.x - self.x);
      const dy = Math.abs(object.y - self.y);
      if (dx > half || dy > half) continue;
      const type = object.type;
      if (type.endsWith('_rock')) plot(object.x, object.y, '#d0d0d0', 2);
      else if (type.endsWith('_tree') || type === 'tree') plot(object.x, object.y, '#1f4a1a', 2);
      else if (type === 'bank_booth') plot(object.x, object.y, '#39c2ff', 4);
      else if (type === 'furnace' || type === 'anvil') plot(object.x, object.y, '#ff9a3a', 4);
    }
    for (const item of ground) plot(item.x, item.y, '#ff4fd8', 3);
    for (const npc of npcs) plot(npc.x, npc.y, npc.level > 0 ? '#e04a3a' : '#f0d060', 4);
    for (const player of players) plot(player.x, player.y, this.isFriend(player.name) ? '#4ade80' : '#ffffff', 4);
    plot(self.x, self.y, '#ffe066', 6);
  }
}

// --- helpers ---------------------------------------------------------------

function setOrbFill(orb, fraction) {
  let fill = orb.querySelector('.orb-fill');
  if (!fill) {
    fill = document.createElement('div');
    fill.className = 'orb-fill';
    orb.appendChild(fill);
  }
  fill.style.height = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
}

function safeItem(id) {
  try {
    return getItem(id);
  } catch {
    return { name: id, examine: '', value: 1 };
  }
}

function shortName(name) {
  return name.length > 16 ? `${name.slice(0, 15)}.` : name;
}

function formatCount(count) {
  if (count >= 1_000_000) return `${Math.floor(count / 1_000_000)}M`;
  if (count >= 1000) return `${Math.floor(count / 1000)}K`;
  return String(count);
}

function itemColour(id) {
  const item = ITEMS[id];
  if (!item) return '#888';
  if (id === 'coins') return '#d4af37';
  if (id.includes('rune')) return '#7a5ad4';
  if (item.edible || item.cookable) return '#d4956a';
  if (item.equip?.slot === 'weapon') return '#c0c6d0';
  if (item.equip) return '#8a9ab0';
  if (id.includes('ore') || id.includes('bar') || id === 'coal') return '#9a7a5a';
  if (id.includes('logs')) return '#7a5a2a';
  return '#6b7280';
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
