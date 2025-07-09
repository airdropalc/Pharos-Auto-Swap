require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const randomUseragent = require('random-useragent');
const axios = require('axios');
const { abi: NONFUNGIBLE_POSITION_MANAGER_ABI } = require('@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json');
const log = require('./config/logger');
const { banner } = require('./config/banner');

const DODO_CONFIG = {
  router: '0x73CAfc894dBfC181398264934f7Be4e482fc9d40',
  apiUrl: 'https://api.dodoex.io/route-service/v2/widget/getdodoroute',
  apiKey: 'a37546505892e1a952',
  slippage: '3.225',
  pairs: {
    PHRS_USDT: {
      from: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', 
      to: '0xD4071393f8716661958F766DF660033b3d35fD29', 
      fromDecimals: 18,
      toDecimals: 6
    },
    USDT_PHRS: {
      from: '0xD4071393f8716661958F766DF660033b3d35fD29',
      to: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', 
      fromDecimals: 6,
      toDecimals: 18
    }
  }
};

const createErrorHandler = () => {
  const errorCounts = new Map();
  const MAX_ERRORS_BEFORE_SKIP = 2;
  let isShuttingDown = false;

  const handleError = (error, context) => {
    if (isShuttingDown) return;

    const count = (errorCounts.get(context) || 0) + 1;
    errorCounts.set(context, count);

    log.error(`[${context}] Error (${count}/${MAX_ERRORS_BEFORE_SKIP}):`, error.message);
    
    if (count >= MAX_ERRORS_BEFORE_SKIP) {
      log.warn(`[${context}] Skipping after ${MAX_ERRORS_BEFORE_SKIP} errors`);
      errorCounts.delete(context);
      return 'skip';
    }
    return 'retry';
  };

  process.on('unhandledRejection', (error, promise) => {
    const context = promise.context || 'unhandled';
    const action = handleError(error, context);
    
    if (action === 'skip') {
      promise.catch(() => {});
    }
  });

  return {
    wrap: (fn, context) => {
      return async (...args) => {
        if (isShuttingDown) return null;
        
        const promise = fn(...args);
        promise.context = context;
        
        try {
          return await promise;
        } catch (error) {
          const action = handleError(error, context);
          if (action === 'skip') return null;
          throw error;
        }
      };
    },
    shutdown: () => {
      isShuttingDown = true;
      errorCounts.clear();
    }
  };
};

const errorHandler = createErrorHandler();

const HEALTH_CHECK_INTERVAL = 300000; 
let lastHealthCheck = Date.now();

const networkConfig = {
  name: 'Pharos Testnet',
  chainId: 688688,
  rpcUrl: 'https://api.zan.top/node/v1/pharos/testnet/54b49326c9f44b6e8730dc5dd4348421',
  currencySymbol: 'PHRS',
};

const tokens = {
  USDC: '0xad902cf99c2de2f1ba5ec4d642fd7e49cae9ee37',
  WPHRS: '0x76aaada469d23216be5f7c596fa25f282ff9b364',
  USDT: '0xed59de2d7ad9c043442e381231ee3646fc3c2939',
  PHRS: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' 
};

const uniswapAddress = '0xf8a1d4ff0f9b9af7ce58e1fc1833688f3bfd6115';
const contractAddress = '0x1a4de519154ae51200b0ad7c90f7fac75547888a';

const tokenDecimals = {
  WPHRS: 18,
  USDC: 6,
  USDT: 6,
};

const contractAbi = [
  'function multicall(uint256 timestamp, bytes[] calldata data)',
];

const erc20Abi = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function deposit() payable',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)'
];

const uscdAbi = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)'
];

const MAX_RETRIES = 3;
const RETRY_DELAY = 30000;
const FREEZE_TIMEOUT = 300000; 

let isShuttingDown = false;
let cachedLoginData = {};

let proxies = [];
let proxyAssignments = {};

function healthCheck() {
  const now = Date.now();
  if (now - lastHealthCheck > HEALTH_CHECK_INTERVAL) {
    log.info('Health check: Script is running');
    lastHealthCheck = now;
  }
}

process.on('SIGINT', () => {
  isShuttingDown = true;
  log.warn('Shutting down gracefully...');
  errorHandler.shutdown();
  setTimeout(() => process.exit(0), 5000);
});

const loadProxies = () => {
  try {
    proxies = fs.readFileSync('proxies.txt', 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line);
    log.info(`Loaded ${proxies.length} proxies from file`);
    return proxies;
  } catch (error) {
    log.info('No proxy file found, continuing without proxy');
    return [];
  }
};

const assignProxyToWallet = (walletAddress) => {
  if (proxies.length === 0) return null;
  
  if (proxyAssignments[walletAddress]) {
    return proxyAssignments[walletAddress];
  }
  
  const proxyIndex = Object.keys(proxyAssignments).length % proxies.length;
  const assignedProxy = proxies[proxyIndex];
  proxyAssignments[walletAddress] = assignedProxy;
  
  log.info(`Assigned proxy ${assignedProxy} to wallet ${walletAddress}`);
  return assignedProxy;
};

