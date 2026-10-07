'use strict'

const test = require('ava')
const { createServer } = require('node:http')
const { once, getEventListeners } = require('node:events')
const { inspect } = require('node:util')
const { Telegram, TelegrafNetworkError, TelegramError } = require('../')
const { Polling } = require('../lib/core/network/polling')

async function localApi(t) {
    const server = createServer((req, res) => {
        req.resume()
        req.on('end', () => {
            if (req.url.startsWith('/files/')) {
                res.end('file-bytes')
                return
            }
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: true, result: true }))
        })
    })
    t.teardown(() => {
        server.closeAllConnections()
        server.close()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    return `http://127.0.0.1:${server.address().port}`
}

test('injected fetch has no options-object receiver', async (t) => {
    const apiRoot = await localApi(t)
    let calls = 0
    function fetch(url, init) {
        if (this !== undefined) throw new TypeError('Illegal invocation')
        calls++
        return globalThis.fetch(url, init)
    }
    const telegram = new Telegram('123:secret', { apiRoot, fetch })
    t.true(await telegram.getMe())
    t.true(await telegram.sendPhoto(1, { url: `${apiRoot}/files/photo.png` }))
    t.is(calls, 3)
})

test('proxy fetch keeps its explicitly bound receiver', async (t) => {
    const apiRoot = await localApi(t)
    const proxy = 'http://proxy.test:8080'
    let calls = 0
    class FetchClient {
        constructor(options) {
            this.proxy = options.proxy
        }
        fetch(url, init) {
            t.is(this.proxy, proxy)
            calls++
            return globalThis.fetch(url, init)
        }
    }
    const telegram = new Telegram('123:secret', {
        apiRoot,
        proxy: { proxy, FetchClient },
    })
    t.true(await telegram.getMe())
    t.true(await telegram.sendPhoto(1, { url: `${apiRoot}/files/photo.png` }))
    t.is(calls, 3)
})

for (const abort of [false, true]) {
    test.serial(
        `signal fallback covers body consumption (caller abort: ${abort})`,
        async (t) => {
            const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any')
            Object.defineProperty(AbortSignal, 'any', {
                value: undefined,
                configurable: true,
            })
            const controller = new AbortController()
            const server = createServer((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.flushHeaders()
                if (abort) setTimeout(() => controller.abort(), 20)
            })
            t.teardown(() => {
                controller.abort()
                server.closeAllConnections()
                server.close()
                if (any) Object.defineProperty(AbortSignal, 'any', any)
                else delete AbortSignal.any
            })
            server.listen(0, '127.0.0.1')
            await once(server, 'listening')
            const telegram = new Telegram('123:secret', {
                apiRoot: `http://127.0.0.1:${server.address().port}`,
                requestTimeout: abort ? 2000 : 100,
            })
            const error = await t.throwsAsync(
                telegram.callApi('getMe', {}, { signal: controller.signal })
            )
            t.true(error instanceof TelegrafNetworkError)
            t.is(error.errorName, abort ? 'AbortError' : 'TimeoutError')
            t.is(error.transient, !abort)
            t.is(getEventListeners(controller.signal, 'abort').length, 0)
        }
    )
}

for (const status of [401, 409, 429]) {
    test(`unreadable HTTP ${status} responses retain their status`, async (t) => {
        const telegram = new Telegram('123:secret', {
            fetch: async () => ({
                status,
                statusText: 'Rejected',
                json: async () => {
                    throw new Error('broken JSON')
                },
            }),
        })
        const error = await t.throwsAsync(telegram.getMe())
        t.true(error instanceof TelegramError)
        t.is(error.code, status)
    })
}

test.serial(
    'timeout fallback preserves timeout and caller abort reasons',
    async (t) => {
        // The fake transport lacks a socket to keep the unref'ed timeout alive.
        const keepAlive = setInterval(() => undefined, 1000)
        t.teardown(() => clearInterval(keepAlive))
        const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any')
        Object.defineProperty(AbortSignal, 'any', {
            value: undefined,
            configurable: true,
        })
        t.teardown(() => {
            if (any) Object.defineProperty(AbortSignal, 'any', any)
            else delete AbortSignal.any
        })
        const controller = new AbortController()
        const telegram = new Telegram('123:secret', {
            requestTimeout: 10,
            fetch: async (_url, init) => {
                init.signal.throwIfAborted()
                return await new Promise((_resolve, reject) => {
                    init.signal.addEventListener(
                        'abort',
                        () => reject(init.signal.reason),
                        { once: true }
                    )
                })
            },
        })
        const timeout = await t.throwsAsync(
            telegram.callApi('getMe', {}, { signal: controller.signal })
        )
        t.is(timeout.errorName, 'TimeoutError')
        t.true(timeout.transient)
        controller.abort(new DOMException('User stopped', 'AbortError'))
        const abort = await t.throwsAsync(
            telegram.callApi('getMe', {}, { signal: controller.signal })
        )
        t.is(abort.errorName, 'AbortError')
        t.false(abort.transient)
    }
)

test('polling stops cleanly when its active request is aborted', async (t) => {
    const telegram = new Telegram('123:secret', {
        fetch: async (_url, init) => {
            if (JSON.parse(init.body).limit === 1) {
                return {
                    status: 200,
                    json: async () => ({ ok: true, result: [] }),
                }
            }
            return await new Promise((_resolve, reject) => {
                init.signal.addEventListener(
                    'abort',
                    () => reject(init.signal.reason),
                    { once: true }
                )
                polling.stop()
            })
        },
    })
    const polling = new Polling(telegram, [])
    await t.notThrowsAsync(polling.loop(async () => undefined))
})

const shutdownFailures = {
    timeout: new TelegrafNetworkError(
        'Timed out',
        { method: 'getUpdates' },
        { errorName: 'TimeoutError', transient: true }
    ),
    permanent: new TelegrafNetworkError(
        'Invalid transport',
        { method: 'getUpdates' },
        { errorName: 'TypeError' }
    ),
    unauthorized: new TelegramError({ error_code: 401, description: 'Denied' }),
    conflict: new TelegramError({ error_code: 409, description: 'Conflict' }),
    unavailable: new TelegramError({
        error_code: 503,
        description: 'Service unavailable',
    }),
    unexpected: new Error('Unexpected failure'),
}

for (const [name, original] of Object.entries(shutdownFailures)) {
    test(`polling preserves ${name} errors after stop`, async (t) => {
        let calls = 0
        let synced = 0
        const polling = new Polling(
            {
                callApi: async (_method, payload) => {
                    if (payload.limit === 1) {
                        synced++
                        return []
                    }
                    calls++
                    polling.stop()
                    throw original
                },
            },
            [],
            { retryOnConflict: true }
        )
        const error = await t.throwsAsync(polling.loop(async () => undefined))
        t.is(error, original)
        t.is(calls, 1)
        t.is(synced, ['unauthorized', 'conflict'].includes(name) ? 0 : 1)
    })
}

test('handler errors survive polling shutdown', async (t) => {
    const original = new Error('Handler failed during shutdown')
    const polling = new Polling(
        {
            callApi: async (_method, payload) =>
                payload.limit === 1 ? [] : [{ update_id: 1 }],
        },
        []
    )
    const error = await t.throwsAsync(
        polling.loop(async () => {
            polling.stop()
            throw original
        })
    )
    t.is(error, original)
})

test('native request timeouts are retryable network errors', async (t) => {
    const server = createServer(() => undefined)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.teardown(() => {
        server.closeAllConnections()
        server.close()
    })
    const telegram = new Telegram('123:secret', {
        apiRoot: `http://127.0.0.1:${server.address().port}`,
        requestTimeout: 30,
    })
    const error = await t.throwsAsync(telegram.getMe())
    t.true(error instanceof TelegrafNetworkError)
    t.is(error.errorName, 'TimeoutError')
    t.true(error.transient)
})

test('response body failures cross the same network error boundary', async (t) => {
    const original = new TypeError('bot123:secret disconnected', {
        cause: Object.assign(new Error('socket closed'), {
            code: 'UND_ERR_SOCKET',
        }),
    })
    const telegram = new Telegram('123:secret', {
        fetch: async () => ({
            status: 200,
            json: async () => {
                throw original
            },
        }),
    })
    const error = await t.throwsAsync(telegram.getMe())
    t.true(error instanceof TelegrafNetworkError)
    t.true(error.transient)
    t.false(inspect(error, { depth: null }).includes('secret'))
    t.true(original.message.includes('secret'))
})

test('deep error causes cannot overflow the network error boundary', async (t) => {
    let original = new Error('root')
    for (let i = 0; i < 15000; i++) {
        original = new Error('layer', { cause: original })
    }
    const telegram = new Telegram('123:secret', {
        fetch: async () => {
            throw original
        },
    })
    const error = await t.throwsAsync(telegram.getMe())
    t.true(error instanceof TelegrafNetworkError)
    let cause = error.cause
    for (let depth = 0; depth < 4; depth++) cause = cause?.cause
    t.is(cause, '[Truncated]')
})

test('network diagnostics redact tokens in names, codes and object keys', async (t) => {
    const token = '123:secret'
    const original = Object.assign(new Error(token), {
        name: token,
        code: token,
        cause: JSON.parse(
            '{"123:secret":"123:secret","__proto__":{"polluted":true}}'
        ),
    })
    const telegram = new Telegram(token, {
        fetch: async () => {
            throw original
        },
    })
    const error = await t.throwsAsync(telegram.getMe())
    t.true(error instanceof TelegrafNetworkError)
    t.false(inspect(error, { depth: null }).includes('secret'))
    t.is(error.cause.cause.polluted, undefined)
    t.is(original.name, token)
})

test('uninspectable fetch rejections do not replace the network error', async (t) => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    const telegram = new Telegram('123:secret', {
        fetch: async () => {
            throw proxy
        },
    })
    const error = await t.throwsAsync(telegram.getMe())
    t.true(error instanceof TelegrafNetworkError)
    t.is(error.cause, '[Uninspectable object]')
})

