// Shared by Node and Edge; no Node-only APIs belong in this module.
async function hmacKey (token, usage) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

function payload (url, body, timestamp) {
  // Binding signatures to the destination prevents forwarding a signature
  // obtained at a different host to this deployment.
  return new TextEncoder().encode(`${timestamp}\n${new URL(url).host}\n${body}`)
}

export async function signKVRequest (token, url, body, timestamp = String(Date.now())) {
  const key = await hmacKey(token, 'sign')
  const digest = await crypto.subtle.sign('HMAC', key, payload(url, body, timestamp))
  const signature = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  return { 'X-Twikoo-Timestamp': timestamp, 'X-Twikoo-Signature': signature }
}

export async function verifyKVRequest (token, url, body, headers) {
  const timestamp = headers.get('X-Twikoo-Timestamp') || ''
  const signature = headers.get('X-Twikoo-Signature') || ''
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60000 || !/^[a-f0-9]{64}$/.test(signature)) return false
  const bytes = Uint8Array.from(signature.match(/../g), byte => parseInt(byte, 16))
  const key = await hmacKey(token, 'verify')
  return crypto.subtle.verify('HMAC', key, bytes, payload(url, body, timestamp))
}
