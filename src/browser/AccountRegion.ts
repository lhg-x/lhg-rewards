import fs from 'node:fs/promises'
import path from 'node:path'
import type { Frame, Locator, Page } from 'patchright'

import type { MicrosoftRewardsBot } from '../index'
import type { Account } from '../interface/Account'
import { normalizeCountry } from '../util/Locale'
import { clearAccountFingerprints, saveResolvedRegion, saveStorageState } from '../util/SessionStore'
import type { Login } from './auth/Login'

export interface CountryProfile {
    code: string
    defaultLangCode: string
    exactLabels: string[]
}

export const COUNTRY_PROFILES: Record<string, CountryProfile> = {
    CN: {
        code: 'CN',
        defaultLangCode: 'zh-CN',
        exactLabels: [
            'china',
            'china mainland',
            'china (mainland)',
            '中国',
            '中国大陆',
            '中国（大陆）',
            '中国 (大陆)',
            '中华人民共和国',
            '中華人民共和國',
            '中國',
            '中國大陸'
        ]
    },
    US: {
        code: 'US',
        defaultLangCode: 'en-US',
        exactLabels: [
            'united states',
            'united states of america',
            'usa',
            'u.s.',
            '美国',
            '美國',
            'アメリカ合衆国',
            'アメリカ'
        ]
    },
    JP: {
        code: 'JP',
        defaultLangCode: 'ja-JP',
        exactLabels: ['japan', '日本']
    },
    HK: {
        code: 'HK',
        defaultLangCode: 'zh-HK',
        exactLabels: [
            'hong kong',
            'hong kong sar',
            'china (hong kong sar)',
            '香港',
            '中国香港',
            '香港特別行政區',
            '香港特别行政区'
        ]
    },
    TW: {
        code: 'TW',
        defaultLangCode: 'zh-TW',
        exactLabels: ['taiwan', 'taiwan region', 'china (taiwan)', '台湾', '台灣', '中国台湾', '中國台灣']
    },
    GB: {
        code: 'GB',
        defaultLangCode: 'en-GB',
        exactLabels: ['united kingdom', 'uk', 'great britain', '英国', '英國', 'イギリス']
    },
    SG: {
        code: 'SG',
        defaultLangCode: 'en-SG',
        exactLabels: ['singapore', '新加坡', 'シンガポール']
    },
    CA: {
        code: 'CA',
        defaultLangCode: 'en-CA',
        exactLabels: ['canada', '加拿大', 'カナダ']
    },
    AU: {
        code: 'AU',
        defaultLangCode: 'en-AU',
        exactLabels: ['australia', '澳大利亚', '澳洲', 'オーストラリア']
    },
    DE: {
        code: 'DE',
        defaultLangCode: 'de-DE',
        exactLabels: ['germany', 'deutschland', '德国', '德國', 'ドイツ']
    }
}

export interface SetRegionResult {
    email: string
    targetCountry: string
    previousCountry?: string
    changed: boolean
    status: 'updated' | 'already_target' | 'dry_run' | 'failed'
    message: string
    screenshotPath?: string
}

export interface UpdateEnvRegionOptions {
    country: string
    langCode: string
    clearProxy?: boolean
}

export interface UpdateEnvRegionResult {
    content: string
    updatedSlots: string[]
}

function normalizeLabel(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/（/g, '(')
        .replace(/）/g, ')')
        .replace(/\s+/g, ' ')
}

export function getDefaultLangForCountry(countryCode: string): string {
    const normalized = normalizeCountry(countryCode) ?? countryCode.trim().toUpperCase()
    const profile = COUNTRY_PROFILES[normalized]
    if (profile) return profile.defaultLangCode
    return 'en'
}

export function matchesCountryLabel(rawText: string, countryCode: string): boolean {
    const normalizedText = normalizeLabel(rawText)
    if (!normalizedText) return false

    const normalizedCode = normalizeCountry(countryCode) ?? countryCode.trim().toUpperCase()
    if (normalizedText === normalizedCode.toLowerCase()) {
        return true
    }

    const profile = COUNTRY_PROFILES[normalizedCode]
    if (profile) {
        return profile.exactLabels.some(label => normalizeLabel(label) === normalizedText)
    }

    // Fallback exact lookup via Intl.DisplayNames for ISO-2 codes outside the static table
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja']) {
        try {
            const displayName = new Intl.DisplayNames([locale], { type: 'region' }).of(normalizedCode)
            if (displayName && normalizeLabel(displayName) === normalizedText) {
                return true
            }
        } catch {}
    }

    return false
}