test('polling does not silently swallow an unsolicited abort', async (t) => {
    const telegram = new Telegram('123:secret', {
        fetch: async (_url, init) => {
            if (JSON.parse(init.body).limit === 1) {
                return {
                    status: 200,
                    json: async () => ({ ok: true, result: [] }),
                }
            }
            throw new DOMException('Unexpected abort', 'AbortError')
        },
    })
    const polling = new Polling(telegram, [])
    const error = await t.throwsAsync(polling.loop(async () => undefined))
    t.true(error instanceof TelegrafNetworkError)
    t.is(error.errorName, 'AbortError')
})

for (const code of [409, 429, 503]) {
    test(`stop interrupts the ${code} retry delay`, async (t) => {
        t.timeout(2000)
        let calls = 0
        let synced = 0
        const polling = new Polling(
            {
                callApi: async (_method, payload) => {
                    if (payload.limit === 1) {
                        synced++
                        return []
                    }
                    calls++
                    setTimeout(() => polling.stop(), 20)
                    throw new TelegramError({
                        error_code: code,
                        description: 'Retry later',
                        parameters: { retry_after: 5 },
                    })
                },
            },
            [],
            { retryOnConflict: true, conflictRetryDelay: 5000 }
        )
        await t.notThrowsAsync(polling.loop(async () => undefined))
        t.is(calls, 1)
        t.is(synced, 1)
    })
}

