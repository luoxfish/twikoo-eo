import nodemailer from 'nodemailer'
import addressparser from 'nodemailer/lib/addressparser/index.js'

function mailbox (value) {
  const addresses = addressparser(value || '')
  if (addresses.length !== 1 || !addresses[0].address || /[\r\n]/.test(value)) {
    throw new Error('邮件地址不合法')
  }
  const { address: email, name } = addresses[0]
  return name ? { email, name } : { email }
}

export function createTransport (mailConfig) {
  const service = (mailConfig.service || '').toLowerCase()
  if (service !== 'sendgrid' && service !== 'mailchannels') {
    const options = {
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      ...mailConfig
    }
    if (service === 'yeah' || service === 'yeah.net') {
      Object.assign(options, { host: 'smtp.yeah.net', port: 465, secure: true, ...mailConfig })
      delete options.service
    }
    // Explicit server settings take priority over service presets.
    if (options.host) delete options.service
    options.requireTLS = true
    return nodemailer.createTransport(options)
  }

  return {
    async verify () {
      if (!mailConfig.auth?.pass) throw new Error('需要在 SMTP_PASS 中配置 API 令牌。')
      return true
    },
    async sendMail ({ from, to, subject, html }) {
      await this.verify()
      const response = await fetch(service === 'sendgrid'
        ? 'https://api.sendgrid.com/v3/mail/send'
        : 'https://api.mailchannels.net/tx/v1/send', {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: {
          'Content-Type': 'application/json',
          ...(service === 'sendgrid'
            ? { Authorization: `Bearer ${mailConfig.auth.pass}` }
            : { 'X-Api-Key': mailConfig.auth.pass })
        },
        body: JSON.stringify({
          personalizations: [{ to: [mailbox(to)] }],
          from: mailbox(from),
          subject,
          content: [{ type: 'text/html', value: html }]
        })
      })
      if (!response.ok) {
        // Provider response bodies can contain credentials or private content.
        await response.body?.cancel()
        throw new Error(`${service} 邮件发送失败 (HTTP ${response.status})`)
      }
      await response.body?.cancel()
      return { messageId: response.headers.get('x-message-id') || `${service}-accepted` }
    }
  }
}
