import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import manifest from "../package.json" with { type: "json" }
import { test } from "vitest"

test("package contract", async () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const temporary = mkdtempSync(join(tmpdir(), "phreshos-node-package-"))
  const cache = join(temporary, "npm-cache")
  const coreCandidate = process.env.PHRESHOS_CORE_PACKAGE
  const corePackage = `@phreshos/core@${manifest.devDependencies["@phreshos/core"]}`

  assert.equal(
    manifest.peerDependencies["@phreshos/core"],
    manifest.devDependencies["@phreshos/core"],
    "the published Core peer must match the verified Core dependency"
  )

  try {
    const output = execFileSync("npm", [
      "pack", "--json", "--ignore-scripts", "--pack-destination", temporary
    ], {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: cache }
    })
    const packed = JSON.parse(output)[0]
    const paths = new Set(packed.files.map(file => file.path))

    for (const path of ["dist/main.js", "dist/main.d.ts", "LICENSE", "README.md", "package.json"]) {
      assert(paths.has(path), `the package has no ${path}`)
    }

    for (const path of paths) {
      assert(
        path === "LICENSE" || path === "README.md" || path === "package.json" || path.startsWith("dist/"),
        `private repository material entered the package: ${path}`
      )
    }

    const consumer = join(temporary, "consumer")
    const archive = join(temporary, packed.filename)
    mkdirSync(consumer)
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2))
    execFileSync("npm", [
      "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock",
      archive,
      coreCandidate ?? corePackage,
      `@types/node@${manifest.devDependencies["@types/node"]}`
    ], {
      cwd: consumer,
      stdio: "inherit",
      env: { ...process.env, npm_config_cache: cache }
    })

    writeFileSync(join(consumer, "runtime.mjs"), `import assert from "node:assert/strict"
  import * as sdk from "@phreshos/node"

  assert.deepEqual(Object.keys(sdk).sort(), ["Project", "System", "gatewayAddress", "resolveHome"])
  `)
    execFileSync(process.execPath, [join(consumer, "runtime.mjs")], { cwd: consumer, stdio: "inherit" })

    writeFileSync(join(consumer, "consumer.ts"), `import { Project, System, gatewayAddress, resolveHome, type Manifest, type PackedProject, type ProjectMode, type ProjectOptions, type ProjectRunOptions } from "@phreshos/node"
  import { Program, type Process, type Storage, type StorageFile, type System as SystemContract } from "@phreshos/core"
  // @ts-expect-error shared domains are imported from Core, not republished by an environment SDK
  import { Endpoint } from "@phreshos/node"

  declare const connected: System
  const shared: SystemContract = connected
  const programs: Promise<Program[]> = connected.program.list()
  const forcedProgram: Promise<Program> = connected.program.forceCreate("./phresh.config.ts")
  // @ts-expect-error Program creation belongs to the Program capability
  connected.forceCreateProgram("./phresh.config.ts")
  const processes: Promise<Process[]> = connected.process.list()
  const storage: Storage = connected.storage.navigate("Documents")
  const storageFile: StorageFile = storage.file("example.txt")
  const storageText: Promise<string> = storageFile.text()
  const opening: Promise<Project> = Project.open()
  const address: string = gatewayAddress(resolveHome())
  let manifest: Manifest | undefined
  let packed: PackedProject | undefined
  let mode: ProjectMode = "development"
  let options: ProjectOptions = {}
  let runOptions: ProjectRunOptions = {}

  void shared
  void programs
  void forcedProgram
  void processes
  void opening
  void address
  void manifest
  void packed
  void mode
  void options
  void runOptions
  `)
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        lib: ["DOM", "ESNext"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ESNext",
        types: ["node"]
      },
      include: ["consumer.ts"]
    }, null, 2))

    const typescript = resolve(repository, "node_modules/typescript/bin/tsc")
    assert(readFileSync(typescript).length > 0, "TypeScript is not installed")
    execFileSync(process.execPath, [typescript, "-p", join(consumer, "tsconfig.json")], {
      cwd: consumer,
      stdio: "inherit"
    })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}, 120_000)
