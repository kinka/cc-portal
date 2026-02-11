import chalk from 'chalk';

export const logger = {
  info: (...args: any[]) => {
    console.log(chalk.blue('[INFO]'), ...args);
  },
  error: (...args: any[]) => {
    console.error(chalk.red('[ERROR]'), ...args);
  },
  warn: (...args: any[]) => {
    console.warn(chalk.yellow('[WARN]'), ...args);
  },
  debug: (...args: any[]) => {
    if (process.env.DEBUG) {
      console.log(chalk.gray('[DEBUG]'), ...args);
    }
  },
  success: (...args: any[]) => {
    console.log(chalk.green('[SUCCESS]'), ...args);
  },
};
