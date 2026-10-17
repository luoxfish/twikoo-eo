/*!
 * Twikoo EdgeOne Pages Node Function
 * (c) 2020-present iMaeGoo
 * Released under the MIT License.
 *
 * 使用 twikoo-func 实现核心逻辑，通过 Edge Function 操作 KV 数据库
 */

import bowser from 'bowser'
import utils from 'twikoo-func/utils/index.js'
import constants from 'twikoo-func/utils/constants.js'
import imageUtils from 'twikoo-func/utils/image.js'
import importUtils from 'twikoo-func/utils/import.js'
import libUtils from 'twikoo-func/utils/lib.js'
import logger from 'twikoo-func/utils/logger.js'
import notifyUtils from 'twikoo-func/utils/notify.js'
import spamUtils from 'twikoo-func/utils/spam.js'
import { createTransport } from '../lib/mail.js'
import { INTERNAL_TOKEN } from '../.generated/internal-token.js'
import { signKVRequest } from '../lib/kv-auth.js'

const {
  addQQMailSuffix,
  checkGeeTestCaptcha,
  checkTurnstileCaptcha,
  equalsMail,
  getAvatar,
  getConfig,
  getConfigForAdmin,
  getFuncVersion,
  getMailMd5,
  getPasswordStatus,
  getQQAvatar,
  getUrlQuery,
  getUrlsQuery,
  isQQ,
  normalizeMail,
  preCheckSpam,
  validate,
  validateClientFields
} = utils
const { uploadImage } = imageUtils
const {
  commentImportArtalk,
  commentImportArtalk2,
  commentImportDisqus,
  commentImportTwikoo,
  commentImportValine,
  jsonParse
} = importUtils
const {
  getMd5,
  getSha256,
  getXml2js,
  setCustomLibs
} = libUtils
const { emailTest, sendNotice } = notifyUtils
const { postCheckSpam } = spamUtils
import { v4 as uuidv4 } from 'uuid'
import xss from 'xss'
import { getIpRegion } from './ip2region-searcher.js'

const { RES_CODE, MAX_REQUEST_TIMES } = constants
const VERSION = '1.7.1'

// Keep SMTP TLS/authentication and MIME handling in Nodemailer.
setCustomLibs({ nodemailer: { createTransport } })

const md5 = getMd5()
const sha256 = getSha256()
const xml2js = getXml2js()

// ==================== 本地实现的 parseComment（替代 twikoo-func 版本）====================

/**
 * 修复 OS 版本名称
 */
function fixOS (ua) {
  const os = ua.getOS()
  if (!os.versionName) {
    if (os.name === 'Windows' && os.version === 'NT 11.0') {
      os.versionName = '11'
    } else if (os.name === 'macOS') {
      const majorPlatformVersion = os.version?.split('.')[0]
      os.versionName = {
        11: 'Big Sur', 12: 'Monterey', 13: 'Ventura', 14: 'Sonoma', 15: 'Sequoia'
      }[majorPlatformVersion]
    } else if (os.name === 'Android') {
      const majorPlatformVersion = os.version?.split('.')[0]
      os.versionName = {
        10: 'Quince Tart',
        11: 'Red Velvet Cake',
        12: 'Snow Cone',
        13: 'Tiramisu',
        14: 'Upside Down Cake',
        15: 'Vanilla Ice Cream',
        16: 'Baklava'
      }[majorPlatformVersion]
    } else if (ua.test(/harmony/i)) {
      os.name = 'Harmony'
      const match = ua.getUA().match(/harmony[\s/-](\d+(\.\d+)*)/i)
      os.version = (match && match[1]) || ''
      os.versionName = ''
    }
  }
  return os
}

/**
 * 获取回复人昵称
 */
function getRuser (pid, comments = []) {
  const comment = comments.find((item) => item._id === pid)
  return comment ? comment.nick : null
}

/**
 * 将评论记录转换为前端需要的格式（使用本地 IP 归属地查询）
 */
