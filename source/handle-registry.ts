/** Canonical domain handles owned for exactly one connected System context. */
export default class HandleRegistry {
  private readonly handles = new Map<string, object>()

  public obtain<Value extends object>(key: string, create: () => Value): Value {
    const existing = this.handles.get(key) as Value | undefined
    if (existing) return existing

    const value = create()
    this.handles.set(key, value)
    return value
  }

  public clear() { this.handles.clear() }
}
