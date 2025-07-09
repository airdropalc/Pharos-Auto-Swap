#!/bin/bash

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m' # No Color

BOT_DIR="Pharos-Swap"
SCREEN_SESSION_NAME="PharosBot"

# Function for initial setup
initial_setup() {
    echo -e "${CYAN}➤ Starting initial setup for the Pharos Swap Bot...${NC}"

    # Create base directory if it doesn't exist
    if [ ! -d "$BOT_DIR" ]; then
        echo -e "${CYAN}Creating bot directory: $BOT_DIR${NC}"
        mkdir -p "$BOT_DIR/config"
    else
        echo -e "${YELLOW}Directory '$BOT_DIR' already exists. Skipping directory creation.${NC}"
        # Ensure config subdir exists
        mkdir -p "$BOT_DIR/config"
    fi

    # Download required files
    echo -e "${CYAN}Downloading required files from GitHub...${NC}"
    wget -q --show-progress -O "$BOT_DIR/config/banner.js" "https://raw.githubusercontent.com/airdropalc/Pharos-Auto-Swap/refs/heads/main/config/banner.js"
    wget -q --show-progress -O "$BOT_DIR/config/logger.js" "https://raw.githubusercontent.com/airdropalc/Pharos-Auto-Swap/refs/heads/main/config/logger.js"
    wget -q --show-progress -O "$BOT_DIR/main.js" "https://raw.githubusercontent.com/airdropalc/Pharos-Auto-Swap/refs/heads/main/main.js"
    wget -q --show-progress -O "$BOT_DIR/package.json" "https://raw.githubusercontent.com/airdropalc/Pharos-Auto-Swap/refs/heads/main/package.json"
    wget -q --show-progress -O "$BOT_DIR/recipients.json" "https://raw.githubusercontent.com/airdropalc/Pharos-Auto-Swap/refs/heads/main/recipients.json"
    echo -e "${GREEN}✓ Files downloaded successfully.${NC}"

    # Install NodeJS dependencies
    echo -e "${CYAN}➤ Installing NodeJS packages using npm...${NC}"
    (cd "$BOT_DIR" && npm install)
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Dependencies installed successfully.${NC}"
    else
        echo -e "${RED}✗ Failed to install dependencies. Please check npm and your internet connection.${NC}"
        read -n 1 -s -r -p "Press any key to return to the menu..."
        return 1
    fi

    echo ""
    echo -e "${GREEN}✅ Initial setup completed! Please configure your wallet and other settings.${NC}"
    echo ""
    read -n 1 -s -r -p "Press any key to return to the menu..."
}

# Function to configure .env file
configure_env() {
    echo -e "${CYAN}➤ Private Keys Configuration (.env)${NC}"
    echo -e "${YELLOW}Please enter your private keys, separated by commas.${NC}"
    echo -e "${YELLOW}Example: 0xkey1,0xkey2,0xkey3${NC}"
    
    read -p "Enter Private Keys: " private_keys
    
    # Write to .env file
    echo "PRIVATE_KEYS=${private_keys}" > "$BOT_DIR/.env"
    
    echo -e "${GREEN}✓ Private keys saved to $BOT_DIR/.env successfully.${NC}"
    echo ""
    read -n 1 -s -r -p "Press any key to return to the menu..."
}

# Function to configure proxies.txt (optional)
configure_proxies() {
    echo -e "${CYAN}➤ Proxy Configuration (proxies.txt)${NC}"
    echo -e "${YELLOW}This is optional. Enter proxies one by one. Press ENTER on an empty line to finish.${NC}"
    echo -e "${YELLOW}Format: http://username:password@host:port OR ip:port${NC}"

    > "$BOT_DIR/proxies.txt" # Create or clear the file
    local count=0
    while true; do
        read -p "Enter proxy: " proxy_line
        if [ -z "$proxy_line" ]; then
            break
        fi
        echo "$proxy_line" >> "$BOT_DIR/proxies.txt"
        count=$((count + 1))
    done

    if [ "$count" -gt 0 ]; then
        echo -e "${GREEN}✓ Saved $count proxies to $BOT_DIR/proxies.txt successfully.${NC}"
    else
        echo -e "${YELLOW}⚠ No proxies were entered. The file is empty.${NC}"
    fi
    echo ""
    read -n 1 -s -r -p "Press any key to return to the menu..."
}

