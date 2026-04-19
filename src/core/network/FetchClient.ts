/* eslint @typescript-eslint/restrict-template-expressions: [ "error", { "allowNumber": true, "allowBoolean": true } ] */
import { SocksClient, SocksProxy } from 'socks'
import { Agent, ProxyAgent, Dispatcher } from 'undici'
import { URL } from 'url'
import * as tls from 'tls'

export type ProxyProtocol = 'http' | 'https' | 'socks' | 'socks5' | 'socks4'

export interface NetworkOptions {
    proxy?: string
    timeout?: number
}

export class FetchClient {
    private readonly dispatcher?: Dispatcher

    constructor(options: NetworkOptions = {}) {
        if (!options.proxy) return

        const parsedProxy = new URL(options.proxy)
        const protocol = parsedProxy.protocol.replace(':', '')

        const proxyOptions: SocksProxy = {
            host: parsedProxy.hostname,
            port: parseInt(parsedProxy.port),
            type: protocol.includes('5') ? 5 : 4,
        }

        if (parsedProxy.username) {
            proxyOptions.userId = decodeURIComponent(parsedProxy.username)
            proxyOptions.password = decodeURIComponent(parsedProxy.password)
        }

        if (protocol.startsWith('socks')) {
            const proxyOptions: SocksProxy = {
                host: parsedProxy.hostname,
                port: parseInt(parsedProxy.port),
                type: protocol.includes('5') ? 5 : 4,
            }

            if (parsedProxy.username) {
                proxyOptions.userId = decodeURIComponent(parsedProxy.username)
                proxyOptions.password = decodeURIComponent(parsedProxy.password)
            }

            this.dispatcher = new Agent({
                allowH2: false,
                connect: async (opts, callback) => {
                    try {
                        const { socket } = await SocksClient.createConnection({
                            proxy: proxyOptions,
                            destination: {
                                host: opts.hostname,
                                port: opts.port
                                    ? parseInt(opts.port.toString(), 10)
                                    : 443,
                            },
                            command: 'connect',
                        })

                        if (opts.protocol === 'https:') {
                            const tlsSocket = tls.connect(
                                {
                                    socket: socket,
                                    servername: opts.hostname,
                                },
                                () => {
                                    callback(null, tlsSocket)
                                }
                            )

                            tlsSocket.on('error', (err) => callback(err, null))
                        } else {
                            callback(null, socket)
                        }
                    } catch (err) {
                        callback(err as Error, null)
                    }
                },
            })
        } else {
            this.dispatcher = new ProxyAgent(options.proxy)
        }
    }
    public get fetch(): typeof globalThis.fetch {
        return (url, init) => {
            let signal = init?.signal
            if (
                !signal &&
                init &&
                'timeout' in init &&
                typeof init.timeout === 'number'
            ) {
                signal = AbortSignal.timeout(init.timeout)
            }
            return globalThis.fetch(url, {
                ...init,
                // @ts-ignore: undici dispatcher support
                dispatcher: this.dispatcher,
                signal: signal,
            })
        }
    }
}
