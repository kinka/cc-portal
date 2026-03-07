#!/usr/bin/env bash
# cc-portal 容器启动脚本

set -e

CONTAINER_NAME="cc-portal"
PORT="${PORT:-9033}"

docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

VOLUMES=(
  -v "$(pwd):/workspace"
  -v cc-portal-npm-global:/usr/local/lib/node_modules
  -v cc-portal-node-modules:/workspace/node_modules
  -v "$(pwd)/portal-claude:/home/ccas/.claude"
)

DOCKER_FLAGS="-it --rm"
if [ "$1" = "-d" ] || [ "$1" = "--detach" ]; then
  shift
  DOCKER_FLAGS="-d --rm"
fi

if [ "$1" = "--root" ]; then
  shift
  DOCKER_USER="-u root"
  USER_CMD="${*:-bash}"
elif [ -n "$1" ]; then
  DOCKER_USER=""
  USER_CMD="$*"
else
  DOCKER_USER=""
  USER_CMD="
    [ ! -f node_modules/.modules.yaml ] && echo '📦 安装依赖...' && bun install
    echo '🚀 启动服务 (端口 $PORT)...'
    exec bun src/index.ts
  "
fi

# Always inject env vars before running the user command
CMD="
  if [ -f /home/ccas/.claude/settings.json ]; then
    eval \$(bun -e \"
      const d = require('/home/ccas/.claude/settings.json');
      Object.entries(d.env || {}).forEach(([k,v]) => console.log('export ' + k + '=\'' + v + '\''));
    \" 2>/dev/null)
  fi
  $USER_CMD
"

docker run $DOCKER_FLAGS --name "$CONTAINER_NAME" $DOCKER_USER \
  "${VOLUMES[@]}" \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  -p "${PORT}:9033" \
  ccas:latest bash -c "cd /workspace && $CMD"
docker logs -f cc-portal
