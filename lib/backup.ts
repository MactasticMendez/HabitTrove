import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { ZipArchive } from 'archiver';
import { DateTime } from 'luxon';
import { getDefaultSettings, type Settings } from './types';
import { log } from './logger';

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

export async function runBackup() {
  try {
    let settings: Settings;
    try {
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
      archive.directory(dataDir(), false);
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
    log('error', 'Failed to run backup', error);
    // Rethrow or handle as appropriate for the scheduler
    throw error;
  }
}
