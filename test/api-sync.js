const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const test = require('ava')
const { Telegram } = require('../')

function readMethodsFromTypes() {
    const typesRoot = path.dirname(require.resolve('@telegraf/types/package.json'))
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
        ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
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
