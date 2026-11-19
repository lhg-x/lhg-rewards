const assert = require('node:assert/strict')
const test = require('node:test')

const {
    getDefaultLangForCountry,
    matchesCountryLabel,
    updateEnvContentForRegion
} = require('../../dist/browser/AccountRegion.js')

test('matchesCountryLabel matches China mainland labels strictly without matching HK or TW', () => {
    for (const positive of ['China', 'China mainland', 'China (mainland)', '中国', '中国大陆', '中国（大陆）', 'CN']) {
        assert.equal(matchesCountryLabel(positive, 'CN'), true, `expected ${positive} to match CN`)
    }

    for (const negative of [
        'China (Hong Kong SAR)',
        'Hong Kong SAR',
        '中国香港',
        '中国台湾',
        'Taiwan',
        'United States',
        'Japan',
        ''
    ]) {
        assert.equal(matchesCountryLabel(negative, 'CN'), false, `expected ${negative} NOT to match CN`)
    }

    assert.equal(matchesCountryLabel('China (Hong Kong SAR)', 'HK'), true)
    assert.equal(getDefaultLangForCountry('CN'), 'zh-CN')
    assert.equal(getDefaultLangForCountry('US'), 'en-US')
})

test('updateEnvContentForRegion updates target account slots and clears proxies while preserving others', () => {
    const rawEnv = [
        '# Account 1',
        'ACCOUNT_1_EMAIL=AndersClarke@outlook.com',
        'ACCOUNT_1_PASSWORD=secret1',
        'ACCOUNT_1_GEO_LOCALE=US',
        'ACCOUNT_1_LANG_CODE=en-US',
        'ACCOUNT_1_PROXY_HTTP=true',
        'ACCOUNT_1_PROXY_URL=http://proxy.example.com',
        'ACCOUNT_1_PROXY_PORT=8080',
        'ACCOUNT_1_PROXY_USERNAME=user1',
        'ACCOUNT_1_PROXY_PASSWORD=pass1',
        '',
        '# Account 2 (untouched when filtering by email)',
        'ACCOUNT_2_EMAIL=other@outlook.com',
        'ACCOUNT_2_GEO_LOCALE=JP',
        'ACCOUNT_2_LANG_CODE=ja-JP',
        '',
        'API_TOKEN=keep-me-123'
    ].join('\n')

    const { content, updatedSlots } = updateEnvContentForRegion(rawEnv, ['andersclarke@outlook.com'], {
        country: 'CN',
        langCode: 'zh-CN',
        clearProxy: true
    })

    assert.deepEqual(updatedSlots, ['1'])
    assert.match(content, /^ACCOUNT_1_GEO_LOCALE=CN$/m)
    assert.match(content, /^ACCOUNT_1_LANG_CODE=zh-CN$/m)
    assert.match(content, /^ACCOUNT_1_PROXY_HTTP=false$/m)
    assert.match(content, /^ACCOUNT_1_PROXY_URL=$/m)
    assert.match(content, /^ACCOUNT_1_PROXY_PORT=0$/m)
    assert.match(content, /^ACCOUNT_1_PROXY_USERNAME=$/m)
    assert.match(content, /^ACCOUNT_1_PROXY_PASSWORD=$/m)

    // Unrelated account and token remain unchanged
    assert.match(content, /^ACCOUNT_2_GEO_LOCALE=JP$/m)
    assert.match(content, /^ACCOUNT_2_LANG_CODE=ja-JP$/m)
    assert.match(content, /^API_TOKEN=keep-me-123$/m)
    assert.match(content, /^# Account 1$/m)
})

test('updateEnvContentForRegion inserts missing GEO_LOCALE and LANG_CODE for matched slots', () => {
    const rawEnv = [
        'ACCOUNT_3_EMAIL="third@outlook.com"',
        'ACCOUNT_3_PASSWORD=pwd3',
        '',
        'API_TOKEN=abc'
    ].join('\n')

    const { content, updatedSlots } = updateEnvContentForRegion(rawEnv, [], {
        country: 'CN',
        langCode: 'zh-CN',
        clearProxy: true
    })

    assert.deepEqual(updatedSlots, ['3'])
    assert.equal(
        content,
        [
            'ACCOUNT_3_EMAIL="third@outlook.com"',
            'ACCOUNT_3_PASSWORD=pwd3',
            'ACCOUNT_3_GEO_LOCALE=CN',
            'ACCOUNT_3_LANG_CODE=zh-CN',
            '',
            'API_TOKEN=abc'
        ].join('\n')
    )
})
