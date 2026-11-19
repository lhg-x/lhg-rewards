import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'
import type { Account } from '../../../interface/Account'
import { canPromptForInput, getErrorMessage, getSubtitleMessage, promptInput } from './LoginUtils'
import { RecoveryMailboxClient } from './RecoveryMailboxClient'

export class CodeLogin {
    private readonly textInputSelector = '[data-testid="codeInputWrapper"]'
    private readonly secondairyInputSelector = 'input[id="otc-confirmation-input"], input[name="otc"], input[id="iOttText"]'
    private readonly emailVerificationInputSelectors = [
        'input#proof-confirmation-email-input',
        '[data-testid="proof-confirmation"]'
    ] as const
    private readonly maxManualSeconds = 60
    private readonly maxManualAttempts = 5

    constructor(private bot: MicrosoftRewardsBot) {}

    canAutoFetchCode(account?: Account): boolean {
        return Boolean(account?.recoveryEmail && account?.recoveryPassword)
    }

    createMailboxClient(account?: Account): RecoveryMailboxClient | null {
        if (!account?.recoveryEmail || !account?.recoveryPassword) return null
        return new RecoveryMailboxClient({
            address: account.recoveryEmail,
            password: account.recoveryPassword,
            baseUrl: account.recoveryUrl
        })
    }

    private async findEmailVerificationInput(page: Page) {
        for (const selector of this.emailVerificationInputSelectors) {
            const input = await page.waitForSelector(selector, { state: 'visible', timeout: 500 }).catch(() => null)

            if (input) return { input, selector }
        }

        return null
    }

    private async fillCode(page: Page, code: string): Promise<boolean> {
        try {
            const visibleInput = await page
                .waitForSelector(this.textInputSelector, { state: 'visible', timeout: 500 })
                .catch(() => null)

            if (visibleInput) {
                await visibleInput.click().catch(() => {})
                await page.keyboard.type(code, { delay: 50 })
                const stilOnPage = await page
                    .waitForSelector(this.textInputSelector, { state: 'visible', timeout: 750 })
                    .then(() => true)
                    .catch(() => false)
                if (stilOnPage) {
                    await page.keyboard.press('Enter')
                }
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', '已填写代码输入')
                return true
            }

            const secondairyInput = await page.$(this.secondairyInputSelector)
            if (secondairyInput) {
                await secondairyInput.click().catch(() => {})
                await page.keyboard.type(code, { delay: 50 })

                const stilOnPage = await page
                    .waitForSelector(this.secondairyInputSelector, { state: 'visible', timeout: 750 })
                    .then(() => true)
                    .catch(() => false)
                if (stilOnPage) {
                    await page.keyboard.press('Enter')
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', '已填写代码输入')
                return true
            }

            this.bot.logger.warn(this.bot.isMobile, 'LOGIN-CODE', '未找到代码输入字段')
            return false
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-CODE',
                `填写代码输入失败: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    private async fillEmail(page: Page, email: string): Promise<boolean> {
        try {
            const visibleInput = await this.findEmailVerificationInput(page)

            if (visibleInput) {
                await visibleInput.input.click().catch(() => {})
                await page.keyboard.type(email, { delay: 50 })
                await page.keyboard.press('Enter')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', '已提交验证邮箱')
                return true
            }

            this.bot.logger.warn(this.bot.isMobile, 'LOGIN-CODE', '未找到邮箱验证输入')
            return false
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-CODE',
                `填写邮箱输入失败: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    async handle(page: Page, account?: Account, preExistingCodes?: Set<string>): Promise<void> {
        try {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', '请求代码登录身份验证')

            const mailboxClient = this.createMailboxClient(account)
            const autoFetchAvailable = mailboxClient !== null
            const usedCodes = preExistingCodes ?? new Set<string>()

            if (!autoFetchAvailable && !canPromptForInput()) {
                throw new Error(
                    'Email-code authentication requires ACCOUNT_N_RECOVERY_EMAIL + ACCOUNT_N_RECOVERY_PASSWORD (for auto fetch) or interactive stdin; unavailable in background mode'
                )
            }

            const emailMessage = await getSubtitleMessage(page)
            if (emailMessage) {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', `页面消息: "${emailMessage}"`)
            } else {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-CODE', '无法检索邮件代码目的地')
            }

            const emailProofInput = await this.findEmailVerificationInput(page)

            if (emailProofInput) {
                const selectorVariant =
                    emailProofInput.selector === this.emailVerificationInputSelectors[0] ? 'new' : 'old'
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-CODE', `使用${selectorVariant}版邮箱验证输入选择器`)
                const maskedHint = emailMessage?.match(/[A-Za-z0-9._*+-]+@[A-Za-z0-9.*-]+\.[A-Za-z]{2,}/)?.[0]
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', '检测到邮箱验证挑战，准备填写验证邮箱')

                if (mailboxClient && usedCodes.size === 0) {
                    try {
                        const existing = await mailboxClient.snapshotCodes()
                        existing.forEach(c => usedCodes.add(c))
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'LOGIN-CODE',
                            `已预快照辅助邮箱历史验证码数量: ${usedCodes.size}`
                        )
                    } catch (error) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'LOGIN-CODE',
                            `预快照辅助邮箱历史验证码失败，将继续流程: ${error instanceof Error ? error.message : String(error)}`
                        )
                    }
                }

                let emailVerified = false

                // 优先自动使用 .env 中配置的恢复邮箱
                if (account?.recoveryEmail) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'LOGIN-CODE',
                        `自动填写已配置的恢复邮箱: ${account.recoveryEmail}`
                    )
                    const filled = await this.fillEmail(page, account.recoveryEmail)
                    if (filled) {
                        await this.bot.utils.wait(500)
                        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
                        const emailError = await getErrorMessage(page)
                        if (!emailError) {
                            this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', '恢复邮箱已接受，验证代码已发送')
                            emailVerified = true
                        } else {
                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'LOGIN-CODE',
                                `配置的恢复邮箱被拒绝: ${emailError}`
                            )
                        }
                    }
                }

