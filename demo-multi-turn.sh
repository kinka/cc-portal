#!/bin/bash

# 演示：cc-portal 进程复用 + 多轮对话
# 目标：证明多个查询只启动一个进程

echo "=========================================="
echo "🎭 cc-portal 进程复用演示"
echo "=========================================="
echo ""

API="http://localhost:9033"

# 1. 清理现有 sessions
echo "🧹 步骤 1: 清理现有 sessions..."
for id in $(curl -s "$API/sessions" | jq -r '.sessions[].sessionId'); do
  curl -s -X DELETE "$API/sessions/$id" > /dev/null
  echo "   已删除: ${id:0:8}..."
done
echo ""

# 2. 查看初始进程数
echo "📊 步骤 2: 查看初始 Claude 进程数..."
INITIAL=$(ps aux | grep "claude --output-format" | grep -v grep | wc -l | tr -d ' ')
echo "   当前进程数: $INITIAL"
echo ""

# 3. 创建 session
echo "📝 步骤 3: 创建 session..."
SESSION=$(curl -s -X POST "$API/sessions" \
  -H "Content-Type: application/json" \
  -d '{"path": "/tmp/multi-agent-demo"}' | jq -r '.sessionId')
echo "   Session ID: ${SESSION:0:8}..."
echo ""

# 4. 第一轮对话
echo "💬 步骤 4: 第一轮对话 - 打招呼..."
RESPONSE1=$(curl -s -X POST "$API/sessions/$SESSION/messages" \
  -H "Content-Type: application/json" \
  -d '{"message": "你好！请简单自我介绍"}')
echo "   AI: $(echo "$RESPONSE1" | jq -r '.response' | head -1 | cut -c1-60)..."
PROC_AFTER_1=$(ps aux | grep "claude --output-format" | grep -v grep | wc -l | tr -d ' ')
echo "   进程数: $PROC_AFTER_1"
echo ""

# 5. 第二轮对话（追问）
echo "💬 步骤 5: 第二轮对话 - 追问细节..."
RESPONSE2=$(curl -s -X POST "$API/sessions/$SESSION/messages" \
  -H "Content-Type: application/json" \
  -d '{"message": "你刚才说你能帮我做什么？举3个例子"}')
echo "   AI: $(echo "$RESPONSE2" | jq -r '.response' | head -1 | cut -c1-60)..."
PROC_AFTER_2=$(ps aux | grep "claude --output-format" | grep -v grep | wc -l | tr -d ' ')
echo "   进程数: $PROC_AFTER_2"
echo ""

# 6. 第三轮对话（上下文验证）
echo "💬 步骤 6: 第三轮对话 - 验证上下文记忆..."
RESPONSE3=$(curl -s -X POST "$API/sessions/$SESSION/messages" \
  -H "Content-Type: application/json" \
  -d '{"message": "你还记得我们刚才聊了什么吗？请总结我们的对话"}')
echo "   AI: $(echo "$RESPONSE3" | jq -r '.response' | head -1 | cut -c1-60)..."
PROC_AFTER_3=$(ps aux | grep "claude --output-format" | grep -v grep | wc -l | tr -d ' ')
echo "   进程数: $PROC_AFTER_3"
echo ""

# 7. 第四轮对话（复杂任务）
echo "💬 步骤 7: 第四轮对话 - 复杂任务..."
RESPONSE4=$(curl -s -X POST "$API/sessions/$SESSION/messages" \
  -H "Content-Type: application/json" \
  -d '{"message": "查看当前目录的文件列表，然后告诉我这个项目的结构"}')
echo "   AI: $(echo "$RESPONSE4" | jq -r '.response' | head -1 | cut -c1-60)..."
PROC_AFTER_4=$(ps aux | grep "claude --output-format" | grep -v grep | wc -l | tr -d ' ')
echo "   进程数: $PROC_AFTER_4"
echo ""

# 8. 查看进程详情
echo "🔍 步骤 8: 查看进程详情..."
echo "   当前运行的 Claude 进程："
ps aux | grep "claude --output-format" | grep -v grep | awk '{print "   PID: " $2 ", 启动时间: " $9}'
echo ""

# 9. 查看对话历史
echo "📜 步骤 9: 查看对话历史..."
MESSAGES=$(curl -s "$API/sessions/$SESSION" | jq -r '.messages | length')
echo "   总消息数: $MESSAGES 条"
echo "   历史记录："
curl -s "$API/sessions/$SESSION" | jq -r '.messages[] | "   [" + .role + "] " + .content[:50] + "..."'
echo ""

# 10. 删除 session
echo "🗑️  步骤 10: 删除 session..."
curl -s -X DELETE "$API/sessions/$SESSION" > /dev/null
PROC_AFTER_DELETE=$(ps aux | grep "claude --output-format" | grep -v grep | wc -l | tr -d ' ')
echo "   删除后进程数: $PROC_AFTER_DELETE"
echo ""

# 结果总结
echo "=========================================="
echo "📈 演示结果总结"
echo "=========================================="
echo "初始进程数:        $INITIAL"
echo "第1轮对话后:       $PROC_AFTER_1"
echo "第2轮对话后:       $PROC_AFTER_2"
echo "第3轮对话后:       $PROC_AFTER_3"
echo "第4轮对话后:       $PROC_AFTER_4"
echo "删除 session 后:   $PROC_AFTER_DELETE"
echo ""

if [ "$PROC_AFTER_1" -eq "$PROC_AFTER_2" ] && [ "$PROC_AFTER_2" -eq "$PROC_AFTER_3" ] && [ "$PROC_AFTER_3" -eq "$PROC_AFTER_4" ] && [ "$PROC_AFTER_1" -eq 1 ]; then
  echo "✅ 成功！4 轮对话只启动 1 个进程，进程被完美复用"
else
  echo "❌ 失败！进程数有变化"
fi

if [ "$PROC_AFTER_DELETE" -lt "$PROC_AFTER_4" ]; then
  echo "✅ 成功！删除 session 后进程被正确清理"
fi

if [ "$MESSAGES" -ge 8 ]; then
  echo "✅ 成功！对话历史完整保存（共 $MESSAGES 条消息）"
fi

echo ""
echo "=========================================="
echo "🎯 核心优势"
echo "=========================================="
echo "1. 进程复用：N 轮对话 = 1 个进程（不是 N 个）"
echo "2. 上下文保持：Claude 记住之前的对话"
echo "3. 性能优异：避免重复 spawn 的开销"
echo "4. 资源友好：内存占用稳定"
echo "=========================================="
