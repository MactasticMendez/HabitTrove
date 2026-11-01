import fs from 'fs/promises';
import { createWriteStream } from 'fs'; // Use specific import for createWriteStream
import path from 'path';
import { ZipArchive } from 'archiver';
import { DateTime } from 'luxon';
import { getDefaultSettings, type Settings } from './types';

const backupDir = () => path.join(process.cwd(), 'backups');
const dataDir = () => path.join(process.cwd(), 'data');
const MAX_BACKUPS = 7; // Number of backups to keep

async function ensureBackupDir() {
  try {
    await fs.access(backupDir());
  } catch {
    await fs.mkdir(backupDir(), { recursive: true, mode: 0o700 });
    console.log('Created backup directory:', backupDir());
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
      console.log(`Rotation check: ${backupFiles.length} backups found, less than or equal to max ${MAX_BACKUPS}. No rotation needed.`);
      return; // No rotation needed
    }

    console.log(`Rotation check: ${backupFiles.length} backups found, exceeding max ${MAX_BACKUPS}. Starting rotation.`);

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
    console.log(`Identified ${filesToDelete.length} backups to delete.`);

    for (const file of filesToDelete) {
      try {
        await fs.unlink(file.path);
        console.log(`Rotated (deleted) old backup: ${file.name}`);
      } catch (err) {
        console.error(`Error deleting old backup ${file.name}:`, err);
      }
    }
  } catch (error) {
    console.error('Error during backup rotation:', error);
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
      console.log('Auto backup is disabled in settings. Skipping backup.');
      return;
    }

    console.log('Starting daily backup...');
    await ensureBackupDir();

    const timestamp = DateTime.now().toFormat('yyyy-MM-dd_HH-mm-ss');
    const backupFileName = `backup-${timestamp}.zip`;
    const backupFilePath = path.join(backupDir(), backupFileName);

    // Use createWriteStream from fs directly
    const output = createWriteStream(backupFilePath, { flags: 'wx', mode: 0o600 });
    const archive = new ZipArchive({
      zlib: { level: 9 } // Sets the compression level.
    });

    return new Promise<void>((resolve, reject) => {
      output.on('close', async () => {
        console.log(`Backup created successfully: ${backupFileName} (${archive.pointer()} total bytes)`);
        try {
          await rotateBackups(); // Rotate after successful backup
          resolve();
        } catch (rotationError) {
          console.error("Error during post-backup rotation:", rotationError);
          // Decide if backup failure should depend on rotation failure
          // For now, resolve even if rotation fails, as backup itself succeeded.
          resolve();
        }
      });

      // Handle stream finish event for better completion tracking
      output.on('finish', () => {
        console.log('Backup file stream finished writing.');
      });

      archive.on('warning', (err) => {
        if (err.code === 'ENOENT') {
          // Log specific warnings but don't necessarily reject
          console.warn('Archiver warning (ENOENT):', err);
        } else {
          // Treat other warnings as potential issues, but maybe not fatal
          console.warn('Archiver warning:', err);
        }
      });

      archive.on('error', (err) => {
        console.error('Archiver error:', err);
        reject(err); // Reject the promise on critical archiver errors
      });

      // Pipe archive data to the file
      archive.pipe(output);

      // Append the entire data directory to the archive
      // The second argument specifies the path prefix inside the zip file (false means root)
      console.log(`Archiving directory: ${dataDir()}`);
      archive.directory(dataDir(), false);

      // Finalize the archive (writes the central directory)
      console.log('Finalizing archive...');
      archive.finalize().catch(err => {
        // Catch potential errors during finalization
        console.error('Error during archive finalization:', err);
        reject(err);
      });
    });

  } catch (error) {
    console.error('Failed to run backup:', error);
    // Rethrow or handle as appropriate for the scheduler
    throw error;
  }
}