function toCommentDto (comment, uid, replies = [], comments = [], cfg) {
  let displayOs = ''
  let displayBrowser = ''
  if (cfg.SHOW_UA !== 'false') {
    try {
      const ua = bowser.getParser(comment.ua)
      const os = fixOS(ua)
      displayOs = [os.name, os.versionName ? os.versionName : os.version].join(' ')
      displayBrowser = [ua.getBrowserName(), ua.getBrowserVersion()].join(' ')
    } catch (e) {
      logger.warn('bowser 错误：', e)
    }
  }
  const showRegion = !!cfg.SHOW_REGION && cfg.SHOW_REGION !== 'false'
  const ups = comment.ups || comment.like || []
  const downs = comment.downs || []
  return {
    id: comment._id.toString(),
    nick: comment.nick,
    avatar: comment.avatar,
    mailMd5: getMailMd5(comment),
    link: comment.link,
    comment: comment.comment,
    os: displayOs,
    browser: displayBrowser,
    ipRegion: showRegion ? getIpRegion(comment.ip, false) : '',
    master: comment.master,
    like: ups.length,
    ups: ups.length,
    downs: downs.length,
    liked: ups.includes(uid),
    disliked: downs.includes(uid),
    isOwner: Boolean(uid && comment.uid === uid),
    replies: replies,
    rid: comment.rid,
    pid: comment.pid,
    ruser: getRuser(comment.pid, comments),
    top: comment.top,
    isSpam: comment.isSpam,
    created: comment.created,
    updated: comment.updated
  }
}

/**
 * 筛除隐私字段，拼接回复列表（本地实现，使用自己的 IP 归属地查询）
 */
function parseComment (comments, uid, cfg) {
  const result = []
  for (const comment of comments) {
    if (!comment.rid) {
      const replies = comments
        .filter((item) => item.rid === comment._id.toString())
        .map((item) => toCommentDto(item, uid, [], comments, cfg))
        .sort((a, b) => a.created - b.created)
      result.push(toCommentDto(comment, uid, replies, [], cfg))
    }
  }
  return result
}

/**
 * 为管理后台解析评论
 */
function parseCommentForAdmin (comments) {
  for (const comment of comments) {
    comment.ipRegion = getIpRegion(comment.ip, true)
  }
  return comments
}

// 全局变量
const requestTimes = Object.create(null)

// ==================== 工具函数 ====================

function getAllowedOrigin (req, config) {
  const origin = req.headers.origin
  if (!origin) return ''
  const allowList = config.CORS_ALLOW_ORIGIN
  if (!allowList) return origin
  if (typeof allowList !== 'string') return ''
  let originHost
  try {
    const parsed = new URL(origin)
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    originHost = parsed.host
  } catch {
    return ''
  }
  return allowList.split(',').some(value => {
    const allowed = value.trim().replace(/\/$/, '')
    if (allowed === '*') return true
    if (allowed === origin) return true
    // Preserve the documented domain-only format.
    return !allowed.includes('://') && originHost === allowed
  }) ? origin : ''
}

// 获取 IP（优先使用 EdgeOne 提供的 eo-connecting-ip）
function getIp (req) {
  return req.headers['eo-connecting-ip'] ||
         req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.ip ||
         'unknown'
}

function protect (ip) {
  requestTimes[ip] = (requestTimes[ip] || 0) + 1
  if (requestTimes[ip] > MAX_REQUEST_TIMES) {
    logger.warn(`${ip} 当前请求次数为 ${requestTimes[ip]}，已超过最大请求次数`)
    throw new Error('Too Many Requests')
  }
  logger.log(`${ip} 当前请求次数为 ${requestTimes[ip]}`)
}

// 定期清理请求计数
setInterval(() => {
  Object.keys(requestTimes).forEach(key => delete requestTimes[key])
}, 10 * 60 * 1000).unref()

// ==================== KV 代理层 ====================