function unquoteEnvValue(rawValue: string): string {
    const trimmed = rawValue.trim()
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1)
    }
    return trimmed
}

const PROXY_KEY_DEFAULTS: ReadonlyArray<[string, string]> = [
    ['PROXY_URL', ''],
    ['PROXY_PORT', '0'],
    ['PROXY_USERNAME', ''],
    ['PROXY_PASSWORD', ''],
    ['PROXY_HTTP', 'false'],
    ['PROXY_AXIOS', 'false']
]

export function updateEnvContentForRegion(
    rawEnv: string,
    emails: string[],
    options: UpdateEnvRegionOptions
): UpdateEnvRegionResult {
    const lineEnding = rawEnv.includes('\r\n') ? '\r\n' : '\n'
    const lines = rawEnv.split(/\r?\n/)
    const targetEmails = new Set(emails.map(e => e.trim().toLowerCase()).filter(Boolean))
    const matchAll = targetEmails.size === 0
    const normalizedCountry = normalizeCountry(options.country) ?? options.country.trim().toUpperCase()

    const slotEmailIndex = new Map<string, number>()
    const slotLastLineIndex = new Map<string, number>()
    const slotUpdatedKeys = new Map<string, Set<string>>()

    // First pass: discover matching ACCOUNT_<N>_EMAIL slots and track each slot's span
    for (let i = 0; i < lines.length; i++) {
        const trimmed = (lines[i] ?? '').trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue

        const key = trimmed.slice(0, eq).trim()
        const value = trimmed.slice(eq + 1)

        const emailMatch = /^ACCOUNT_([1-9]\d*)_EMAIL$/.exec(key)
        if (emailMatch?.[1]) {
            const slot = emailMatch[1]
            const parsedEmail = unquoteEnvValue(value).toLowerCase()
            if (parsedEmail && (matchAll || targetEmails.has(parsedEmail))) {
                slotEmailIndex.set(slot, i)
                slotUpdatedKeys.set(slot, new Set<string>())
            }
        }

        const slotMatch = /^ACCOUNT_([1-9]\d*)_/.exec(key)
        if (slotMatch?.[1]) {
            slotLastLineIndex.set(slotMatch[1], i)
        }
    }

    const updatedSlots = [...slotEmailIndex.keys()].sort((a, b) => Number(a) - Number(b))
    if (updatedSlots.length === 0) {
        return { content: rawEnv, updatedSlots: [] }
    }

    const targetSlotSet = new Set(updatedSlots)
    const proxyDefaultMap = new Map(PROXY_KEY_DEFAULTS)

    // Second pass: update existing active keys belonging to matched slots
    for (let i = 0; i < lines.length; i++) {
        const trimmed = (lines[i] ?? '').trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue

        const key = trimmed.slice(0, eq).trim()
        const match = /^ACCOUNT_([1-9]\d*)_(.+)$/.exec(key)
        if (!match?.[1] || !match[2]) continue

        const slot = match[1]
        const suffix = match[2]
        if (!targetSlotSet.has(slot)) continue

        if (suffix === 'GEO_LOCALE') {
            lines[i] = `ACCOUNT_${slot}_GEO_LOCALE=${normalizedCountry}`
            slotUpdatedKeys.get(slot)?.add('GEO_LOCALE')
        } else if (suffix === 'LANG_CODE') {
            lines[i] = `ACCOUNT_${slot}_LANG_CODE=${options.langCode}`
            slotUpdatedKeys.get(slot)?.add('LANG_CODE')
        } else if (options.clearProxy && proxyDefaultMap.has(suffix)) {
            lines[i] = `ACCOUNT_${slot}_${suffix}=${proxyDefaultMap.get(suffix)}`
        }
    }

    // Third pass: insert missing GEO_LOCALE / LANG_CODE keys right after each matched slot's last line
    const insertions = updatedSlots
        .map(slot => {
            const seen = slotUpdatedKeys.get(slot) ?? new Set<string>()
            const missingLines: string[] = []
            if (!seen.has('GEO_LOCALE')) {
                missingLines.push(`ACCOUNT_${slot}_GEO_LOCALE=${normalizedCountry}`)
            }
            if (!seen.has('LANG_CODE')) {
                missingLines.push(`ACCOUNT_${slot}_LANG_CODE=${options.langCode}`)
            }
            const anchor = slotLastLineIndex.get(slot) ?? slotEmailIndex.get(slot) ?? -1
            return { anchor, missingLines }
        })
        .filter(item => item.anchor >= 0 && item.missingLines.length > 0)
        .sort((a, b) => b.anchor - a.anchor)

    for (const item of insertions) {
        lines.splice(item.anchor + 1, 0, ...item.missingLines)
    }

    return {
        content: lines.join(lineEnding),
        updatedSlots
    }
}

