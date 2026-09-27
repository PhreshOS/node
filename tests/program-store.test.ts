import { describe, expect, it } from "vitest"
import { programStore } from "../source/program-resources.js"

describe("ProgramStore adapter", () => {
  it("does not let an older initial snapshot override a seeded value", async () => {
    let release!: (value: unknown) => void
    const pending = new Promise<unknown>(resolve => { release = resolve })
    const store = programStore(async <Result = unknown>(_event: string, _handle: unknown, operation: unknown): Promise<Result> => {
      if (operation === "snapshot") return await pending as Result
      if (operation === "getOrSet") return { run: "one", revision: 1, value: "colors" } as Result
      throw new Error("Unexpected operation")
    }, { identity: "program", reference: "reference" }, () => () => undefined)
    const observed: unknown[] = []
    const stop = store.subscribe("tab", value => observed.push(value))
    expect(await store.getOrSet("tab", "colors")).toBe("colors")
    release({ run: "one", revision: 0, value: undefined })
    await Promise.resolve()
    expect(observed).toEqual(["colors"])
    stop()
  })

  it("retries an atomic update and follows the authoritative change once", async () => {
    let value: unknown = undefined
    let revision = 0
    const listeners = new Set<(key: string, snapshot: { run: string, revision: number, value: unknown }) => void>()
    const current = () => ({ run: "one", revision, value })
    let conflict = true
    const store = programStore(async <Result = unknown>(event: string, _handle: unknown, operation: unknown, key: unknown, next: unknown, expected: unknown): Promise<Result> => {
      expect(event).toBe("/program/store")
      if (operation === "snapshot") return current() as Result
      if (operation === "compareAndSet") {
        if (conflict) { conflict = false; value = "concurrent"; revision++; return { changed: false, snapshot: current() } as Result }
        if ((expected as { revision: number }).revision !== revision) return { changed: false, snapshot: current() } as Result
        if (next === value) return { changed: true, snapshot: current() } as Result
        value = next
        revision++
        for (const listener of listeners) listener(key as string, current())
        return { changed: true, snapshot: current() } as Result
      }
      throw new Error(`Unexpected operation ${String(operation)}`)
    }, { identity: "program", reference: "reference" }, subscriber => {
      listeners.add(subscriber)
      return () => { listeners.delete(subscriber) }
    })

    const observed: unknown[] = []
    const stop = store.subscribe("tab", value => observed.push(value))
    await Promise.resolve()
    expect(await store.update("tab", current => current ?? "initial")).toBe("concurrent")
    expect(observed).toEqual([undefined, "concurrent"])
    stop()
    expect(listeners.size).toBe(0)
  })
})