                if (!emailVerified) {
                    if (!canPromptForInput()) {
                        throw new Error('Recovery email verification failed and interactive stdin is unavailable')
                    }

                    for (let attempt = 1; attempt <= this.maxManualAttempts; attempt++) {
                        const email = await promptInput({
                            question: maskedHint
                                ? `Enter the full email address for "${maskedHint}" to send the code to (waiting ${this.maxManualSeconds}s): `
                                : `Enter the email address to send the code to (waiting ${this.maxManualSeconds}s): `,
                            timeoutSeconds: this.maxManualSeconds,
                            validate: value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
                        })

                        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'LOGIN-CODE',
                                `无效或缺少邮箱 (尝试 ${attempt}/${this.maxManualAttempts}) | 输入长度=${email?.length}`
                            )

                            if (attempt === this.maxManualAttempts) {
                                throw new Error('Manual email input failed or timed out')
                            }
                            continue
                        }

                        const filled = await this.fillEmail(page, email)
                        if (!filled) {
                            this.bot.logger.error(
                                this.bot.isMobile,
                                'LOGIN-CODE',
                                `无法填写邮箱输入 (尝试 ${attempt}/${this.maxManualAttempts})`
                            )

                            if (attempt === this.maxManualAttempts) {
                                throw new Error('Email verification input not found')
                            }
                            continue
                        }

                        await this.bot.utils.wait(500)
                        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

                        const emailError = await getErrorMessage(page)
                        if (emailError) {
                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'LOGIN-CODE',
                                `邮箱被拒绝: ${emailError} (尝试 ${attempt}/${this.maxManualAttempts})`
                            )

                            if (attempt === this.maxManualAttempts) {
                                throw new Error(`Maximum email attempts reached: ${emailError}`)
                            }

                            const inputToClear = await this.findEmailVerificationInput(page)
                            if (inputToClear) {
                                await inputToClear.input.click()
                                await page.keyboard.press('Control+A')
                                await page.keyboard.press('Backspace')
                            }
                            continue
                        }

                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', '邮箱已接受，验证代码已发送')
                        emailVerified = true
                        break
                    }
                }

                if (!emailVerified) {
                    throw new Error('Email verification failed')
                }

                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
            }

            // 优先通过辅助邮箱 HTTP 接口自动取码
            if (mailboxClient) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-CODE',
                    `正在通过辅助邮箱自动获取 6 位验证码 (${account?.recoveryEmail})`
                )
                const fetched = await mailboxClient.waitForNewCode(usedCodes)
                if (fetched.ok && fetched.code) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'LOGIN-CODE',
                        `已自动获取验证码${fetched.reused ? '（复用最新有效码）' : ''}，正在回填`
                    )
                    const filled = await this.fillCode(page, fetched.code)
                    if (!filled) {
                        throw new Error('Code input field not found after auto-fetching code')
                    }

                    await this.bot.utils.wait(1000)
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

                    const errorMessage = await getErrorMessage(page)
                    if (!errorMessage) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', '自动验证码身份验证成功完成')
                        return
                    }

                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN-CODE', `自动获取的验证码被拒: ${errorMessage}`)
                    if (!canPromptForInput()) {
                        throw new Error(`Auto-fetched code rejected: ${errorMessage}`)
                    }
                } else {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-CODE',
                        `自动获取验证码失败: ${fetched.error ?? 'unknown'}`
                    )
                    if (!canPromptForInput()) {
                        throw new Error(`Auto-fetch email verification code failed: ${fetched.error ?? 'unknown'}`)
                    }
                }
            }

            for (let attempt = 1; attempt <= this.maxManualAttempts; attempt++) {
                const code = await promptInput({
                    question: `Enter the 6-digit code (waiting ${this.maxManualSeconds}s): `,
                    timeoutSeconds: this.maxManualSeconds,
                    validate: code => /^\d{6}$/.test(code)
                })

                if (!code || !/^\d{6}$/.test(code)) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-CODE',
                        `无效或缺少代码 (尝试 ${attempt}/${this.maxManualAttempts}) | 输入长度=${code?.length}`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Manual code input failed or timed out')
                    }
                    continue
                }

                const filled = await this.fillCode(page, code)
                if (!filled) {
                    this.bot.logger.error(
                        this.bot.isMobile,
                        'LOGIN-CODE',
                        `无法填写代码输入 (尝试 ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Code input field not found')
                    }
                    continue
                }

                await this.bot.utils.wait(500)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

                // Check if wrong code was entered
                const errorMessage = await getErrorMessage(page)
                if (errorMessage) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-CODE',
                        `代码不正确: ${errorMessage} (尝试 ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error(`Maximum attempts reached: ${errorMessage}`)
                    }

                    // Clear the input field before retrying
                    const inputToClear = await page.$(this.textInputSelector).catch(() => null)
                    if (inputToClear) {
                        await inputToClear.click()
                        await page.keyboard.press('Control+A')
                        await page.keyboard.press('Backspace')
                    }
                    continue
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-CODE', '代码身份验证成功完成')
                return
            }

            throw new Error(`Code input failed after ${this.maxManualAttempts} attempts`)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-CODE',
                `发生错误: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }
}