const setupProvider = errorHandler.wrap(async (proxy = null) => {
  let retries = 0;
  
  while (retries < MAX_RETRIES && !isShuttingDown) {
    try {
      if (proxy) {
        log.info(`Using proxy: ${proxy}`);
        const agent = new HttpsProxyAgent(proxy);
        return new ethers.JsonRpcProvider(networkConfig.rpcUrl, {
          chainId: networkConfig.chainId,
          name: networkConfig.name,
        }, {
          fetchOptions: { agent },
          headers: { 'User-Agent': randomUseragent.getRandom() },
        });
      } else {
        log.info('Running without proxy');
        return new ethers.JsonRpcProvider(networkConfig.rpcUrl, {
          chainId: networkConfig.chainId,
          name: networkConfig.name,
        });
      }
    } catch (error) {
      if (error.code === 'ENOTFOUND' || error.message.includes('getaddrinfo ENOTFOUND')) {
        retries++;
        log.warn(`Failed to setup provider, attempt ${retries}/${MAX_RETRIES}. Waiting 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        throw error;
      }
    }
  }
  
  throw new Error(`Failed to setup provider after ${MAX_RETRIES} attempts`);
}, 'setupProvider');


const fetchDodoRoute = errorHandler.wrap(async (fromToken, toToken, walletAddress, amount) => {
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const url = `${DODO_CONFIG.apiUrl}?chainId=${networkConfig.chainId}&deadLine=${deadline}&apikey=${DODO_CONFIG.apiKey}&slippage=${DODO_CONFIG.slippage}&source=dodoV2AndMixWasm&toTokenAddress=${toToken}&fromTokenAddress=${fromToken}&userAddr=${walletAddress}&estimateGas=true&fromAmount=${amount}`;
  
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': randomUseragent.getRandom(),
        'Referer': 'https://faroswap.xyz/'
      },
      timeout: 10000
    });
    
    if (response.data.status === -1) {
      throw new Error('DODO API returned status -1');
    }
    
    if (!response.data.data) {
      throw new Error('Invalid DODO API response');
    }
    
    return response.data.data;
  } catch (error) {
    log.error(`DODO API request failed: ${error.message}`);
    throw error;
  }
}, 'fetchDodoRoute');

const approveTokenForDodo = errorHandler.wrap(async (wallet, tokenAddress, amount, decimals) => {
  if (tokenAddress === tokens.PHRS) return true;
  
  const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  
  try {
    const allowance = await tokenContract.allowance(wallet.address, DODO_CONFIG.router);
    if (allowance >= amount) {
      log.info('Token already approved for DODO');
      return true;
    }
    
    log.step(`Approving ${ethers.formatUnits(amount, decimals)} tokens for DODO router`);
    const tx = await tokenContract.approve(DODO_CONFIG.router, amount);
    await tx.wait();
    log.success('DODO approval confirmed');
    return true;
  } catch (error) {
    log.error(`DODO approval failed: ${error.message}`);
    throw error;
  }
}, 'approveTokenForDodo');

const executeDodoSwap = errorHandler.wrap(async (wallet, swapData, fromToken, amount) => {
  try {
    if (!swapData.data || swapData.data === '0x') {
      throw new Error('Invalid swap data from DODO API');
    }
    
    const txParams = {
      to: swapData.to,
      data: swapData.data,
      value: BigInt(swapData.value || 0),
      gasLimit: BigInt(swapData.gasLimit || 500000)
    };
    
    log.info('Executing DODO swap transaction...');
    const tx = await wallet.sendTransaction(txParams);
    log.info(`DODO Transaction sent: ${tx.hash}`);
    
    const receipt = await tx.wait();
    log.success(`DODO Swap completed in block ${receipt.blockNumber}`);
    return receipt.hash;
  } catch (error) {
    log.error(`DODO Swap execution failed: ${error.message}`);
    throw error;
  }
}, 'executeDodoSwap');

const performAutoSwap = errorHandler.wrap(async (wallet, provider, swapCount, proxy = null) => {
  const swaps = [];
  
  for (let i = 0; i < swapCount; i++) {
    swaps.push(i % 2 === 0 ? 'PHRS_USDT' : 'USDT_PHRS');
  }
  
  for (let i = swaps.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [swaps[i], swaps[j]] = [swaps[j], swaps[i]];
  }
  
  for (const swapType of swaps) {
    if (isShuttingDown) break;
    
    const pair = DODO_CONFIG.pairs[swapType];
    const amount = swapType === 'PHRS_USDT' 
      ? ethers.parseEther((Math.random() * 0.01 + 0.001).toFixed(6))
      : ethers.parseUnits((Math.random() * 1 + 0.5).toFixed(2), pair.fromDecimals); 
    
    try {
      log.step(`Preparing FARO ${swapType.replace('_', ' → ')} swap`);

      if (pair.from === tokens.PHRS) {
        const balance = await provider.getBalance(wallet.address);
        if (balance < amount) {
          log.error(`Insufficient PHRS balance: ${ethers.formatEther(balance)} < ${ethers.formatEther(amount)}`);
          continue;
        }
      } else {
        const tokenContract = new ethers.Contract(pair.from, erc20Abi, wallet);
        const balance = await tokenContract.balanceOf(wallet.address);
        if (balance < amount) {
          log.error(`Insufficient token balance: ${ethers.formatUnits(balance, pair.fromDecimals)} < ${ethers.formatUnits(amount, pair.fromDecimals)}`);
          continue;
        }
      }
      
      const route = await fetchDodoRoute(pair.from, pair.to, wallet.address, amount.toString());
      
      if (pair.from !== tokens.PHRS) {
        await approveTokenForDodo(wallet, pair.from, amount, pair.fromDecimals);
      }
      
      await executeDodoSwap(wallet, route, pair.from, amount);
      
      const delay = Math.floor(Math.random() * 10000) + 5000;
      await new Promise(resolve => setTimeout(resolve, delay));
      
    } catch (error) {
      log.error(`DODO Swap ${swapType} failed: ${error.message}`);
      
      const delay = Math.floor(Math.random() * 10000) + 20000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}, 'performAutoSwap');

const performCheckIn = errorHandler.wrap(async (wallet, proxy = null) => {
  if (isShuttingDown) return false;
  if (cachedLoginData[wallet.address] && cachedLoginData[wallet.address].jwt) {
    return cachedLoginData[wallet.address];
  }

  let retries = 0;
  
  while (retries < MAX_RETRIES && !isShuttingDown) {
    try {
      const message = "pharos";
      const signature = await wallet.signMessage(message);
      log.wallet(`Login info: ${signature}`);

      const loginUrl = `https://api.pharosnetwork.xyz/user/login?address=${wallet.address}&signature=${signature}&invite_code=S6NGMzXSCDBxhnwo`;
      const headers = {
        accept: "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.8",
        authorization: "Bearer null",
        "sec-ch-ua": '"Chromium";v="136", "Brave";v="136", "Not.A/Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "sec-gpc": "1",
        Referer: "https://testnet.pharosnetwork.xyz/",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "User-Agent": randomUseragent.getRandom(),
      };

      const axiosConfig = {
        method: 'post',
        url: loginUrl,
        headers,
        httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
        timeout: 10000
      };

      log.loading('Sending login request...');
      const loginResponse = await axios(axiosConfig);
      const loginData = loginResponse.data;

      if (loginData.code !== 0 || !loginData.data.jwt) {
        log.error(`Login failed: ${loginData.msg || 'Unknown error'}`);
        return false;
      }

      const jwt = loginData.data.jwt;
      log.success('Login successful');

      const updatedHeaders = {
        ...headers,
        authorization: `Bearer ${jwt}`,
      };

      cachedLoginData[wallet.address] = {
        headers: updatedHeaders,
        jwt,
      };

      return cachedLoginData[wallet.address];
    } catch (error) {
      if (error.code === 'ENOTFOUND' || error.message.includes('getaddrinfo ENOTFOUND')) {
        retries++;
        log.warn(`Login failed, attempt ${retries}/${MAX_RETRIES}. Waiting 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        log.error(`Login error: ${error.message}`);
        return false;
      }
    }
  }
  
  log.error(`Login failed after ${MAX_RETRIES} attempts`);
  return false;
}, 'performCheckIn');

const checkInFunction = errorHandler.wrap(async (wallet, proxy = null) => {
  if (isShuttingDown) return false;
  const checkInData = await performCheckIn(wallet, proxy);
  if (!checkInData) {
    log.error("Failed to get login data");
    return;
  }

  let retries = 0;
  
  while (retries < MAX_RETRIES && !isShuttingDown) {
    try {
      const checkInUrl = `https://api.pharosnetwork.xyz/sign/in?address=${wallet.address}`;
      
      log.loading('Sending daily check-in request...');
      const checkInResponse = await axios({
        method: 'post',
        url: checkInUrl,
        headers: checkInData.headers,
        httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
        timeout: 10000
      });

      const checkIn = checkInResponse.data;

      if (checkIn.code === 0) {
        log.success(`Check-in successful for ${wallet.address}`);
        return true;
      } else {
        log.error(`Check-in failed: ${checkIn.msg || 'Unknown error'}`);
        return false;
      }
    } catch (error) {
      if (error.code === 'ENOTFOUND' || error.message.includes('getaddrinfo ENOTFOUND')) {
        retries++;
        log.warn(`Check-in failed, attempt ${retries}/${MAX_RETRIES}. Waiting 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        log.error(`Check-in error for ${wallet.address}: ${error.message}`);
        return false;
      }
    }
  }
  
  log.error(`Check-in failed after ${MAX_RETRIES} attempts`);
  return false;
}, 'checkInFunction');

const getUserProfile = errorHandler.wrap(async (wallet, proxy = null) => {
  if (isShuttingDown) return null;
  
  const checkInData = await performCheckIn(wallet, proxy);
  if (!checkInData) {
    log.error("Failed to get login data");
    return null;
  }

  let retries = 0;
  
  while (retries < MAX_RETRIES && !isShuttingDown) {
    try {
      const profileUrl = `https://api.pharosnetwork.xyz/user/profile?address=${wallet.address}`;
      
      log.loading('Get profil data...');
      const response = await axios({
        method: 'get',
        url: profileUrl,
        headers: checkInData.headers,
        httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
        timeout: 10000
      });

      const profileData = response.data;

      if (profileData.code === 0) {
        const userInfo = profileData.data?.user_info || {};
        
        log.success('Profil :');
        log.info(`- Address: ${userInfo.Address || wallet.address}`);
        log.info(`- Invite Points: ${userInfo.InvitePoints || 0}`);
        log.info(`- Task Points: ${userInfo.TaskPoints || 0}`);
        log.info(`- TotalPoints: ${userInfo.TotalPoints || 0}`);
        
        return {
          address: userInfo.Address || wallet.address,
          invitePoints: userInfo.InvitePoints || 0,
          taskPoints: userInfo.TaskPoints || 0,
          totalPoints: userInfo.TotalPoints || 0,
          rawData: userInfo
        };
      } else {
        log.error(`Geting profil data failed: ${profileData.msg || 'Unknown error'}`);
        return null;
      }
    } catch (error) {
      if (error.code === 'ENOTFOUND' || error.message.includes('getaddrinfo ENOTFOUND')) {
        retries++;
        log.warn(`Request profil failed, retry ${retries}/${MAX_RETRIES}. 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        log.error(`Error request profil: ${error.message}`);
        if (error.response) {
          log.error('Response API:', error.response.data);
        }
        return null;
      }
    }
  }
  
  log.error(`Request profil failed ${MAX_RETRIES} retrys`);
  return null;
}, 'getUserProfile');

const checkPoints = errorHandler.wrap(async (wallet, proxy = null) => {
  if (isShuttingDown) return null;
  
  try {
    const profile = await getUserProfile(wallet, proxy);
    if (!profile) {
      log.error('Request profil not found');
      return null;
    }

    log.success(`Statistik Poin address: ${profile.address}:`);
    log.info(`- Invite Points: ${profile.invitePoints}`);
    log.info(`- Task Points: ${profile.taskPoints}`);
    log.info(`- TotalPoints: ${profile.totalPoints}`);
    
    return {
      address: profile.address,
      invitePoints: profile.invitePoints,
      taskPoints: profile.taskPoints,
      totalPoints: profile.totalPoints,
      lastUpdate: new Date().toLocaleString('id-ID')
    };
  } catch (error) {
    log.error(`Eror geting poin: ${error.message}`);
    return null;
  }
}, 'checkPoints');

const faucetFunction = errorHandler.wrap(async (wallet, proxy = null) => {
  if (isShuttingDown) return false;
  const checkInData = await performCheckIn(wallet, proxy);
  if (!checkInData) {
    log.error("Failed to get login data");
    return;
  }

  let retries = 0;
  
  while (retries < MAX_RETRIES && !isShuttingDown) {
    try {
      const checkInUrl = `https://api.pharosnetwork.xyz/faucet/daily?address=${wallet.address}`;
      
      log.loading('Sending faucet request...');
      const checkInResponse = await axios({
        method: 'post',
        url: checkInUrl,
        headers: checkInData.headers,
        httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
        timeout: 10000
      });

      const checkIn = checkInResponse.data;

      if (checkIn.code === 0) {
        log.success(`Faucet claim successful for ${wallet.address}`);
        return true;
      } else {
        log.error(`Faucet claim failed: ${checkIn.msg || 'Unknown error'}`);
        return false;
      }
    } catch (error) {
      if (error.code === 'ENOTFOUND' || error.message.includes('getaddrinfo ENOTFOUND')) {
        retries++;
        log.warn(`Faucet claim failed, attempt ${retries}/${MAX_RETRIES}. Waiting 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        log.error(`Faucet claim error for ${wallet.address}: ${error.message}`);
        return false;
      }
    }
  }
  
  log.error(`Faucet claim failed after ${MAX_RETRIES} attempts`);
  return false;
}, 'faucetFunction');

const loadRecipientAddresses = () => {
  try {
    const data = fs.readFileSync('recipients.json', 'utf8');
    const addresses = JSON.parse(data);
    
    if (!Array.isArray(addresses) || addresses.length !== 65) {
      throw new Error('Recipients file must contain exactly 65 addresses');
    }
    
    addresses.forEach(addr => {
      if (!ethers.isAddress(addr)) {
        throw new Error(`Invalid address found in recipients.json: ${addr}`);
      }
    });
    
    return addresses;
  } catch (error) {
    log.error(`Failed to load recipient addresses: ${error.message}`);
    process.exit(1);
  }
};

const recipientAddresses = loadRecipientAddresses();

const verifyFunction = errorHandler.wrap(async (wallet, provider, index, proxy = null) => {
  if (isShuttingDown) return false;
  
  const checkInData = await performCheckIn(wallet, proxy);
  if (!checkInData) {
    log.error("Failed to get login data for verification");
    return false;
  }

  let txhash;
  let verificationAttempts = 0;
  const MAX_VERIFICATION_ATTEMPTS = 5;
  const INITIAL_DELAY = 30000; 
  const BACKOFF_FACTOR = 2;

  while (verificationAttempts < MAX_VERIFICATION_ATTEMPTS && !isShuttingDown) {
    try {
      if (verificationAttempts === 0) {
        txhash = await transferPHRS(wallet, provider, index);
        if (!txhash) {
          log.error("Transfer failed, skipping verification");
          return false;
        }
        log.info(`Transaction hash: ${txhash}`);
      }

      const currentDelay = INITIAL_DELAY * Math.pow(BACKOFF_FACTOR, verificationAttempts);
      log.info(`Waiting ${currentDelay/1000} seconds before verification...`);
      await new Promise(resolve => setTimeout(resolve, currentDelay));

      log.info("Checking transaction confirmation...");
      const receipt = await provider.getTransactionReceipt(txhash);
      if (!receipt || receipt.status !== 1) {
        throw new Error('Transaction not yet confirmed or failed');
      }

      log.loading(`Attempting verification (attempt ${verificationAttempts + 1})...`);
      const checkInUrl = `https://api.pharosnetwork.xyz/task/verify`;
      const params = {
        address: wallet.address,
        task_id: 103,
        tx_hash: txhash,
      };
      
      const checkInResponse = await axios({
        method: 'post',
        params: params,
        url: checkInUrl,
        headers: checkInData.headers,
        httpsAgent: proxy ? new HttpsProxyAgent(proxy) : null,
        timeout: 20000 
      });

      const checkIn = checkInResponse.data;

      if (checkIn.code === 0) {
        log.success(`Verification successful for ${wallet.address}`);
        return true;
      } else {
        throw new Error(checkIn.msg || 'Verification failed');
      }

    } catch (error) {
      verificationAttempts++;
      const errorMsg = error.response?.data?.msg || error.message;
      
      if (errorMsg.includes('get transaction hash failed') || 
          errorMsg.includes('transaction not found')) {
        log.warn(`Verification failed (attempt ${verificationAttempts}): ${errorMsg}`);
        
        if (verificationAttempts < MAX_VERIFICATION_ATTEMPTS) {
          continue;
        } else {
          log.error(`All verification attempts failed for tx ${txhash}`);
          return false;
        }
      } else {
        log.error(`Unexpected verification error: ${errorMsg}`);
        return false;
      }
    }
  }

  return false;
}, 'verifyFunction');

const transferPHRS = errorHandler.wrap(async (wallet, provider, index) => {
  if (isShuttingDown) return null;
  
  let retries = 0;
  while (retries < MAX_RETRIES && !isShuttingDown) {
    try {
      const amountOptions = [0.0001, 0.0002, 0.0003, 0.0004, 0.0005];
      const amount = amountOptions[Math.floor(Math.random() * amountOptions.length)];
      
      const toAddress = recipientAddresses[Math.floor(Math.random() * recipientAddresses.length)];
      log.step(`Preparing transfer ${index + 1}: ${amount} PHRS to ${toAddress}`);

      const balance = await provider.getBalance(wallet.address);
      const required = ethers.parseEther(amount.toString());

      if (balance < required) {
        log.error(`Insufficient PHRS balance: ${ethers.formatEther(balance)} < ${amount}`);
        return null;
      }

      const tx = await wallet.sendTransaction({
        to: toAddress,
        value: required,
        gasLimit: 21000,
        gasPrice: 0,
      });

      log.info(`Transfer transaction ${index + 1} sent: ${tx.hash}`);
      
      const receipt = await tx.wait(1);
      
      if (receipt.status === 1) {
        log.success(`Transfer ${index + 1} confirmed in block ${receipt.blockNumber}`);
        return tx.hash;
      } else {
        throw new Error(`Transaction reverted: ${receipt.hash}`);
      }
    } catch (error) {
      retries++;
      log.error(`Transfer ${index + 1} failed (attempt ${retries}): ${error.message}`);
      
      if (retries < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }
  
  return null;
}, 'transferPHRS');

const getRandomSwapPair = () => {
  const tokenPairs = [
    { from: 'WPHRS', to: 'USDC', decimals: 18 },
    { from: 'USDC', to: 'WPHRS', decimals: 6 },
    { from: 'WPHRS', to: 'USDC', decimals: 18 },
    { from: 'USDC', to: 'WPHRS', decimals: 6 },
  ];
  
  return tokenPairs[Math.floor(Math.random() * tokenPairs.length)];
};

const getRandomSwapAmount = (decimals) => {
  const minAmount = 0.01;
  const maxAmount = 0.02;
  const randomAmount = Math.random() * (maxAmount - minAmount) + minAmount;
  
  return ethers.parseUnits(randomAmount.toFixed(decimals), decimals);
};

const performRandomSwap = errorHandler.wrap(async (wallet, provider, index, proxy = null) => {
  if (isShuttingDown) return false;
  
  let retries = 0;
  while (retries < MAX_RETRIES && !isShuttingDown) {
    try {
      const pair = getRandomSwapPair();
      const amountIn = getRandomSwapAmount(pair.decimals);
      
      log.loading(`Preparing ZENITH swap ${index + 1} (${pair.from} → ${pair.to})`);
      log.info(`Amount: ${ethers.formatUnits(amountIn, pair.decimals)} ${pair.from}`);

      const tokenContract = new ethers.Contract(tokens[pair.from], erc20Abi, wallet);

      const balance = await tokenContract.balanceOf(wallet.address);
      log.info(`Current balance: ${ethers.formatUnits(balance, pair.decimals)} ${pair.from}`);
      
      if (balance < amountIn) {
        throw new Error(`Insufficient ${pair.from} balance`);
      }

      const requiredAllowance = amountIn;
      const currentAllowance = await tokenContract.allowance(wallet.address, contractAddress);
      
      if (currentAllowance < requiredAllowance) {
        log.info(`Approving ${ethers.formatUnits(requiredAllowance, pair.decimals)} ${pair.from}...`);
        const approveTx = await tokenContract.approve(contractAddress, requiredAllowance);
        await approveTx.wait();
        log.success('Approval confirmed');
      }

      const timestamp = Math.floor(Date.now() / 1000) + 120;
      const swapParams = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint24", "address", "uint256", "uint256", "uint256"],
        [tokens[pair.from], tokens[pair.to], 500, wallet.address, amountIn, 0, 0]
      );

      const swapContract = new ethers.Contract(contractAddress, contractAbi, wallet);
      const tx = await swapContract.multicall(
        timestamp,
        ["0x04e45aaf" + swapParams.slice(2)],
        {
          gasLimit: 200000,
          maxFeePerGas: ethers.parseUnits("2", "gwei"),
          maxPriorityFeePerGas: ethers.parseUnits("1", "gwei")
        }
      );

      log.info(`Tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      
      if (receipt.status === 1) {
        log.success(`Swap ${index + 1} completed in block ${receipt.blockNumber}`);
        return receipt.hash;
      } else {
        throw new Error('Transaction reverted');
      }

    } catch (error) {
      retries++;
      const errorMsg = error.reason || error.shortMessage || error.message;
      log.error(`Attempt ${retries} failed: ${errorMsg}`);
      
      if (retries < MAX_RETRIES) {
        const delay = Math.min(30000, 5000 * retries);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  log.error(`Swap ${index + 1} failed after ${MAX_RETRIES} attempts`);
  return false;
}, 'performRandomSwap');

const wrapPHRS = errorHandler.wrap(async (wallet, provider, amountInPHRS = 0.01) => {
  if (isShuttingDown) return null;
  let retries = 0;
  
  while (retries < MAX_RETRIES && !isShuttingDown) {
    try {
      const amountString = typeof amountInPHRS === 'number' ? amountInPHRS.toString() : amountInPHRS;
      
      log.loading(`Starting to wrap ${amountString} PHRS -> WPHRS for ${wallet.address}...`);
      
      const wphrsContract = new ethers.Contract(tokens.WPHRS, erc20Abi, wallet);
      const balance = await provider.getBalance(wallet.address);
      log.info(`PHRS balance: ${ethers.formatEther(balance)} PHRS`);

      const amountInWei = ethers.parseEther(amountString);
      if (balance < amountInWei) {
        throw new Error(`Insufficient balance! Need ${amountString} PHRS, only have ${ethers.formatEther(balance)} PHRS`);
      }

      log.info('Sending transaction...');
      const tx = await wphrsContract.deposit({
        value: amountInWei,
        gasLimit: 30000,
        gasPrice: ethers.parseUnits("1", "gwei")
      });

      log.info(`Tx Hash: ${tx.hash}`);
      log.info('Waiting for confirmation...');
      const receipt = await tx.wait();

      const depositEvent = receipt.logs?.find(log => 
        log.topics[0] === ethers.id("Deposit(uint256,address)")
      );

      if (depositEvent) {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ["uint256", "address"],
          depositEvent.data
        );
        log.success(`Wrapped ${amountString} PHRS successfully!`);
        log.info(`- NFT ID: ${decoded[0]}`);
        log.info(`- Sender: ${decoded[1]}`);
      } else {
        log.info('Wrapping successful but event not found');
      }

      return receipt.hash;

    } catch (error) {
      if (error.code === 'ENOTFOUND' || error.message.includes('getaddrinfo ENOTFOUND')) {
        retries++;
        log.warn(`Wrapping failed, attempt ${retries}/${MAX_RETRIES}. Waiting 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        log.error(`Failed to wrap PHRS: ${error.shortMessage || error.message}`);
        if (error.info) log.error("Details:", error.info);
        throw error;
      }
    }
  }
  
  log.error(`Wrapping failed after ${MAX_RETRIES} attempts`);
  return null;
}, 'wrapPHRS');

const performSwap = errorHandler.wrap(async (wallet, provider, index, proxy = null) => {
  if (isShuttingDown) return false;
  let retries = 0;
  
  while (retries < MAX_RETRIES && !isShuttingDown) {
    try {
      log.loading(`Starting swap ${index + 1} for ${wallet.address}`);
      
      const randomAmount = Math.random() * 0.04 + 0.01;
      const amount = parseFloat(randomAmount.toFixed(5));
      
      const txHash = await wrapPHRS(wallet, provider, amount);
      
      log.success(`Swap ${index + 1} successful! Tx Hash: ${txHash}`);
      return true;
      
    } catch (error) {
      if (error.code === 'ENOTFOUND' || error.message.includes('getaddrinfo ENOTFOUND')) {
        retries++;
        log.warn(`Swap failed, attempt ${retries}/${MAX_RETRIES}. Waiting 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        log.error(`Swap ${index + 1} failed: ${error.message}`);
        return false;
      }
    }
  }
  
  log.error(`Swap failed after ${MAX_RETRIES} attempts`);
  return false;
}, 'performSwap');

const addLiquidityToV3Pool = errorHandler.wrap(async (wallet, provider, proxy = null) => {
  if (isShuttingDown) return false;
  let retries = 0;
  
  while (retries < MAX_RETRIES && !isShuttingDown) {
    try {
      log.loading('Preparing liquidity addition to Uniswap V3...');

      const usdcContract = new ethers.Contract(tokens.USDC, uscdAbi, wallet);

      const amountUSDC = ethers.parseUnits("2", 6);
      const amountWPHRS = ethers.parseEther("0.00");

      const usdcBalance = await usdcContract.balanceOf(wallet.address);
      if (usdcBalance < amountUSDC) {
        throw new Error(`Insufficient USDC balance! Required: ${ethers.formatUnits(amountUSDC, 6)} USDC, Available: ${ethers.formatUnits(usdcBalance, 6)} USDC`);
      }

      log.info('Approving USDC...');
      const approveTx = await usdcContract.approve(uniswapAddress, amountUSDC);
      await approveTx.wait();
      log.success('USDC approval successful!');

      const positionManager = new ethers.Contract(uniswapAddress, NONFUNGIBLE_POSITION_MANAGER_ABI, wallet);

      const params = {
        token0: tokens.WPHRS,
        token1: tokens.USDC,
        fee: 500,
        tickLower: 44410,
        tickUpper: 44460,
        amount0Desired: amountWPHRS,
        amount1Desired: amountUSDC,
        amount0Min: 0,
        amount1Min: 0,
        recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 1200
      };

      log.info('Sending mint liquidity transaction...');
      const tx = await positionManager.mint(params, {
        gasLimit: 600000
      });

      log.info(`Tx Hash: ${tx.hash}`);
      const receipt = await tx.wait();
      log.info('Transaction successful! Looking for events...');

      const increaseLiquidityEvent = receipt.logs.find(log => {
        try {
          const parsedLog = positionManager.interface.parseLog(log);
          return parsedLog && (parsedLog.name === "IncreaseLiquidity" || parsedLog.name === "Mint");
        } catch {
          return false;
        }
      });

      if (increaseLiquidityEvent) {
        log.success('Liquidity successfully added!');
        log.info(`- Event: ${increaseLiquidityEvent.name}`);
        log.info(`- Args: ${increaseLiquidityEvent.args}`);
      } else {
        log.info('Event not found, checking logs manually:');
        log.info(receipt.logs);
      }
      
      return true;

    } catch (error) {
      if (error.code === 'ENOTFOUND' || error.message.includes('getaddrinfo ENOTFOUND')) {
        retries++;
        log.warn(`Liquidity addition failed, attempt ${retries}/${MAX_RETRIES}. Waiting 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        log.error('Failed to add liquidity:');
        log.error(`- Error message: ${error.reason || error.message}`);
        log.error(`- Error data: ${error.data || "No additional data"}`);
        
        if (error.transaction) {
          log.error(`- Tx Hash: ${error.transaction.hash}`);
        }
        throw error;
      }
    }
  }
  
  throw new Error(`Failed to add liquidity after ${MAX_RETRIES} attempts`);
}, 'addLiquidityToV3Pool');

const performV3Pool = errorHandler.wrap(async (wallet, provider, index, proxy = null) => {
  if (isShuttingDown) return false;
  let retries = 0;
  
  while (retries < MAX_RETRIES && !isShuttingDown) {
    try {
      log.loading(`Starting liquidity addition ${index} for ${wallet.address}`);
      
      await addLiquidityToV3Pool(wallet, provider, proxy);
      
      log.success(`Completed liquidity addition ${index}`);
      return true;
    } catch (error) {
      if (error.code === 'ENOTFOUND' || error.message.includes('getaddrinfo ENOTFOUND')) {
        retries++;
        log.warn(`Liquidity addition failed, attempt ${retries}/${MAX_RETRIES}. Waiting 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        log.error(`Liquidity addition ${index} failed: ${error.message}`);
        return false;
      }
    }
  }
  
  log.error(`Liquidity addition failed after ${MAX_RETRIES} attempts`);
  return false;
}, 'performV3Pool');

const withFreezeProtection = async (fnName, fn, ...args) => {
  return new Promise(async (resolve, reject) => {
    if (isShuttingDown) return resolve(null);
    
    const timeoutId = setTimeout(() => {
      log.warn(`Process ${fnName} detected freeze for more than 1 hour, continuing to next process...`);
      resolve(null);
    }, FREEZE_TIMEOUT);

    try {
      const result = await fn(...args);
      clearTimeout(timeoutId);
      resolve(result);
    } catch (error) {
      clearTimeout(timeoutId);
      reject(error);
    }
  });
};

const processWallet = errorHandler.wrap(async (privateKey) => {
  if (isShuttingDown) return;
  
  if (proxies.length === 0) {
    proxies = loadProxies();
  }
  
  const provider = await setupProvider();
  const wallet = new ethers.Wallet(privateKey, provider);
  
  const proxy = assignProxyToWallet(wallet.address);
  const proxiedProvider = await setupProvider(proxy);
  const proxiedWallet = new ethers.Wallet(privateKey, proxiedProvider);
  
  log.wallet(`Using wallet: ${proxiedWallet.address} with proxy: ${proxy || 'none'}`);
  
  healthCheck();

  try {
    await withFreezeProtection('checkInFunction', checkInFunction, proxiedWallet, proxy);
  } catch (e) {
    log.error('Check-in failed:', e.message);
  }

  try {
    await withFreezeProtection('faucetFunction', faucetFunction, proxiedWallet, proxy);
  } catch (e) {
    log.error('Faucet claim failed:', e.message);
  }

  try {
    const points = await checkPoints(proxiedWallet, proxy);
    if (points) {
      log.info(`Total Points: ${points.totalPoints}`);

      if (points.taskPoints < 1000) {
        log.info('Task points are less than 1000, skipping further actions');
      }
    };

    if (!isShuttingDown) {
      const swapCount = Math.floor(Math.random() * 100) + 95; 
      await withFreezeProtection(
        'performAutoSwap',
        performAutoSwap,
        proxiedWallet,
        proxiedProvider,
        swapCount,
        proxy
      );
    }

    if (!isShuttingDown) {
      await withFreezeProtection(
        'performSwap',
        performSwap,
        proxiedWallet,
        proxiedProvider,
        0,
        proxy
      );
      await new Promise(resolve => setTimeout(resolve, Math.random() * 20000 + 10000));
    };

    for (let i = 0; i < 100; i++) {
      if (!isShuttingDown) {
        await withFreezeProtection(
          'performRandomSwap',
          performRandomSwap,
          proxiedWallet,
          proxiedProvider,
          i,
          0,
          proxy
        );
        await new Promise(resolve => setTimeout(resolve, Math.random() * 15000 + 5000));
      }
    };

    for (let i = 0; i < 100; i++) {
      if (isShuttingDown) break;
      try {
        log.step(`Starting process ${i + 1}`);
        await withFreezeProtection(
          'verifyFunction',
          verifyFunction,
          proxiedWallet,
          proxiedProvider,
          i,
          proxy
        );
        
        const delayTime = Math.random() * 20000 + 10000;
        log.info(`Waiting ${(delayTime/1000).toFixed(2)} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delayTime));
      } catch (error) {
        log.error(`Failed in process ${i + 1}: ${error.message}`);
      }
    };

    if (!isShuttingDown) {
      await withFreezeProtection(
        'performV3Pool',
        performV3Pool,
        proxiedWallet,
        proxiedProvider,
        0,
        proxy
      );
      await new Promise(resolve => setTimeout(resolve, Math.random() * 15000 + 20000));
    }

  } catch (error) {
    log.error('Wallet process error:', error.message);
    if (error.code === 'ENOTFOUND') {
      log.warn('Connection issue, retrying in 5 seconds...');
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }
}, 'processWallet');

// ==================== MAIN FUNCTION (UNCHANGED) ====================
const main = async () => {
  console.log(banner.join('\n'));
  await new Promise(resolve => setTimeout(resolve, 10000));

  proxies = loadProxies();

  const privateKeys = process.env.PRIVATE_KEYS.split(',').filter(pk => pk);
  if (!privateKeys.length) {
    log.error('No private keys found in .env file');
    return;
  }

  try {
    const addresses = loadRecipientAddresses();
    log.info(`Loaded ${addresses.length} recipient addresses`);
  } catch (error) {
    log.error(`Failed to load recipients: ${error.message}`);
    return;
  }

  const runFullCycle = async () => {
    try {
      log.info('Starting new cycle...');
      for (const privateKey of privateKeys) {
        if (isShuttingDown) break;
        await processWallet(privateKey);
      }
      log.success('Cycle completed successfully!');
    } catch (error) {
      log.error('Error during cycle:', error);
    }
  };

  const startCountdown = () => {
    return new Promise((resolve) => {
      const twelveHours = 12 * 60 * 60 * 1000;
      const targetTime = Date.now() + twelveHours;
      
      const countdownInterval = setInterval(() => {
        if (isShuttingDown) {
          clearInterval(countdownInterval);
          return resolve();
        }

        const now = Date.now();
        const diff = targetTime - now;
        
        if (diff <= 0) {
          clearInterval(countdownInterval);
          return resolve();
        }

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);
        
        process.stdout.write(`\rNext run in: ${hours}h ${minutes}m ${seconds}s  `);
      }, 1000);
    });
  };

  while (!isShuttingDown) {
    await runFullCycle();
    
    if (!isShuttingDown) {
      process.stdout.write('\n');
      log.info('Waiting for next cycle in 12 hours...');
      
      await startCountdown();
      
      if (!isShuttingDown) {
        process.stdout.write('\n');
      }
    }
  }

  log.info('Script shutdown completed');
  errorHandler.shutdown();
};

main().catch(error => {
  log.error('Fatal error in main:', error);
  errorHandler.shutdown();
  process.exit(1);
});
