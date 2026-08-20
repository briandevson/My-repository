import { Net } from './net.js';
import { LocalNet } from './localnet.js';

/**
 * OFFLINE is replaced at build time by esbuild's `define`. The standalone
 * single-file build runs the world in the page; the served build talks to the
 * dedicated server over a WebSocket.
 */
export const OFFLINE = __AETHERIA_OFFLINE__;

export function createTransport() {
  return OFFLINE ? new LocalNet() : new Net();
}
