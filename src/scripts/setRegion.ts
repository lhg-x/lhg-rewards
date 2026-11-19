import fs from 'node:fs'
import path from 'node:path'

import Browser from '../browser/Browser'
import {
    ensureAccountProfileRegion,
    getDefaultLangForCountry,
    type SetRegionResult,
    updateEnvContentForRegion
} from '../browser/AccountRegion'
import { Login } from '../browser/auth/Login'
import { MicrosoftRewardsBot, runInExecutionContext } from '../index'
import type { Account } from '../interface/Account'
import HttpClient from '../util/Http'
import { getProjectRoot, loadAccounts, loadConfig } from '../util/Load'
import { normalizeCountry, resolveAccountLocale } from '../util/Locale'
import { clearAccountFingerprints, closeSessionStore, saveResolvedRegion } from '../util/SessionStore'

interface CliOptions {
    country: string
    emails: string[]
    all: boolean
    updateEnv: boolean
    clearProxy: boolean
    localOnly: boolean
    dryRun: boolean
    headlessOverride?: boolean
    json: boolean
    help: boolean
}

function printHelp(): void {
    console.log(`
Microsoft Account & Rewards Region Migration Tool

Usage:
  npm run set-region -- [options]

Options:
  --country <ISO2>   Target country code (default: CN).
  --email <addr>     Target specific account email(s), comma-separated. Defaults to all .env accounts.
  --all              Explicitly process all accounts in .env.
  --update-env       Update ACCOUNT_N_GEO_LOCALE and ACCOUNT_N_LANG_CODE in .env.
  --clear-proxy      Clear ACCOUNT_N_PROXY_* in .env (with --update-env) and launch browser without proxy.
  --local-only       Skip browser profile update; only update .env (with --update-env) and sessions.db metadata/fingerprints.
  --dry-run          Inspect current account region without saving profile, sessions.db, or .env changes.
  --headed           Force visible browser window (headless=false).
  --headless         Force headless browser window (headless=true).
  --json             Print machine-readable JSON summary to stdout.
  --help, -h         Show this help.

Examples:
  npm run set-region -- --country CN --update-env --clear-proxy --json
  npm run set-region -- --country CN --email user@outlook.com --update-env --headed
  npm run set-region -- --country CN --local-only --update-env --clear-proxy
`)
}

function parseCliArgs(argv: string[]): CliOptions {
    const opts: CliOptions = {
        country: 'CN',
        emails: [],
        all: false,
        updateEnv: false,
        clearProxy: false,
        localOnly: false,
        dryRun: false,
        json: false,
        help: false
    }

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (!arg) continue

        if (arg === '--help' || arg === '-h') {
            opts.help = true
            continue
        }
        if (arg === '--all') {
            opts.all = true
            continue
        }
        if (arg === '--update-env') {
            opts.updateEnv = true
            continue
        }
        if (arg === '--clear-proxy') {
            opts.clearProxy = true
            continue
        }
        if (arg === '--local-only') {
            opts.localOnly = true
            continue
        }
        if (arg === '--dry-run') {
            opts.dryRun = true
            continue
        }
        if (arg === '--headed') {
            opts.headlessOverride = false
            continue
        }
        if (arg === '--headless') {
            opts.headlessOverride = true
            continue
        }
        if (arg === '--json') {
            opts.json = true
            continue
        }

        const takeValue = (flag: string): string => {
            const eqIdx = arg.indexOf('=')
            if (eqIdx !== -1) return arg.slice(eqIdx + 1)
            const next = argv[++i]
            if (!next || next.startsWith('-')) {
                throw new Error(`${flag} requires a value`)
            }
            return next
        }

        if (arg === '--country' || arg.startsWith('--country=')) {
            const rawCountry = takeValue('--country')
            const normalized = normalizeCountry(rawCountry)
            if (!normalized) {
                throw new Error(`Invalid --country "${rawCountry}"; expected a 2-letter ISO code like CN, US, JP`)
            }
            opts.country = normalized
            continue
        }

        if (arg === '--email' || arg.startsWith('--email=')) {
            const rawEmail = takeValue('--email')
            const parts = rawEmail
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
            if (!parts.length) {
                throw new Error('--email requires a valid email address')
            }
            opts.emails.push(...parts)
            continue
        }

        throw new Error(`Unknown option: ${arg}`)
    }

    return opts
}

function findEnvFilePath(): string | undefined {
    const root = getProjectRoot()
    const candidates = [
        path.join(process.cwd(), '.env'),
        path.join(root, '.env'),
        path.join(root, 'dist', '.env'),
        path.join(root, 'src', '.env')
    ]
    return candidates.find(p => fs.existsSync(p))
}

function selectTargetAccounts(accounts: Account[], opts: CliOptions): Account[] {
    if (opts.all || opts.emails.length === 0) return accounts

    const requested = new Set(opts.emails.map(e => e.toLowerCase()))
    const matched = accounts.filter(acc => requested.has(acc.email.toLowerCase()))
    const foundEmails = new Set(matched.map(acc => acc.email.toLowerCase()))
    const missing = opts.emails.filter(e => !foundEmails.has(e.toLowerCase()))
    if (missing.length > 0) {
        throw new Error(`Account(s) not found in .env: ${missing.join(', ')}`)
    }
    return matched
}

