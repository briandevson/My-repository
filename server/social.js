import { MAX_FRIENDS, TRADE_SLOTS } from '../shared/constants.js';
import { getItem } from '../shared/items.js';
import { normaliseName, displayName } from '../shared/names.js';
import { addItem, canHold, createContainer, removeFromSlot, serialize } from './container.js';

/**
 * Friends, private messages and trading.
 *
 * Friend lists hold canonical (lowercase) names and are saved with the
 * character. Presence is pushed: when anyone logs in or out, everyone who has
 * them on their list is told, so the list is live without polling.
 */

// --- Friends ---------------------------------------------------------------

export function sendFriendList(world, player) {
  const online = new Set([...world.players.values()].map((other) => other.name));
  player.send('friends', {
    friends: [...player.friends].map((name) => ({
      name,
      display: displayName(name),
      online: online.has(name),
    })),
    ignores: [...player.ignores].map((name) => ({ name, display: displayName(name) })),
  });
}

/** Tell everyone who has `player` on their list that they came or went. */
export function broadcastPresence(world, player, online) {
  for (const other of world.players.values()) {
    if (other === player || !other.friends.has(player.name)) continue;
    other.message(`${player.display} has ${online ? 'logged in' : 'logged out'}.`);
    sendFriendList(world, other);
  }
}

export function handleFriend(world, player, msg) {
  const name = normaliseName(msg.name);
  const list = msg.list === 'ignore' ? player.ignores : player.friends;

  switch (msg.act) {
    case 'add': {
      if (!name) {
        player.message('That is not a valid name.');
        return;
      }
      if (name === player.name) {
        player.message('You cannot add yourself.');
        return;
      }
      if (list.size >= MAX_FRIENDS) {
        player.message('Your list is full.');
        return;
      }
      if (list.has(name)) {
        player.message(`${displayName(name)} is already on your list.`);
        return;
      }
      list.add(name);
      player.message(`${displayName(name)} added to your ${msg.list === 'ignore' ? 'ignore' : 'friends'} list.`);
      break;
    }
    case 'remove': {
      if (!name || !list.delete(name)) return;
      player.message(`${displayName(name)} removed from your list.`);
      break;
    }
    default:
      break;
  }
  sendFriendList(world, player);
}

// --- Private messages ------------------------------------------------------

export function handlePrivateMessage(world, player, msg) {
  const name = normaliseName(msg.to);
  const text = String(msg.text ?? '').slice(0, 120).replace(/[<>]/g, '').trim();
  if (!name || !text) return;

  const target = [...world.players.values()].find((other) => other.name === name);
  if (!target) {
    player.send('message', { text: `${displayName(name)} is not logged in.`, pm: true });
    return;
  }
  if (target.ignores.has(player.name)) {
    // Say nothing revealing: the sender simply sees it delivered.
    player.send('message', { text: `You tell ${target.display}: ${text}`, pm: true });
    return;
  }
  player.send('message', { text: `You tell ${target.display}: ${text}`, pm: true });
  target.send('message', { text: `${player.display} tells you: ${text}`, pm: true, from: player.name });
}

// --- Trading ---------------------------------------------------------------

/**
 * A trade runs in two stages, which is what makes it safe: stage one is the
 * offer screen, stage two is a confirmation showing exactly what is on the
 * table. Any change to either offer resets both acceptances, so nobody can
 * swap an item in after the other side has agreed.
 *
 * Offered items leave the inventory immediately and sit in escrow, so an item
 * can never be offered in a trade and spent elsewhere at the same time.
 */
export class TradeSession {
  constructor(a, b) {
    this.players = [a, b];
    this.offers = new Map([
      [a.id, createContainer(TRADE_SLOTS)],
      [b.id, createContainer(TRADE_SLOTS)],
    ]);
    this.accepted = new Map([
      [a.id, false],
      [b.id, false],
    ]);
    this.stage = 1;
  }

  other(player) {
    return this.players[0] === player ? this.players[1] : this.players[0];
  }

  offerOf(player) {
    return this.offers.get(player.id);
  }

  /** Any change invalidates both acceptances - this is the anti-scam rule. */
  reset() {
    for (const player of this.players) this.accepted.set(player.id, false);
    this.stage = 1;
  }
}

export function openTrade(world, player, targetId) {
  const target = world.players.get(targetId);
  if (!target || target === player) return;
  if (player.trade || target.trade) {
    player.message('One of you is already trading.');
    return;
  }
  if (player.pendingTradeFrom === target.id) {
    // They asked us first and we have just asked back, so both sides agreed.
    player.pendingTradeFrom = null;
    target.pendingTradeFrom = null;
    const session = new TradeSession(player, target);
    for (const side of session.players) {
      side.trade = session;
      side.path = [];
      side.action = null;
      side.pending = null;
      side.target = null;
      side.following = null;
      side.send('tradeopen', { with: session.other(side).display });
    }
    sendTradeState(session);
    return;
  }
  target.pendingTradeFrom = player.id;
  player.message(`Sending a trade request to ${target.display}...`);
  target.send('message', { text: `${player.display} wishes to trade with you.`, trade: player.id });
}