function createKVProxy (req) {
  const baseUrl = req.origin
  const token = req.internalToken
  if (!token) throw new Error('请配置环境变量 TWIKOO_INTERNAL_TOKEN（Node 和 Edge 函数须使用同一值）')

  async function callKV (action, data) {
    const kvUrl = `${baseUrl}/api/kv`
    const body = JSON.stringify({ action, data })

    try {
      const response = await fetch(kvUrl, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          'Content-Type': 'application/json',
          ...await signKVRequest(token, kvUrl, body)
        },
        body
      })

      if (!response.ok) throw new Error(`KV API HTTP ${response.status}`)
      const text = await response.text()

      let result
      try {
        result = JSON.parse(text)
      } catch (e) {
        logger.error('[KV] JSON 解析失败:', text.substring(0, 200))
        throw new Error(`KV API 返回非 JSON: ${text.substring(0, 200)}`)
      }

      if (result.code !== 0) {
        throw new Error(result.message || 'KV 操作失败')
      }

      return result.data
    } catch (e) {
      logger.error('[KV] 调用异常:', e.message)
      throw e
    }
  }

  return {
    async getComments (query = {}) {
      return callKV('getComments', { query })
    },
    async countComments (query = {}) {
      const comments = await this.getComments(query)
      return comments.length
    },
    async addComment (comment) {
      return callKV('addComment', { comment })
    },
    async updateComment (id, updates) {
      return callKV('updateComment', { id, updates })
    },
    async deleteComment (id) {
      return callKV('deleteComment', { id })
    },
    async getComment (id) {
      return callKV('getComment', { id })
    },
    async bulkAddComments (comments) {
      return callKV('bulkAddComments', { comments })
    },
    async getConfig () {
      return callKV('getConfig', {})
    },
    async saveConfig (newConfig) {
      return callKV('saveConfig', { config: newConfig })
    },
    async getCounter (url) {
      return callKV('getCounter', { url })
    },
    async incCounter (url, title) {
      return callKV('incCounter', { url, title })
    }
  }
}

// ==================== 配置管理 ====================

async function readConfig (db, env) {
  // A failed read must never be mistaken for an uninitialized administrator.
  const config = await db.getConfig()
  return {
    ...config,
    ...(!config.CAPTCHA_PROVIDER && config.TURNSTILE_SITE_KEY ? { CAPTCHA_PROVIDER: 'Turnstile' } : {}),
    ...(env.CORS_ALLOW_ORIGIN ? { CORS_ALLOW_ORIGIN: env.CORS_ALLOW_ORIGIN } : {})
  }
}

async function writeConfig (db, newConfig) {
  if (!Object.keys(newConfig).length) return 0
  logger.info('写入配置')
  await db.saveConfig(newConfig)
  return 1
}

function isAdmin (accessToken, config) {
  return Boolean(accessToken && config.ADMIN_PASS && config.ADMIN_PASS === md5(accessToken))
}

// ==================== 密码管理 ====================

async function setPassword (event, db, accessToken, config) {
  validate(event, ['password'])
  const isAdminUser = isAdmin(accessToken, config)
  if (config.ADMIN_PASS && !isAdminUser) {
    return { code: RES_CODE.PASS_EXIST, message: '请先登录再修改密码' }
  }
  const ADMIN_PASS = md5(event.password)
  await writeConfig(db, { ADMIN_PASS })
  return { code: RES_CODE.SUCCESS }
}

async function login (password, config) {
  validate({ password }, ['password'])
  if (!config) {
    return { code: RES_CODE.CONFIG_NOT_EXIST, message: '数据库无配置' }
  }
  if (!config.ADMIN_PASS) {
    return { code: RES_CODE.PASS_NOT_EXIST, message: '未配置管理密码' }
  }
  if (config.ADMIN_PASS !== md5(password)) {
    return { code: RES_CODE.PASS_NOT_MATCH, message: '密码错误' }
  }
  return { code: RES_CODE.SUCCESS, accessToken: password }
}

// ==================== 评论读取 ====================

