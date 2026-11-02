import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'

const DEFAULT_DATA_DIR = 'data'

/**
 * Checks startup permissions for the data directory
 */
interface StartupPermissionResult {
  success: boolean
  error?: { path: string; message: string; type?: 'writable_data_dir' }
}

export async function checkStartupPermissions(): Promise<StartupPermissionResult> {
  const dirPath = DEFAULT_DATA_DIR

  // Check if directory exists and is accessible
  try {
    const stats = await fs.stat(dirPath)
    if (!stats.isDirectory()) {
      return {
        success: false,
        error: {
          path: dirPath,
          message: `Path '${dirPath}' exists but is not a directory. Please ensure the data directory is properly configured.`,
          type: 'writable_data_dir'
        }
      }
    }
  } catch (statError) {
    return {
      success: false,
      error: {
        path: dirPath,
        message: `Data directory '${dirPath}' does not exist or is not accessible. Check volume mounts and permissions.`,
        type: 'writable_data_dir'
      }
    }
  }

  // Test read/write permissions with a temporary file
  const testFilePath = join(dirPath, `.habittrove-permission-test-${randomUUID()}`)
  const testContent = 'permission-test'
  let created = false
  let errorType: 'integrity' | 'permission' | undefined

  try {
    await fs.writeFile(testFilePath, testContent, { flag: 'wx', mode: 0o600 })
    created = true
    const readContent = await fs.readFile(testFilePath, 'utf8')
    if (readContent !== testContent) {
      errorType = 'integrity'
    }
  } catch {
    errorType = 'permission'
  }
  if (created) {
    try { await fs.unlink(testFilePath) } catch { errorType = 'permission' }
  }
  if (errorType) {
    return {
      success: false,
      error: {
        path: dirPath,
        message: errorType === 'integrity'
          ? `Data integrity check failed in '${dirPath}'. File system may be corrupted or have inconsistent behavior.`
          : `Insufficient read/write permissions for data directory '${dirPath}'. Check file permissions and ownership.`,
        type: 'writable_data_dir'
      }
    }
  }
  return { success: true }
}
