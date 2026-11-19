const DEFAULT_RECOVERY_URL = 'https://pyyemail.cc'

export interface RecoveryMailboxConfig {
    address: string
    password: string
    baseUrl?: string
}

export interface WaitCodeResult {
    ok: boolean
    code?: string
    reused?: boolean
    error?: string
}

export function extractSecurityCode(rawHtmlOrText: string): string {
    if (!rawHtmlOrText) return ''
    const txt = String(rawHtmlOrText)
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+/g, ' ')

    const patterns = [
        /セキュリティ\s*コード[：:\s]*([0-9]{6,8})/i,
        /(?:安全代码|安全代碼|一次性代码(?:为)?|單次代碼|验证码|驗證碼)[：:\s]*([0-9]{6,8})/i,
        /(?:security\s+code|one-time\s+code|verification\s+code|single-use\s+code)[:\sis]+([0-9]{6,8})/i
    ]
    for (const pat of patterns) {
        const match = txt.match(pat)
        if (match?.[1]) return match[1]
    }

    const fallbackRe = /(?:^|[^0-9])([0-9]{6})(?:[^0-9]|$)/g
    let match: RegExpExecArray | null
    while ((match = fallbackRe.exec(txt)) !== null) {
        const candidate = match[1]
        if (candidate && candidate !== '000000' && candidate !== '123456') {
            return candidate
        }
    }
    return ''
}

export class RecoveryMailboxClient {
    private readonly baseUrl: string
    private readonly address: string
    private readonly password: string
    private cookieHeader = ''

    constructor(config: RecoveryMailboxConfig) {
        this.baseUrl = (config.baseUrl || DEFAULT_RECOVERY_URL).trim().replace(/\/+$/, '')
        this.address = config.address.trim()
        this.password = config.password
    }

    private async login(): Promise<string> {
        const resp = await fetch(`${this.baseUrl}/api/v1/user/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: this.address, password: this.password }),
            signal: AbortSignal.timeout(15000)
        })

        const setCookies =
            typeof resp.headers.getSetCookie === 'function'
                ? resp.headers.getSetCookie()
                : [resp.headers.get('set-cookie') || ''].filter(Boolean)

        const cookiePairs = setCookies
            .map(c => c.split(';')[0]?.trim() || '')
            .filter(Boolean)
            .join('; ')

        const data = (await resp.json().catch(() => ({}))) as { code?: number; message?: string }
        if (data.code !== 0 || !cookiePairs) {
            throw new Error(data.message || `recovery_mailbox_login_failed (HTTP ${resp.status})`)
        }

        this.cookieHeader = cookiePairs
        return cookiePairs
    }

    async fetchRecentCodes(limit = 4): Promise<string[]> {
        if (!this.address || !this.password) return []
        if (!this.cookieHeader) {
            await this.login()
        }

        let listResp = await fetch(`${this.baseUrl}/app/list?mailbox=inbox`, {
            headers: { Cookie: this.cookieHeader },
            redirect: 'manual',
            signal: AbortSignal.timeout(15000)
        })

        if (listResp.status >= 300 && listResp.status < 400) {
            await this.login()
            listResp = await fetch(`${this.baseUrl}/app/list?mailbox=inbox`, {
                headers: { Cookie: this.cookieHeader },
                signal: AbortSignal.timeout(15000)
            })
        }

        const listHtml = await listResp.text()
        const ids: string[] = []
        const rowRe = /class="[^"]*u-mail-row[^"]*"[^>]*data-id="(\d+)"/g
        let match: RegExpExecArray | null
        while ((match = rowRe.exec(listHtml)) !== null && ids.length < limit) {
            if (match[1]) ids.push(match[1])
        }

        const codes: string[] = []
        for (const id of ids) {
            const renderResp = await fetch(`${this.baseUrl}/app/emails/${id}/render`, {
                headers: { Cookie: this.cookieHeader },
                signal: AbortSignal.timeout(15000)
            }).catch(() => null)
            if (!renderResp) continue
            const html = await renderResp.text().catch(() => '')
            const code = extractSecurityCode(html)
            if (code && !codes.includes(code)) {
                codes.push(code)
            }
        }
        return codes
    }

    async snapshotCodes(): Promise<Set<string>> {
        const codes = await this.fetchRecentCodes()
        return new Set(codes)
    }

    async waitForNewCode(
        usedCodes: Set<string>,
        options: { maxAttempts?: number; pollIntervalMs?: number; reuseAfterAttempt?: number } = {}
    ): Promise<WaitCodeResult> {
        const maxAttempts = options.maxAttempts ?? 22
        const pollIntervalMs = options.pollIntervalMs ?? 2300
        const reuseAfterAttempt = options.reuseAfterAttempt ?? 12

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const codes = await this.fetchRecentCodes()
                for (const code of codes) {
                    if (!usedCodes.has(code)) {
                        usedCodes.add(code)
                        return { ok: true, code }
                    }
                }
                if (attempt >= reuseAfterAttempt && codes.length > 0 && codes[0]) {
                    return { ok: true, code: codes[0], reused: true }
                }
            } catch (error) {
                this.cookieHeader = ''
                if (attempt === maxAttempts - 1) {
                    return {
                        ok: false,
                        error: error instanceof Error ? error.message : String(error)
                    }
                }
            }

            if (attempt < maxAttempts - 1) {
                await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
            }
        }

        return { ok: false, error: 'code_not_found' }
    }
}
