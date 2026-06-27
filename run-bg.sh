#!/bin/bash
cd "$(dirname "$0")"
git pull

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
nvm install 24
nvm use 24

npm i

while true; do; node generate-project.js; done > autocode.log 2>&1 &