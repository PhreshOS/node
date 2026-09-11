import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Storage, StorageFile } from "@phreshos/core"
import { filesystemStorage } from "../dist/storage.js"
import test from "node:test"

test("Storage and StorageFile preserve one private boundary across entry points", async function () {
  const root = await mkdtemp(join(tmpdir(), "phreshos-node-storage-"))

  try {
    const storage = filesystemStorage(root, "test storage")
    const nested = storage.navigate("nested")
    const file = nested.file("value.txt")

    assert.ok(storage instanceof Storage)
    assert.ok(nested instanceof Storage)
    assert.ok(file instanceof StorageFile)

    await nested.create()
    await file.write("value", { overwrite: false })
    await file.append(" appended")

    assert.equal(await file.text(), "value appended")
    assert.equal(await file.text({ offset: 6, length: 8 }), "appended")
    assert.equal((await file.stat()).size, 14)
    assert.deepEqual(await Promise.all((await storage.list({ recursive: true })).map(async entry => [
      entry instanceof StorageFile ? "file" : "storage",
      await entry.name()
    ])), [
      ["storage", "nested"],
      ["file", "value.txt"]
    ])
    assert.ok((await storage.space()).capacity > 0)
    await assert.rejects(file.write("again", { overwrite: false }), /exist/i)
    await assert.rejects(storage.navigate("..").path(), /configured boundary/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