async function main(): Promise<void> {
    const opts = parseCliArgs(process.argv.slice(2))
    if (opts.help) {
        printHelp()
        return
    }

    const config = loadConfig()
    const allAccounts = loadAccounts()
    const targetAccounts = selectTargetAccounts(allAccounts, opts)
    const targetLang = getDefaultLangForCountry(opts.country)
    const results: SetRegionResult[] = []

    try {
        if (opts.localOnly) {
            for (const account of targetAccounts) {
                if (opts.dryRun) {
                    results.push({
                        email: account.email,
                        targetCountry: opts.country,
                        changed: false,
                        status: 'dry_run',
                        message: `Dry-run (local-only): 将更新 sessions.db resolved_region=${opts.country} 并清除旧指纹`
                    })
                    continue
                }

                saveResolvedRegion(config.sessionPath, account.email, opts.country)
                clearAccountFingerprints(config.sessionPath, account.email)
                results.push({
                    email: account.email,
                    targetCountry: opts.country,
                    changed: true,
                    status: 'updated',
                    message: `已更新本地 sessions.db resolved_region=${opts.country} 并清除旧浏览器指纹`
                })
            }
        } else {
            const bot = new MicrosoftRewardsBot()
            if (opts.headlessOverride !== undefined) {
                bot.config.headless = opts.headlessOverride
            }
            const browserFactory = new Browser(bot)
            const login = new Login(bot)

            for (let idx = 0; idx < targetAccounts.length; idx++) {
                const account = targetAccounts[idx]
                if (!account) continue

                if (idx > 0) {
                    await bot.utils.wait(2000)
                }

                const effectiveAccount: Account = opts.clearProxy
                    ? {
                          ...account,
                          proxy: { proxyHttp: false, url: '', port: 0, username: '', password: '' }
                      }
                    : account

                const res = await runInExecutionContext({ isMobile: false, account: effectiveAccount }, async () => {
                    bot.userData.userName = bot.utils.getEmailUsername(effectiveAccount.email)
                    bot.userData.timezoneOffset = String(new Date().getTimezoneOffset())
                    bot.accountLocale = resolveAccountLocale({
                        langCode: targetLang,
                        geoLocale: opts.country
                    })
                    bot.userData.langCode = bot.accountLocale.language
                    bot.userData.geoLocale = bot.accountLocale.country ?? opts.country
                    bot.http = new HttpClient(effectiveAccount.proxy, {
                        'Accept-Language': bot.accountLocale.acceptLanguage
                    })

                    const session = await browserFactory.createBrowser(effectiveAccount)
                    try {
                        const page = await session.context.newPage()
                        bot.mainDesktopPage = page
                        return await ensureAccountProfileRegion(bot, login, page, effectiveAccount, {
                            targetCountry: opts.country,
                            dryRun: opts.dryRun
                        })
                    } finally {
                        await bot.browser.func.closeBrowser(session.context, effectiveAccount.email, false)
                    }
                })

                results.push(res)
            }
        }

        let updatedEnvSlots: string[] = []
        let envUpdatedPath: string | undefined
        if (opts.updateEnv && !opts.dryRun) {
            const succeededEmails = results.filter(r => r.status !== 'failed').map(r => r.email)
            if (succeededEmails.length > 0) {
                const envFilePath = findEnvFilePath()
                if (!envFilePath) {
                    throw new Error('--update-env was specified, but no .env file was found')
                }
                const rawEnv = fs.readFileSync(envFilePath, 'utf8')
                const updated = updateEnvContentForRegion(rawEnv, succeededEmails, {
                    country: opts.country,
                    langCode: targetLang,
                    clearProxy: opts.clearProxy
                })
                if (updated.updatedSlots.length > 0 && updated.content !== rawEnv) {
                    fs.writeFileSync(envFilePath, updated.content, 'utf8')
                }
                updatedEnvSlots = updated.updatedSlots
                envUpdatedPath = envFilePath
            }
        }

        const ok = results.every(r => r.status !== 'failed')
        if (opts.json) {
            console.log(
                JSON.stringify(
                    {
                        ok,
                        targetCountry: opts.country,
                        targetLang,
                        localOnly: opts.localOnly,
                        dryRun: opts.dryRun,
                        ...(envUpdatedPath ? { envFile: envUpdatedPath, updatedEnvSlots } : {}),
                        results
                    },
                    null,
                    2
                )
            )
        } else {
            for (const r of results) {
                const tag = r.status.toUpperCase().padEnd(14, ' ')
                console.log(
                    `[${tag}] ${r.email}: ${r.message}${r.screenshotPath ? ` (screenshot: ${r.screenshotPath})` : ''}`
                )
            }
            if (envUpdatedPath) {
                console.log(
                    `[ENV           ] Updated ${envUpdatedPath} slot(s): ${updatedEnvSlots.join(', ') || 'none'}`
                )
            }
        }

        if (!ok) {
            process.exitCode = 1
        }
    } finally {
        closeSessionStore()
    }
}

main().catch(error => {
    console.error('[FAIL] set-region error:', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
})
