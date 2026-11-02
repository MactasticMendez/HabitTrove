import cron from 'node-cron';
import { runBackup } from './backup';
import { log } from './logger';

let isSchedulerInitialized = false;

export function initializeScheduler() {
  if (isSchedulerInitialized) {
    log('debug', 'Scheduler already initialized');
    return;
  }

  log('info', 'Initializing scheduler');

  // Schedule backup to run daily at 2:00 AM server time
  // Format: second minute hour day-of-month month day-of-week
  // '0 2 * * *' means at minute 0 of hour 2 (2:00 AM) every day
  const backupJob = cron.schedule('0 2 * * *', async () => {
    log('info', 'Running scheduled daily backup task');
    try {
      await runBackup();
      log('info', 'Scheduled backup task completed');
    } catch (err) {
      log('error', 'Scheduled backup task failed', err);
    }
  });

  log('info', 'Scheduler initialized; daily backup scheduled for 2:00 AM server time');
  isSchedulerInitialized = true;

  // Graceful shutdown handling (optional but recommended)
  process.on('SIGTERM', () => {
    log('info', 'SIGTERM received; stopping scheduler');
    backupJob.stop();
    // Add cleanup for other jobs if needed
    process.exit(0);
  });

  process.on('SIGINT', () => {
    log('info', 'SIGINT received; stopping scheduler');
    backupJob.stop();
    // Add cleanup for other jobs if needed
    process.exit(0);
  });

  // --- Add other scheduled tasks here in the future ---
  // Example:
  // cron.schedule('* * * * *', () => {
  //   console.log('Running every minute');
  // });
}
