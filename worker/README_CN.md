# OMP 媒体代理 Worker

[English](README.md) | 中文

这是一个可选的 Cloudflare Worker。它验证浏览器生成的 HMAC 签名媒体 URL，
并代理短时效 OneDrive 下载 URL 的 `GET`、`HEAD` 和字节范围请求。Worker
不会收到 Microsoft Graph Access Token。

Cloudflare Worker 仅适合个人、低流量实验。Cloudflare 和 OpenList 均不建议
使用普通 Worker 长期分发或大流量分发媒体内容。

## 配置

1. 在本目录运行 `npm install` 安装依赖。
2. 生成并设置一个强随机代理密钥：

   ```sh
   openssl rand -base64 32 | npx wrangler secret put PROXY_ACCESS_KEY
   ```

3. 编辑 `wrangler.jsonc`：
   - `ALLOWED_ORIGINS` 是以逗号分隔的 OMP 来源列表，来源不应包含路径。
     默认仅允许 `http://localhost:8760`；部署时请按实际使用的 OMP 来源修改。
   - `ALLOWED_UPSTREAM_SUFFIXES` 是 Microsoft 下载域名的逗号分隔白名单。
     `.1drv.com,.sharepoint.com` 覆盖常见的全球版 OneDrive 下载 URL。对于
     其他云环境，只应添加实际观察到的 Microsoft 所有域名后缀。
4. 运行 `npm run deploy` 部署。
5. 在 OMP 设置中填写已部署 Worker 的 Origin，以及与
   `PROXY_ACCESS_KEY` 完全一致的代理访问密钥。

OMP 只会将代理访问密钥保存在当前浏览器的本地设置中，Worker 则将同一个值
保存为 Secret。OMP 使用该密钥通过 HMAC-SHA256 生成签名媒体 URL；密钥本身
不会进入媒体 URL。密钥不强制使用特定编码，但如果签名媒体 URL 泄露，短密码
或重复使用的密码可能遭到离线猜测，因此应使用强随机密钥。

媒体请求使用以下格式：

```text
/v1/media?payload={payload}&signature={signature}
```

签名 payload 包含可逆的 Base64URL 编码短时效 OneDrive 下载 URL。因此，每次
媒体请求都可能在 CDN 或 Worker 请求日志中留下该临时 URL 的编码形式。示例配置
默认关闭 Worker 可观测性。请勿添加会记录密钥、完整签名媒体 URL 或解码后上游
URL 的应用日志。

切换账户，或修改 Worker 地址、代理密钥及启用状态时，OMP 会清空内存中的媒体
来源缓存。代理播放失败后，OMP 会先获取新的 Graph 下载 URL 并重新签名；若仍然
失败，则使用新的 Graph 下载 URL 直连播放。

## 测试

```sh
npm test
```

运行 `npm run typecheck` 可检查 Worker 和测试的 TypeScript 类型；运行
`npm run check` 可同时执行类型检查和测试。
