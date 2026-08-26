type Listener = (...args: any[]) => void

/**
 * Small browser-safe subset of Node's EventEmitter used by the local runtime.
 * Keeping it here prevents the flight-controller worker from pulling Node
 * stream/event shims into the production bundle.
 */
export class EventEmitter {
  private readonly listeners = new Map<string | symbol, Set<Listener>>()

  setMaxListeners(_count: number): this {
    return this
  }

  eventNames(): Array<string | symbol> {
    return [...this.listeners.keys()]
  }

  on(event: string | symbol, listener: Listener): this {
    const current = this.listeners.get(event) ?? new Set<Listener>()
    current.add(listener)
    this.listeners.set(event, current)
    return this
  }

  once(event: string | symbol, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped)
      listener(...args)
    }
    return this.on(event, wrapped)
  }

  off(event: string | symbol, listener: Listener): this {
    const current = this.listeners.get(event)
    current?.delete(listener)
    if (current?.size === 0) this.listeners.delete(event)
    return this
  }

  removeListener(event: string | symbol, listener: Listener): this {
    return this.off(event, listener)
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.listeners.clear()
    else this.listeners.delete(event)
    return this
  }

  emit(event: string | symbol, ...args: any[]): boolean {
    const current = this.listeners.get(event)
    if (!current?.size) return false
    for (const listener of [...current]) listener(...args)
    return true
  }
}
