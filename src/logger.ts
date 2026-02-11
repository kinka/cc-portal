export const logger = {
  info: (...args: any[]) => {
    console.log('[INFO]', ...args);
  },
  error: (...args: any[]) => {
    console.error('[ERROR]', ...args);
  },
  warn: (...args: any[]) => {
    console.warn('[WARN]', ...args);
  },
  debug: (...args: any[]) => {
    if (process.env.DEBUG) {
      console.log('[DEBUG]', ...args);
    }
  },
  success: (...args: any[]) => {
    console.log('[SUCCESS]', ...args);
  },
};
