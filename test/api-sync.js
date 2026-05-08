const fs = require('fs')
const http = require('http')
const path = require('path')
const ts = require('typescript')
const test = require('ava')
const { Context, Input, Telegram } = require('../')

function readMethodsFromTypes() {
    const typesRoot = path.dirname(
        require.resolve('@telegraf/types/package.json')
    )
    const methods = fs.readFileSync(
        path.join(typesRoot, 'methods.d.ts'),
        'utf8'
    )
    const source = ts.createSourceFile(
        'methods.d.ts',
        methods,
        ts.ScriptTarget.Latest,
        true
    )
    const names = []
    const getName = (name) =>
        ts.isIdentifier(name) || ts.isStringLiteral(name)
            ? name.text
            : undefined
    const visit = (node) => {
        if (
            ts.isTypeAliasDeclaration(node) &&
            node.name.text === 'ApiMethods' &&
            ts.isTypeLiteralNode(node.type)
        ) {
            for (const member of node.type.members) {
                const name = member.name && getName(member.name)
                if (name) names.push(name)
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    return names
}

test('Telegram wraps every typed Bot API method', (t) => {
    const methods = readMethodsFromTypes()
    const missing = methods.filter(
        (name) => typeof Telegram.prototype[name] !== 'function'
    )
    t.deepEqual(missing, [])
})

test('Telegram wrappers call through to matching Bot API methods', (t) => {
    const source = fs.readFileSync(path.join(__dirname, '../src/telegram.ts'), {
        encoding: 'utf8',
    })
    const wrapped = new Set(
        [...source.matchAll(/callApi\('([a-zA-Z0-9]+)'/g)].map(
            (match) => match[1]
        )
    )
    const aliases = new Set(
        [
            ...source.matchAll(/get ([a-zA-Z0-9]+)\(\) \{\n {8}return this\./g),
        ].map((match) => match[1])
    )
    const missing = readMethodsFromTypes().filter(
        (method) => !wrapped.has(method) && !aliases.has(method)
    )
    t.deepEqual(missing, [])
})

test('Context exposes business update helpers', async (t) => {
    let businessConnectionId
    const telegram = {
        getBusinessConnection(id) {
            businessConnectionId = id
            return { id }
        },
    }
    const ctx = new Context(
        {
            update_id: 1,
            business_message: {
                business_connection_id: 'biz-1',
                message_id: 12,
                date: 1,
                chat: { id: 42, type: 'private' },
                text: 'hello',
            },
        },
        telegram,
        { id: 7, is_bot: true, first_name: 'Bot' }
    )

    t.is(ctx.bizConnId, 'biz-1')
    t.is(ctx.msg.text, 'hello')
    t.deepEqual(await ctx.getBusinessConnection(), { id: 'biz-1' })
    t.is(businessConnectionId, 'biz-1')
})

test('multipart form data serializes nested input files', async (t) => {
    let resolveRequest
    const request = new Promise((resolve) => {
        resolveRequest = resolve
    })
    const server = http.createServer((req, res) => {
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
            resolveRequest({
                url: req.url,
                headers: req.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            })
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: true, result: true }))
            server.close()
        })
    })

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const telegram = new Telegram('123:abc', {
        apiRoot: `http://127.0.0.1:${port}`,
    })

    await telegram.setMyProfilePhoto({
        photo: {
            type: 'static',
            photo: Input.fromBuffer(Buffer.from('avatar-bytes'), 'avatar.png'),
        },
    })

    const captured = await request
    t.is(captured.url, '/bot123:abc/setMyProfilePhoto')
    t.regex(captured.headers['content-type'], /^multipart\/form-data/)
    const attachment = captured.body.match(/"photo":"attach:\/\/([0-9a-f]+)"/)
    t.truthy(attachment)
    t.true(captured.body.includes(`name="${attachment[1]}"`))
    t.true(captured.body.includes('filename="avatar.png"'))
    t.true(captured.body.includes('avatar-bytes'))
})

