import { createContext, useContext, type ReactNode } from 'react'
import { LAYOUT_DEFAULTS, type LayoutPrefs } from './layout-prefs'

/**
 * The layout cookie, read once in the root loader and handed to whoever needs it. The sidebar is
 * on five pages; passing its opened state through each of their loaders would be five chances for
 * one of them to forget and start the page with a bounce.
 */
const Ctx = createContext<LayoutPrefs>(LAYOUT_DEFAULTS)

export const LayoutProvider = ({ value, children }: { value: LayoutPrefs; children: ReactNode }) => (
  <Ctx.Provider value={value}>{children}</Ctx.Provider>
)

export const useLayout = () => useContext(Ctx)