export function sendTradeState(session) {
  for (const player of session.players) {
    const other = session.other(player);
    player.send('tradeupdate', {
      stage: session.stage,
      with: other.display,
      yours: serialize(session.offerOf(player)),
      theirs: serialize(session.offerOf(other)),
      youAccepted: session.accepted.get(player.id),
      theyAccepted: session.accepted.get(other.id),
    });
  }
}

export function handleTrade(world, player, msg) {
  if (msg.act === 'request') {
    openTrade(world, player, msg.id);
    return;
  }
  const session = player.trade;
  if (!session) return;

  switch (msg.act) {
    case 'offer': {
      const slot = player.inventory[msg.slot];
      if (!slot) return;
      const offer = session.offerOf(player);
      const wanted = Math.max(1, Math.min(slot.count, msg.count ?? 1));
      if (canHold(offer, slot.id, wanted) <= 0) {
        player.message('You cannot offer any more items.');
        return;
      }
      const moved = removeFromSlot(player.inventory, msg.slot, wanted);
      addItem(offer, moved.id, moved.count);
      player.dirty.inventory = true;
      session.reset();
      break;
    }
    case 'withdraw': {
      const offer = session.offerOf(player);
      const slot = offer[msg.slot];
      if (!slot) return;
      const wanted = Math.max(1, Math.min(slot.count, msg.count ?? slot.count));
      if (canHold(player.inventory, slot.id, wanted) < wanted) {
        player.message('You do not have room for that.');
        return;
      }
      const moved = removeFromSlot(offer, msg.slot, wanted);
      addItem(player.inventory, moved.id, moved.count);
      player.dirty.inventory = true;
      session.reset();
      break;
    }
    case 'accept': {
      session.accepted.set(player.id, true);
      const other = session.other(player);
      if (!session.accepted.get(other.id)) {
        other.message(`${player.display} has accepted.`);
        break;
      }
      if (session.stage === 1) {
        // Both agreed to the offers; move to the confirmation screen.
        session.stage = 2;
        session.accepted.set(player.id, false);
        session.accepted.set(other.id, false);
        break;
      }
      completeTrade(world, session);
      return;
    }
    case 'decline':
      cancelTrade(session, `${player.display} declined the trade.`);
      return;
    default:
      return;
  }
  sendTradeState(session);
}

function offerSummary(offer) {
  return offer
    .filter(Boolean)
    .map((slot) => `${slot.count > 1 ? `${slot.count} x ` : ''}${getItem(slot.id).name}`)
    .join(', ') || 'nothing';
}

export function completeTrade(world, session) {
  const [a, b] = session.players;
  const offerA = session.offerOf(a);
  const offerB = session.offerOf(b);

  // Both sides must have room for what they are about to receive.
  for (const [receiver, incoming] of [[a, offerB], [b, offerA]]) {
    const room = createContainer(receiver.inventory.length);
    for (let i = 0; i < receiver.inventory.length; i++) room[i] = receiver.inventory[i] ? { ...receiver.inventory[i] } : null;
    for (const slot of incoming.filter(Boolean)) {
      if (addItem(room, slot.id, slot.count) < slot.count) {
        cancelTrade(session, `${receiver.display} does not have room for that.`);
        return false;
      }
    }
  }

  for (const [receiver, incoming] of [[a, offerB], [b, offerA]]) {
    for (const slot of incoming.filter(Boolean)) addItem(receiver.inventory, slot.id, slot.count);
    receiver.dirty.inventory = true;
  }
  a.message(`Trade complete. You received: ${offerSummary(offerB)}.`);
  b.message(`Trade complete. You received: ${offerSummary(offerA)}.`);
  closeTrade(session);
  return true;
}

/** Return every escrowed item and shut the screen. */
export function cancelTrade(session, reason = 'The trade was cancelled.') {
  for (const player of session.players) {
    const offer = session.offerOf(player);
    for (const slot of offer.filter(Boolean)) {
      // The items came out of this inventory a moment ago, so they fit; if the
      // player somehow has no room, drop nothing on the floor - keep it simple
      // and give back what fits, then tell them.
      if (addItem(player.inventory, slot.id, slot.count) < slot.count) {
        player.message('Some items could not be returned - your inventory is full.');
      }
    }
    player.dirty.inventory = true;
    player.message(reason);
  }
  closeTrade(session);
}

function closeTrade(session) {
  for (const player of session.players) {
    player.trade = null;
    player.pendingTradeFrom = null;
    player.send('tradeclose', {});
  }
}

/** Called when a player leaves, dies, or otherwise cannot keep trading. */
export function endTradeFor(player, reason) {
  if (!player.trade) return;
  cancelTrade(player.trade, reason);
}
