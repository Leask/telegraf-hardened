// ----------------------
// validate-token.ts - validateToken,validateTokenAsync functions
// ----------------------

// Dependencies
import * as https from 'https';

export function validateToken(token: string): void {
    if (!token) {
        throw new Error('Telegraf: Token is required!')
    };
    if (typeof token !== 'string' || !token.includes(':')) {
        throw new Error('Telegraf: Invalid token format!')
    };
};