async function commentGet (event, db, accessToken, config) {
  const res = {}
  try {
    validate(event, ['url'])
    const uid = accessToken
    const isAdminUser = isAdmin(accessToken, config)
    const limit = parseInt(config.COMMENT_PAGE_SIZE) || 8
    const sort = event.sort || 'newest'
    let more = false

    const urlQuery = getUrlQuery(event.url)

    // 获取所有评论
    const allComments = await db.getComments()

    // 过滤主楼评论
    let mainComments = allComments.filter(c =>
      urlQuery.includes(c.url) &&
      (!c.rid || c.rid === '') &&
      (c.isSpam !== true || c.uid === uid || isAdminUser)
    )

    // 计算总数
    const count = mainComments.length

    // 排序
    if (sort === 'oldest') {
      mainComments.sort((a, b) => a.created - b.created)
    } else if (sort === 'popular') {
      mainComments.sort((a, b) => {
        const aUps = (a.ups || a.like || []).length
        const bUps = (b.ups || b.like || []).length
        if (bUps !== aUps) return bUps - aUps
        return b.created - a.created
      })
    } else {
      mainComments.sort((a, b) => b.created - a.created)
    }

    // 处理置顶和分页
    let top = []
    if (config.TOP_DISABLED !== 'true' && config.TOP_DISABLED !== true) {
      if (!event.before) top = mainComments.filter(c => c.top === true)
      mainComments = mainComments.filter(c => c.top !== true)
    }

    // 分页
    if (event.before) {
      mainComments = mainComments.filter(c => sort === 'oldest'
        ? c.created > event.before
        : c.created < event.before)
    }

    if (mainComments.length > limit) {
      more = true
      mainComments = mainComments.slice(0, limit)
    }

    // 合并置顶
    mainComments = [...top, ...mainComments]

    // 获取回复
    const mainIds = mainComments.map(c => c._id)
    const replies = allComments.filter(c =>
      mainIds.includes(c.rid) &&
      (c.isSpam !== true || c.uid === uid || isAdminUser)
    )

    res.data = parseComment([...mainComments, ...replies], uid, config)
    res.more = more
    res.count = count
  } catch (e) {
    res.data = []
    res.message = e.message
  }
  return res
}

// ==================== 管理员评论操作 ====================

async function commentGetForAdmin (event, db, accessToken, config) {
  const res = {}
  const isAdminUser = isAdmin(accessToken, config)
  if (isAdminUser) {
    validate(event, ['per', 'page'])

    let comments = await db.getComments()

    if (event.type === 'VISIBLE') {
      comments = comments.filter(c => c.isSpam !== true)
    } else if (event.type === 'HIDDEN') {
      comments = comments.filter(c => c.isSpam === true)
    }

    if (event.keyword) {
      const keyword = event.keyword.toLowerCase()
      comments = comments.filter(c =>
        (c.nick && c.nick.toLowerCase().includes(keyword)) ||
        (c.mail && c.mail.toLowerCase().includes(keyword)) ||
        (c.link && c.link.toLowerCase().includes(keyword)) ||
        (c.ip && c.ip.toLowerCase().includes(keyword)) ||
        (c.comment && c.comment.toLowerCase().includes(keyword)) ||
        (c.url && c.url.toLowerCase().includes(keyword)) ||
        (c.href && c.href.toLowerCase().includes(keyword))
      )
    }

    comments.sort((a, b) => b.created - a.created)

    const count = comments.length
    const start = event.per * (event.page - 1)
    const data = comments.slice(start, start + event.per)

    res.code = RES_CODE.SUCCESS
    res.count = count
    res.data = parseCommentForAdmin(data)
  } else {
    res.code = RES_CODE.NEED_LOGIN
    res.message = '请先登录'
  }
  return res
}

async function commentSetForAdmin (event, db, accessToken, config) {
  const res = {}
  const isAdminUser = isAdmin(accessToken, config)
  if (isAdminUser) {
    validate(event, ['id', 'set'])
    await db.updateComment(event.id, {
      ...event.set,
      updated: Date.now()
    })
    res.code = RES_CODE.SUCCESS
    res.updated = 1
  } else {
    res.code = RES_CODE.NEED_LOGIN
    res.message = '请先登录'
  }
  return res
}

async function commentDeleteForAdmin (event, db, accessToken, config) {
  const res = {}
  const isAdminUser = isAdmin(accessToken, config)
  if (isAdminUser) {
    validate(event, ['id'])
    await db.deleteComment(event.id)
    res.code = RES_CODE.SUCCESS
    res.deleted = 1
  } else {
    res.code = RES_CODE.NEED_LOGIN
    res.message = '请先登录'
  }
  return res
}

