// ----------------------
// validate-token.ts - validateToken,validateTokenAsync functions
// ----------------------

export function validateToken(token: string): void {
    if (!token) {
        throw new Error('Telegraf: Token is required!')
    }
    if (typeof token !== 'string' || !token.includes(':')) {
        throw new Error('Telegraf: Invalid token format!')
    }
}
