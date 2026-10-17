/*!
 * Twikoo EdgeOne Pages Edge Function - KV 数据库操作层
 * (c) 2025-present Mintimate
 * Released under the MIT License.
 *
 * 使用 EdgeOne Pages KV 存储作为数据库
 * KV 命名空间需要在 EdgeOne Pages 控制台绑定，变量名：TWIKOO_KV
 *
 * 存储结构：
 * - comments_all    - 所有评论的 JSON 数组（单次读取，减少 KV 调用）
 * - config_main     - 系统配置
 * - counter_{hash}  - 页面访问计数
 */

import { INTERNAL_TOKEN } from '../../.generated/internal-token.js'
import { verifyKVRequest } from '../../lib/kv-auth.js'

// 响应码
const RES_CODE = {
  SUCCESS: 0,
  FAIL: 1000,
  FORBIDDEN: 1403
}

// 评论存储的 KV 键名
const COMMENTS_KEY = 'comments_all'

/**
 * EdgeOne Pages Edge Function 入口
 */
export async function onRequest (context) {
  const { request, env = {} } = context

  const headers = {
    'Content-Type': 'application/json; charset=UTF-8',
    'Cache-Control': 'no-store'
  }
  const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers })
  if (request.method !== 'POST') {
    return respond({ code: RES_CODE.FORBIDDEN, message: '禁止直接访问 KV API' }, 405)
  }

  const token = env.TWIKOO_INTERNAL_TOKEN ||
    (typeof TWIKOO_INTERNAL_TOKEN !== 'undefined' ? TWIKOO_INTERNAL_TOKEN : INTERNAL_TOKEN)
  if (!token) {
    return respond({ code: RES_CODE.FAIL, message: '未配置 TWIKOO_INTERNAL_TOKEN' }, 503)
  }
  const rawBody = await request.text()
  if (!await verifyKVRequest(token, request.url, rawBody, request.headers)) {
    return respond({ code: RES_CODE.FORBIDDEN, message: '禁止直接访问 KV API' }, 403)
  }

  let body
  try {
    body = JSON.parse(rawBody)
    if (!body || typeof body.action !== 'string' || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
      throw new Error('Invalid request')
    }
  } catch {
    return respond({ code: RES_CODE.FAIL, message: '请求体不合法' }, 400)
  }
  const { action, data } = body
  let res = {}
  try {
    // 创建数据库操作对象
    const db = createKVDatabase(env.TWIKOO_KV || (typeof TWIKOO_KV !== 'undefined' ? TWIKOO_KV : undefined))

    switch (action) {
      case 'getComments':
        res = { code: RES_CODE.SUCCESS, data: await db.getComments(data.query || {}) }
        break
      case 'addComment':
        res = { code: RES_CODE.SUCCESS, data: await db.addComment(data.comment) }
        break
      case 'updateComment':
        res = { code: RES_CODE.SUCCESS, data: await db.updateComment(data.id, data.updates) }
        break
      case 'deleteComment':
        res = { code: RES_CODE.SUCCESS, data: await db.deleteComment(data.id) }
        break
      case 'getComment':
        res = { code: RES_CODE.SUCCESS, data: await db.getComment(data.id) }
        break
      case 'bulkAddComments':
        res = { code: RES_CODE.SUCCESS, data: await db.bulkAddComments(data.comments) }
        break
      case 'getConfig':
        res = { code: RES_CODE.SUCCESS, data: await db.getConfig() }
        break
      case 'saveConfig':
        res = { code: RES_CODE.SUCCESS, data: await db.saveConfig(data.config) }
        break
      case 'getCounter':
        res = { code: RES_CODE.SUCCESS, data: await db.getCounter(data.url) }
        break
      case 'incCounter':
        res = { code: RES_CODE.SUCCESS, data: await db.incCounter(data.url, data.title) }
        break
      default:
        res = { code: RES_CODE.FAIL, message: '未知操作' }
    }
  } catch (e) {
    console.error('KV 操作错误：', e.message, e.stack)
    res = { code: RES_CODE.FAIL, message: `KV Error: ${e.message}` }
  }

  return respond(res)
}

// ==================== 工具函数 ====================

function generateUUID () {
  // 使用 Web Crypto API 生成标准 UUID v4（EdgeOne Edge Function 支持）
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '') // 移除连字符保持 32 位格式
  }
  // 降级方案：使用 crypto.getRandomValues 获取更高质量的随机数
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    // 设置 UUID v4 版本位
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  }
  // 保底: 原始实现
  return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/[x]/g, () => {
    return (Math.random() * 16 | 0).toString(16)
  })
}

// ==================== KV 数据库操作层（优化版） ====================

