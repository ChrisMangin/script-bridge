// ScriptBridge Syntax Highlight wrapper for highlight.js
// Maps ScriptBridge language names to hljs language identifiers
var SyntaxHighlight = {
    langMap: {
        javascript: 'javascript',
        typescript: 'typescript',
        python: 'python',
        rust: 'rust',
        c: 'c',
        sql: 'sql',
        vbscript: 'vbscript',
        shell: 'bash',
        cmd: 'dos',
        powershell: 'powershell'
    },
    highlight: function(code, language) {
        if (!code) return '';
        if (typeof hljs === 'undefined') return code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        var lang = this.langMap[language] || 'javascript';
        try {
            var result = hljs.highlight(code, {language: lang, ignoreIllegals: true});
            return result.value;
        } catch(e) {
            return code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        }
    }
};