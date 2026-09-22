import type { FileUIPart } from 'ai'

/**
 * The home composer creates the project and then navigates to it with the prompt in the URL.
 * Attachments are data URLs and do not belong in a URL, so they wait here for the project page,
 * which takes them once. Client-side navigation keeps the module alive; a full reload loses them,
 * and the prompt still arrives.
 */
let pending: FileUIPart[] = []
export function stashFiles(files: FileUIPart[]) { pending = files }
export function takeFiles(): FileUIPart[] { const f = pending; pending = []; return f }
