// 用 bun 启动演示页面服务器
import { existsSync } from "fs";
import { serve } from "bun";

const server = serve({
  port: 8080,
  fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;

    // 安全路径检查
    if (path.includes("..")) {
      return new Response("Forbidden", { status: 403 });
    }

    const filePath = `./${path}`;

    if (!existsSync(filePath)) {
      return new Response("Not Found", { status: 404 });
    }

    const file = Bun.file(filePath);
    return new Response(file);
  },
});

console.log(`🚀 Demo 页面已启动: http://localhost:${server.port}`);
console.log("按 Ctrl+C 停止服务");
