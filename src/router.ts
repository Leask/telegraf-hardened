/** @format */

import { Middleware, MiddlewareObj } from './middleware'
import Composer from './composer'
import Context from './context'

type NonemptyReadonlyArray<T> = readonly [T, ...T[]]

type RouteFn<TContext extends Context> = (ctx: TContext) => {
    route: string
    context?: Partial<TContext>
    state?: Partial<TContext['state']>
} | null

/** @deprecated in favor of {@link Composer.dispatch} */
export class Router<C extends Context> implements MiddlewareObj<C> {
    private otherwiseHandler: Middleware<C> = Composer.passThru()

    constructor(
        private readonly routeFn: RouteFn<C>,
        public handlers = new Map<string, Middleware<C>>()
    ) {
        if (typeof routeFn !== 'function') {
            throw new Error('Missing routing function')
        }
    }

    on(route: string, ...fns: NonemptyReadonlyArray<Middleware<C>>) {
        // siakinnik - removed, typescript guaranties fns.length !== 0
        // if (fns.length === 0) {
        //   throw new TypeError('At least one handler must be provided')
        // };
        for (const fn of fns) {
            if (
                typeof fn !== 'function' &&
                !(typeof fn === 'object' && 'middleware' in fn)
            ) {
                throw new TypeError(
                    ` Router.on handler for route "${route}" must be a function or MiddlewareObj`
                )
            }
        }

        this.handlers.set(route, Composer.compose(fns))
        return this
    }

    otherwise(...fns: NonemptyReadonlyArray<Middleware<C>>) {
        // siakinnik - removed, typescript guaranties fns.length !== 0
        // if (fns.length === 0) {
        //   throw new TypeError('At least one otherwise handler must be provided')
        // };
        for (const fn of fns) {
            if (
                typeof fn !== 'function' &&
                !(typeof fn === 'object' && 'middleware' in fn)
            ) {
                throw new TypeError(
                    'Telegraf: Router.otherwise handler must be a function or MiddlewareObj'
                )
            }
        }

        this.otherwiseHandler = Composer.compose(fns)
        return this
    }

    middleware() {
        return Composer.lazy<C>((ctx) => {
            const result = this.routeFn(ctx)
            if (result == null) {
                return this.otherwiseHandler
            }

            if (result.context) {
                Object.assign(ctx, result.context)
            }

            if (result.state) {
                Object.assign(ctx.state, result.state)
            }

            return this.handlers.get(result.route) ?? this.otherwiseHandler
        })
    }
}
