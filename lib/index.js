/**
 * dsh-clipboard-menu — host half.
 *
 * DSH Desktop runs its Electron main process from a packaged, non-plugin bundle
 * (electron-runtime), so a plugin cannot reach `webContents` to pop a native
 * `Menu`. The fix therefore lives in the renderer: the browser half
 * (./client.js) installs a contextmenu listener and renders its own menu.
 *
 * This module exists only so the bundle patch has a loader row to materialise.
 * @module dsh-clipboard-menu
 */

export const name = 'dsh-clipboard-menu'

/** No host-side services are needed: the browser half carries no host state. */
export const inject = []

/** Intentionally empty: everything happens in the renderer. */
export function apply() {}

export default { name, inject, apply }