async function commentImportForAdmin (event, db, accessToken, config) {
  const res = {}
  let logText = ''
  const log = (message) => {
    logText += `${new Date().toLocaleString()} ${message}\n`
  }
  const isAdminUser = isAdmin(accessToken, config)
  if (isAdminUser) {
    try {
      validate(event, ['source', 'file'])
      log(`开始导入 ${event.source}`)
      let comments
      switch (event.source) {
        case 'valine': {
          const valineDb = await readFile(event.file, 'json', log)
          comments = await commentImportValine(valineDb, log)
          break
        }
        case 'disqus': {
          const disqusDb = await readFile(event.file, 'xml', log)
          comments = await commentImportDisqus(disqusDb, log)
          break
        }
        case 'artalk': {
          const artalkDb = await readFile(event.file, 'json', log)
          comments = await commentImportArtalk(artalkDb, log)
          break
        }
        case 'artalk2': {
          const artalkDb = await readFile(event.file, 'json', log)
          comments = await commentImportArtalk2(artalkDb, log)
          break
        }
        case 'twikoo': {
          const twikooDb = await readFile(event.file, 'json', log)
          comments = await commentImportTwikoo(twikooDb, log)
          break
        }
        default:
          throw new Error(`不支持 ${event.source} 的导入，请更新 Twikoo 云函数至最新版本`)
      }
      // Twikoo exports already contain HTML; sanitize that format as well as
      // the Markdown-based import formats before storing it.
      comments = comments.map(comment => ({ ...comment, comment: xss(comment.comment || '') }))
      await db.bulkAddComments(comments)
      log('导入成功')
    } catch (e) {
      log(e.message)
    }
    res.code = RES_CODE.SUCCESS
    res.log = logText
    logger.info(logText)
  } else {
    res.code = RES_CODE.NEED_LOGIN
    res.message = '请先登录'
  }
  return res
}

async function commentExportForAdmin (event, db, accessToken, config) {
  const res = {}
  const isAdminUser = isAdmin(accessToken, config)
  if (isAdminUser) {
    const data = await db.getComments()
    res.code = RES_CODE.SUCCESS
    res.data = data
  } else {
    res.code = RES_CODE.NEED_LOGIN
    res.message = '请先登录'
  }
  return res
}

async function readFile (file, type, log) {
  try {
    let content = file.toString('utf8')
    log('评论文件读取成功')
    if (type === 'json') {
      content = jsonParse(content)
      log('评论文件 JSON 解析成功')
    } else if (type === 'xml') {
      content = await xml2js.parseStringPromise(content)
      log('评论文件 XML 解析成功')
    }
    return content
  } catch (e) {
    log(`评论文件读取失败：${e.message}`)
  }
}

// ==================== 点赞 ====================

async function commentLike (event, db, accessToken) {
  const res = {}
  validate(event, ['id'])
  const uid = accessToken
  const type = event.type || 'up'
  const comment = await db.getComment(event.id)

  if (comment) {
    const ups = comment.ups || comment.like || []
    const downs = comment.downs || []

    let newUps = [...ups]
    let newDowns = [...downs]

    if (type === 'up') {
      const index = ups.indexOf(uid)
      if (index === -1) {
        newUps.push(uid)
        newDowns = newDowns.filter((item) => item !== uid)
      } else {
        newUps.splice(index, 1)
      }
    } else if (type === 'down') {
      const index = downs.indexOf(uid)
      if (index === -1) {
        newDowns.push(uid)
        newUps = newUps.filter((item) => item !== uid)
      } else {
        newDowns.splice(index, 1)
      }
    }

    await db.updateComment(event.id, { ups: newUps, downs: newDowns })
    res.updated = 1
  } else {
    res.updated = 0
  }
  return res
}

// ==================== 评论提交 ====================

async function commentSubmit (event, req, db, accessToken, config) {
  const res = {}
  validate(event, ['url', 'ua', 'comment'])

  const ip = getIp(req)

  // 限流检查
  await limitFilter(db, ip, config)

  // 验证码检查
  await checkCaptcha(event, ip, config)

  // 解析评论数据
  const data = await parseCommentData(event, req, accessToken, ip, config)

  // 保存评论
  const result = await db.addComment(data)
  data.id = result.id
  data._id = result.id
  res.id = result.id

  // Wait for post-processing before the serverless invocation can end.
  await postSubmit(data, db, config)

  return res
}

