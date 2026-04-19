/* eslint @typescript-eslint/restrict-template-expressions: [ "error", { "allowNumber": true, "allowBoolean": true } ] */
import { SocksProxyAgent } from 'socks-proxy-agent'
import { ProxyAgent } from 'undici'

export type ProxyProtocol = 'http' | 'https' | 'socks' | 'socks5' | 'socks4'

export interface NetworkOptions {
    proxy?: string
    timeout?: number
}

export class FetchClient {
    private readonly agent?: SocksProxyAgent | ProxyAgent

    constructor(options: NetworkOptions = {}) {
        if (options.proxy) {
            const protocol = new URL(options.proxy).protocol.replace(
                ':',
                ''
            ) as ProxyProtocol

            if (protocol.startsWith('socks')) {
                this.agent = new SocksProxyAgent(options.proxy)
            } else {
                this.agent = new ProxyAgent(options.proxy)
            }
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
                // @ts-ignore: dispatcher
                dispatcher: this.agent,
                signal: signal,
            })
        }
    }
}