function createKVDatabase (kv) {
  if (!kv) {
    throw new Error('未配置 TWIKOO_KV 命名空间，请在 EdgeOne Pages 控制台绑定 KV 存储')
  }

  // New keys use only letters, digits and underscores. Retain existing data
  // from deployments where the legacy colon-separated keys were accepted.
  async function readValue (key, legacyKey) {
    const current = await kv.get(key)
    if (current !== null && current !== undefined) return current
    try {
      return await kv.get(legacyKey)
    } catch (error) {
      if (/invalid.*key|key.*(?:invalid|character|format|allow|only)|键.*(?:格式|字符|不合法)/i.test(error.message)) return null
      throw error
    }
  }

  // 评论缓存（减少重复读取）
  let commentsCache = null

  return {
    // 获取所有评论（单次 KV 读取）
    async getAllComments () {
      if (commentsCache !== null) {
        return commentsCache
      }
      // eslint-disable-next-line no-undef
      const data = await readValue(COMMENTS_KEY, 'comments:all')
      commentsCache = data ? JSON.parse(data) : []
      return commentsCache
    },

    // 保存所有评论
    async saveAllComments (comments) {
      commentsCache = comments
      // eslint-disable-next-line no-undef
      await kv.put(COMMENTS_KEY, JSON.stringify(comments))
    },

    // 查询评论（支持过滤条件）
    async getComments (query = {}) {
      const allComments = await this.getAllComments()
      return filterComments(allComments, query)
    },

    // 添加评论
    async addComment (comment) {
      const id = comment._id || generateUUID()
      comment._id = id
      comment.id = id // 兼容性

      const comments = await this.getAllComments()
      comments.push(comment)
      await this.saveAllComments(comments)

      return { id }
    },

    // 更新评论
    async updateComment (id, updates) {
      const comments = await this.getAllComments()
      const index = comments.findIndex(c => c._id === id)

      if (index !== -1) {
        Object.assign(comments[index], updates)
        await this.saveAllComments(comments)
        return { updated: 1 }
      }
      return { updated: 0 }
    },

    // 删除评论
    async deleteComment (id) {
      const comments = await this.getAllComments()
      const index = comments.findIndex(c => c._id === id)

      if (index !== -1) {
        comments.splice(index, 1)
        await this.saveAllComments(comments)
        return { deleted: 1 }
      }
      return { deleted: 0 }
    },

    // 获取单条评论
    async getComment (id) {
      const comments = await this.getAllComments()
      return comments.find(c => c._id === id) || null
    },

    // 批量添加评论
    async bulkAddComments (newComments) {
      const comments = await this.getAllComments()
      let insertedCount = 0

      for (const comment of newComments) {
        const id = comment._id || generateUUID()
        comment._id = id
        comment.id = id
        comments.push(comment)
        insertedCount++
      }

      await this.saveAllComments(comments)
      return insertedCount
    },

    // 获取配置
    async getConfig () {
      // eslint-disable-next-line no-undef
      const data = await readValue('config_main', 'config:main')
      return data ? JSON.parse(data) : {}
    },

    // 保存配置
    async saveConfig (newConfig) {
      const currentConfig = await this.getConfig()
      const merged = { ...currentConfig, ...newConfig }
      // eslint-disable-next-line no-undef
      await kv.put('config_main', JSON.stringify(merged))
      return { updated: 1 }
    },

    // 获取计数器
    async getCounter (url) {
      const key = await counterKey(url)
      // eslint-disable-next-line no-undef
      const data = await readValue(key, `counter:${encodeURIComponent(url)}`)
      return data ? JSON.parse(data) : null
    },

    // 增加计数器
    async incCounter (url, title) {
      const key = await counterKey(url)
      let counter = await this.getCounter(url)

      if (counter) {
        counter.time = (counter.time || 0) + 1
        counter.title = title
        counter.updated = Date.now()
      } else {
        counter = {
          url,
          title,
          time: 1,
          created: Date.now(),
          updated: Date.now()
        }
      }

      // eslint-disable-next-line no-undef
      await kv.put(key, JSON.stringify(counter))
      return 1
    }
  }
}

async function counterKey (url) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url))
  return 'counter_' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

// ==================== 评论过滤函数 ====================

function filterComments (comments, query) {
  if (!Object.keys(query).length) return comments

  return comments.filter(comment => {
    for (const [key, value] of Object.entries(query)) {
      if (key === '$or') {
        const orMatch = value.some(condition => {
          return Object.entries(condition).every(([k, v]) => matchCondition(comment, k, v))
        })
        if (!orMatch) return false
      } else if (!matchCondition(comment, key, value)) {
        return false
      }
    }
    return true
  })
}

function matchCondition (comment, key, value) {
  const commentValue = comment[key]

  if (value === null || value === undefined) {
    return commentValue === null || commentValue === undefined
  }

  if (typeof value === 'object') {
    if ('$in' in value) {
      return value.$in.includes(commentValue)
    }
    if ('$ne' in value) {
      return commentValue !== value.$ne
    }
    if ('$exists' in value) {
      return value.$exists
        ? (commentValue !== undefined && commentValue !== null && commentValue !== '')
        : (commentValue === undefined || commentValue === null || commentValue === '')
    }
    if ('$gt' in value) {
      return commentValue > value.$gt
    }
    if ('$lt' in value) {
      return commentValue < value.$lt
    }
    if ('$regex' in value) {
      const regex = new RegExp(value.$regex, value.$options || '')
      return regex.test(commentValue)
    }
  }

  return commentValue === value
}

export default onRequest