test('custom fetch is used for Bot API calls', async (t) => {
    let captured
    const telegram = new Telegram('123:abc', {
        fetch: async (url, init) => {
            captured = { url, init }
            return {
                status: 200,
                statusText: 'OK',
                json: async () => ({
                    ok: true,
                    result: { id: 42, is_bot: true, first_name: 'Bot' },
                }),
            }
        },
    })

    const result = await telegram.getMe()

    t.is(String(captured.url), 'https://api.telegram.org/bot123:abc/getMe')
    t.is(captured.init.method, 'POST')
    t.deepEqual(JSON.parse(captured.init.body), {})
    t.deepEqual(result, { id: 42, is_bot: true, first_name: 'Bot' })
})

test('custom fetch is used for URL attachments', async (t) => {
    const calls = []
    let botApiInit
    const telegram = new Telegram('123:abc', {
        fetch: async (url, init) => {
            calls.push(String(url))
            if (String(url) === 'https://example.test/avatar.png') {
                return {
                    status: 200,
                    statusText: 'OK',
                    body: new ReadableStream({
                        start(controller) {
                            controller.enqueue(Buffer.from('image-bytes'))
                            controller.close()
                        },
                    }),
                    json: async () => ({ ok: true, result: true }),
                }
            }
            botApiInit = init
            return {
                status: 200,
                statusText: 'OK',
                json: async () => ({ ok: true, result: true }),
            }
        },
    })

    await telegram.sendPhoto(
        1,
        Input.fromURLStream('https://example.test/avatar.png')
    )

    t.deepEqual(calls, [
        'https://example.test/avatar.png',
        'https://api.telegram.org/bot123:abc/sendPhoto',
    ])
    t.is(botApiInit.method, 'POST')
    t.is(botApiInit.duplex, 'half')
    t.regex(botApiInit.headers['content-type'], /^multipart\/form-data/)
})

test('request timeout aborts fetch calls', async (t) => {
    const telegram = new Telegram('123:abc', {
        requestTimeout: 1,
        fetch: async (_url, init) =>
            await new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => {
                    const err = new Error('aborted')
                    err.name = 'AbortError'
                    reject(err)
                })
            }),
    })

    const err = await t.throwsAsync(telegram.getMe())
    t.is(err.name, 'AbortError')
})

test('fetch errors redact token and preserve metadata', async (t) => {
    class FetchLikeError extends Error {
        constructor(message, options) {
            super(message, options)
            this.name = 'FetchLikeError'
            this.code = 'ECONNRESET'
        }
    }

    const cause = new Error('root cause')
    const err = new FetchLikeError(
        'request to https://api.telegram.org/bot123:secret/getMe failed',
        { cause }
    )
    err.stack = `${err.name}: ${err.message}\n    at userland.js:1:1`

    const telegram = new Telegram('123:secret', {
        fetch: async () => {
            throw err
        },
    })

    const thrown = await t.throwsAsync(telegram.getMe())
    t.is(thrown, err)
    t.true(thrown instanceof FetchLikeError)
    t.is(thrown.name, 'FetchLikeError')
    t.is(thrown.code, 'ECONNRESET')
    t.is(thrown.cause, cause)
    t.true(thrown.message.includes('[REDACTED]'))
    t.false(thrown.message.includes('secret'))
    t.false(thrown.stack.includes('secret'))
})

test('fetch errors redact token on getter-only native errors', async (t) => {
    const err = new DOMException(
        'request to https://api.telegram.org/bot123:secret/getMe failed',
        'AbortError'
    )
    const telegram = new Telegram('123:secret', {
        fetch: async () => {
            throw err
        },
    })

    const thrown = await t.throwsAsync(telegram.getMe())
    t.true(thrown instanceof DOMException)
    t.is(thrown.name, 'AbortError')
    t.true(thrown.message.includes('[REDACTED]'))
    t.false(thrown.message.includes('secret'))
})