async function parseCommentData (event, req, accessToken, ip, config) {
  const timestamp = Date.now()
  const isAdminUser = isAdmin(accessToken, config)
  const isBloggerMail = equalsMail(config.BLOGGER_EMAIL, event.mail)

  if (isBloggerMail && !isAdminUser) {
    throw new Error('请先登录管理面板，再使用博主身份发送评论')
  }

  const hashMethod = config.GRAVATAR_CDN === 'cravatar.cn' ? md5 : sha256

  const commentDo = {
    _id: uuidv4().replace(/-/g, ''),
    uid: accessToken,
    nick: event.nick ? event.nick : '匿名',
    mail: event.mail ? event.mail : '',
    mailMd5: event.mail ? hashMethod(normalizeMail(event.mail)) : '',
    link: event.link ? event.link : '',
    ua: event.ua,
    ip: ip,
    master: isBloggerMail,
    url: event.url,
    href: event.href,
    comment: xss(event.comment),
    pid: event.pid ? event.pid : event.rid,
    rid: event.rid,
    isSpam: isAdminUser ? false : preCheckSpam({ ...event, nick: event.nick || '匿名' }, config),
    created: timestamp,
    updated: timestamp
  }

  // 处理 QQ 邮箱和头像
  if (isQQ(event.mail)) {
    commentDo.mail = addQQMailSuffix(event.mail)
    commentDo.mailMd5 = md5(normalizeMail(commentDo.mail))
    try {
      commentDo.avatar = await getQQAvatar(event.mail)
    } catch (e) {
      logger.warn('获取 QQ 头像失败：', e.message)
    }
  }

  return commentDo
}

async function postSubmit (comment, db, config) {
  try {
    logger.log('POST_SUBMIT')

    // 获取父评论
    const getParentComment = async (c) => {
      if (c.pid) {
        return db.getComment(c.pid)
      }
      return null
    }

    // 垃圾检测
    const isSpam = await postCheckSpam(comment, config)
    if (isSpam && !comment.isSpam) {
      await db.updateComment(comment._id, { isSpam: true, updated: Date.now() })
      comment.isSpam = isSpam
    }

    // 发送通知
    await sendNotice(comment, config, getParentComment)
  } catch (e) {
    logger.warn('POST_SUBMIT 失败', e)
  }
}

async function limitFilter (db, ip, config) {
  const comments = await db.getComments()
  let limitPerMinute = parseInt(config.LIMIT_PER_MINUTE)
  if (Number.isNaN(limitPerMinute)) limitPerMinute = 10

  if (limitPerMinute) {
    const recentComments = comments.filter(c =>
      c.ip === ip && c.created > Date.now() - 60000
    )
    if (recentComments.length >= limitPerMinute) {
      throw new Error('发言频率过高')
    }
  }

  let limitPerMinuteAll = parseInt(config.LIMIT_PER_MINUTE_ALL)
  if (Number.isNaN(limitPerMinuteAll)) limitPerMinuteAll = 10

  if (limitPerMinuteAll) {
    const recentComments = comments.filter(c => c.created > Date.now() - 60000)
    if (recentComments.length >= limitPerMinuteAll) {
      throw new Error('评论太火爆啦 >_< 请稍后再试')
    }
  }
}

async function checkCaptcha (event, ip, config) {
  const provider = config.CAPTCHA_PROVIDER
  if ((!provider || provider === 'Turnstile') && config.TURNSTILE_SITE_KEY && config.TURNSTILE_SECRET_KEY) {
    await checkTurnstileCaptcha({
      ip: ip,
      turnstileToken: event.turnstileToken,
      turnstileTokenSecretKey: config.TURNSTILE_SECRET_KEY
    })
  } else if (provider === 'Geetest' && config.GEETEST_CAPTCHA_ID && config.GEETEST_CAPTCHA_KEY) {
    await checkGeeTestCaptcha({
      geeTestCaptchaId: config.GEETEST_CAPTCHA_ID,
      geeTestCaptchaKey: config.GEETEST_CAPTCHA_KEY,
      geeTestLotNumber: event.geeTestLotNumber,
      geeTestCaptchaOutput: event.geeTestCaptchaOutput,
      geeTestPassToken: event.geeTestPassToken,
      geeTestGenTime: event.geeTestGenTime
    })
  }
}

// ==================== 配置操作 ====================

async function setConfig (event, db, accessToken, config) {
  const isAdminUser = isAdmin(accessToken, config)
  if (isAdminUser) {
    if (!event.config || typeof event.config !== 'object' || Array.isArray(event.config)) {
      throw new Error('config 必须为对象')
    }
    await writeConfig(db, event.config)
    return { code: RES_CODE.SUCCESS }
  } else {
    return { code: RES_CODE.NEED_LOGIN, message: '请先登录' }
  }
}

// ==================== 计数器 ====================