function safeEmailSlug(email: string): string {
    return (
        email
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || 'account'
    )
}

async function captureRegionDiagnostic(page: Page, email: string): Promise<string | undefined> {
    if (page.isClosed()) return undefined
    try {
        const dir = path.join(process.cwd(), 'diagnostics')
        await fs.mkdir(dir, { recursive: true })
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const filePath = path.join(dir, `set-region-${safeEmailSlug(email)}-${timestamp}.png`)
        await page.screenshot({ path: filePath, fullPage: true, type: 'png' })
        return filePath
    } catch {
        return undefined
    }
}

function isAuthHost(hostname: string): boolean {
    const h = hostname.toLowerCase()
    return (
        h === 'login.live.com' ||
        h === 'login.microsoftonline.com' ||
        h === 'account.live.com' ||
        h.endsWith('.login.live.com') ||
        h.endsWith('.account.live.com')
    )
}

async function dismissPrivacyNoticeIfPresent(page: Page): Promise<boolean> {
    let clickedAny = false
    const frames: Frame[] = [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())]
    const consentButtonRegex = /^(?:Continue|OK|Accept|Next|继续|确定|接受|下一步|同意|次へ|続行)$/i

    for (const frame of frames) {
        const frameUrl = frame.url().toLowerCase()
        const isPrivacyFrame =
            frameUrl.includes('privacynotice.account.microsoft.com') || frameUrl.includes('consent')
        if (!isPrivacyFrame && !page.url().toLowerCase().includes('privacynotice')) continue

        const buttons = frame.locator('button, input[type="submit"], [role="button"]')
        const count = await buttons.count().catch(() => 0)
        for (let i = 0; i < count; i++) {
            const btn = buttons.nth(i)
            const visible = await btn.isVisible().catch(() => false)
            if (!visible) continue
            const text = (
                (await btn.innerText().catch(() => '')) ||
                (await btn.getAttribute('value').catch(() => '')) ||
                ''
            ).trim()
            if (consentButtonRegex.test(text)) {
                await btn.click().catch(() => {})
                clickedAny = true
                break
            }
        }
        if (clickedAny) break
    }
    return clickedAny
}

