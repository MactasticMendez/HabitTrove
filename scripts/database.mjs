try {
  const { databaseCommand } = await import('../dist/database.mjs')
  await databaseCommand()
} catch (error) {
  // Driver/validation errors may contain credentials or account data. Keep CLI output private by default.
  console.error(error?.name === 'MigrationValidationError' ? error.message : 'Database command failed. Check the command, private source, explicit target database, and database availability.')
  process.exitCode = 1
}
