#!/usr/bin/env bash                                                                              
# cc-portal 容器启动脚本

set -e

CONTAINER_NAME="cc-portal"
PORT="${PORT:-9033}"

docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

# 自动修改权限，确保 Docker 内的 ccas 用户可以访问
echo "🔧 检查并修复目录权限 (portal-claude, users)..."
mkdir -p portal-claude users
chmod -R 777 portal-claude users

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

# 在宿主机上从 settings.json 提取环境变量
SETTINGS_FILE="$(pwd)/portal-claude/settings.json"
ENV_ARRAY=()
ENV_COUNT=0
if [ -f "$SETTINGS_FILE" ]; then
  # 使用 node 解析 JSON 并添加到环境变量数组
  while IFS=$'\t' read -r key value; do
    if [ -n "$key" ]; then
      ENV_ARRAY+=("-e" "${key}=${value}")
      ENV_COUNT=$((ENV_COUNT + 1))
    fi
  done < <(node -e "
    const d = require('$SETTINGS_FILE');
    Object.entries(d.env || {}).forEach(([k,v]) => console.log(k + '\t' + v));
  " 2>/dev/null)
  echo "✅ 已从 settings.json 加载 ${ENV_COUNT} 个环境变量"
fi

docker run $DOCKER_FLAGS --name "$CONTAINER_NAME" $DOCKER_USER \
  "${VOLUMES[@]}" \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  "${ENV_ARRAY[@]}" \
  -p "${PORT}:9033" \
  ccas:latest bash -c "cd /workspace && $USER_CMD"
docker logs -f cc-portal