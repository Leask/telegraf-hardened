import * as stream from 'stream'
import { hasPropType } from '../helpers/check'
const CRNL = '\r\n'

interface Part {
    headers: { [key: string]: string }
    body: NodeJS.ReadStream | NodeJS.ReadableStream | Buffer | string
}

class MultipartStream extends stream.Readable {
    private parts: Part[] = []
    private partIterator?: AsyncIterator<Buffer | string>
    private reading = false

    constructor(private boundary: string) {
        super()
    }

    addPart(part: Part) {
        this.parts.push(part)
    }

    async *_iterator() {
        for (const [index, part] of this.parts.entries()) {
            yield index === 0
                ? `--${this.boundary}${CRNL}`
                : `${CRNL}--${this.boundary}${CRNL}`

            for (const [key, header] of Object.entries(part.headers)) {
                yield `${key}:${header}${CRNL}`
            }
            yield CRNL

            if (MultipartStream.isStream(part.body)) {
                for await (const chunk of part.body as AsyncIterable<Buffer>) {
                    yield chunk
                }
            } else {
                yield part.body
            }
        }
        yield `${CRNL}--${this.boundary}--`
    }

    _read() {
        this.partIterator ??= this._iterator()
        void this.readNext()
    }

    private async readNext() {
        if (this.reading || !this.partIterator) return
        this.reading = true
        try {
            let shouldContinue = true
            while (shouldContinue) {
                const { value, done } = await this.partIterator.next()
                if (done) {
                    this.push(null)
                    break
                }
                shouldContinue = this.push(value)
            }
        } catch (error) {
            this.destroy(error as Error)
        } finally {
            this.reading = false
        }
    }

    static isStream(
        stream: unknown
    ): stream is { pipe: MultipartStream['pipe'] } {
        return (
            typeof stream === 'object' &&
            stream !== null &&
            hasPropType(stream, 'pipe', 'function')
        )
    }
}

export default MultipartStream
