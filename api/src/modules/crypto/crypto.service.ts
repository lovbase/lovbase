import { Injectable } from '@nestjs/common'
import { ConfigService } from '../../config/config.service'

// AES-GCM via WebCrypto. Key = SHA-256(BETTER_AUTH_SECRET).
// Used for user-supplied LLM keys at rest. Not a substitute for a KMS, but strictly better than plaintext.
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

@Injectable()
export class CryptoService {
  constructor(private readonly cfg: ConfigService) {}

  private async key() {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.cfg.env.BETTER_AUTH_SECRET))
    return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt'])
  }

  async encrypt(text: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.key(), new TextEncoder().encode(text)))
    const out = new Uint8Array(iv.length + ct.length)
    out.set(iv); out.set(ct, iv.length)
    return b64(out)
  }

  async decrypt(blob: string): Promise<string> {
    const buf = unb64(blob)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, await this.key(), buf.slice(12))
    return new TextDecoder().decode(pt)
  }
}
