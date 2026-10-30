// Mirror bin/minipod.mjs: swallow only Node 22's `node:sqlite` ExperimentalWarning in tests.
const defaultWarningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  for (const listener of defaultWarningListeners) listener.call(process, warning);
});
