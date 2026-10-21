export type McpClient = 'claude' | 'codex' | 'cursor' | 'other'
// Single quoting protects self-hosted URLs when copied into a shell.
const shell = (s: string) => /^[a-zA-Z0-9:/._-]+$/.test(s) ? s : "'" + s.replace(/'/g,"'\\''") + "'"
export function mcpClientConfig(url: string) {
  return {
    claude: `claude mcp add --transport http lovbase ${shell(url)}`,
    codex: `codex mcp add lovbase --url ${shell(url)}`,
    login: 'codex mcp login lovbase',
    json: JSON.stringify({ mcpServers: { lovbase: { url } } }, null, 2),
    vscode: JSON.stringify({ servers: { lovbase: { type: 'http', url } } }, null, 2),
  }
}
