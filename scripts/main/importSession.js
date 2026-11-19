import fs from 'node:fs'
import path from 'node:path'

import {
    closeSessionDb,
    ensureSessionSchema,
    findUnknownOptions,
    getDirname,
    getProjectRoot,
    getSessionDbPath,
    loadConfig,
    log,
    openSessionDb,
    parseArgs,
    resolveEmailArgument,
    saveSessionRow
} from '../utils.js'

const __dirname = getDirname(import.meta.url)
const projectRoot = getProjectRoot(__dirname)

function printHelp() {
    console.log(`
Import external browser cookies or Playwright storageState into sessions/sessions.db

Usage:
  npm run import-session -- --email <account-email> --file <cookies.json> [--platform both|desktop|mobile]

Options:
  --email       Account email address (must match ACCOUNT_N_EMAIL in .env).
  --file        Path to a Playwright storageState JSON ({ cookies, origins }) OR a plain cookie array JSON
                (e.g., exported from Chrome/Edge/EditThisCookie/Cookie-Editor/CDP).
  --platform    Target platform(s): both (default), desktop, or mobile.
  --help        Show this help.
`)
}

function normalizeSameSite(raw) {
    if (!raw || typeof raw !== 'string') return 'Lax'
    const lower = raw.trim().toLowerCase()
    if (lower === 'strict') return 'Strict'
    if (lower === 'none' || lower === 'no_restriction') return 'None'
    return 'Lax'
}

function normalizeCookie(raw) {
    if (!raw || typeof raw !== 'object') return null
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const value = typeof raw.value === 'string' ? raw.value : raw.value == null ? '' : String(raw.value)
    const domain = typeof raw.domain === 'string' ? raw.domain.trim() : ''
    if (!name || !domain) return null

    const pathValue = typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : '/'
    const rawExpires = raw.expires ?? raw.expirationDate
    let expires = -1
    if (typeof rawExpires === 'number' && Number.isFinite(rawExpires) && rawExpires > 0) {
        // Convert ms timestamps to seconds if needed
        expires = rawExpires > 1e12 ? rawExpires / 1000 : rawExpires
    }

    const sameSite = normalizeSameSite(raw.sameSite)
    const secure = Boolean(raw.secure) || sameSite === 'None'

    return {
        name,
        value,
        domain,
        path: pathValue,
        expires,
        httpOnly: Boolean(raw.httpOnly),
        secure,
        sameSite
    }
}

export function normalizeStorageState(parsed) {
    if (Array.isArray(parsed)) {
        const cookies = parsed.map(normalizeCookie).filter(Boolean)
        return { cookies, origins: [] }
    }

    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.cookies)) {
        const cookies = parsed.cookies.map(normalizeCookie).filter(Boolean)
        const origins = Array.isArray(parsed.origins) ? parsed.origins : []
        return { cookies, origins }
    }

    throw new Error('Unsupported JSON format: expected Playwright storageState ({ cookies, origins }) or a cookie array')
}

function parsePlatforms(raw) {
    if (raw === undefined) return ['desktop', 'mobile']
    const val = String(raw).trim().toLowerCase()
    if (val === 'both') return ['desktop', 'mobile']
    if (val === 'desktop' || val === 'mobile') return [val]
    throw new Error(`Invalid --platform "${raw}"; expected both, desktop, or mobile`)
}

function main() {
    const args = parseArgs(process.argv.slice(2), { boolean: ['help'] })
    if (args.help) {
        printHelp()
        return
    }

    const unknown = findUnknownOptions(args, ['email', 'file', 'platform', 'help'])
    if (unknown.length > 0) {
        log('ERROR', `Unknown option(s): ${unknown.map(k => `--${k}`).join(', ')}`)
        printHelp()
        process.exit(1)
    }

    let email
    try {
        email = resolveEmailArgument(args)
    } catch (error) {
        log('ERROR', error.message)
        printHelp()
        process.exit(1)
    }

    const fileArg = typeof args.file === 'string' ? args.file.trim() : ''
    if (!fileArg) {
        log('ERROR', 'Missing required --file <path-to-cookies.json>')
        printHelp()
        process.exit(1)
    }

    const resolvedFile = path.resolve(process.cwd(), fileArg)
    if (!fs.existsSync(resolvedFile)) {
        log('ERROR', `Cookie file not found: ${resolvedFile}`)
        process.exit(1)
    }

    let platforms
    try {
        platforms = parsePlatforms(args.platform)
    } catch (error) {
        log('ERROR', error.message)
        process.exit(1)
    }

    let storageState
    try {
        const rawText = fs.readFileSync(resolvedFile, 'utf8')
        const parsed = JSON.parse(rawText)
        storageState = normalizeStorageState(parsed)
    } catch (error) {
        log('ERROR', `Failed to parse cookie file: ${error.message}`)
        process.exit(1)
    }

    if (storageState.cookies.length === 0) {
        log('ERROR', 'No valid cookies found in input file')
        process.exit(1)
    }

    const { data: config } = loadConfig(projectRoot)
    const { dbPath } = getSessionDbPath(projectRoot, config.sessionPath)
    const sessionDir = path.dirname(dbPath)
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 })

    const db = openSessionDb(dbPath)
    try {
        ensureSessionSchema(db)
        for (const platform of platforms) {
            saveSessionRow(db, email, platform, storageState, null, false)
            log('INFO', `Imported ${storageState.cookies.length} cookies for ${email} (${platform}) -> ${dbPath}`)
        }
    } finally {
        closeSessionDb(db)
    }
}

main()
