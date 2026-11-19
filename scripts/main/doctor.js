import fs from 'node:fs'
import path from 'node:path'
import semver from 'semver'
import { chromium } from 'patchright'

import {
    closeSessionDb,
    findUnknownOptions,
    getDirname,
    getProjectRoot,
    getSessionDbPath,
    listSessionRows,
    loadAccountsFromEnv,
    loadJsonFile,
    openSessionDb,
    parseArgs
} from '../utils.js'

const __dirname = getDirname(import.meta.url)
const projectRoot = getProjectRoot(__dirname)

function printHelp() {
    console.log(`
Microsoft Rewards Script - Environment & Network Doctor

Usage:
  npm run doctor -- [--skip-network] [--json]

Options:
  --skip-network   Skip launching Chromium to test https://rewards.bing.com connectivity.
  --json           Output machine-readable JSON (recommended for AI agents).
  --help           Show this help.
`)
}

async function runDoctor({ skipNetwork = false }) {
    const checks = []
    const add = (name, status, detail) => checks.push({ name, status, detail })

    // 1. Node.js version
    const pkgPath = path.join(projectRoot, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    const requiredNode = pkg.engines?.node || '>=24.0.0'
    if (semver.satisfies(process.version, requiredNode)) {
        add('node_version', 'ok', `${process.version} satisfies ${requiredNode}`)
    } else {
        add('node_version', 'fail', `${process.version} does not satisfy ${requiredNode}`)
    }

    // 2. Build output
    const distEntry = path.join(projectRoot, 'dist', 'index.js')
    if (fs.existsSync(distEntry)) {
        add('build_dist', 'ok', 'dist/index.js exists')
    } else {
        add('build_dist', 'fail', 'dist/index.js missing; run `npm run build`')
    }

    // 3. config.json
    const configResult = loadJsonFile(
        [
            path.resolve(process.cwd(), 'config.json'),
            path.join(projectRoot, 'config.json'),
            path.join(projectRoot, 'dist', 'config.json')
        ],
        false
    )
    let sessionPath = 'sessions'
    if (!configResult) {
        add('config_json', 'fail', 'config.json missing; copy config.agent.json or config.example.json to config.json')
    } else {
        sessionPath = configResult.data.sessionPath || 'sessions'
        const headless = Boolean(configResult.data.headless)
        const linuxNoDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
        if (!headless && linuxNoDisplay) {
            add(
                'config_json',
                'warn',
                `Loaded ${configResult.path}, but headless=false on Linux without DISPLAY/WAYLAND_DISPLAY (set headless: true)`
            )
        } else {
            add('config_json', 'ok', `Loaded ${configResult.path} (headless=${headless})`)
        }
    }

    // 4. .env accounts
    const accounts = loadAccountsFromEnv(projectRoot)
    if (accounts.length === 0) {
        add('accounts_env', 'fail', 'No ACCOUNT_N_EMAIL found in .env or environment')
    } else {
        const summary = accounts.map(acc => {
            const auto2fa = Boolean(acc.recoveryEmail && acc.recoveryPassword)
            return `${acc.email} (locale=${acc.geoLocale}/${acc.langCode}, auto2fa=${auto2fa ? 'yes' : 'no'})`
        })
        add('accounts_env', 'ok', `${accounts.length} account(s): ${summary.join('; ')}`)
    }

    // 5. Sessions DB
    const { dbPath, exists: dbExists } = getSessionDbPath(projectRoot, sessionPath)
    if (!dbExists) {
        add('sessions_db', 'warn', `No sessions.db yet at ${dbPath} (will be created on first login or import-session)`)
    } else {
        try {
            const db = openSessionDb(dbPath, { readonly: true })
            const rows = listSessionRows(db)
            closeSessionDb(db)
            add(
                'sessions_db',
                'ok',
                `${rows.length} stored session(s) in ${dbPath}: ${rows.map(r => `${r.email}[${r.platform}]`).join(', ') || 'none'}`
            )
        } catch (error) {
            add('sessions_db', 'warn', `Unable to read ${dbPath}: ${error.message}`)
        }
    }

    // 6. Patchright Chromium executable
    let chromiumPath = ''
    try {
        chromiumPath = chromium.executablePath()
        if (chromiumPath && fs.existsSync(chromiumPath)) {
            add('chromium_binary', 'ok', chromiumPath)
        } else {
            add('chromium_binary', 'fail', 'Chromium executable missing; run `npx patchright install chromium`')
        }
    } catch (error) {
        add('chromium_binary', 'fail', `Chromium check failed: ${error.message}`)
    }

    // 7. Browser connectivity check to rewards.bing.com
    if (!skipNetwork && chromiumPath && fs.existsSync(chromiumPath)) {
        let browser = null
        try {
            browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
            const context = await browser.newContext()
            const page = await context.newPage()
            const resp = await page.goto('https://rewards.bing.com', {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            })
            const status = resp?.status() ?? 0
            add('browser_network', 'ok', `Chromium reached ${page.url()} (HTTP ${status})`)
        } catch (error) {
            add(
                'browser_network',
                'fail',
                `Chromium failed to reach https://rewards.bing.com: ${error.message} (check sandbox proxy / firewall)`
            )
        } finally {
            if (browser) await browser.close().catch(() => {})
        }
    } else if (skipNetwork) {
        add('browser_network', 'skip', 'Skipped via --skip-network')
    }

    const ok = checks.every(c => c.status !== 'fail')
    return { ok, checks }
}

async function main() {
    const args = parseArgs(process.argv.slice(2), { boolean: ['skip-network', 'json', 'help'] })
    if (args.help) {
        printHelp()
        return
    }

    const unknown = findUnknownOptions(args, ['skip-network', 'json', 'help'])
    if (unknown.length > 0) {
        console.error(`Unknown option(s): ${unknown.map(k => `--${k}`).join(', ')}`)
        process.exit(1)
    }

    const result = await runDoctor({ skipNetwork: Boolean(args['skip-network']) })

    if (args.json) {
        console.log(JSON.stringify(result, null, 2))
    } else {
        for (const check of result.checks) {
            const tag = check.status.toUpperCase().padEnd(4, ' ')
            console.log(`[${tag}] ${check.name}: ${check.detail}`)
        }
        console.log(result.ok ? '\nDoctor passed.' : '\nDoctor found blocking issue(s).')
    }

    if (!result.ok) process.exit(1)
}

main().catch(error => {
    console.error('[FAIL] doctor crashed:', error?.message || error)
    process.exit(1)
})