# Function to let user edit recipients.json
edit_recipients() {
    local recipients_file="$BOT_DIR/recipients.json"
    if [ ! -f "$recipients_file" ]; then
        echo -e "${RED}✗ File 'recipients.json' not found! Please run Initial Setup first.${NC}"
    else
        echo -e "${CYAN}➤ Editing recipients.json...${NC}"
        echo -e "${YELLOW}The file will open in the 'nano' editor.${NC}"
        echo -e "${YELLOW}Save and exit by pressing ${CYAN}CTRL+X${YELLOW}, then ${CYAN}Y${YELLOW}, then ${CYAN}ENTER${NC}."
        sleep 3
        nano "$recipients_file"
        echo -e "${GREEN}✓ Closed editor.${NC}"
    fi
    echo ""
    read -n 1 -s -r -p "Press any key to return to the menu..."
}

# Function to run the bot
run_bot() {
    if [ ! -f "$BOT_DIR/.env" ]; then
        echo -e "${RED}✗ Configuration file (.env) not found!${NC}"
        echo -e "${YELLOW}Please configure your private keys first (Option 2).${NC}"
    else
        echo -e "${CYAN}➤ Starting the bot in a background 'screen' session named '${SCREEN_SESSION_NAME}'...${NC}"
        (cd "$BOT_DIR" && screen -dmS "$SCREEN_SESSION_NAME" node main.js)
        echo -e "${GREEN}✓ Bot has been started.${NC}"
        echo -e "${YELLOW}IMPORTANT: To view the bot's output, use Option 6 (Check Bot Status).${NC}"
        echo -e "${YELLOW}To detach from the session, press: ${CYAN}CTRL+A${YELLOW} then ${CYAN}D${NC}"
    fi
    echo ""
    read -n 1 -s -r -p "Press any key to return to the menu..."
}

# Function to check bot status
check_status() {
    echo -e "${CYAN}➤ Attaching to screen session '${SCREEN_SESSION_NAME}'...${NC}"
    echo -e "${YELLOW}To detach and return, press: ${CYAN}CTRL+A${YELLOW} then ${CYAN}D${NC}"
    sleep 2
    screen -r "$SCREEN_SESSION_NAME"
    echo -e "\n${GREEN}Returned from screen session.${NC}"
    echo ""
    read -n 1 -s -r -p "Press any key to return to the menu..."
}

# Function to stop the bot
stop_bot() {
    echo -e "${CYAN}➤ Attempting to stop the bot...${NC}"
    if screen -list | grep -q "$SCREEN_SESSION_NAME"; then
        screen -X -S "$SCREEN_SESSION_NAME" quit
        echo -e "${GREEN}✓ Bot session '${SCREEN_SESSION_NAME}' has been stopped.${NC}"
    else
        echo -e "${YELLOW}⚠ Bot session '${SCREEN_SESSION_NAME}' is not currently running.${NC}"
    fi
    echo ""
    read -n 1 -s -r -p "Press any key to return to the menu..."
}

while true; do
    clear
    echo -e "${CYAN}===============================================${NC}"
    echo -e "${CYAN}        PHAROS AUTO BOT BY AIRDROP ALC         ${NC}"
    echo -e "${CYAN}===============================================${NC}"
    echo -e "Please choose an option:"
    echo -e "1. ${GREEN}Initial Setup${NC} (Download files & Install Dependencies)"
    echo -e "2. ${GREEN}Configure Private Keys${NC} (Create/Edit .env file)"
    echo -e "3. ${GREEN}Configure Proxies${NC} (Optional)"
    echo -e "4. ${GREEN}Edit Recipients File${NC} (Edit recipients.json)"
    echo -e "5. ${GREEN}Run Bot${NC} (Starts the swapping process)"
    echo -e "6. ${YELLOW}Check Bot Status${NC} (View the bot's live output)"
    echo -e "7. ${RED}Stop Bot${NC}"
    echo -e "0. ${RED}Exit${NC}"
    echo -e "${CYAN}------------------------------------${NC}"
    read -p "Enter your choice [0-7]: " choice

    case $choice in
        1) initial_setup ;;
        2) configure_env ;;
        3) configure_proxies ;;
        4) edit_recipients ;;
        5) run_bot ;;
        6) check_status ;;
        7) stop_bot ;;
        0) echo "Exiting. Goodbye!"; exit 0 ;;
        *) echo -e "${RED}Invalid option. Please try again.${NC}"; sleep 2 ;;
    esac
done
