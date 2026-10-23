import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export async function acquireCdkLock(root) {
  const id = crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 32);
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\tosub2-cdk-${id}` : process.platform === "linux" ? `\0tosub2-cdk-${id}` : path.join(os.tmpdir(), `tosub2-cdk-${id}.sock`);
  const lock = net.createServer((socket) => socket.end());
  try {
    await new Promise((resolve, reject) => { lock.once("error", reject); lock.listen(socketPath, resolve); });
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    if (!["win32", "linux"].includes(process.platform)) {
      const live = await new Promise((resolve) => { const socket = net.connect(socketPath); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); });
      if (!live) {
        const stat = await fs.lstat(socketPath); if (!stat.isSocket()) throw new Error("工作区锁路径已被其他文件占用");
        await fs.unlink(socketPath);
        return acquireCdkLock(root);
      }
    }
    throw new Error("同一数据目录已有控制台在运行，请停止原实例后启动");
  }
  return { close: () => new Promise((resolve) => lock.close(resolve)) };
}