async function counterGet (event, db) {
  const res = {}
  try {
    validate(event, ['url'])
    const record = await db.getCounter(event.url)
    res.data = record || {}
    res.time = res.data.time || 0
    res.updated = await db.incCounter(event.url, event.title)
  } catch (e) {
    res.message = e.message
  }
  return res
}

// ==================== 评论统计 ====================

async function getCommentsCount (event, db) {
  const res = {}
  try {
    validate(event, ['urls'])
    const comments = await db.getComments()

    res.data = []
    for (const url of event.urls) {
      const urlVariants = getUrlQuery(url)
      const count = comments.filter(c =>
        urlVariants.includes(c.url) &&
        c.isSpam !== true &&
        (event.includeReply || !c.rid || c.rid === '')
      ).length
      res.data.push({ url, count })
    }
  } catch (e) {
    res.message = e.message
  }
  return res
}

async function getRecentComments (event, db, config) {
  const res = {}
  try {
    let comments = await db.getComments()

    comments = comments.filter(c => c.isSpam !== true)

    if (event.urls && event.urls.length) {
      const urlsQuery = getUrlsQuery(event.urls)
      comments = comments.filter(c => urlsQuery.includes(c.url))
    }

    if (!event.includeReply) {
      comments = comments.filter(c => !c.rid || c.rid === '')
    }

    comments.sort((a, b) => b.created - a.created)

    const pageSize = Math.min(event.pageSize || 10, 100)
    comments = comments.slice(0, pageSize)

    res.data = comments.map(comment => ({
      id: comment._id,
      url: comment.url,
      nick: comment.nick,
      avatar: getAvatar(comment, config),
      mailMd5: getMailMd5(comment),
      link: comment.link,
      comment: comment.comment,
      commentText: comment.comment.replace(/<[^>]*>/g, ''),
      created: comment.created
    }))
  } catch (e) {
    res.message = e.message
  }
  return res
}

// EdgeOne Pages Node Function 入口
async function handleTwikooRequest ({ request, env = {}, clientIp }) {
  const url = new URL(request.url)
  const runtimeEnv = { ...process.env, ...env }
  const req = {
    headers: Object.fromEntries(request.headers),
    ip: clientIp,
    origin: url.origin,
    internalToken: runtimeEnv.TWIKOO_INTERNAL_TOKEN || INTERNAL_TOKEN
  }
  const responseHeaders = {
    'Content-Type': 'application/json; charset=UTF-8',
    'Cache-Control': 'no-store',
    Vary: 'Origin'
  }
  const respond = (data, status = 200) => new Response(
    status === 204 || request.method === 'HEAD' ? null : JSON.stringify(data),
    { status, headers: responseHeaders }
  )
  let config = { CORS_ALLOW_ORIGIN: runtimeEnv.CORS_ALLOW_ORIGIN }

  function setCors () {
    const origin = getAllowedOrigin(req, config)
    if (origin) {
      responseHeaders['Access-Control-Allow-Origin'] = origin
      responseHeaders['Access-Control-Allow-Methods'] = 'POST, GET, HEAD, OPTIONS'
      responseHeaders['Access-Control-Allow-Headers'] = 'Content-Type'
      responseHeaders['Access-Control-Max-Age'] = '600'
    }
    return !req.headers.origin || Boolean(origin)
  }

  try {
    if (runtimeEnv.TWIKOO_SERVER_URL) req.origin = new URL(runtimeEnv.TWIKOO_SERVER_URL).origin
    else if (req.headers['eo-pages-host']) req.origin = new URL(`https://${req.headers['eo-pages-host']}`).origin
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (!setCors()) return respond({ code: RES_CODE.FORBIDDEN, message: 'Origin not allowed' }, 403)
      return respond({
        code: RES_CODE.SUCCESS,
        message: 'Twikoo 云函数运行正常，请参考 https://twikoo.js.org/frontend.html 完成前端的配置',
        version: VERSION
      })
    }
    if (request.method !== 'POST' && request.method !== 'OPTIONS') {
      responseHeaders.Allow = 'GET, HEAD, POST, OPTIONS'
      setCors()
      return respond({ code: 405, message: 'Method Not Allowed' }, 405)
    }
    if (request.method === 'POST') {
      try {
        req.body = await request.json()
        if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object') throw new Error('invalid body')
      } catch {
        setCors()
        return respond({ code: RES_CODE.FAIL, message: '请求体必须为 JSON 对象' }, 400)
      }
    }
    const db = createKVProxy(req)
    config = await readConfig(db, runtimeEnv)
    if (!setCors()) return respond({ code: RES_CODE.FORBIDDEN, message: 'Origin not allowed' }, 403)
    if (request.method === 'OPTIONS') return respond(null, 204)
    return respond(await handlePost(req, db, config))
  } catch (error) {
    logger.error('请求处理失败:', error.message)
    setCors()
    return respond({ code: RES_CODE.FAIL, message: error.message }, 503)
  }
}

