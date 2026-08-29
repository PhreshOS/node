import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, normalize } from "node:path"

/** Resolve the absolute PhreshOS home selected for one System connection. */
export function resolveHome(home?: string, environment: NodeJS.ProcessEnv = process.env, userHome = homedir()) {
  const selected = home ?? environment.PHRESHOS_HOME

  if (selected === undefined) return canonical(join(userHome, ".phreshos"))
  if (!isAbsolute(selected)) throw new Error("The PhreshOS home must be an absolute filesystem path")

  return canonical(selected)
}

function canonical(path: string) {
  const normalized = normalize(path)
  return existsSync(normalized) ? realpathSync(normalized) : normalized
}