async function readDisplayedCountryRegion(page: Page): Promise<string | null> {
    return await page
        .evaluate(() => {
            const labelRegex = /^(?:Country or region|Country\/region|国家或地区|国家\/地区|國家或地區|国または地域)$/i
            const ignoreRegex =
                /^(?:Country or region|Country\/region|国家或地区|国家\/地区|國家或地區|国または地域|Edit|Edit profile info|Edit country\/region|编辑|编辑个人资料信息|编辑国家\/地区|変更|編集)$/i

            const isVisible = (el: Element): boolean => {
                const style = window.getComputedStyle(el)
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                    return false
                }
                const rect = el.getBoundingClientRect()
                return rect.width > 0 && rect.height > 0
            }

            // If a country select or combobox is already rendered, read its active display value
            const selectEl = document.querySelector<HTMLSelectElement>(
                'select[name*="country" i], select[id*="country" i], select[aria-label*="Country" i], select[aria-label*="国家" i], select[aria-label*="國家" i], select[aria-label*="国または地域" i]'
            )
            if (selectEl && isVisible(selectEl)) {
                const selectedOpt = selectEl.selectedOptions[0]
                if (selectedOpt?.textContent?.trim()) return selectedOpt.textContent.trim()
            }

            const comboboxEl = document.querySelector<HTMLElement>(
                '[role="combobox"][aria-label*="Country" i], [role="combobox"][aria-label*="国家" i], [role="combobox"][aria-label*="國家" i], [role="combobox"][aria-label*="国" i]'
            )
            if (comboboxEl && isVisible(comboboxEl)) {
                const val = (
                    (comboboxEl as HTMLInputElement).value ||
                    comboboxEl.innerText ||
                    comboboxEl.textContent ||
                    ''
                ).trim()
                if (val && !labelRegex.test(val)) return val
            }

            const allElements = Array.from(document.querySelectorAll('span, div, p, label, dt, th, h2, h3, h4'))
            for (const el of allElements) {
                if (!isVisible(el)) continue
                const ownText = (el.textContent || '').trim()
                if (!labelRegex.test(ownText)) continue

                // Prefer direct sibling or sibling container text before walking up
                const candidates: string[] = []
                if (el.nextElementSibling && isVisible(el.nextElementSibling)) {
                    candidates.push((el.nextElementSibling.textContent || '').trim())
                }

                let parent: HTMLElement | null = el.parentElement
                for (let depth = 0; depth < 3 && parent; depth++) {
                    const rowTexts = Array.from(parent.querySelectorAll('span, div, p, dd, td, a, button'))
                        .filter(node => node !== el && !node.contains(el) && isVisible(node))
                        .map(node => (node.textContent || '').trim())
                        .filter(Boolean)
                    candidates.push(...rowTexts)
                    parent = parent.parentElement
                }

                for (const text of candidates) {
                    const firstLine = text.split(/\r?\n/)[0]?.trim() || ''
                    if (!firstLine || ignoreRegex.test(firstLine) || firstLine.length > 60) continue
                    return firstLine
                }
            }

            return null
        })
        .catch(() => null)
}

async function clickFirstVisibleLocator(locators: Locator[]): Promise<boolean> {
    for (const locator of locators) {
        const count = await locator.count().catch(() => 0)
        for (let i = 0; i < count; i++) {
            const candidate = locator.nth(i)
            if (await candidate.isVisible().catch(() => false)) {
                await candidate.scrollIntoViewIfNeeded().catch(() => {})
                await candidate.click()
                return true
            }
        }
    }
    return false
}

async function selectCountryControl(page: Page, targetCountry: string): Promise<boolean> {
    const selectLocator = page.locator(
        'select[name*="country" i], select[id*="country" i], select[aria-label*="Country" i], select[aria-label*="国家" i], select[aria-label*="國家" i], select[aria-label*="国または地域" i]'
    )
    const selectCount = await selectLocator.count().catch(() => 0)
    for (let i = 0; i < selectCount; i++) {
        const sel = selectLocator.nth(i)
        if (!(await sel.isVisible().catch(() => false))) continue

        const options = await sel
            .evaluate(el =>
                Array.from((el as HTMLSelectElement).options).map(opt => ({
                    value: opt.value,
                    text: (opt.textContent || '').trim()
                }))
            )
            .catch(() => [] as Array<{ value: string; text: string }>)

        const matched = options.find(
            opt => opt.value.trim().toUpperCase() === targetCountry || matchesCountryLabel(opt.text, targetCountry)
        )
        if (matched) {
            await sel.selectOption(matched.value)
            return true
        }
    }

    // Fallback Path B: Fluent UI combobox / dropdown button
    const comboLocator = page.locator(
        '[role="combobox"][aria-label*="Country" i], [role="combobox"][aria-label*="国家" i], [role="combobox"][aria-label*="國家" i], [role="combobox"][aria-label*="国" i], button[aria-label*="Country" i], button[aria-label*="国家" i], button[aria-label*="國家" i]'
    )
    const comboCount = await comboLocator.count().catch(() => 0)
    for (let i = 0; i < comboCount; i++) {
        const combo = comboLocator.nth(i)
        if (!(await combo.isVisible().catch(() => false))) continue

        await combo.scrollIntoViewIfNeeded().catch(() => {})
        await combo.click()
        await page.waitForTimeout(600)

        const optionLocator = page.locator('[role="option"], [role="listbox"] li, [role="listbox"] button')
        await optionLocator
            .first()
            .waitFor({ state: 'visible', timeout: 5000 })
            .catch(() => {})

        const optCount = await optionLocator.count().catch(() => 0)
        for (let j = 0; j < optCount; j++) {
            const opt = optionLocator.nth(j)
            if (!(await opt.isVisible().catch(() => false))) continue
            const text = (await opt.innerText().catch(() => '')).trim()
            if (matchesCountryLabel(text, targetCountry)) {
                await opt.scrollIntoViewIfNeeded().catch(() => {})
                await opt.click()
                return true
            }
        }

        await page.keyboard.press('Escape').catch(() => {})
    }

    return false
}

