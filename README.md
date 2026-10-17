# 工业余热回收 Agent · Render 免费试运行

本分支是已有 Agent 的便携部署包，与 GitHub Pages 的 gh-pages 分支分开。计算引擎、数据表、知识源和 dialog 原字节封装，SHA256 见 runtime-manifest.json。只新增云端 HTTP 入口和界面接入配置。

## Render 创建 Web Service

| 配置项 | 填写内容 |
|---|---|
| Repository | https://github.com/chen-1314-yang/waste-heat-platform |
| Branch | agent-service |
| Name | waste-heat-agent（重名时可由 Render 加后缀） |
| Region | Singapore |
| Language / Runtime | Node |
| Root Directory | 留空 |
| Build Command | npm run verify |
| Start Command | npm start |
| Instance Type | Free |
| Health Check Path | /api/health |
| Auto Deploy | Off（手动发布，保留数值冻结） |

环境变量：DEEPSEEK_API_KEY 填你自己的 DeepSeek API 密钥；只在 Render 的环境变量框填写，不发到聊天、不写 GitHub。NODE_VERSION=24.8.0，PARENT_ORIGIN=https://chen-1314-yang.github.io，DAILY_TURN_LIMIT=120。PORT 由 Render 提供，无需手填。

也可用仓库根目录 render.yaml 创建 Blueprint（规格已写 free）；仍需你在 Render 填写密钥并确认免费方案。若出现绑卡、付费升级或额外资源，不属于本轮授权，请先停在该页。

## 运行和验证

`npm run verify` 检查冻结文件哈希及凭据；`npm test` 执行真实 HTTP 安全和 SSE 契约测试；`node cloud_e2e.mjs` 执行打包后的真实引擎结构化计算。

`npm start` 监听 0.0.0.0 和 Render 的 PORT。/api/health 仅检查加载状态，不调用收费模型，也不返回主机路径/密钥来源。DEEPSEEK_API_KEY 未配置时，自然语言入口明确降级；结构化参数计算仍可运行。

## 试运行边界

- Free 服务闲置 15 分钟后休眠，首次访问恢复可能约一分钟；不设置定时保活。
- 会话和请求限额在单进程内存里，重启/重新部署会丢失会话并重置限额；不是持久化账本。
- 随机会话 id 是 bearer 能力令牌，仅放当前浏览器标签的 sessionStorage，不放 URL。公开入口不提供读取/列举其他会话或调试接口。
- 默认每天全站最多 120 次对话请求、每个会话 30 次、最多同时处理 2 轮；新会话也限速。它们是试运行限额，不等同于 DeepSeek 账号的硬支出上限。模型调用仍按 DeepSeek 账号规则计费。
- 计算结果仍属原项目仿真/推算口径，不代表工程保证。
- 原 Agent 在“直接填参数”分支的校验报告已发现舍入显示值等提示异常；两组真实 HTTP 对比确认云端与原版输出及提示完全相同，未在本批改动数字或原校验逻辑。不能把“接入测试通过”表述成“所有科学口径均已验证”。

## 接入主站与回滚

部署成功后先验证 Render 实际生成的 HTTPS 地址及两轮真实对话，再在主站 content/site.json 的 agentUrl 填该地址。主站 src/views/agent.js 在独立持久容器加载 iframe；切换计算页保留助手。只接受 *.onrender.com 的 HTTPS 地址，开发预览可在 localhost 嵌 localhost。

主站发布必须经原 tools/deploy.py 全部门禁，不跳过测试。回滚接入：撤回这批显示层提交，按原发布流程恢复 gh-pages；关闭 Render 服务不会影响原 GitHub Pages 计算页。冻结的 runtime 文件不在本批修改范围内。

官方说明：https://render.com/docs/free · https://render.com/docs/blueprint-spec · https://render.com/docs/web-services

## 2026-10-17 Streamlit 旧入口内嵌修复

现有入口 `https://waste-heat-demo.streamlit.app` 外层套着 GitHub Pages 主站，主站再加载本 Agent。CSP frame-ancestors 会检查每一层祖先，故白名单同时包含 self、GitHub 主站与上述确切的 Streamlit 入口。没有开放 *.streamlit.app 或任意来源；API 的 POST Origin 限制保持原样，嵌入许可不授予额外的 API 跨域许可。

验证：cloud_test.mjs 的 Streamlit 链路测试先失败、修复后通过；删除外层许可的反向变异也确实失败。全部 8 项服务测试通过，23 份冻结文件校验通过。Render 生效须部署本次 agent-service 提交（若自动部署关闭，手动 Deploy latest commit）。
