# Twikoo EdgeOne Pages 版本

<a href="https://twikoo.js.org/"><img src="./docs/static/logo.png" width="300" alt="Twikoo"></a>

[![](https://img.shields.io/npm/l/twikoo)](./LICENSE)

专为腾讯云 EdgeOne Pages 平台优化的 [Twikoo](https://github.com/twikoojs/twikoo) 评论系统后端。

本仓库基于 [Mintimate/twikoo-eo](https://github.com/Mintimate/twikoo-eo) 修复并维护。

**简洁** · **安全** · **免费**

## 特性

- 基于 EdgeOne Pages 边缘计算，全球加速
- 使用 KV 存储，无需额外数据库
- 支持邮件通知、即时消息推送
- 一键部署，开箱即用

## 快速上手 | Quick Start

### 一键部署 | One-Click Deploy

您可以通过 [腾讯云 EdgeOne Pages](https://pages.edgeone.ai/zh) 一键部署。

直接点击此按钮一键部署：

[![使用 EdgeOne Pages 部署](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://console.cloud.tencent.com/edgeone/pages/new?repository-url=https%3A%2F%2Fgithub.com%2Fluoxfish%2Ftwikoo-eo)

查看 [腾讯云 EdgeOne Pages 文档](https://pages.edgeone.ai/zh/document/product-introduction) 了解更多详情。

需要注意，你还是需要新建一个 KV，并且绑定到项目中:

![设置的 KV](./docs/static/eoKvSetting.png)

### 完整教程 | Full Tutorial

Twikoo 的完整教程，参考 Twikoo 官方项目: https://github.com/twikoojs/twikoo 以及 Twikoo 的[快速上手](https://twikoo.js.org/quick-start.html)

手动部署到 EdgeOne Pages 的方法如下： 

#### 部署步骤 | Deployment Steps

1. **准备工作**
   - 注册腾讯云账号并开通 EdgeOne 服务

2. **创建 EdgeOne Pages 项目**
   - 登录腾讯云 EdgeOne 控制台
   - 创建新的 Pages 项目
   - 选择 GitHub 作为代码源
   - 关联本仓库。或者直接下载本仓库，手动上传到 EdgeOne Pages 里（会自动触发部署）。

3. **配置 KV 存储**
   - 在 EdgeOne Pages 控制台创建 KV 命名空间
   - 将 KV 命名空间绑定到项目，变量名设为：`TWIKOO_KV`

4. **构建配置**
   - 仓库内的 `edgeone.json` 已配置 `npm ci`、`npm run build`、输出目录 `dist` 和 Node.js 22.11.0。
   - 框架预设选择 **Other**，项目根目录选择仓库根目录。
   - 当前平台入口是 `cloud-functions/index.js`，旧 `node-functions/index.js` 保留兼容。
   - 构建会自动生成 Node / Edge 共用的私有请求签名密钥，无需额外配置；请部署完整项目，使两个函数来自同一次构建。
   - 可选环境变量 `TWIKOO_INTERNAL_TOKEN` 可以指定固定密钥（建议使用至少 32 字节随机值）；如设置，Node 和 Edge 函数必须使用同一值。不要将密钥填入前端或提交到仓库。

5. **配置跨域（可选）**
   - 在 EdgeOne Pages 控制台添加环境变量 `CORS_ALLOW_ORIGIN`
   - 格式：`example.com,blog.example.com`（多个域名用逗号分隔）
   - 不设置则允许所有域名访问

6. **触发部署**
   - 三种方式触发部署: ① Fork 代码到自己仓库，EdgeOne Pages 进行关联，后续会自动触发部署。② 直接本地安装 edgeone-cli 情况下，`edgeone pages link`、`edgeone pages deploy`部署。③ 手动上传代码到 EdgeOne Pages 里覆盖。
   - 部署完成后，获取你的 EdgeOne Pages 地址作为 twikoo 的环境配置

7. **前端配置**
   ```html
   <script>
     twikoo.init({
       envId: 'https://your-edgeone-pages-domain',  // EdgeOne Pages 地址
       el: '#tcomment'
     })
   </script>
   ```

关键步骤截图:

![设置的 KV](./docs/static/eoKvSetting.png)

#### 环境配置要求 | Environment Requirements

- **Node.js**: 20+（构建配置使用平台预装的 22.11.0）
- **KV 存储**: 必须创建并绑定 TWIKOO_KV 命名空间

#### 常见问题解决方法 | Common Issues

1. **KV 存储连接失败**
   - 检查 KV 命名空间是否正确绑定
   - 确认变量名为 `TWIKOO_KV`
   - 重新部署项目

2. **邮件通知不工作**
   - 验证 SMTP 服务配置是否正确
   - 检查邮箱是否开启了 IMAP/SMTP 服务
   - 确认邮箱密码或应用专用密码

3. **访问地址返回 404 / NOT_FOUND**
   - 确认构建日志已生成 `cloud-functions/index.js` 的 `/` 路由。
   - 确认项目关联的是本仓库实际推送的分支，并重新部署最新提交。
   - 检查项目根目录为仓库根目录、框架预设为 Other，构建配置以 `edgeone.json` 为准。
   - 如果默认部署域名可用、自定义域名仍返回 404，请检查自定义域名绑定。

4. **评论提交失败**
   - 检查网络连接、Node Function 地址和 KV 绑定
   - 确认 KV 存储空间是否充足
   - 查看部署日志排查错误


#### 注意事项 | Important Notes

当前测试以下功能正常:
- 评论提交、评论回复、评论点赞、评论删除等前台评论操作。
- 邮件通知（支持 SMTP TLS / STARTTLS，以及 SendGrid 和 MailChannels HTTP API）。
- IP 获取正常（使用 EdgeOne 提供的 `eo-connecting-ip`）。
- UA 获取、浏览器类型正常。
- IP 归属地查询正常。

KV 存储的评论:

![KV 存储的评论](./docs/static/eoKvComments.png)

## 开发 | Development

### EdgeOne Pages 开发 | EdgeOne Pages Development

本项目结构专为 EdgeOne Pages 平台优化：

```sh
npm ci
npm test
npm run build

# 可选：安装并登录 EdgeOne CLI 后调试
npm install -g edgeone
npm run dev
```

`npm ci` 会生成 IP 数据文件、私有签名密钥及静态输出目录。构建脚本不再覆写 `node_modules` 中的邮件、HTML 清理等依赖。依赖锁文件应随代码一起提交。

**项目结构说明：**

```text
├── cloud-functions/index.js       # 当前平台的 / 路由入口
├── node-functions/
│   ├── index.js                   # 评论业务逻辑及旧平台入口
│   ├── ip2region-searcher.js       # 内存 IP 属地查询
│   └── ip2region-data.js          # 构建生成，不提交
├── edge-functions/api/kv.js       # 仅接受签名请求的 KV 接口
├── lib/                          # 邮件适配与请求签名
├── test/                         # 接口及本地 SMTP 回归测试
├── .generated/                   # 构建生成的私有密钥，不提交
├── dist/                         # 静态输出，不含函数源码和密钥
├── edgeone.json                  # 部署配置
├── build.cjs                     # 构建脚本
└── package-lock.json             # 固定依赖版本
```

**架构说明：**
- **Edge Function (`edge-functions/api/kv.js`)**: 运行在边缘节点，负责 KV 数据库的读写操作
- **Node Function (`cloud-functions/index.js` → `node-functions/index.js`)**: 运行在 Node.js 环境，处理评论业务逻辑、邮件通知等
- Node Function 通过带 HMAC 签名的 HTTP 请求调用 Edge Function 的 KV API；签名绑定请求内容、目标主机及时间，密钥不会随请求发送。

**开发注意事项：**
- Edge Functions 使用 KV 存储作为数据库
- Node Functions 用于处理评论逻辑和邮件通知
- 环境变量在 EdgeOne Pages 控制台配置
- 本地开发时需要模拟 KV 环境；`npm test` 使用内存 KV 和本地 SMTP 服务，不读写线上数据、不发送真实邮件。
- Node Function 优先使用平台的 `eo-pages-host` 调用同一部署的 KV 接口；必要时可通过 `TWIKOO_SERVER_URL` 指定项目访问地址。
- 新存储键使用 `comments_all`、`config_main`、`counter_{SHA256}`；会兼容读取旧的冒号格式键，后续写入使用新键。
- KV 是最终一致存储，当前评论和计数采用读改写，不提供跨节点并发事务保证，适用于低流量博客。需要严格一致性或高并发写入时应改用支持事务的数据库。

如果您的改动能够帮助到更多人，欢迎提交 Pull Request！

## 许可 | License

<details>
<summary>MIT License</summary>

[![FOSSA Status](https://app.fossa.com/api/projects/git%2Bgithub.com%2Fimaegoo%2Ftwikoo.svg?type=large)](https://app.fossa.com/projects/git%2Bgithub.com%2Fimaegoo%2Ftwikoo?ref=badge_large)

</details>