export async function ensureAccountProfileRegion(
    bot: MicrosoftRewardsBot,
    login: Login,
    page: Page,
    account: Account,
    options: { targetCountry: string; dryRun?: boolean }
): Promise<SetRegionResult> {
    const targetCountry = normalizeCountry(options.targetCountry) ?? options.targetCountry.trim().toUpperCase()
    const dryRun = Boolean(options.dryRun)
    const profileUrl = 'https://account.microsoft.com/profile?lang=en-US'

    const ensureOnAccountProfile = async (): Promise<void> => {
        for (let guard = 0; guard < 4; guard++) {
            let currentHost: string
            try {
                currentHost = new URL(page.url()).hostname.toLowerCase()
            } catch {
                currentHost = ''
            }

            if (isAuthHost(currentHost)) {
                bot.logger.info(
                    bot.isMobile,
                    'SET-REGION',
                    `${account.email} 需要登录认证，正在自动完成登录/2FA`
                )
                await login.authenticateToHost(page, account, 'account.microsoft.com')
                await bot.utils.wait(1500)
                continue
            }

            if (currentHost.includes('privacynotice')) {
                const dismissed = await dismissPrivacyNoticeIfPresent(page)
                if (dismissed) {
                    await bot.utils.wait(2000)
                    continue
                }
            }

            if (currentHost === 'account.microsoft.com') {
                return
            }

            await page.goto(profileUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
            await bot.utils.wait(1500)
        }
    }

    try {
        bot.logger.info(
            bot.isMobile,
            'SET-REGION',
            `正在打开个人资料页 (${account.email}) -> 目标国家=${targetCountry}`
        )
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
        await bot.utils.wait(1500)
        await ensureOnAccountProfile()

        await page
            .locator(
                'text=/Country or region|国家或地区|国家\\/地区|国または地域|Edit profile info|编辑个人资料信息/i'
            )
            .first()
            .waitFor({ state: 'visible', timeout: 15000 })
            .catch(() => {})

        const previousCountry = (await readDisplayedCountryRegion(page)) ?? undefined

        if (previousCountry && matchesCountryLabel(previousCountry, targetCountry)) {
            if (!dryRun) {
                const storageState = await page.context().storageState()
                saveStorageState(bot.config.sessionPath, account.email, bot.isMobile, storageState)
                saveResolvedRegion(bot.config.sessionPath, account.email, targetCountry)
                clearAccountFingerprints(bot.config.sessionPath, account.email)
            }
            return {
                email: account.email,
                targetCountry,
                previousCountry,
                changed: false,
                status: 'already_target',
                message: `资料国家/地区已是 ${previousCountry} (${targetCountry})`
            }
        }

        if (dryRun) {
            return {
                email: account.email,
                targetCountry,
                previousCountry,
                changed: false,
                status: 'dry_run',
                message: `Dry-run: 当前资料地区=${previousCountry ?? '未知'}，未做修改`
            }
        }

        const hasVisibleControl =
            (await page
                .locator(
                    'select[name*="country" i], select[id*="country" i], [role="combobox"][aria-label*="Country" i], [role="combobox"][aria-label*="国家" i]'
                )
                .first()
                .isVisible()
                .catch(() => false)) || false

        if (!hasVisibleControl) {
            const editClicked = await clickFirstVisibleLocator([
                page.getByRole('button', {
                    name: /Edit country\/region|Edit profile info|编辑国家\/地区|编辑个人资料信息|編輯個人資料資訊|プロフィール情報の編集/i
                }),
                page.getByRole('link', {
                    name: /Edit country\/region|Edit profile info|编辑国家\/地区|编辑个人资料信息|編輯個人資料資訊|プロフィール情報の編集/i
                }),
                page.locator('button:has-text("Edit"), a:has-text("Edit"), button:has-text("编辑"), a:has-text("编辑")')
            ])

            if (!editClicked) {
                const screenshotPath = await captureRegionDiagnostic(page, account.email)
                return {
                    email: account.email,
                    targetCountry,
                    previousCountry,
                    changed: false,
                    status: 'failed',
                    message: '未找到“编辑个人资料信息”或“编辑国家/地区”按钮',
                    screenshotPath
                }
            }

            await bot.utils.wait(1500)
            await ensureOnAccountProfile()
            await page
                .locator(
                    'select[name*="country" i], select[id*="country" i], [role="combobox"][aria-label*="Country" i], [role="combobox"][aria-label*="国家" i], button[aria-label*="Country" i], button[aria-label*="国家" i]'
                )
                .first()
                .waitFor({ state: 'visible', timeout: 15000 })
                .catch(() => {})
        }

        const selected = await selectCountryControl(page, targetCountry)
        if (!selected) {
            const screenshotPath = await captureRegionDiagnostic(page, account.email)
            return {
                email: account.email,
                targetCountry,
                previousCountry,
                changed: false,
                status: 'failed',
                message: `未找到国家/地区选择控件或目标选项 (${targetCountry})`,
                screenshotPath
            }
        }

        await bot.utils.wait(400)
        const saveClicked = await clickFirstVisibleLocator([
            page.locator('button:has-text("Save")'),
            page.locator('button:has-text("保存")'),
            page.locator('button:has-text("儲存")'),
            page.locator('[data-testid*="save" i]'),
            page.locator('button[type="submit"]')
        ])

        if (!saveClicked) {
            const screenshotPath = await captureRegionDiagnostic(page, account.email)
            return {
                email: account.email,
                targetCountry,
                previousCountry,
                changed: false,
                status: 'failed',
                message: '已选择目标国家/地区，但未找到“保存”按钮',
                screenshotPath
            }
        }

        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
        await bot.utils.wait(2000)

        // Check for validation/lock errors (e.g., 3-month region cooldown or store balance restriction)
        const alertLocator = page.locator('div[role="alert"], [aria-live="assertive"], .ms-MessageBar--error')
        const alertCount = await alertLocator.count().catch(() => 0)
        for (let i = 0; i < alertCount; i++) {
            const alert = alertLocator.nth(i)
            if (!(await alert.isVisible().catch(() => false))) continue
            const alertText = (await alert.innerText().catch(() => '')).trim()
            if (alertText) {
                const screenshotPath = await captureRegionDiagnostic(page, account.email)
                return {
                    email: account.email,
                    targetCountry,
                    previousCountry,
                    changed: false,
                    status: 'failed',
                    message: `保存地区失败，微软返回提示: ${alertText}`,
                    screenshotPath
                }
            }
        }

        const updatedCountry = await readDisplayedCountryRegion(page)
        if (updatedCountry && !matchesCountryLabel(updatedCountry, targetCountry)) {
            const screenshotPath = await captureRegionDiagnostic(page, account.email)
            return {
                email: account.email,
                targetCountry,
                previousCountry,
                changed: false,
                status: 'failed',
                message: `保存后页面仍显示地区 "${updatedCountry}"，与目标 ${targetCountry} 不一致`,
                screenshotPath
            }
        }

        const storageState = await page.context().storageState()
        saveStorageState(bot.config.sessionPath, account.email, bot.isMobile, storageState)
        saveResolvedRegion(bot.config.sessionPath, account.email, targetCountry)
        clearAccountFingerprints(bot.config.sessionPath, account.email)

        return {
            email: account.email,
            targetCountry,
            previousCountry,
            changed: true,
            status: 'updated',
            message: `已将微软账号资料地区从 ${previousCountry ?? '未知'} 更新为 ${updatedCountry ?? targetCountry}`
        }
    } catch (error) {
        const screenshotPath = await captureRegionDiagnostic(page, account.email)
        return {
            email: account.email,
            targetCountry,
            changed: false,
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
            screenshotPath
        }
    }
}
