/**
 * Twikoo EdgeOne Pages 构建脚本
 *
 * 生成 IP 数据并检查部署入口；不修改第三方依赖
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { randomBytes } = require('node:crypto')
const { execFileSync } = require('node:child_process')

const srcDir = __dirname

// Bundle the same private token into both server runtimes. It is never placed
// in the static output or committed. An environment token can override it.
const generatedDir = path.join(srcDir, '.generated')
fs.mkdirSync(generatedDir, { recursive: true })
const tokenFile = path.join(generatedDir, 'internal-token.js')
if (!fs.existsSync(tokenFile)) {
  fs.writeFileSync(tokenFile, `export const INTERNAL_TOKEN = '${randomBytes(32).toString('hex')}'\n`)
}
const outputDir = path.join(srcDir, 'dist')
fs.mkdirSync(outputDir, { recursive: true })
fs.copyFileSync(path.join(srcDir, 'favicon.ico'), path.join(outputDir, 'favicon.ico'))

console.log('Twikoo EdgeOne Pages 构建脚本')
console.log('==============================')
console.log('')

// 步骤 0: 生成 ip2region 数据文件
console.log('步骤 0: 生成 ip2region 数据文件...')
const ip2regionDbPath = path.join(srcDir, 'node_modules/@imaegoo/node-ip2region/data/ip2region.db')
const ip2regionOutputPath = path.join(srcDir, 'node-functions/ip2region-data.js')

if (fs.existsSync(ip2regionDbPath)) {
  const dbBuffer = fs.readFileSync(ip2regionDbPath)
  console.log(`  原始大小: ${(dbBuffer.length / 1024 / 1024).toFixed(2)} MB`)

  const compressed = zlib.gzipSync(dbBuffer, { level: 9 })
  console.log(`  压缩后大小: ${(compressed.length / 1024 / 1024).toFixed(2)} MB`)

  const base64 = compressed.toString('base64')

  const jsContent = `/**
 * ip2region.db 数据（gzip 压缩 + Base64 编码）
 * 自动生成，请勿手动修改
 * 原始大小: ${(dbBuffer.length / 1024 / 1024).toFixed(2)} MB
 * 压缩后: ${(compressed.length / 1024 / 1024).toFixed(2)} MB
 */
import pako from 'pako'

const IP2REGION_DATA_BASE64 = '${base64}'

let _cachedBuffer = null

export function getIp2RegionBuffer() {
  if (_cachedBuffer === null) {
    // 将 Base64 转换为 Uint8Array
    const binaryString = atob(IP2REGION_DATA_BASE64)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    // 使用 pako 解压（纯 JS 实现，不依赖 Node.js zlib）
    _cachedBuffer = Buffer.from(pako.ungzip(bytes))
  }
  return _cachedBuffer
}

export default getIp2RegionBuffer
`

  fs.writeFileSync(ip2regionOutputPath, jsContent)
  console.log(`  ✓ 已生成: node-functions/ip2region-data.js (${(fs.statSync(ip2regionOutputPath).size / 1024 / 1024).toFixed(2)} MB)`)
} else {
  console.error('ip2region.db 不存在，请先安装依赖')
  process.exit(1)
}
console.log('')

// 检查必要文件
console.log('步骤 1: 检查项目文件...')
const requiredFiles = [
  'cloud-functions/index.js',
  'node-functions/index.js',
  'lib/mail.js',
  'lib/kv-auth.js',
  'node-functions/ip2region-searcher.js',
  'node-functions/ip2region-data.js',
  'edge-functions/api/kv.js',
  'package.json',
  'edgeone.json'
]

let allFilesExist = true
for (const file of requiredFiles) {
  const filePath = path.join(srcDir, file)
  if (fs.existsSync(filePath)) {
    console.log(`  ✓ ${file}`)
  } else {
    console.log(`  ✗ ${file} (缺失)`)
    allFilesExist = false
  }
}

console.log('')
if (allFilesExist) {
  // File existence alone does not detect invalid ESM/CJS imports.
  execFileSync(process.execPath, ['--input-type=module', '-e',
    "await import('./cloud-functions/index.js'); await import('./edge-functions/api/kv.js')"
  ], { cwd: srcDir, stdio: 'inherit' })
  console.log('构建完成！所有文件已就绪。')
  console.log('')
  console.log('项目结构：')
  console.log('  cloud-functions/index.js           - Node Function 主入口')
  console.log('  node-functions/ip2region-searcher.js - IP 归属地查询器')
  console.log('  node-functions/ip2region-data.js   - IP 数据库（自动生成）')
  console.log('  edge-functions/api/kv.js           - Edge Function KV API')
  console.log('')
  console.log('部署说明：')
  console.log('  1. 在 EdgeOne Pages 控制台创建项目')
  console.log('  2. 创建 KV 命名空间并绑定，变量名：TWIKOO_KV')
  console.log('  3. 推送代码触发部署')
} else {
  console.log('错误：部分必要文件缺失，请检查项目结构')
  process.exit(1)
}
