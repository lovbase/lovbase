import { DomainError } from '../../common/errors'

/** Application source only; reject ambiguous paths before either snapshots or sandboxes are read. */
export function sourcePath(path: string) {
  // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted paths.
  if (!path || path.length > 500 || path.startsWith('/') || /[\\\x00-\x1f]/.test(path)
    || path.split('/').some(p => !p || p === '.' || p === '..')
    || path.split('/').some(p => /^(?:\.env(?:\..*)?|\.git|\.ssh|\.pi|node_modules|dist|AGENTS\.md|\.npmrc|\.netrc)$/i.test(p)))
    throw new DomainError('This path is not an editable application source file')
  return path
}
export function isSourcePath(path: string) { try { sourcePath(path); return true } catch { return false } }