export { handleTwikooRequest as onRequest }
export default handleTwikooRequest

// POST 请求处理主逻辑
async function handlePost (req, db, config) {
  let accessToken
  const event = req.body || {}
  const ip = getIp(req)

  logger.log('请求 IP：', ip)
  logger.log('请求函数：', event.event)

  let result = {}

  try {
    validateClientFields(event)
    for (const field of ['event', 'password', 'nick', 'mail', 'link', 'ua', 'comment', 'href']) {
      if (event[field] != null && typeof event[field] !== 'string') throw new Error(`${field} 必须为字符串`)
    }

    // 防护
    protect(ip)

    // 生成或使用 accessToken
    accessToken = event.accessToken || uuidv4().replace(/-/g, '')

    switch (event.event) {
      case 'GET_FUNC_VERSION':
        result = getFuncVersion(VERSION)
        break
      case 'COMMENT_GET':
        result = await commentGet(event, db, accessToken, config)
        break
      case 'COMMENT_GET_FOR_ADMIN':
        result = await commentGetForAdmin(event, db, accessToken, config)
        break
      case 'COMMENT_SET_FOR_ADMIN':
        result = await commentSetForAdmin(event, db, accessToken, config)
        break
      case 'COMMENT_DELETE_FOR_ADMIN':
        result = await commentDeleteForAdmin(event, db, accessToken, config)
        break
      case 'COMMENT_IMPORT_FOR_ADMIN':
        result = await commentImportForAdmin(event, db, accessToken, config)
        break
      case 'COMMENT_LIKE':
        result = await commentLike(event, db, accessToken)
        break
      case 'COMMENT_SUBMIT':
        result = await commentSubmit(event, req, db, accessToken, config)
        break
      case 'COUNTER_GET':
        result = await counterGet(event, db)
        break
      case 'GET_PASSWORD_STATUS':
        result = await getPasswordStatus(config, VERSION)
        break
      case 'SET_PASSWORD':
        result = await setPassword(event, db, accessToken, config)
        break
      case 'GET_CONFIG':
        result = await getConfig({ config, VERSION, isAdmin: isAdmin(accessToken, config) })
        break
      case 'GET_CONFIG_FOR_ADMIN':
        result = await getConfigForAdmin({ config, isAdmin: isAdmin(accessToken, config) })
        break
      case 'SET_CONFIG':
        result = await setConfig(event, db, accessToken, config)
        break
      case 'LOGIN':
        result = await login(event.password, config)
        break
      case 'GET_COMMENTS_COUNT':
        result = await getCommentsCount(event, db)
        break
      case 'GET_RECENT_COMMENTS':
        result = await getRecentComments(event, db, config)
        break
      case 'EMAIL_TEST':
        result = await emailTest(event, config, isAdmin(accessToken, config))
        break
      case 'UPLOAD_IMAGE':
        result = await uploadImage(event, config)
        break
      case 'COMMENT_EXPORT_FOR_ADMIN':
        result = await commentExportForAdmin(event, db, accessToken, config)
        break
      default:
        if (event.event) {
          result.code = RES_CODE.EVENT_NOT_EXIST
          result.message = '请更新 Twikoo 云函数至最新版本'
        } else {
          result.code = RES_CODE.NO_PARAM
          result.message = 'Twikoo 云函数运行正常，请参考 https://twikoo.js.org/frontend.html 完成前端的配置'
          result.version = VERSION
        }
    }

    if (!result.code && !event.accessToken && !result.accessToken) {
      result.accessToken = accessToken
    }
  } catch (e) {
    logger.error('Twikoo 遇到错误：', e.message, e.stack)
    result.code = RES_CODE.FAIL
    result.message = e.message
  }

  return result
}
