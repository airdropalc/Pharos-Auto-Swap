# 🤖 Pharos Automation Bot

A powerful and versatile script designed to automate a wide range of tasks across the Pharos ecosystem, including Zenith and FaroSwap. Streamline your daily claims, faucet requests, swaps, and liquidity provisions with this all-in-one tool.

---

## ⚠️ Important: Getting Started Prerequisite

**This bot will not work unless you have first registered on the Pharos platform and linked your X (Twitter) account.**

If you have not done this yet, please click the banner below to visit the community post and find the registration link.

[![Telegram](https://img.shields.io/badge/Register_Here-Airdrop_ALC-26A5E4?style=for-the-badge&logo=telegram)](https://t.me/airdropalc/1349)

---

## ✨ Key Features

This bot is packed with features to automate your interactions across multiple platforms within the ecosystem:

#### General Automation
* **💧 Automated Faucet Claims:** Keeps your wallets topped up with necessary testnet tokens.
* **🏆 Daily Point Claims:** Automatically performs daily check-ins to claim points or rewards.

#### Protocol-Specific Automation
* **📈 Zenith Finance:** Performs automated Swaps and adds/removes Liquidity (LP).
* **🔄 FaroSwap:** Executes automated swaps on the FaroSwap platform.

---

## 🚀 Installation & Setup

You have two options for running the bot. Choose the one that suits you best.

### Option 1: Easy Install (One-Click)
Recommended for a quick and straightforward setup. This single command downloads and executes the setup script for you.
```bash
wget https://raw.githubusercontent.com/airdropalc/Pharos-Auto-Swap/refs/heads/main/pharos-swap.sh -O pharos-swap.sh && chmod +x pharos-swap.sh && ./pharos-swap.sh
```

---

### Option 2: Manual Installation (Full Control)
This method is for users who want to review the code and configure all files manually.

**1. Clone the Repository**
```bash
git clone https://github.com/airdropalc/Pharos-Auto-Swap.git
cd Pharos-Auto-Swap
```

**2. Install Dependencies**
```bash
npm install
```

**3. Configure Environment (`.env`)**
Create and edit the `.env` file to add your wallet private keys. This is the most critical step.
```bash
nano .env
```
**Required format for `.env`:**
```
PRIVATE_KEY_1="0xYourFirstPrivateKey"
PRIVATE_KEY_2="0xYourSecondPrivateKey"
# Add more wallets on new lines
```

**4. Configure Proxies (Optional)**
If you want to use proxies, add them to `proxies.txt`, one per line.
```bash
nano proxies.txt
```

**5. Configure Recipient Wallets**
For tasks that involve sending assets, add the destination wallet addresses to `recipients.json`.
```bash
nano recipients.json
```
**Example `recipients.json` format:**
```json
[
  "0xRecipientAddressOne...",
  "0xRecipientAddressTwo..."
]
```

**6. Run the Bot**
Start the bot using the command below. (Check `package.json` for the exact start command if this doesn't work).
```bash
node index.js 
```

---

## 🚨 Security Warning & Disclaimer

**This software is provided for educational purposes only. Use it at your own risk.**

* **Your Private Keys are Your Responsibility:** The `.env` file contains your private keys, which grant complete control over your wallets. **Treat this file like a password.** Never share it, and never commit it to a public GitHub repository.
* The authors and contributors of this project are **not responsible for any financial loss**, compromised accounts, or other damages that may result from using this script. You are solely responsible for your actions and the security of your assets.

---
> Inspired by and developed for the [Airdrop ALC](https://t.me/airdropalc) community.

## License

![Version](https://img.shields.io/badge/version-1.1.0-blue)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)]()

---
