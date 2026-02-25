import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MemoryManager } from '../memory/MemoryManager';

/**
 * 注册记忆管理相关的 API 路由
 * 
 * 这些路由供客户端或 MCP 工具调用，实现:
 * - 读取用户内核
 * - 更新内核特定部分
 * - 查看对话历史
 */
export function registerMemoryRoutes(
  fastify: FastifyInstance,
  memoryManager: MemoryManager
) {
  // GET /users/:userId/kernel - 读取用户内核
  fastify.get('/users/:userId/kernel', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const requestingUser = (request as any).userContext?.userId;

    // 只能访问自己的内核
    if (requestingUser !== userId) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    try {
      const kernel = await memoryManager.readKernel(userId);
      return { userId, kernel };
    } catch (error) {
      reply.status(500);
      return { error: 'Failed to read kernel' };
    }
  });

  // GET /users/:userId/kernel/prompt - 获取用于 System Prompt 的摘要
  fastify.get('/users/:userId/kernel/prompt', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const requestingUser = (request as any).userContext?.userId;

    if (requestingUser !== userId) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const maxLength = parseInt((request.query as any).maxLength || '2000', 10);

    try {
      const prompt = await memoryManager.getKernelPrompt(userId, maxLength);
      return { userId, prompt };
    } catch (error) {
      reply.status(500);
      return { error: 'Failed to generate prompt' };
    }
  });

  // POST /users/:userId/kernel/update - 更新内核部分
  fastify.post('/users/:userId/kernel/update', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const requestingUser = (request as any).userContext?.userId;

    if (requestingUser !== userId) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const { section, content, append } = request.body as {
      section: string;
      content: string;
      append?: boolean;
    };

    if (!section || !content) {
      reply.status(400);
      return { error: 'Missing section or content' };
    }

    try {
      await memoryManager.updateKernelSection(userId, section, content, append);
      return { ok: true, section, userId };
    } catch (error) {
      reply.status(500);
      return { error: 'Failed to update kernel' };
    }
  });

  // POST /users/:userId/memory - 添加单条记忆
  fastify.post('/users/:userId/memory', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const requestingUser = (request as any).userContext?.userId;

    if (requestingUser !== userId) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const { category, memory } = request.body as {
      category: 'habits' | 'skills' | 'preferences' | 'context';
      memory: string;
    };

    if (!category || !memory) {
      reply.status(400);
      return { error: 'Missing category or memory' };
    }

    try {
      await memoryManager.appendMemory(userId, category, memory);
      return { ok: true, category, memory };
    } catch (error) {
      reply.status(500);
      return { error: 'Failed to append memory' };
    }
  });

  // GET /users/:userId/conversations - 获取对话历史列表
  fastify.get('/users/:userId/conversations', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const requestingUser = (request as any).userContext?.userId;

    if (requestingUser !== userId) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const days = parseInt((request.query as any).days || '7', 10);

    try {
      const conversations = await memoryManager.getRecentConversations(userId, days);
      return {
        userId,
        days,
        count: conversations.length,
        conversations,
      };
    } catch (error) {
      reply.status(500);
      return { error: 'Failed to get conversations' };
    }
  });

  // POST /sessions/:sessionId/summarize - 总结当前会话并更新记忆
  fastify.post('/sessions/:sessionId/summarize', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const userId = (request as any).userContext?.userId;

    const { topic, keyDecisions, newMemories } = request.body as {
      topic: string;
      keyDecisions: string[];
      newMemories: string[];
    };

    if (!topic) {
      reply.status(400);
      return { error: 'Missing topic' };
    }

    try {
      await memoryManager.appendConversationSummary(userId, sessionId, {
        topic,
        keyDecisions: keyDecisions || [],
        newMemories: newMemories || [],
      });

      // 如果有新记忆，也更新到内核
      if (newMemories?.length > 0) {
        for (const memory of newMemories) {
          // 尝试分类并追加
          await memoryManager.appendMemory(userId, 'context', memory);
        }
      }

      return { ok: true, sessionId, memoriesAdded: newMemories?.length || 0 };
    } catch (error) {
      reply.status(500);
      return { error: 'Failed to summarize session' };
    }
  });
}
