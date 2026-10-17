import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import { test } from 'node:test'
import { createTransport } from '../lib/mail.js'

// These self-signed credentials are used only by the local SMTP test server.
const cert = readFileSync(new URL('./fixtures/smtp-cert.pem', import.meta.url))
const key = readFileSync(new URL('./fixtures/smtp-key.pem', import.meta.url))
const mail = { from: '"测试博客" <sender@example.test>', to: 'recipient@example.test', subject: '通知测试', html: '<p>Hello</p>' }

async function smtpServer (t, { implicitTLS = false, rejectTLS = false } = {}) {
  const commands = []
  const messages = []
  const sockets = new Set()
  const secureContext = tls.createSecureContext({ key, cert })
  const accept = (socket, encrypted) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    if (!encrypted || implicitTLS) socket.write('220 localhost test SMTP\r\n')
    let buffer = ''
    let receiving = false
    const onData = data => {
      buffer += data.toString()
      while (buffer.includes('\r\n')) {
        if (receiving) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end === -1) return
          messages.push(buffer.slice(0, end))
          buffer = buffer.slice(end + 5)
          receiving = false
          socket.write('250 Message accepted\r\n')
          continue
        }
        const end = buffer.indexOf('\r\n')
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const command = line.split(' ')[0]
        commands.push({ command, encrypted })
        if (command === 'EHLO') {
          socket.write(encrypted ? '250-localhost\r\n250 AUTH PLAIN\r\n' : '250-localhost\r\n250 STARTTLS\r\n')
        } else if (command === 'STARTTLS') {
          if (rejectTLS) {
            socket.write('454 TLS unavailable\r\n')
          } else {
            socket.write('220 Ready to start TLS\r\n')
            socket.removeListener('data', onData)
            const encryptedSocket = new tls.TLSSocket(socket, { isServer: true, secureContext })
            accept(encryptedSocket, true)
            return
          }
        } else if (command === 'AUTH') {
          assert.equal(encrypted, true, 'credentials must only travel over TLS')
          socket.write('235 Authentication successful\r\n')
        } else if (command === 'MAIL' || command === 'RCPT') {
          socket.write('250 OK\r\n')
        } else if (command === 'DATA') {
          receiving = true
          socket.write('354 End data with CRLF.CRLF\r\n')
        } else if (command === 'QUIT') {
          socket.end('221 Bye\r\n')
        } else {
          socket.write('500 Unknown command\r\n')
        }
      }
    }
    socket.on('data', onData)
  }
  const server = implicitTLS
    ? tls.createServer({ key, cert }, socket => accept(socket, true))
    : net.createServer(socket => accept(socket, false))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  const transport = createTransport({
    host: '127.0.0.1', port: server.address().port, secure: implicitTLS,
    auth: { user: 'sender@example.test', pass: 'local-test-password' },
    tls: { ca: cert, servername: 'localhost' }
  })
  t.after(() => transport.close())
  return { transport, commands, messages }
}

for (const implicitTLS of [true, false]) {
  test(`SMTP verifies and sends MIME mail using ${implicitTLS ? 'implicit TLS' : 'STARTTLS'}`, { timeout: 5000 }, async t => {
    const { transport, commands, messages } = await smtpServer(t, { implicitTLS })
    assert.equal(await transport.verify(), true)
    const result = await transport.sendMail(mail)
    assert.ok(result.messageId)
    assert.equal(messages.length, 1)
    assert.match(messages[0], /Content-Type: text\/html; charset=utf-8/)
    assert.match(messages[0], /Subject: =\?UTF-8\?/i)
    assert.ok(commands.some(entry => entry.command === 'AUTH' && entry.encrypted))
    assert.ok(commands.every(entry => entry.command !== 'AUTH' || entry.encrypted))
  })
}

test('SMTP fails instead of sending cleartext credentials when STARTTLS is rejected', { timeout: 5000 }, async t => {
  const { transport, commands } = await smtpServer(t, { rejectTLS: true })
  await assert.rejects(transport.verify(), /TLS|STARTTLS/i)
  assert.ok(commands.every(entry => entry.command !== 'AUTH'))
})

test('SMTP verify reports an unreachable server instead of returning a false success', { timeout: 5000 }, async t => {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  const failing = createTransport({ host: '127.0.0.1', port, connectionTimeout: 500 })
  t.after(() => failing.close())
  await assert.rejects(failing.verify(), /ECONNREFUSED|ETIMEDOUT/)
})

for (const service of ['SendGrid', 'MailChannels']) {
  test(`${service} handles display names and reports HTTP errors`, async t => {
    let payload
    let status = 202
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      payload = JSON.parse(options.body)
      return new Response(null, { status, headers: { 'x-message-id': 'accepted-id' } })
    })
    const transport = createTransport({ service, auth: { user: 'account', pass: 'api-key' } })
    assert.equal((await transport.sendMail(mail)).messageId, 'accepted-id')
    assert.deepEqual(payload.from, { email: 'sender@example.test', name: '测试博客' })
    assert.deepEqual(payload.personalizations[0].to, [{ email: 'recipient@example.test' }])
    status = 401
    await assert.rejects(transport.sendMail(mail), /HTTP 401/)
  })
}

test('yeah.net service alias resolves to the correct secure SMTP endpoint', () => {
  const transport = createTransport({ service: 'yeah.net', auth: { user: 'test', pass: 'test' } })
  assert.equal(transport.transporter.options.host, 'smtp.yeah.net')
  assert.equal(transport.transporter.options.port, 465)
  assert.equal(transport.transporter.options.secure, true)
  transport.close()
})
