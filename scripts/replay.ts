#!/usr/bin/env tsx

import { MongoDBService } from '../src/services/mongodb.js'
import type { RecordedRequest } from '../src/types/backend.js'

/**
 * 重放脚本 - 从 MongoDB 获取记录的请求并发送到指定的目标 URL
 *
 * 用法:
 *   npx tsx scripts/replay.ts [target_url] [filter_backend_id] [limit] [concurrency]
 *
 * 示例:
 *   npx tsx scripts/replay.ts http://localhost:3000/v1/chat/completions
 *
 * 环境变量:
 *   MONGODB_URL: MongoDB 连接字符串 (默认: mongodb://localhost:27017/wenyao)
 *   PROXY_API_KEY: 测试时使用的代理 API key (可选，若不提供则尝试使用记录中的 Authorization 头)
 */

async function main() {
  const targetUrl = process.argv[2] || 'http://localhost:3000/v1/chat/completions'
  const filterBackendId = process.argv[3]
  const limit = parseInt(process.argv[4] || '10')
  const concurrency = parseInt(process.argv[5] || '1')

  console.log('🚀 Wenyao 请求重放工具');
  console.log('===============================');
  console.log(`目标地址: ${targetUrl}`);
  if (filterBackendId) console.log(`筛选后端 ID: ${filterBackendId}`);
  console.log(`获取记录条数: ${limit}`);
  console.log(`并发量: ${concurrency}`);
  console.log('===============================\n');

  const mongo = new MongoDBService()

  try {
    await mongo.connect()
    console.log('✅ 已连接到 MongoDB');

    const collection = mongo.getRecordedRequestsCollection()
    const query = filterBackendId ? { backendId: filterBackendId } : {}

    const requests = await collection
      .find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray()

    if (requests.length === 0) {
      console.log('❌ 未找到记录的请求。');
      return;
    }

    console.log(`找到 ${requests.length} 条记录。开始重放...\n`);

    let successCount = 0;
    let failCount = 0;
    let index = 0;

    async function worker() {
      while (index < requests.length) {
        const currentIndex = index++;
        const req = requests[currentIndex] as RecordedRequest;

        let payload: any;
        try {
          payload = JSON.parse(req.body);
        } catch (e) {
          console.log(`[${currentIndex + 1}/${requests.length}] ❌ 无法解析请求体: ${req.body.substring(0, 50)}...`);
          failCount++;
          continue;
        }

        // 使用原始模型名称，以便代理进行路由
        if (req.model) {
          payload.model = req.model;
        }

        const requestLabel = `[${currentIndex + 1}/${requests.length}] 重放 ${payload.model || 'unknown'} (原后端: ${req.backendId})`;
        const startTime = Date.now();

        try {
          const headers: Record<string, string> = { ...req.headers };

          // 优先使用环境变量提供的 API Key
          if (process.env.PROXY_API_KEY) {
            headers['Authorization'] = `Bearer ${process.env.PROXY_API_KEY}`;
          }

          const response = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
          });

          const duration = Date.now() - startTime;

          if (response.ok) {
            successCount++;
            console.log(`${requestLabel} ✅ ${response.status} (${duration}ms)`);
          } else {
            failCount++;
            const errorText = await response.text();
            console.log(`${requestLabel} ❌ ${response.status} (${duration}ms)`);
            console.log(`   错误响应: ${errorText.substring(0, 200)}${errorText.length > 200 ? '...' : ''}`);
          }
        } catch (err: any) {
          failCount++;
          console.log(`${requestLabel} ❌ 失败: ${err.message}`);
        }
      }
    }

    // 启动指定数量的 worker
    const workers = Array.from({ length: Math.min(concurrency, requests.length) }, () => worker());
    await Promise.all(workers);

    console.log('\n===============================');
    console.log('重放任务完成:');
    console.log(`总计: ${requests.length}`);
    console.log(`成功: ${successCount}`);
    console.log(`失败: ${failCount}`);
    console.log('===============================');

  } catch (error) {
    console.error('❌ 重放过程中出现错误:', error);
  } finally {
    await mongo.disconnect();
  }
}

main().catch(error => {
  console.error('致命错误:', error);
  process.exit(1);
});
