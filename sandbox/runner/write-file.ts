import { randomUUID } from 'node:crypto'

type Exec = (args: string[], env?: string[]) => Promise<{ success: boolean; stderr: string }>

/** Linux limits each argv/env entry to 128 KiB. Snapshots routinely exceed that. */
export async function writeDockerFile(exec: Exec, path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const run = async (script: string, args: string[], env?: string[]) => {
    const result = await exec(['sh', '-c', script, 'sh', ...args], env)
    if (!result.success) throw new Error(result.stderr || 'File write failed')
  }
  try {
    await run('mkdir -p "$(dirname "$1")" && : > "$1"', [temporary])
    const encoded = Buffer.from(content).toString('base64')
    for (let offset = 0; offset < encoded.length; offset += 49152) {
      await run(
        'printf "%s" "$CHUNK" | base64 -d >> "$1"',
        [temporary],
        [`CHUNK=${encoded.slice(offset, offset + 49152)}`],
      )
    }
    await run('mv -f -- "$1" "$2"', [temporary, path])
  } finally {
    await exec(['rm', '-f', '--', temporary]).catch(() => {})
  }
}
