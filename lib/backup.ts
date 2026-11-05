import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { ZipArchive } from 'archiver';
import { DateTime } from 'luxon';
import { getDefaultSettings, type Settings } from './types';
import { log } from './logger';
import { usesPostgres } from './storage-mode';
import { familyBackupRequired, captureFamilyDatabaseSource, readFamilyBackupSettings, type CapturedFamilySource } from './family-backup';
import { captureDatabaseSource, withProtectedAssetCapture, type CapturedSource } from './db-migration';

const backupDir = () => path.join(process.cwd(), 'backups');
const dataDir = () => path.join(process.cwd(), 'data');
const MAX_BACKUPS = 7; // Number of backups to keep

async function ensureBackupDir() {
  try {
    await fs.access(backupDir());
  } catch {
    await fs.mkdir(backupDir(), { recursive: true, mode: 0o700 });
    log('info', 'Created backup directory', backupDir());
  }
  const directory = await fs.lstat(backupDir());
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe backup directory');
  await fs.chmod(backupDir(), 0o700);
}

async function rotateBackups() {
  try {
    await ensureBackupDir();
    const files = await fs.readdir(backupDir());
    const backupFiles = files
      .filter(file => file.startsWith('backup-') && file.endsWith('.zip'))
      .map(file => ({
        name: file,
        path: path.join(backupDir(), file),
      }));

    if (backupFiles.length <= MAX_BACKUPS) {
      log('debug', `Rotation check: ${backupFiles.length} backups found, no rotation needed.`);
      return; // No rotation needed
    }

    log('info', `Rotation check: ${backupFiles.length} backups found, starting rotation.`);

    // Get stats to sort by creation time (mtime as proxy)
    const fileStats = await Promise.all(
      backupFiles.map(async (file) => ({
        ...file,
        stat: await fs.stat(file.path),
      }))
    );

    // Sort oldest first
    fileStats.sort((a, b) => a.stat.mtime.getTime() - b.stat.mtime.getTime());

    const filesToDelete = fileStats.slice(0, fileStats.length - MAX_BACKUPS);
    log('debug', `Identified ${filesToDelete.length} backups to delete.`);

    for (const file of filesToDelete) {
      try {
        await fs.unlink(file.path);
        log('info', `Rotated old backup: ${file.name}`);
      } catch (err) {
        log('error', `Error deleting old backup ${file.name}`, err);
      }
    }
  } catch (error) {
    log('error', 'Error during backup rotation', error);
  }
}

export async function runBackup(options: { scheduled?: boolean } = {}) {
  let leaseOwner: string | undefined;
  try {
    let settings: Settings;
    let databaseSource: CapturedSource | CapturedFamilySource | undefined;
    if (usesPostgres()) {
      databaseSource = await withProtectedAssetCapture(async () => {
        const source = await familyBackupRequired() ? await captureFamilyDatabaseSource(dataDir()) : await captureDatabaseSource(dataDir());
        const sourceSettings = source.manifest.version === 2 ? readFamilyBackupSettings(source as CapturedFamilySource) : (source as CapturedSource).snapshot.settings;
        if (sourceSettings.system.autoBackupEnabled && options.scheduled) {
          const { currentDatabaseClient } = await import('./db/client');
          const owner = randomUUID();
          const claimed = await currentDatabaseClient()!.query(
            `INSERT INTO job_leases(name, owner, expires_at) VALUES ('scheduled-backup', $1, (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC')
             ON CONFLICT(name) DO UPDATE SET owner=EXCLUDED.owner, expires_at=EXCLUDED.expires_at WHERE job_leases.expires_at <= now() RETURNING owner`, [owner]);
          if (!claimed.rowCount) return undefined;
          leaseOwner = owner;
        }
        return source;
      });
      if (!databaseSource) return;
      settings = databaseSource.manifest.version === 2 ? readFamilyBackupSettings(databaseSource as CapturedFamilySource) : (databaseSource as CapturedSource).snapshot.settings;
    } else try {
      settings = JSON.parse(await fs.readFile(path.join(dataDir(), 'settings.json'), 'utf8')) as Settings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      settings = getDefaultSettings();
    }
    if (!settings.system.autoBackupEnabled) {
      log('debug', 'Auto backup is disabled; skipping backup.');
      return;
    }

    log('info', 'Starting daily backup');
    await ensureBackupDir();

    const timestamp = DateTime.now().toFormat('yyyy-MM-dd_HH-mm-ss');
    const backupFileName = `backup-${timestamp}-${randomUUID()}.zip`;
    const backupFilePath = path.join(backupDir(), backupFileName);
    const stagingPath = path.join(backupDir(), `.${backupFileName}.tmp`);

    const output = createWriteStream(stagingPath, { flags: 'wx', mode: 0o600 });
    const archive = new ZipArchive({
      zlib: { level: 9 } // Sets the compression level.
    });
    let archiveFailure: Error | undefined;
    const completed = new Promise<void>((resolve, reject) => {
      output.once('error', error => {
        archiveFailure ??= error;
        output.destroy();
      });
      archive.once('error', error => {
        archiveFailure ??= error;
        output.destroy();
      });
      archive.on('warning', error => {
        archiveFailure ??= error;
        log('warn', 'Archiver warning; discarding incomplete backup', error);
      });
      output.once('close', () => archiveFailure ? reject(archiveFailure) : resolve());
    });

    try {
      archive.pipe(output);
      if (databaseSource) {
        if (databaseSource.manifest.version === 2) {
          archive.append(JSON.stringify(databaseSource.snapshot, null, 2), { name: 'family-database.json', mode: 0o600 });
        } else {
          const legacySource = databaseSource as CapturedSource;
          const files = { auth: 'auth.json', habits: 'habits.json', coins: 'coins.json', wishlist: 'wishlist.json', settings: 'settings.json', adminConfig: 'admin-config.json' } as const;
          for (const [key, name] of Object.entries(files)) if (key in legacySource.snapshot) {
            archive.append(JSON.stringify(legacySource.snapshot[key as keyof typeof legacySource.snapshot], null, 2), { name, mode: 0o600 });
          }
        }
        for (const [name, bytes] of databaseSource.assets) archive.append(bytes, { name, mode: 0o600 });
        archive.append(JSON.stringify(databaseSource.manifest, null, 2), { name: 'manifest.json', mode: 0o600 });
      } else archive.directory(dataDir(), false);
      await Promise.all([archive.finalize(), completed]);
      await fs.link(stagingPath, backupFilePath);
      await fs.unlink(stagingPath);
      log('info', `Backup created: ${backupFileName} (${archive.pointer()} bytes)`);
      await rotateBackups();
    } catch (error) {
      archive.abort();
      output.destroy();
      await completed.catch(() => undefined);
      await fs.unlink(stagingPath).catch(cleanupError => {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          log('error', 'Failed to remove incomplete backup', cleanupError);
        }
      });
      throw error;
    }

  } catch (error) {
    if (leaseOwner) {
      try {
        const { withStorageTransaction, currentDatabaseClient } = await import('./db/client');
        await withStorageTransaction(async () => {
          await currentDatabaseClient()!.query("DELETE FROM job_leases WHERE name='scheduled-backup' AND owner=$1", [leaseOwner]);
        });
      } catch { log('error', 'Could not release failed scheduled backup lease'); }
    }
    if (process.env.DATABASE_URL) {
      log('error', 'Database backup failed');
      throw new Error('Database backup failed');
    }
    log('error', 'Failed to run backup', error);
    // Rethrow or handle as appropriate for the scheduler
    throw error;
  }
}