test('polling retries transient errors after backoff', async (t) => {
    t.timeout(8000)
    let calls = 0
    const telegram = new Telegram('123:secret', {
        fetch: async (_url, init) => {
            const payload = JSON.parse(init.body)
            if (payload.limit !== 1) {
                calls++
                if (calls === 1) {
                    throw new DOMException('Timed out', 'TimeoutError')
                }
                polling.stop()
            }
            return { status: 200, json: async () => ({ ok: true, result: [] }) }
        },
    })
    const polling = new Polling(telegram, [])
    await t.notThrowsAsync(polling.loop(async () => undefined))
    t.is(calls, 2)
})

test('a synchronous throw from a custom fetch becomes a network error', async (t) => {
    const telegram = new Telegram('123:secret', {
        fetch: () => {
            throw new TypeError('sync failure for /bot123:secret/getMe')
        },
    })
    const error = await t.throwsAsync(telegram.getMe())
    t.true(error instanceof TelegrafNetworkError)
    t.false(error.message.includes('secret'))
})

test('5xx responses start body cancellation before failing', async (t) => {
    let cancelled = false
    const telegram = new Telegram('123:secret', {
        fetch: async () => ({
            status: 502,
            statusText: 'Bad Gateway',
            body: {
                cancel: async () => {
                    cancelled = true
                },
            },
        }),
    })
    const error = await t.throwsAsync(telegram.getMe())
    t.true(error instanceof TelegramError)
    t.is(error.code, 502)
    t.true(cancelled)
})

