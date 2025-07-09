const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  white: '\x1b[37m',
  bold: '\x1b[1m',
};

const log = {
  info: (msg) => console.log(`${colors.green}[INFO] ${msg}${colors.reset}`),
  wallet: (msg) => console.log(`${colors.yellow}[WALLET] ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}[WARN] ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}[EROR] ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}[SUCCESS] ${msg}${colors.reset}`),
  loading: (msg) => console.log(`${colors.cyan}[LOADING] ${msg}${colors.reset}`),
  step: (msg) => console.log(`${colors.white}[STEP] ${msg}${colors.reset}`),
};

module.exports = log;

