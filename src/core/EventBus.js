/**
 * EventBus — the single nervous system of the game.
 *
 * Every subsystem talks through here rather than importing each other, so
 * battle can trigger audio stingers without knowing audio exists, and UI can
 * react to damage without reaching into the combat resolver.
 *
 * Event names are namespaced with `:` and documented in docs/ARCHITECTURE.md.
 * Adding an event is cheap; changing an existing payload is not — subsystems
 * are written against those shapes.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
    /** @type {Set<Function>} */
    this._any = new Set();
    this.debug = false;
  }

  /**
   * Subscribe to an event. Returns an unsubscribe function so callers can
   * clean up without needing to hold onto the original handler reference.
   * @param {string} type
   * @param {(payload:any, type:string) => void} handler
   * @returns {() => void}
   */
  on(type, handler) {
    let set = this._handlers.get(type);
    if (!set) {
      set = new Set();
      this._handlers.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }

  /** Subscribe for exactly one firing. */
  once(type, handler) {
    const off = this.on(type, (payload, t) => {
      off();
      handler(payload, t);
    });
    return off;
  }

  /** Subscribe to every event; used by the debug overlay and the replay log. */
  onAny(handler) {
    this._any.add(handler);
    return () => this._any.delete(handler);
  }

  off(type, handler) {
    const set = this._handlers.get(type);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this._handlers.delete(type);
  }

  /**
   * Fire an event. Handlers are copied before iteration so a handler may
   * safely subscribe or unsubscribe during dispatch. A throwing handler is
   * logged and skipped — one broken listener must never stall the frame.
   */
  emit(type, payload) {
    if (this.debug) console.debug('[bus]', type, payload);
    const set = this._handlers.get(type);
    if (set) {
      for (const handler of [...set]) {
        try {
          handler(payload, type);
        } catch (err) {
          console.error(`[EventBus] handler for "${type}" threw`, err);
        }
      }
    }
    for (const handler of [...this._any]) {
      try {
        handler(payload, type);
      } catch (err) {
        console.error('[EventBus] wildcard handler threw', err);
      }
    }
  }

  /** Drop every subscription. Used when tearing down a scene. */
  clear() {
    this._handlers.clear();
    this._any.clear();
  }
}

/** The process-wide bus. Subsystems import this directly. */
export const bus = new EventBus();