for (const behavior of ['pending', 'rejected', 'throwing']) {
    test(`5xx body cancellation cannot mask the HTTP error (${behavior})`, async (t) => {
        t.timeout(1000)
        let cancelled = 0
        let parsed = false
        const cancel = () => {
            cancelled++
            if (behavior === 'pending') return new Promise(() => undefined)
            throw new Error('Cancellation failed')
        }
        const body =
            behavior === 'throwing'
                ? { cancel }
                : new ReadableStream({ cancel })
        const telegram = new Telegram('123:secret', {
            fetch: async () => ({
                status: 503,
                statusText: 'Service unavailable',
                body,
                json: async () => {
                    parsed = true
                    return { ok: true, result: true }
                },
            }),
        })
        const error = await t.throwsAsync(telegram.getMe())
        t.true(error instanceof TelegramError)
        t.is(error.code, 503)
        t.is(cancelled, 1)
        t.false(parsed)
        // Flush rejected cancellation promises so AVA catches unhandled ones.
        await new Promise((resolve) => setImmediate(resolve))
    })
}

for (const status of [401, 409, 429]) {
    for (const abort of [false, true]) {
        test(`native HTTP ${status} body preserves cancellation (abort: ${abort})`, async (t) => {
            const controller = new AbortController()
            let headersSeen = false
            let abortTimer
            const server = createServer((_req, res) => {
                res.writeHead(status, { 'Content-Type': 'application/json' })
                res.flushHeaders()
                if (abort) abortTimer = setTimeout(() => controller.abort(), 20)
            })
            t.teardown(() => {
                clearTimeout(abortTimer)
                controller.abort()
                server.closeAllConnections()
                server.close()
            })
            server.listen(0, '127.0.0.1')
            await once(server, 'listening')
            const telegram = new Telegram('123:secret', {
                apiRoot: `http://127.0.0.1:${server.address().port}`,
                requestTimeout: abort ? 2000 : 200,
                fetch: async (url, init) => {
                    const response = await globalThis.fetch(url, init)
                    headersSeen = response.status === status
                    return response
                },
            })
            const error = await t.throwsAsync(
                telegram.callApi('getMe', {}, { signal: controller.signal })
            )
            t.true(error instanceof TelegrafNetworkError)
            t.true(headersSeen, 'the HTTP status must precede cancellation')
            t.is(error.errorName, abort ? 'AbortError' : 'TimeoutError')
            t.is(error.transient, !abort)
        })
    }
}

test('a timeout while reading a 4xx body is not reported as an HTTP error', async (t) => {
    // This fake transport has no socket to keep AbortSignal.timeout alive.
    const keepAlive = setInterval(() => undefined, 1000)
    t.teardown(() => clearInterval(keepAlive))
    const timeout = new DOMException('timed out', 'TimeoutError')
    const telegram = new Telegram('123:secret', {
        requestTimeout: 20,
        fetch: async (_url, init) => ({
            status: 429,
            statusText: 'Too Many Requests',
            json: () =>
                new Promise((_resolve, reject) =>
                    init.signal.addEventListener('abort', () =>
                        reject(init.signal.reason ?? timeout)
                    )
                ),
        }),
    })
    const error = await t.throwsAsync(telegram.getMe())
    t.true(error instanceof TelegrafNetworkError)
    t.is(error.errorName, 'TimeoutError')
    t.true(error.transient)
})
