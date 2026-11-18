// 手动探测登录流程：看 EMAIL_VERIFICATION 页面到底长什么样
const { chromium } = require('patchright');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const ctx = await browser.newContext({
    locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.4341.53',
  });
  const page = await ctx.newPage();
  await page.goto('https://rewards.bing.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
  await page.waitForTimeout(6000);
  console.log('URL after login redirect:', page.url());

  // 填账号邮箱
  await page.waitForSelector('input#usernameEntry', { state: 'visible', timeout: 30000 }).catch(()=>{});
  await page.fill('input#usernameEntry', process.env.ACCOUNT_1_EMAIL || 'your_email@outlook.com');
  await page.waitForTimeout(500);
  // 点下一步
  await page.keyboard.press('Enter');
  await page.waitForTimeout(9000);
  console.log('URL after email:', page.url());
  console.log('TITLE:', await page.title().catch(()=>''));

  // dump 当前页面所有输入框与按钮文本
  const dump = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')].map(i => ({
      id: i.id, type: i.type, name: i.name,
      placeholder: i.placeholder, aria: i.getAttribute('aria-label'),
      testid: i.getAttribute('data-testid'), visible: !!(i.offsetParent || i.getClientRects().length),
    }));
    const btns = [...document.querySelectorAll('button, input[type=submit], [role=button]')]
      .map(b => ({ text: (b.textContent || b.value || '').trim().slice(0, 40), testid: b.getAttribute('data-testid'), visible: !!(b.offsetParent || b.getClientRects().length) }))
      .filter(b => b.text);
    const headers = [...document.querySelectorAll('h1,h2,h3,[role=heading]')].map(h => (h.textContent || '').trim().slice(0, 80)).filter(Boolean);
    return { url: location.href, inputs: inputs.filter(i => i.visible), btns: btns.filter(b => b.visible).slice(0, 10), headers };
  });
  console.log(JSON.stringify(dump, null, 1));
  await page.screenshot({ path: '/tmp/probe_verify_page.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error('PROBE_ERR', e.message); process.exit(1); });
